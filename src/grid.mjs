import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CodexClient } from './codex.mjs';
import { profileInstructions } from './profiles.mjs';

const exec = promisify(execFile);
const mcpEntry = fileURLToPath(new URL('./mcp.mjs', import.meta.url));
const running = new Set(['starting', 'running']);
const textInput = (text) => [{ type: 'text', text }];
const time = () => new Date().toISOString();

const toolLabels = {
  commandExecution: '执行命令',
  fileChange: '修改文件',
  mcpToolCall: '调用 MCP',
  webSearch: '查资料',
};

export class Grid extends EventEmitter {
  constructor({ workspace, directory, profiles, codex }) {
    super();
    this.workspace = workspace;
    this.directory = directory;
    this.codex = codex;
    this.closed = false;
    this.gitQueue = Promise.resolve();
    this.slots = profiles.map((profile) => ({ profile, token: randomBytes(24).toString('hex'), active: null, lastTask: null, client: null, threads: new Set() }));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.statePath = join(directory, 'state.json');
    const saved = existsSync(this.statePath) ? JSON.parse(readFileSync(this.statePath, 'utf8')) : {};
    this.tasks = saved.tasks ?? [];
    this.events = saved.events ?? [];
    this.eventId = this.events.at(-1)?.id ?? 0;
    for (const task of this.tasks) {
      if (running.has(task.status)) {
        task.status = 'interrupted';
        task.activity = '卦阵重启，可继续会话';
        task.updatedAt = time();
      }
      const slot = this.#slot(task.agent);
      if (slot && (!slot.lastTask || task.updatedAt >= slot.lastTask.updatedAt)) slot.lastTask = task;
    }
    this.#save();
  }

  start(origin) {
    this.origin = origin;
    this.#dispatch();
  }

  #slot(name) {
    return this.slots.find(({ profile }) => profile.id === name || profile.name === name);
  }

  #save() {
    const temporary = `${this.statePath}.tmp`;
    writeFileSync(temporary, JSON.stringify({ tasks: this.tasks, events: this.events }), { mode: 0o600 });
    renameSync(temporary, this.statePath);
  }

  snapshot() {
    return {
      workspace: this.workspace,
      agents: this.slots.map((slot) => {
        const { id, name, glyph, specialty, image, mcp } = slot.profile;
        const task = slot.lastTask;
        return { id, name, glyph, specialty, image, status: task?.status ?? 'idle', taskId: task?.id ?? null, tools: mcp.tools };
      }),
      tasks: this.tasks,
      events: this.events,
    };
  }

  #event(kind, from, to, text, taskId) {
    this.events.push({ id: ++this.eventId, at: time(), kind, from, to, text, taskId });
    if (this.events.length > 160) this.events.shift();
    this.#save();
    this.emit('change');
  }

  async enqueue(entries) {
    if (!Array.isArray(entries) || entries.length === 0 || entries.length > 64) {
      throw new Error('请提交 1 到 64 项任务');
    }
    const tasks = entries.map((entry) => {
      const { prompt, agent } = entry ?? {};
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 24_000) throw new Error('任务需要填写内容');
      const preferred = agent ? this.#slot(agent) : null;
      if (agent && !preferred) throw new Error('找不到指定的卦');
      return {
        id: randomUUID().slice(0, 12),
        prompt: prompt.trim(),
        preferredAgent: preferred?.profile.id ?? null,
        agent: null,
        status: 'queued',
        activity: '等待派发',
        result: '',
        createdAt: time(),
        updatedAt: time(),
      };
    });
    let head;
    try {
      const { stdout } = await exec('git', ['-C', this.workspace, 'rev-parse', '--verify', 'HEAD']);
      head = stdout.trim();
    } catch {
      throw new Error('工作仓库需要一个 Git 提交，卦阵会从该提交创建工作目录');
    }
    for (const task of tasks) task.baseCommit = head;
    this.tasks.push(...tasks);
    this.#event('queue', 'user', 'grid', `加入 ${tasks.length} 项任务`);
    this.#dispatch();
    return tasks.map(({ id }) => id);
  }

  #dispatch() {
    if (this.closed) return;
    for (const slot of this.slots) {
      if (slot.active) continue;
      const task = this.tasks.find((job) => job.status === 'queued' && job.preferredAgent === slot.profile.id)
        ?? this.tasks.find((job) => job.status === 'queued' && !job.preferredAgent);
      if (task) this.#begin(slot, task, task.prompt);
    }
  }

  #begin(slot, task, prompt) {
    const run = { task, turnId: null, output: new Map() };
    slot.active = run;
    slot.lastTask = task;
    task.agent = slot.profile.id;
    task.status = 'starting';
    task.activity = task.threadId ? '恢复会话' : '准备工作目录';
    task.updatedAt = time();
    delete task.error;
    this.#event('dispatch', 'grid', slot.profile.id, prompt, task.id);
    void this.#execute(slot, run, prompt).catch((error) => this.#finish(slot, run, 'failed', error.message));
  }

  async #execute(slot, run, prompt) {
    const { task } = run;
    if (!task.worktree) {
      const root = join(this.directory, 'worktrees');
      mkdirSync(root, { recursive: true });
      const worktree = join(root, task.id);
      const branch = `guagrid/${task.id}`;
      const add = this.gitQueue.then(() => {
        if (this.closed) throw new Error('卦阵已关闭');
        return exec('git', ['-C', this.workspace, 'worktree', 'add', '-b', branch, worktree, task.baseCommit]);
      });
      this.gitQueue = add.catch(() => {});
      await add;
      Object.assign(task, { worktree, branch, activity: '连接 Codex', updatedAt: time() });
      this.#save();
      this.emit('change');
    }
    if (this.closed || slot.active !== run) return;
    const client = await this.#client(slot);
    if (this.closed || slot.active !== run) return;
    if (!task.threadId || !slot.threads.has(task.threadId)) {
      const params = {
        cwd: task.worktree,
        sandbox: 'workspace-write',
        approvalPolicy: 'never',
        developerInstructions: profileInstructions(slot.profile),
        config: {
          mcp_servers: {
            ...slot.profile.mcp.servers,
            guagrid: {
              command: process.execPath,
              args: [mcpEntry],
              env: {
                GUAGRID_MCP_URL: `${this.origin}/internal/mcp`,
                GUAGRID_MCP_TOKEN: slot.token,
                GUAGRID_MCP_TOOLS: slot.profile.mcp.tools.join(','),
              },
              tools: Object.fromEntries(slot.profile.mcp.tools.map((name) => [name, { approval_mode: 'approve' }])),
              required: true,
            },
          },
        },
      };
      const response = task.threadId
        ? await client.call('thread/resume', { ...params, threadId: task.threadId, excludeTurns: true })
        : await client.call('thread/start', params);
      task.threadId = response.thread.id;
      slot.threads.add(task.threadId);
      this.#save();
    }
    if (this.closed || slot.active !== run) return;
    const { turn } = await client.call('turn/start', { threadId: task.threadId, input: textInput(prompt) });
    if (slot.active === run && !run.turnId) run.turnId = turn.id;
  }

  async #client(slot) {
    if (!slot.client || slot.client.closed) {
      const client = new CodexClient(this.codex, this.workspace);
      slot.client = client;
      slot.threads.clear();
      client.on('notification', (message) => this.#notification(slot, message));
      client.on('disconnect', (error) => {
        if (slot.client === client && slot.active && !this.closed) this.#finish(slot, slot.active, 'failed', error.message);
      });
    }
    await slot.client.ready;
    return slot.client;
  }

  #notification(slot, { method, params = {} }) {
    const run = slot.active;
    if (!run || run.task.threadId !== params.threadId) return;
    const turnId = params.turnId ?? params.turn?.id;
    if (run.turnId && turnId && run.turnId !== turnId) return;
    const { task } = run;
    if (method === 'turn/started') {
      run.turnId = params.turn.id;
      task.status = 'running';
      task.activity = '执行中';
      task.updatedAt = time();
      this.#event('started', slot.profile.id, 'grid', '已开工', task.id);
    } else if (method === 'item/started' && toolLabels[params.item.type]) {
      task.activity = toolLabels[params.item.type];
      task.updatedAt = time();
      this.#event('tool', slot.profile.id, 'grid', task.activity, task.id);
    } else if (method === 'item/agentMessage/delta' || (method === 'item/completed' && params.item.type === 'agentMessage')) {
      const itemId = params.itemId ?? params.item.id;
      const content = params.item?.text ?? `${run.output.get(itemId) ?? ''}${params.delta}`;
      run.output.set(itemId, content.slice(-12_000));
      task.result = [...run.output.values()].join('\n\n').slice(-12_000);
      task.updatedAt = time();
      this.emit('change');
    } else if (method === 'turn/completed') {
      const status = params.turn.status;
      const final = status === 'completed' ? 'completed' : status === 'interrupted' ? 'interrupted' : 'failed';
      this.#finish(slot, run, final, params.turn.error?.message);
    }
  }

  #finish(slot, run, status, error) {
    if (slot.active !== run) return;
    const { task } = run;
    slot.active = null;
    task.status = status;
    task.activity = { completed: '已交回结果', interrupted: '已中断', failed: '执行失败' }[status];
    task.updatedAt = time();
    if (error) task.error = error;
    this.#event(status, slot.profile.id, 'grid', error ?? task.activity, task.id);
    this.#dispatch();
  }

  async message(id, text) {
    const slot = this.#slot(id);
    if (!slot) throw new Error('找不到指定的卦');
    if (typeof text !== 'string' || !text.trim() || text.length > 24_000) throw new Error('请输入消息');
    const task = slot.lastTask;
    if (!task) {
      await this.enqueue([{ agent: id, prompt: text }]);
    } else if (slot.active) {
      const { turnId } = slot.active;
      if (!turnId) throw new Error('会话正在启动');
      await slot.client.call('turn/steer', { threadId: task.threadId, expectedTurnId: turnId, input: textInput(text) });
      this.#event('message', 'user', slot.profile.id, text, task.id);
    } else {
      this.#begin(slot, task, text);
    }
  }

  async interrupt(id) {
    const slot = this.#slot(id);
    if (!slot?.active?.turnId) throw new Error('该卦当前没有可中断的回合');
    await slot.client.call('turn/interrupt', { threadId: slot.active.task.threadId, turnId: slot.active.turnId });
  }

  query(token, { tool, arguments: args = {} }) {
    const caller = this.slots.find((slot) => slot.token === token);
    if (!caller) throw Object.assign(new Error('状态工具身份无效'), { status: 401 });
    if (!caller.profile.mcp.tools.includes(tool)) throw new Error('该卦未启用此工具');
    if (tool === 'get_task_result') {
      const task = this.tasks.find(({ id }) => id === args.taskId);
      if (!task) throw new Error('找不到该任务');
      this.#event('query', caller.profile.id, task.agent ?? 'grid', '查询任务成果', task.id);
      return { ...task };
    }
    const target = args.agent ? this.#slot(args.agent) : null;
    if (args.agent && !target) throw new Error('找不到该卦');
    const agents = (target ? [target] : this.slots).map((slot) => {
      const task = slot.lastTask;
      return {
        agent: slot.profile.name,
        id: slot.profile.id,
        status: task?.status ?? 'idle',
        activity: task?.activity ?? '待命',
        task: task?.prompt.slice(0, 400) ?? null,
        taskId: task?.id ?? null,
        updatedAt: task?.updatedAt ?? null,
        branch: task?.branch ?? null,
        result: task?.result.slice(-350) || null,
      };
    });
    this.#event('query', caller.profile.id, target?.profile.id ?? 'grid', target ? `查${target.profile.name}的状态` : '查八卦状态', caller.active?.task.id);
    return { agents };
  }

  close() {
    this.closed = true;
    for (const slot of this.slots) {
      if (slot.active) this.#finish(slot, slot.active, 'interrupted');
      slot.client?.close();
    }
  }
}

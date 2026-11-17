import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CodexClient } from './codex.mjs';
import { profileInstructions, step1Agents } from './profiles.mjs';
import { reviewTongqi, tongqiItems, withTimeout } from './tongqi.mjs';

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
    this.slots = profiles.map((profile) => ({ profile, active: null, lastTask: null, client: null, threads: new Set() }));
    this.callers = new Map();
    this.openingThreads = new WeakMap();
    this.tongqiDeliveries = new Map();
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

  #event(kind, from, to, text, taskId, tongqiId) {
    this.events.push({ id: ++this.eventId, at: time(), kind, from, to, text, taskId, ...(tongqiId && { tongqiId }) });
    if (this.events.length > 160) this.events.shift();
    this.#save();
    this.emit('change');
  }

  enqueueStep1(prompt) {
    return this.#enqueue(step1Agents.map((agent) => ({ agent, prompt })), randomUUID());
  }

  enqueue(entries) {
    return this.#enqueue(entries);
  }

  async #enqueue(entries, step1Id) {
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
        prompt: step1Id ? prompt : prompt.trim(),
        ...(step1Id && { step1Id }),
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
    this.#event('queue', 'user', 'grid', step1Id ? 'Step 1 · 等待震与兑开工' : `加入 ${tasks.length} 项任务`);
    this.#dispatch();
    return tasks.map(({ id }) => id);
  }

  #dispatch() {
    if (this.closed) return;
    const step = this.tasks.find((task) => task.status === 'queued' && task.step1Id);
    if (step && step1Agents.every((id) => !this.#slot(id).active)) {
      const pair = this.tasks.filter((task) => task.step1Id === step.step1Id && task.status === 'queued');
      this.#begin(pair.map((task) => ({ slot: this.#slot(task.preferredAgent), task, prompt: task.prompt })));
    }
    for (const slot of this.slots) {
      if (slot.active || (step && step1Agents.includes(slot.profile.id))) continue;
      const task = this.tasks.find((job) => job.status === 'queued' && job.preferredAgent === slot.profile.id && !job.step1Id)
        ?? this.tasks.find((job) => job.status === 'queued' && !job.preferredAgent);
      if (task) this.#begin([{ slot, task, prompt: task.prompt }]);
    }
  }

  #begin(assignments) {
    const runs = assignments.map(({ slot, task, prompt }) => ({ slot, run: this.#reserve(slot, task), prompt }));
    for (const { slot, run, prompt } of runs) {
      this.#event('dispatch', 'grid', slot.profile.id, prompt, run.task.id);
    }
    void this.#startTogether(runs);
  }

  #reserve(slot, task) {
    const run = { task, turnId: null, output: new Map(), started: Promise.withResolvers() };
    slot.active = run;
    slot.lastTask = task;
    task.agent = slot.profile.id;
    task.status = 'starting';
    task.activity = task.threadId ? '恢复会话' : '准备工作目录';
    task.updatedAt = time();
    delete task.error;
    return run;
  }

  async #startTogether(runs) {
    const prepared = await Promise.allSettled(runs.map(({ slot, run }) => this.#prepare(slot, run)));
    for (const [index, result] of prepared.entries()) {
      const { slot, run, prompt } = runs[index];
      if (this.closed || slot.active !== run) continue;
      if (result.status === 'rejected') {
        this.#finish(slot, run, 'failed', result.reason.message);
        continue;
      }
      const client = result.value;
      void client.call('turn/start', { threadId: run.task.threadId, input: textInput(prompt) }).then(({ turn }) => {
        if (slot.active === run && !run.turnId) run.turnId = turn.id;
      }).catch((error) => this.#finish(slot, run, 'failed', error.message));
    }
  }

  async #prepare(slot, run) {
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
    return this.#loadThread(slot, task);
  }

  #loadThread(slot, task) {
    let opening = this.openingThreads.get(task);
    if (!opening) {
      opening = this.#openThread(slot, task).finally(() => this.openingThreads.delete(task));
      this.openingThreads.set(task, opening);
    }
    return opening;
  }

  async #openThread(slot, task) {
    const client = await this.#client(slot);
    if (!task.threadId || !slot.threads.has(task.threadId)) {
      const token = randomBytes(24).toString('hex');
      const params = {
        cwd: task.worktree,
        sandbox: 'workspace-write',
        approvalPolicy: 'never',
        developerInstructions: profileInstructions(slot.profile, task.step1Id),
        config: {
          mcp_servers: {
            ...slot.profile.mcp.servers,
            guagrid: {
              command: process.execPath,
              args: [mcpEntry],
              env: {
                GUAGRID_MCP_URL: `${this.origin}/internal/mcp`,
                GUAGRID_MCP_TOKEN: token,
                GUAGRID_MCP_TOOLS: slot.profile.mcp.tools.join(','),
              },
              tools: Object.fromEntries(slot.profile.mcp.tools.map((name) => [name, { approval_mode: 'approve' }])),
              tool_timeout_sec: 150,
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
      this.callers.set(token, { slot, task, client });
      this.#save();
    }
    return client;
  }

  async #client(slot) {
    if (!slot.client || slot.client.closed) {
      const client = new CodexClient(this.codex, this.workspace);
      slot.client = client;
      slot.threads.clear();
      client.on('notification', (message) => this.#notification(slot, message));
      client.on('disconnect', (error) => {
        for (const [token, caller] of this.callers) {
          if (caller.client === client) this.callers.delete(token);
        }
        if (slot.client === client && slot.active && !this.closed) this.#finish(slot, slot.active, 'failed', error.message);
      });
    }
    const client = slot.client;
    await client.ready;
    return client;
  }

  #notification(slot, { method, params = {} }) {
    const run = slot.active;
    if (!run || run.task.threadId !== params.threadId) return;
    const turnId = params.turnId ?? params.turn?.id;
    if (run.turnId && turnId && run.turnId !== turnId) return;
    const { task } = run;
    if (method === 'item/completed' && params.item.type === 'mcpToolCall'
        && params.item.server === 'guagrid' && params.item.tool === 'tongqi' && params.item.status === 'completed') {
      const receipt = this.tongqiDeliveries.get(params.item.result?.structuredContent?.id);
      if (receipt?.task === task) receipt.resolve();
    }
    if (method === 'turn/started') {
      run.turnId = params.turn.id;
      run.started.resolve();
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
    run.started.resolve();
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
      this.#begin([{ slot, task, prompt: text }]);
    }
  }

  async interrupt(id) {
    const slot = this.#slot(id);
    if (!slot?.active?.turnId) throw new Error('该卦当前没有可中断的回合');
    await slot.client.call('turn/interrupt', { threadId: slot.active.task.threadId, turnId: slot.active.turnId });
  }

  useTool(token, { tool, arguments: args = {} }) {
    const session = this.callers.get(token);
    if (!session) throw Object.assign(new Error('卦阵工具身份无效'), { status: 401 });
    const { slot: caller, task } = session;
    if (!caller.profile.mcp.tools.includes(tool)) throw new Error('该卦未启用此工具');
    if (tool === 'tongqi') return this.#sendQi(session, args);
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
    this.#event('query', caller.profile.id, target?.profile.id ?? 'grid', target ? `查${target.profile.name}的状态` : '查八卦状态', task.id);
    return { agents };
  }

  #sendQi(sender, { agent, message }) {
    if (sender.slot.active?.task !== sender.task) throw new Error('感方当前没有运行中的任务');
    const target = this.#slot(agent);
    if (!target || target === sender.slot) throw new Error('请选择另一卦作为应方');
    if (typeof message !== 'string' || !message.trim() || message.length > 12_000) {
      throw new Error('请填写 1 到 12000 字的通气消息');
    }

    const receiver = sender.task.step1Id && step1Agents.includes(target.profile.id)
      ? this.tasks.find((task) => task.step1Id === sender.task.step1Id && task.preferredAgent === target.profile.id)
      : target.lastTask;
    if (!receiver || (!receiver.worktree && target.active?.task !== receiver)) throw new Error('应方还没有可通气的会话');

    const id = randomUUID();
    const from = sender.slot.profile;
    const to = target.profile;
    const response = Promise.withResolvers();
    this.#event('gan', from.id, to.id, message, sender.task.id, id);
    void this.#reviewQi({ id, sender, target, receiver, message, response }).catch((error) => {
      response.reject(error);
      if (!this.closed) this.#event('tongqi_error', to.id, from.id, error.message, receiver.id, id);
    });
    return response.promise;
  }

  async #reviewQi({ id, sender, target, receiver, message, response }) {
    const active = target.active;
    if (active?.task === receiver) {
      await withTimeout(active.started.promise, 25_000, '应方尚未开始回合，可稍后重试');
    }
    if (!receiver.threadId) throw new Error('应方还没有可通气的会话');

    const client = await this.#loadThread(target, receiver);
    const from = sender.slot.profile;
    const to = target.profile;
    await reviewTongqi(client, { task: receiver, from: from.name, to: to.name, message }, async ({ accepted, reply, preAnalysis }) => {
      if (sender.slot.active?.task !== sender.task) throw new Error('感方回合已结束');
      const delivered = Promise.withResolvers();
      this.tongqiDeliveries.set(id, { task: sender.task, resolve: delivered.resolve });
      try {
        response.resolve({ id, accepted, reply });
        await withTimeout(delivered.promise, 12_000, '感方未收到通气回复');
      } finally {
        this.tongqiDeliveries.delete(id);
      }

      this.#event('ying', to.id, from.id, `${accepted ? '接受' : '不接受'} · ${reply}`, receiver.id, id);
      if (accepted) {
        await client.call('thread/inject_items', { threadId: receiver.threadId, items: tongqiItems(from.name, message, preAnalysis) });
        this.#event('tongqi_applied', to.id, to.id, '已追加原文和预分析', receiver.id, id);
      }
    });
  }

  close() {
    this.closed = true;
    for (const slot of this.slots) {
      if (slot.active) this.#finish(slot, slot.active, 'interrupted');
      slot.client?.close();
    }
  }
}

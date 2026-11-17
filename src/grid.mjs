import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CODEX_MODEL, CodexClient } from './codex.mjs';
import { profileInstructions, step1Agents } from './profiles.mjs';
import { historyText, reviewTongqi, tongqiItems, withTimeout } from './tongqi.mjs';
import { readReview, responsibilities, reviewSchema, stages, workflowPrompt } from './workflow.mjs';
import { sessionTitle, toolTrace, TraceJournal } from './trace.mjs';
import { activeArtifacts, adoptPatch, collectPatch, git, parallelPrompt, parallelReviewSchema, parseForkPlan, roles, WorkFiles } from './parallel.mjs';
import { runNativeFork } from './forks.mjs';

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
    this.workflowExchanges = new Map();
    this.workOperations = new Set();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.statePath = join(directory, 'state.json');
    const saved = existsSync(this.statePath) ? JSON.parse(readFileSync(this.statePath, 'utf8')) : {};
    this.tasks = saved.tasks ?? [];
    this.workflows = saved.workflows ?? [];
    this.events = saved.events ?? [];
    this.journal = new TraceJournal(directory);
    this.workFiles = new WorkFiles(directory);
    this.sessions = saved.sessions ?? this.journal.migrate(this.tasks, this.workflows, this.events);
    this.eventId = Math.max(this.events.at(-1)?.id ?? 0, ...this.sessions.map(({ version }) => Number(version) || 0));
    for (const workflow of this.workflows) {
      if (workflow.status === 'running') {
        workflow.status = 'interrupted';
        workflow.summary = '卦阵重启。工作目录和已有交付可继续检查。';
      }
    }
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
    writeFileSync(temporary, JSON.stringify({ tasks: this.tasks, workflows: this.workflows, sessions: this.sessions, events: this.events }), { mode: 0o600 });
    renameSync(temporary, this.statePath);
  }

  snapshot() {
    const workflow = this.workflows.find(({ status }) => status === 'running');
    return {
      workspace: this.workspace,
      model: CODEX_MODEL,
      agents: this.slots.map((slot) => {
        const { id, name, glyph, specialty, image, mcp } = slot.profile;
        const task = workflow ? this.#workflowTask(workflow.id, id) : slot.lastTask;
        return { id, name, glyph, specialty, image, responsibility: workflow && workflow.mode !== 'parallel' ? responsibilities[id][1] : roles[id].duty,
          status: task?.status ?? 'idle', taskId: task?.id ?? null, tools: this.#tools(mcp, task) };
      }),
      tasks: this.tasks,
      workflows: this.workflows.map((run) => ({ ...run, stageName: run.mode === 'parallel'
        ? ['八卦并行', '八卦并行', '逐项合入', '独立复跑'][run.stage] : stages[run.stage].name, stageCount: stages.length })),
      sessions: this.sessions.map((session) => this.#describeSession(session)),
      live: this.slots.flatMap(({ active, profile }) => active?.stream ? [{ taskId: active.task.id, from: profile.id, text: active.stream }] : []),
      events: this.events,
    };
  }

  #event(kind, from, to, text, taskId, tongqiId, extra = {}) {
    const task = this.tasks.find((entry) => entry.id === taskId);
    const sessionId = extra.sessionId ?? task?.sessionId;
    const work = this.workflows.find((entry) => entry.sessionId === sessionId && entry.mode === 'parallel');
    const id = ++this.eventId;
    const event = { id, at: time(), kind, from, to, text, taskId, ...(tongqiId && { tongqiId }), ...structuredClone(extra), sessionId,
      ...(work && { seq: id, eventId: extra.eventId ?? `${work.id}:${id}`, workId: work.id, baseline: 'B0', baseCommit: work.baseCommit }) };
    this.events.push(event);
    if (this.events.length > 160) this.events.shift();
    const session = this.sessions.find(({ id }) => id === sessionId);
    if (session) {
      this.journal.append(sessionId, event);
      session.version = event.id;
      session.updatedAt = event.at;
    }
    this.#save();
    this.emit('change');
    return event;
  }

  #workEvent(work, kind, from, text, extra = {}) {
    const event = this.#event(kind, from, 'grid', text, extra.taskId, undefined, { ...extra, sessionId: work.sessionId });
    if (extra.candidate) this.workFiles.saveCandidate(work, extra.candidate);
    this.workFiles.save(work);
    return event;
  }

  #session(id) {
    const session = this.sessions.find((entry) => entry.id === id);
    if (!session) throw Object.assign(new Error('找不到会话'), { status: 404 });
    return session;
  }

  #describeSession(session) {
    const tasks = this.tasks.filter(({ sessionId }) => sessionId === session.id);
    const workflow = this.workflows.find(({ sessionId }) => sessionId === session.id);
    const status = tasks.some(({ status }) => running.has(status)) ? 'running'
      : tasks.some((task) => task.status === 'queued' || task.pendingMessages?.length) ? 'queued'
      : workflow?.status ?? (tasks.some(({ status }) => status === 'failed' || status === 'interrupted') ? 'blocked' : tasks.length ? 'completed' : 'idle');
    return { ...session, status, taskCount: tasks.length };
  }

  createSession() {
    const createdAt = time();
    const session = { id: randomUUID().slice(0, 12), title: '新会话', createdAt, updatedAt: createdAt, version: 0 };
    this.sessions.push(session);
    this.#save();
    this.emit('change');
    return this.#describeSession(session);
  }

  trace(id) {
    const session = this.#session(id);
    return this.journal.read(session, this.tasks.filter(({ sessionId }) => sessionId === id), this.slots.map(({ profile }) => profile));
  }

  workArtifact(sessionId, id) {
    this.#session(sessionId);
    const work = this.workflows.find((item) => item.sessionId === sessionId && item.mode === 'parallel');
    if (!work) throw Object.assign(new Error('这个会话没有新版交接'), { status: 404 });
    return this.workFiles.read(work, id);
  }

  enqueueStep1(prompt, sessionId) {
    return this.#enqueue(step1Agents.map((agent) => ({ agent, prompt })), randomUUID(), undefined, sessionId);
  }

  async enqueueWorkflow(prompt, sessionId, { source, forkPlan } = {}) {
    const workflow = {
      id: randomUUID().slice(0, 12), prompt, status: 'queued', stage: 0, repairCount: 0, createdAt: time(), mode: 'parallel',
      model: CODEX_MODEL, scope: [], artifacts: [], candidates: [], forks: [],
      ...(source && { replayOf: source.id, baseCommit: source.baseCommit }), ...(forkPlan && { forkPlan, forkRole: 'zhen' }),
    };
    const entries = Object.keys(roles).map((agent) => ({ agent, prompt }));
    const ids = await this.#enqueue(entries, undefined, workflow, sessionId);
    return { ids, workflowId: workflow.id, sessionId: this.tasks.find(({ id }) => id === ids[0]).sessionId };
  }

  rerun(sessionId, { variants, checks }) {
    this.#session(sessionId);
    const source = this.workflows.find((work) => work.sessionId === sessionId && work.baseCommit);
    if (!source) throw Object.assign(new Error('这个会话没有可重跑的协作基线'), { status: 404 });
    const forkPlan = variants === undefined ? undefined : parseForkPlan(variants, checks);
    return this.enqueueWorkflow(source.prompt, undefined, { source, forkPlan });
  }

  recheck(sessionId, { commit, evidence }) {
    this.#session(sessionId);
    const work = this.workflows.find((entry) => entry.sessionId === sessionId && entry.mode === 'parallel');
    if (work?.status !== 'blocked' || work.review?.verdict !== 'blocked' || !commit
        || commit !== work.integrationCommit || commit !== work.review.checkedCommit) {
      throw Object.assign(new Error('补充验证须对应当前遇阻的受检提交'), { status: 409 });
    }
    if (typeof evidence !== 'string' || !evidence.trim() || evidence.length > 12_000) throw new Error('请附同一提交的实际复跑证据');
    if (this.workflows.some(({ status }) => status === 'running') || this.slots.some(({ active }) => active)) {
      throw Object.assign(new Error('当前有其他回合正在执行'), { status: 409 });
    }
    work.firstConclusion ??= { at: work.finishedAt, verdict: work.review.verdict, summary: work.review.summary };
    work.externalCheck = { commit, text: evidence, at: time() };
    Object.assign(work, { status: 'running', reviewTarget: null, summary: null, finishedAt: null });
    this.#workEvent(work, 'external_check', 'user', '追加同一提交的本机复跑证据', { commit, result: work.externalCheck });
    this.#dispatch();
    return { workId: work.id, sessionId, commit };
  }

  enqueue(entries, sessionId) {
    return this.#enqueue(entries, undefined, undefined, sessionId);
  }

  async #enqueue(entries, step1Id, workflow, sessionId) {
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
        prompt: step1Id || workflow ? prompt : prompt.trim(),
        ...(step1Id && { step1Id }),
        ...(workflow && { workflowId: workflow.id }),
        preferredAgent: preferred?.profile.id ?? null,
        agent: null,
        status: workflow ? 'waiting' : 'queued',
        activity: workflow ? '等待本卦分工' : '等待派发',
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
    if (workflow) {
      workflow.repositoryHead = head;
      if (workflow.baseCommit) {
        await git(this.workspace, 'cat-file', '-e', `${workflow.baseCommit}^{commit}`);
        head = workflow.baseCommit;
      } else {
        const previous = this.workflows.findLast((work) => work.mode === 'parallel' && !work.replayOf && work.repositoryHead === head && work.stableCommit);
        head = previous?.stableCommit ?? head;
      }
    }
    const session = sessionId ? this.#session(sessionId) : this.#session(this.createSession().id);
    if (this.tasks.some((task) => task.sessionId === session.id)) throw new Error('这个会话已有任务，可以选择一卦继续对话');
    session.title = sessionTitle(tasks[0].prompt);
    for (const task of tasks) Object.assign(task, { baseCommit: head, sessionId: session.id });
    this.tasks.push(...tasks);
    if (workflow) this.workflows.push(Object.assign(workflow, { baseCommit: head, sessionId: session.id }));
    const prompt = workflow || step1Id ? tasks[0].prompt : tasks.map((task) => task.prompt).join('\n');
    this.#event('message', 'user', 'grid', prompt, undefined, undefined, { sessionId: session.id });
    const label = workflow ? '八卦协作已入队' : step1Id ? 'Step 1 · 等待震与兑开工' : `加入 ${tasks.length} 项任务`;
    this.#event('queue', 'user', 'grid', label, undefined, undefined, { sessionId: session.id });
    this.#dispatch();
    return tasks.map(({ id }) => id);
  }

  #dispatch() {
    if (this.closed) return;
    const workflow = this.workflows.find(({ status }) => status === 'queued' || status === 'running');
    if (workflow) {
      if (workflow.mode === 'parallel') this.#advanceParallel(workflow);
      else this.#advanceWorkflow(workflow);
      return;
    }
    const step = this.tasks.find((task) => task.status === 'queued' && task.step1Id);
    if (step && step1Agents.every((id) => !this.#slot(id).active)) {
      const pair = this.tasks.filter((task) => task.step1Id === step.step1Id && task.status === 'queued');
      this.#begin(pair.map((task) => ({ slot: this.#slot(task.preferredAgent), task, prompt: task.prompt })));
    }
    for (const slot of this.slots) {
      if (slot.active || (step && step1Agents.includes(slot.profile.id))) continue;
      const followup = this.tasks.find((task) => task.agent === slot.profile.id && task.pendingMessages?.length
        && !['queued', 'waiting'].includes(task.status));
      if (followup) {
        const prompt = followup.pendingMessages.join('\n\n');
        delete followup.pendingMessages;
        this.#begin([{ slot, task: followup, prompt }]);
        continue;
      }
      const task = this.tasks.find((job) => job.status === 'queued' && job.preferredAgent === slot.profile.id && !job.step1Id)
        ?? this.tasks.find((job) => job.status === 'queued' && !job.preferredAgent);
      if (task) this.#begin([{ slot, task, prompt: task.prompt }]);
    }
  }

  #workflowTask(workflowId, role) {
    return this.tasks.find((task) => task.workflowId === workflowId && task.preferredAgent === role);
  }

  #operate(work, operation, run, failed) {
    const key = `${work.id}:${operation}`;
    if (this.workOperations.has(key)) return;
    this.workOperations.add(key);
    void Promise.resolve().then(run).catch((error) => {
      if (!this.closed) failed(error);
    }).finally(() => {
      this.workOperations.delete(key);
      this.#dispatch();
    });
  }

  #working(work, operation) {
    return operation ? this.workOperations.has(`${work.id}:${operation}`)
      : [...this.workOperations].some((key) => key.startsWith(`${work.id}:`));
  }

  #advanceParallel(work) {
    const tasks = this.tasks.filter(({ workflowId }) => workflowId === work.id);
    if (work.status === 'queued') {
      if (this.slots.some(({ active }) => active)) return;
      work.status = 'running';
      this.#workEvent(work, 'baseline', 'kun', `冻结 B0 · ${work.baseCommit}`, { model: CODEX_MODEL, replayOf: work.replayOf });
      this.#operate(work, 'prepare', async () => {
        const [integration, ...isolated] = await Promise.all([
          this.#addWorktree(work.id, work.baseCommit),
          ...tasks.map(({ preferredAgent }) => this.#addWorktree(`${work.id}-${preferredAgent}`, work.baseCommit)),
        ]);
        if (this.closed) return;
        Object.assign(work, integration, { integrationCommit: work.baseCommit, readyAt: time() });
        for (const [index, task] of tasks.entries()) Object.assign(task, isolated[index], { readyAt: work.readyAt });
        this.#workEvent(work, 'workflow', 'grid', '八卦同时开工', { readyAt: work.readyAt });
        this.#begin(tasks.map((task) => ({ slot: this.#slot(task.preferredAgent), task, phase: 'initial',
          prompt: parallelPrompt(work, task, 'initial', task.baseCommit, task.worktree) })));
      }, (error) => this.#endWorkflow(work, 'blocked', error.message));
      return;
    }
    if (!work.readyAt) return;

    if (work.forkPlan && work.forks.length === 0) {
      const task = this.#workflowTask(work.id, work.forkRole);
      if (task.firstStartedAt && task.threadId) this.#startForks(work, task);
    }

    const patch = this.#readyPatch(work);
    if (patch && !this.#working(work, 'adopt')) this.#mergeParallel(work, patch);
    if (this.#working(work, 'adopt')) return;

    if (work.repair?.status === 'waiting') {
      const slot = this.#slot(work.repair.owner);
      if (!slot.active) this.#prepareFollowup(work, this.#workflowTask(work.id, work.repair.owner), 'repair');
      return;
    }
    if (work.repair?.status === 'running' || (work.repair && this.#working(work, `collect:${work.repair.owner}`))) return;

    const reviewTask = this.#workflowTask(work.id, 'gen');
    const initialDone = tasks.every(({ initialFinishedAt }) => initialFinishedAt);
    const haveCode = work.candidates.some(({ role, status }) => role === 'zhen' && status === 'adopted');
    const handoffs = activeArtifacts(work).filter(({ kind }) => kind === 'prd' || kind === 'spec');
    const requiresCode = Boolean(work.replayOf && work.forkPlan && work.forkRole === 'zhen');
    const canReview = reviewTask.initialFinishedAt && (haveCode && handoffs.length === 2 || initialDone && !this.#working(work));
    const target = [work.integrationCommit, ...handoffs.map(({ id }) => id).sort()].join(':');
    if (canReview && !this.#slot('gen').active && target !== work.reviewTarget && !this.#working(work, 'review')) {
      if (initialDone && requiresCode && !haveCode && !this.#working(work)) {
        this.#endWorkflow(work, 'blocked', '两路候选完成，暂无通过文件检查并合入的代码');
      } else if (!requiresCode || haveCode) {
        work.reviewTarget = target;
        this.#prepareFollowup(work, reviewTask, 'review', target);
      }
      return;
    }
    if (!initialDone || this.#working(work) || this.slots.some(({ active }) => active?.task.workflowId === work.id)) return;
    if (work.review?.key !== target) return;
    if (work.review.verdict === 'pass') {
      work.stableCommit = work.integrationCommit;
      this.#workEvent(work, 'baseline_advanced', 'kun', `已验收基线 · ${work.stableCommit}`, { commit: work.stableCommit });
      this.#endWorkflow(work, 'completed', work.review.summary);
    } else {
      this.#endWorkflow(work, 'blocked', work.review.summary);
    }
  }

  #publish(work, task, data) {
    const { artifact, created } = this.workFiles.publish(work, task.preferredAgent, data);
    if (created) {
      if (artifact.scopes) work.scope = artifact.scopes;
      work.artifacts.push(artifact);
      this.#workEvent(work, 'handoff', task.preferredAgent, `交接 ${artifact.id} · ${artifact.summary}`, {
        taskId: task.id, artifact, eventId: `${work.id}:${artifact.eventId}`,
      });
    }
    return artifact;
  }

  #readyPatch(work) {
    const ready = work.candidates.filter(({ status }) => status === 'ready');
    const standalone = ready.find(({ role, phase }) => !work.forkPlan || role !== work.forkRole || phase === 'repair');
    if (standalone) return standalone;
    if (work.forks.length !== 2 || this.#working(work, 'forks') || work.forks.some(({ status }) => ['queued', 'running'].includes(status))) return;
    const rank = (patch) => patch.forkId ? patch.usable === true ? 0 : patch.usable === null ? 1 : 3 : 2;
    return ready.sort((a, b) => rank(a) - rank(b) || a.paths.length - b.paths.length || a.order - b.order)[0];
  }

  #mergeParallel(work, patch) {
    const task = this.#workflowTask(work.id, patch.role);
    const current = new Set(activeArtifacts(work).map(({ id }) => id));
    if (patch.inputs.some((id) => !current.has(id))) {
      patch.status = 'stale';
      this.#workEvent(work, 'candidate_rejected', patch.role, '候选依赖了被更新的交接', { taskId: task.id, candidate: patch });
      queueMicrotask(() => this.#dispatch());
      return;
    }
    work.stage = Math.max(work.stage, 2);
    patch.status = 'applying';
    this.#workEvent(work, 'merge_started', 'kun', `收到候选 · ${patch.id}`, {
      taskId: task.id, candidate: patch, expectedParent: work.integrationCommit,
    });
    this.#operate(work, 'adopt', async () => {
      const commit = await adoptPatch(work, patch);
      work.integrationCommit = commit;
      patch.status = 'adopted';
      patch.integratedCommit = commit;
      this.#workEvent(work, 'candidate_adopted', 'kun', `已合入候选 · ${patch.id}`, { taskId: task.id, candidate: patch, commit });
      if (work.forkPlan && patch.role === work.forkRole && patch.phase !== 'repair') {
        work.selectedFork = patch.forkId ?? null;
        for (const other of work.candidates) {
          if (other.role !== patch.role || other.status !== 'ready' || other.phase === 'repair') continue;
          other.status = 'not_selected';
          this.#workEvent(work, 'candidate_not_selected', patch.role, '这一路保留为对照', { taskId: task.id, candidate: other });
        }
      }
    }, (error) => {
      patch.status = 'rejected';
      patch.error = error.message;
      this.#workEvent(work, 'candidate_rejected', 'kun', error.message, { taskId: task.id, candidate: patch });
    });
  }

  async #collect(work, task, { cwd, base, phase, fork, result, inputs = [] }) {
    const role = task.preferredAgent;
    const id = fork?.id ?? `${work.id}-${role}-${phase}`;
    const file = await collectPatch({ cwd, base, role, scopes: work.scope, id, workspace: this.workspace });
    if (!file || this.closed) return;
    const alreadySelected = phase !== 'repair' && work.forkPlan && role === work.forkRole
      && work.candidates.some((entry) => entry.role === role && entry.status === 'adopted');
    const patch = { ...file, id, role, baseCommit: base, phase, inputs, order: work.candidates.length,
      status: alreadySelected ? 'not_selected' : 'ready', ...(fork && { forkId: fork.id, usable: result.usable, evidence: result.evidence.slice(0, 6000) }) };
    work.candidates.push(patch);
    this.#workEvent(work, alreadySelected ? 'candidate_not_selected' : 'candidate_published', role,
      `候选 ${id} · ${file.paths.length} 个文件`, { taskId: task.id, candidate: patch });
    return patch;
  }

  #startForks(work, task) {
    const role = task.preferredAgent;
    const { variants, checks } = work.forkPlan;
    const baseCommit = task.baseCommit;
    const writable = Boolean(roles[role].writes);
    const inputs = []; // The forks start from the prompt and fixed repository baseline.
    const forks = variants.map((hypothesis, index) => ({ id: `${work.id}-${role}-fork-${index + 1}`, role, hypothesis,
      status: 'queued', baseCommit, model: CODEX_MODEL }));
    work.forks.push(...forks);
    this.#workEvent(work, 'fork_group', role, '从同一基线并行试两个候选', { taskId: task.id, checks, forkIds: forks.map(({ id }) => id) });
    this.#operate(work, 'forks', async () => {
      const client = await this.#loadThread(this.#slot(role), task);
      const prepared = await Promise.allSettled(forks.map(({ id }) => this.#addWorktree(id, baseCommit)));
      await Promise.all(forks.map(async (fork, index) => {
        const start = prepared[index];
        try {
          if (start.status === 'rejected') throw start.reason;
          if (this.closed) return;
          Object.assign(fork, start.value);
          const emit = (kind, text, extra) => {
            if (this.closed) return;
            if (kind === 'fork_started') Object.assign(fork, { status: 'running', startedAt: time(), ...extra });
            this.#workEvent(work, kind, role, text, { ...extra, taskId: task.id, forkId: fork.id, model: CODEX_MODEL });
          };
          const result = await runNativeFork(client, { task, fork, writable, userPrompt: work.prompt, checks }, emit);
          if (this.closed) return;
          Object.assign(fork, { result, status: 'completed', finishedAt: time() });
          if (writable) await this.#collect(work, task, { cwd: fork.worktree, base: baseCommit, inputs, phase: 'initial', fork, result });
          this.#workEvent(work, 'fork_finished', role, result.summary, { taskId: task.id, forkId: fork.id, result });
        } catch (error) {
          if (this.closed) return;
          Object.assign(fork, { status: 'failed', finishedAt: time(), error: error.message });
          this.#workEvent(work, 'fork_failed', role, error.message, { taskId: task.id, forkId: fork.id });
        }
      }));
    }, (error) => {
      for (const fork of forks) Object.assign(fork, { status: 'failed', finishedAt: time(), error: error.message });
      this.#workEvent(work, 'fork_failed', role, error.message, { taskId: task.id });
    });
  }

  #prepareFollowup(work, task, phase, key) {
    const slot = this.#slot(task.preferredAgent);
    const base = work.integrationCommit;
    if (phase === 'repair') work.repair.status = 'running';
    else work.stage = 3;
    this.#workEvent(work, phase === 'review' ? 'review_ready' : 'repair_ready', task.preferredAgent,
      phase === 'review' ? `独立复跑 · ${base.slice(0, 12)}` : `按结论返工 · ${base.slice(0, 12)}`, { taskId: task.id, commit: base });
    this.#operate(work, phase, async () => {
      const { worktree } = await this.#addWorktree(`${work.id}-${phase}-${randomUUID().slice(0, 8)}`, base);
      if (!this.closed) this.#begin([{ slot, task, cwd: worktree, base, phase, key,
        prompt: parallelPrompt(work, task, phase, base, worktree) }]);
    }, (error) => this.#endWorkflow(work, 'blocked', error.message));
  }

  #parallelFinished(work, run, status) {
    const { task, phase, cwd, base, key, forkPreparation } = run;
    const role = task.preferredAgent;
    if (phase === 'review') {
      let result;
      try { result = JSON.parse(task.handoff); } catch { result = null; }
      const valid = status === 'completed' && readReview(task.handoff) && result.checkedCommit === base;
      work.review = valid ? { ...result, key } : {
        verdict: 'blocked', summary: task.error ?? '艮没有交回与受检提交匹配的验收证据', checkedCommit: base, evidence: task.handoff ?? '', key,
      };
      this.#publish(work, task, { kind: 'review', text: JSON.stringify(work.review), inputs: run.inputs });
      this.#workEvent(work, 'review_verdict', 'gen', `${work.review.verdict} · ${work.review.summary}`, { taskId: task.id, review: work.review, commit: base });
      if (work.review.verdict === 'changes_requested' && work.repairCount === 0 && roles[work.review.owner] && work.review.owner !== 'gen') {
        work.repairCount++;
        work.repair = { owner: work.review.owner, status: 'waiting' };
        work.reviewTarget = null;
      }
      return;
    }
    if (phase === 'initial') task.initialFinishedAt = time();
    if (phase === 'repair') work.repair.status = 'completed';
    if (status !== 'completed') return;
    const kind = roles[role].kinds[0];
    if (task.handoff?.trim() && (phase === 'repair' || !work.artifacts.some((item) => item.kind === kind))) {
      this.#publish(work, task, { kind, text: task.handoff, inputs: run.inputs });
    }
    if (role === 'qian' && !work.artifacts.some((item) => item.kind === 'structure')) {
      this.#publish(work, task, { kind: 'structure', text: '本轮采用默认写入归属。', scopes: [] });
    }
    if (roles[role].writes && !forkPreparation) this.#operate(work, `collect:${role}`, async () => {
      await this.#collect(work, task, { cwd, base, phase, inputs: run.inputs });
    }, (error) => this.#workEvent(work, 'candidate_rejected', role, error.message, { taskId: task.id }));
  }

  #advanceWorkflow(workflow) {
    if (this.slots.some(({ active }) => active) || [...this.workflowExchanges.values()].includes(workflow.id)) return;
    const tasks = this.tasks.filter((task) => task.workflowId === workflow.id);
    if (workflow.status === 'queued') {
      workflow.status = 'running';
      this.#event('workflow', 'grid', 'grid', '准备协作工作目录', undefined, undefined, { sessionId: workflow.sessionId });
      void this.#addWorktree(workflow.id, workflow.baseCommit).then((directory) => {
        if (this.closed) return;
        Object.assign(workflow, directory);
        for (const task of tasks) Object.assign(task, directory);
        this.#dispatch();
      }).catch((error) => {
        if (!this.closed) this.#endWorkflow(workflow, 'blocked', error.message);
      });
      return;
    }
    if (!workflow.worktree) return;

    const stage = stages[workflow.stage];
    const group = stage.agents.map((id) => this.#workflowTask(workflow.id, id));
    if (group.every(({ status }) => status === 'waiting')) {
      this.#event('workflow', 'grid', 'grid', stage.name, undefined, undefined, { sessionId: workflow.sessionId });
      this.#begin(group.map((task) => ({
        slot: this.#slot(task.preferredAgent), task, prompt: workflowPrompt(workflow, task, tasks),
      })));
      return;
    }
    const failed = group.find(({ status }) => status !== 'completed');
    if (failed) {
      this.#endWorkflow(workflow, 'blocked', `${responsibilities[failed.preferredAgent][0]}未交付。${failed.error ?? failed.activity}`);
      return;
    }
    if (workflow.stage < stages.length - 1) {
      workflow.stage++;
      this.#advanceWorkflow(workflow);
      return;
    }

    const review = readReview(group[0].handoff);
    workflow.review = review;
    if (review?.verdict === 'changes_requested' && workflow.repairCount === 0) {
      workflow.repairCount++;
      workflow.stage = stages.findIndex(({ agents }) => agents.includes('kun'));
      for (const role of ['kun', 'gen']) {
        Object.assign(this.#workflowTask(workflow.id, role), { status: 'waiting', activity: '等待返工与复验' });
      }
      this.#event('workflow', 'gen', 'kun', `需要返工 · ${review.summary}`, undefined, undefined, { sessionId: workflow.sessionId });
      this.#advanceWorkflow(workflow);
      return;
    }
    this.#endWorkflow(workflow, review?.verdict === 'pass' ? 'completed' : 'blocked', review?.summary ?? '艮未给出有效验收结论');
  }

  #endWorkflow(workflow, status, summary) {
    Object.assign(workflow, { status, summary, finishedAt: time() });
    this.#event('workflow', 'grid', 'user', `${status === 'completed' ? '协作已交付' : '协作遇阻'} · ${summary}`, undefined, undefined, { sessionId: workflow.sessionId });
    if (workflow.mode === 'parallel') this.workFiles.save(workflow);
    this.#dispatch();
  }

  #begin(assignments) {
    const runs = assignments.map(({ slot, task, prompt, phase, cwd, base, key }) => {
      const run = this.#reserve(slot, task);
      const work = this.workflows.find(({ id }) => id === task.workflowId);
      Object.assign(run, { phase, cwd, base: base ?? task.baseCommit, key, work,
        forkPreparation: phase === 'initial' && Boolean(work?.forkPlan) && work.forkRole === slot.profile.id,
        inputs: phase && work?.mode === 'parallel' ? activeArtifacts(work).filter(({ kind }) => kind === 'prd' || kind === 'spec').map(({ id }) => id) : [] });
      return { slot, run, prompt };
    });
    for (const { slot, run, prompt } of runs) {
      const text = run.phase ? roles[slot.profile.id].duty : run.task.workflowId ? responsibilities[slot.profile.id][1] : prompt;
      this.#event('dispatch', 'grid', slot.profile.id, text, run.task.id, undefined,
        run.phase && { workPhase: run.phase, commit: run.base, owner: slot.profile.id });
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
    if (task.workflowId) task.result = '';
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
      run.cwd ??= run.task.worktree;
      const outputSchema = run.phase === 'review' ? parallelReviewSchema
        : !run.phase && run.task.workflowId && run.work?.mode !== 'parallel' && slot.profile.id === 'gen' ? reviewSchema : undefined;
      const sandboxPolicy = run.forkPreparation ? { type: 'readOnly' }
        : run.phase === 'repair' && roles[slot.profile.id].writes ? { type: 'workspaceWrite', writableRoots: [run.cwd] } : undefined;
      void client.call('turn/start', { threadId: run.task.threadId, input: textInput(prompt), outputSchema,
        ...(run.phase && { cwd: run.cwd, sandboxPolicy, effort: run.phase === 'initial' && slot.profile.id !== 'zhen' ? 'low' : 'medium' }),
      }).then(({ turn }) => {
        if (slot.active === run && !run.turnId) run.turnId = turn.id;
      }).catch((error) => this.#finish(slot, run, 'failed', error.message));
    }
  }

  async #prepare(slot, run) {
    const { task } = run;
    if (!task.worktree) {
      const directory = await this.#addWorktree(task.id, task.baseCommit);
      Object.assign(task, directory, { activity: '连接 Codex', updatedAt: time() });
      this.#save();
      this.emit('change');
    }
    if (this.closed || slot.active !== run) return;
    return this.#loadThread(slot, task);
  }

  async #addWorktree(id, baseCommit) {
    const root = join(this.directory, 'worktrees');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const worktree = join(root, id);
    const branch = `guagrid/${id}`;
    const add = this.gitQueue.then(() => {
      if (this.closed) throw new Error('卦阵已关闭');
      return exec('git', ['-C', this.workspace, 'worktree', 'add', '-b', branch, worktree, baseCommit]);
    });
    this.gitQueue = add.catch(() => {});
    await add;
    return { worktree, branch };
  }

  #tools(mcp, task) {
    if (!task?.workflowId) return mcp.tools;
    const parallel = this.workflows.some((work) => work.id === task.workflowId && work.mode === 'parallel');
    return [...new Set([...mcp.tools, 'get_task_result', ...(parallel ? ['publish_handoff', 'get_handoff', 'explore_forks'] : [])])];
  }

  #loadThread(slot, task, seed = false) {
    let opening = this.openingThreads.get(task);
    if (!opening) {
      opening = this.#openThread(slot, task, seed).finally(() => this.openingThreads.delete(task));
      this.openingThreads.set(task, opening);
    }
    return opening;
  }

  async #openThread(slot, task, seed) {
    const client = await this.#client(slot);
    if (!task.threadId || !slot.threads.has(task.threadId)) {
      const token = randomBytes(24).toString('hex');
      const { id, mcp } = slot.profile;
      const parallel = this.workflows.some((work) => work.id === task.workflowId && work.mode === 'parallel');
      const readOnly = parallel ? !roles[id].writes : task.workflowId ? !['zhen', 'kun'].includes(id) : task.step1Id && id === 'dui';
      const tools = this.#tools(mcp, task);
      const params = {
        cwd: task.worktree,
        sandbox: readOnly ? 'read-only' : 'workspace-write',
        approvalPolicy: 'never',
        developerInstructions: profileInstructions(slot.profile, task.step1Id, parallel ? 'parallel' : task.workflowId),
        config: {
          mcp_servers: {
            ...mcp.servers,
            guagrid: {
              command: process.execPath,
              args: [mcpEntry],
              env: {
                GUAGRID_MCP_URL: `${this.origin}/internal/mcp`,
                GUAGRID_MCP_TOKEN: token,
                GUAGRID_MCP_TOOLS: tools.join(','),
              },
              tools: Object.fromEntries(tools.map((name) => [name, { approval_mode: 'approve' }])),
              tool_timeout_sec: 150,
              required: true,
            },
          },
        },
      };
      const response = task.threadId
        ? await client.call('thread/resume', { ...params, threadId: task.threadId, excludeTurns: true })
        : await client.call('thread/start', params);
      if (!task.threadId && seed) {
        const brief = `协作目标（用户原话）\n${task.prompt}\n\n你的分工\n${responsibilities[id][1]}`;
        await client.call('thread/inject_items', { threadId: response.thread.id, items: [historyText(brief)] });
      }
      task.threadId = response.thread.id;
      slot.threads.add(task.threadId);
      this.callers.set(token, { slot, task, client, tools });
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
      if (run.phase === 'initial') task.firstStartedAt ??= time();
      this.#event('started', slot.profile.id, 'grid', '已开工', task.id, undefined,
        run.phase && { workPhase: run.phase, readyAt: task.readyAt, model: CODEX_MODEL, commit: run.base });
      if (run.phase === 'initial') this.#dispatch();
    } else if (method === 'item/started' && toolLabels[params.item.type]) {
      task.activity = toolLabels[params.item.type];
      task.updatedAt = time();
      this.emit('change');
    } else if (method === 'item/agentMessage/delta' || (method === 'item/completed' && params.item.type === 'agentMessage')) {
      const itemId = params.itemId ?? params.item.id;
      const content = params.item?.text ?? `${run.output.get(itemId) ?? ''}${params.delta}`;
      run.output.set(itemId, content.slice(-12_000));
      if (method === 'item/completed' && params.item.phase !== 'commentary') run.handoff = content.slice(-12_000);
      task.result = [...run.output.values()].join('\n\n').slice(-12_000);
      task.updatedAt = time();
      if (method === 'item/completed') {
        run.stream = null;
        if (content.trim()) this.#event('assistant', slot.profile.id, 'user', content.slice(0, 12_000), task.id, undefined, { phase: params.item.phase });
      } else {
        run.stream = content.slice(-12_000);
        this.emit('change');
      }
    } else if (method === 'item/completed') {
      const tool = toolTrace(params.item);
      if (tool) this.#event('tool', slot.profile.id, 'grid', tool.label, task.id, undefined, { tool });
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
    if (task.workflowId && (status === 'completed' || run.phase)) task.handoff = run.handoff ?? task.result;
    this.#event(status, slot.profile.id, 'grid', error ?? task.activity, task.id, undefined, run.phase && { workPhase: run.phase });
    if (run.phase && !this.closed) {
      try { this.#parallelFinished(run.work, run, status); }
      catch (error) { this.#endWorkflow(run.work, 'blocked', error.message); }
    }
    this.#dispatch();
  }

  async message(id, text) {
    const slot = this.#slot(id);
    if (!slot) throw new Error('找不到指定的卦');
    if (typeof text !== 'string' || !text.trim() || text.length > 24_000) throw new Error('请输入消息');
    const workflow = this.workflows.find(({ status }) => status === 'running');
    const task = workflow ? this.#workflowTask(workflow.id, slot.profile.id) : slot.lastTask;
    if (workflow && !slot.active) {
      if (!task?.worktree) throw new Error('协作工作目录正在准备');
      const client = await this.#loadThread(slot, task, true);
      await client.call('thread/inject_items', { threadId: task.threadId, items: [historyText(text)] });
      this.#event('message', 'user', slot.profile.id, text, task.id);
      return;
    }
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

  async sessionMessage(sessionId, taskId, text) {
    this.#session(sessionId);
    if (typeof text !== 'string' || !text.trim() || text.length > 24_000) throw new Error('请输入消息');
    const task = this.tasks.find((entry) => entry.id === taskId && entry.sessionId === sessionId);
    if (!task) throw Object.assign(new Error('找不到这个会话中的对话'), { status: 404 });
    const slot = this.#slot(task.agent ?? task.preferredAgent);
    if (!slot) throw new Error('任务正在等待派发');
    if (slot.active?.task === task) {
      const { turnId } = slot.active;
      if (!turnId) throw new Error('会话正在启动，请在开工后发送');
      await slot.client.call('turn/steer', { threadId: task.threadId, expectedTurnId: turnId, input: textInput(text) });
    } else if (this.workflows.some((run) => run.id === task.workflowId && run.status === 'running')) {
      if (!task.worktree) throw new Error('协作工作目录正在准备');
      const client = await this.#loadThread(slot, task, true);
      await client.call('thread/inject_items', { threadId: task.threadId, items: [historyText(text)] });
    } else {
      if (!task.agent) throw new Error('这个卦还没有开工');
      task.pendingMessages ??= [];
      task.pendingMessages.push(text);
      task.activity = '等待继续对话';
    }
    this.#event('message', 'user', slot.profile.id, text, task.id);
    this.#dispatch();
  }

  async sessionInterrupt(sessionId, taskId) {
    this.#session(sessionId);
    const slot = this.slots.find(({ active }) => active?.task.id === taskId && active.task.sessionId === sessionId);
    if (!slot) throw new Error('这个对话当前没有运行中的回合');
    await this.interrupt(slot.profile.id);
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
    if (!session.tools.includes(tool)) throw new Error('该卦未启用此工具');
    const work = this.workflows.find(({ id, mode }) => id === task.workflowId && mode === 'parallel');
    if (tool === 'get_handoff') return args.id ? this.workFiles.read(work, args.id) : { artifacts: activeArtifacts(work) };
    if (tool === 'publish_handoff' || tool === 'explore_forks') {
      if (work?.status !== 'running' || caller.active?.task !== task) throw new Error('当前回合没有发布交接的权限');
      if (tool === 'publish_handoff') return this.#publish(work, task, args);
      const plan = parseForkPlan(args.variants, args.checks);
      if (work.forkPlan) {
        if (work.forkRole !== task.agent || JSON.stringify(plan) !== JSON.stringify(work.forkPlan)) throw new Error('本轮已有一组并行候选');
      } else {
        Object.assign(work, { forkPlan: plan, forkRole: task.agent });
        this.#startForks(work, task);
      }
      return { workId: work.id, forks: work.forks.map(({ id, status }) => ({ id, status })) };
    }
    if (tool === 'tongqi') return this.#sendQi(session, args);
    if (tool === 'get_task_result') {
      const result = this.tasks.find(({ id }) => id === args.taskId);
      if (!result || result.sessionId !== task.sessionId || (task.workflowId && result.workflowId !== task.workflowId)) throw new Error('找不到本次协作中的任务');
      this.#event('query', caller.profile.id, result.agent ?? 'grid', '查询任务成果', result.id);
      return { ...result };
    }
    const target = args.agent ? this.#slot(args.agent) : null;
    if (args.agent && !target) throw new Error('找不到该卦');
    const agents = (target ? [target] : this.slots).map((slot) => {
      const peer = this.#peerTask(task, slot);
      return {
        agent: slot.profile.name,
        id: slot.profile.id,
        responsibility: work ? roles[slot.profile.id].duty : responsibilities[slot.profile.id][1],
        status: peer?.status ?? 'idle',
        activity: peer?.activity ?? '待命',
        task: peer?.prompt.slice(0, 400) ?? null,
        taskId: peer?.id ?? null,
        updatedAt: peer?.updatedAt ?? null,
        branch: peer?.branch ?? null,
        result: peer?.result.slice(-350) || null,
      };
    });
    this.#event('query', caller.profile.id, target?.profile.id ?? 'grid', target ? `查${target.profile.name}的状态` : '查八卦状态', task.id);
    return { agents, ...(work && { work: { id: work.id, baseCommit: work.baseCommit, integrationCommit: work.integrationCommit,
      scope: work.scope, artifacts: activeArtifacts(work), forks: work.forks } }) };
  }

  #peerTask(source, target) {
    if (source.workflowId) return this.#workflowTask(source.workflowId, target.profile.id);
    if (source.step1Id && step1Agents.includes(target.profile.id)) {
      return this.tasks.find((task) => task.step1Id === source.step1Id && task.preferredAgent === target.profile.id);
    }
    return this.tasks.findLast((task) => task.sessionId === source.sessionId && task.agent === target.profile.id);
  }

  #sendQi(sender, { agent, message }) {
    if (sender.slot.active?.task !== sender.task) throw new Error('感方当前没有运行中的任务');
    const target = this.#slot(agent);
    if (!target || target === sender.slot) throw new Error('请选择另一卦作为应方');
    if (typeof message !== 'string' || !message.trim() || message.length > 12_000) {
      throw new Error('请填写 1 到 12000 字的通气消息');
    }

    const receiver = this.#peerTask(sender.task, target);
    if (!receiver || (!receiver.worktree && target.active?.task !== receiver)) throw new Error('应方还没有可通气的会话');

    const id = randomUUID();
    const from = sender.slot.profile;
    const to = target.profile;
    const work = this.workflows.find(({ id, mode }) => id === sender.task.workflowId && mode === 'parallel');
    if (work) {
      this.#event('gan', from.id, to.id, message, sender.task.id, id, { requestId: id });
      void this.#asyncQi({ id, sender, target, receiver, message }).catch((error) => {
        if (!this.closed) this.#event('tongqi_error', to.id, from.id, error.message, receiver.id, id, { requestId: id });
      });
      return { id, queued: true };
    }
    const response = Promise.withResolvers();
    if (sender.task.workflowId) this.workflowExchanges.set(id, sender.task.workflowId);
    this.#event('gan', from.id, to.id, message, sender.task.id, id);
    void this.#reviewQi({ id, sender, target, receiver, message, response }).catch((error) => {
      response.reject(error);
      if (!this.closed) this.#event('tongqi_error', to.id, from.id, error.message, receiver.id, id);
    }).finally(() => {
      if (this.workflowExchanges.delete(id)) this.#dispatch();
    });
    return response.promise;
  }

  async #asyncQi({ id, sender, target, receiver, message }) {
    const client = await this.#loadThread(target, receiver, !receiver.threadId);
    const from = sender.slot.profile;
    const to = target.profile;
    await reviewTongqi(client, { task: receiver, from: from.name, to: to.name, message }, async ({ accepted, reply, preAnalysis }) => {
      if (this.closed) return;
      this.#event('ying', to.id, from.id, `${accepted ? '接受' : '不接受'} · ${reply}`, receiver.id, id, { requestId: id, accepted });
      if (accepted) {
        await client.call('thread/inject_items', { threadId: receiver.threadId, items: tongqiItems(from.name, message, preAnalysis) });
        this.#event('tongqi_applied', to.id, to.id, '已追加原文和预分析', receiver.id, id, { requestId: id });
      }
      if (!sender.client.closed) {
        await sender.client.call('thread/inject_items', { threadId: sender.task.threadId,
          items: [historyText(`${to.name}的应（${accepted ? '接受' : '不接受'}，${id}）\n${reply}`)] }).catch(() => {});
      }
    });
  }

  async #reviewQi({ id, sender, target, receiver, message, response }) {
    const active = target.active;
    if (active?.task === receiver) {
      await withTimeout(active.started.promise, 25_000, '应方尚未开始回合，可稍后重试');
    }
    if (!receiver.threadId && !receiver.workflowId) throw new Error('应方还没有可通气的会话');

    const client = await this.#loadThread(target, receiver, !receiver.threadId);
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

      this.#event('ying', to.id, from.id, `${accepted ? '接受' : '不接受'} · ${reply}`, receiver.id, id, { accepted });
      if (accepted) {
        await client.call('thread/inject_items', { threadId: receiver.threadId, items: tongqiItems(from.name, message, preAnalysis) });
        this.#event('tongqi_applied', to.id, to.id, '已追加原文和预分析', receiver.id, id);
      }
    });
  }

  close() {
    this.closed = true;
    for (const workflow of this.workflows) {
      if (workflow.status === 'running') {
        Object.assign(workflow, { status: 'interrupted', summary: '协作已中断。已有工作可在协作分支继续检查。', finishedAt: time() });
        if (workflow.mode === 'parallel') this.workFiles.save(workflow);
      }
    }
    for (const slot of this.slots) {
      if (slot.active) this.#finish(slot, slot.active, 'interrupted');
      slot.client?.close();
    }
    this.#save();
  }
}

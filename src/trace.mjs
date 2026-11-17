import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const taskIdPattern = /^[\da-f-]{4,40}$/i;
const threadIdPattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const iso = (time, fallback) => Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : fallback;
const byTime = (a, b) => Date.parse(a.at) - Date.parse(b.at);
const datePart = (date) => [date.getFullYear(), date.getMonth() + 1, date.getDate()]
  .map((part, index) => index === 0 ? String(part) : String(part).padStart(2, '0'));

export function sessionTitle(text) {
  const firstLine = text?.split('\n').map((line) => line.trim()).find(Boolean);
  return firstLine ? Array.from(firstLine).slice(0, 50).join('') : '新会话';
}

function lines(text) {
  return text.split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function safeText(text, limit = 12_000) {
  return String(text ?? '')
    .replace(/\bBearer\s+[^\s'"]+/gi, 'Bearer [已隐藏]')
    .replace(/\bsk-[\w-]{16,}/g, '[已隐藏]')
    .replace(/\b(?:OPENAI_API_KEY|GUAGRID_MCP_TOKEN)\s*=\s*[^\s]+/g, '[已隐藏]')
    .slice(0, limit);
}

function itemText(content) {
  return typeof content === 'string' ? content : content?.map?.(({ text }) => text ?? '').join('\n') ?? '';
}

export function toolTrace(item) {
  switch (item?.type?.toLowerCase()) {
    case 'commandexecution': {
      const argv = item.command;
      const command = safeText(Array.isArray(argv) ? (argv[1] === '-lc' ? argv[2] : argv.join(' ')) : argv, 4000);
      return { label: '运行命令', command, output: safeText(item.aggregatedOutput ?? item.aggregated_output ?? item.stdout, 3500),
        exitCode: item.exitCode ?? item.exit_code, status: item.status, cwd: item.cwd };
    }
    case 'filechange':
      return { label: '修改文件', files: Array.isArray(item.changes) ? item.changes.map(({ path }) => path).filter(Boolean) : Object.keys(item.changes ?? {}), status: item.status };
    case 'mcptoolcall':
      return item.server === 'guagrid' ? null : { label: '调用 MCP', command: safeText(item.server + '/' + item.tool, 300), status: item.status };
    case 'websearch':
    case 'extension':
      return { label: item.query ? '搜索' : '调用工具', command: safeText(item.query ?? item.kind, 600) };
    default:
      return null;
  }
}

export class TraceJournal {
  constructor(directory) {
    this.directory = join(directory, 'trace');
    this.restored = new Map();
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  path(id) {
    if (!taskIdPattern.test(id)) throw new Error('会话 ID 无效');
    return join(this.directory, id + '.jsonl');
  }

  append(id, event) {
    appendFileSync(this.path(id), JSON.stringify(event) + '\n', { mode: 0o600 });
  }

  migrate(tasks, workflows, events) {
    const groups = new Map();
    for (const task of tasks) {
      const id = task.workflowId ?? task.step1Id ?? task.id;
      task.sessionId = id;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(task);
    }
    const sessions = [];
    for (const [id, members] of groups) {
      const workflow = workflows.find((run) => run.id === id);
      if (workflow) workflow.sessionId = id;
      const first = members[0];
      const createdAt = workflow?.createdAt ?? first.createdAt;
      const updatedAt = workflow?.finishedAt ?? members.map((task) => task.updatedAt).sort().at(-1) ?? createdAt;
      const session = { id, title: sessionTitle(workflow?.prompt ?? first.prompt), createdAt, updatedAt, restoredThrough: updatedAt, version: 0 };
      const ids = new Set(members.map((task) => task.id));
      const entries = events.filter((event) => ids.has(event.taskId) || (
        workflow && event.kind === 'workflow' && event.at >= workflow.createdAt
          && event.at <= (workflow.finishedAt ?? updatedAt)
      ));
      for (const event of entries) event.sessionId = id;
      session.version = entries.at(-1)?.id ?? 0;
      const prompt = { id: 'prompt-' + id, kind: 'message', from: 'user', to: 'grid', at: createdAt, text: workflow?.prompt ?? first.prompt, sessionId: id };
      writeFileSync(this.path(id), [prompt, ...entries].map((event) => JSON.stringify(event)).join('\n') + '\n', { mode: 0o600 });
      sessions.push(session);
    }
    return sessions;
  }

  async read(session, tasks, agents) {
    const saved = await readFile(this.path(session.id), 'utf8').then(lines, (error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    if (!session.restoredThrough) return { entries: saved, restoredThreads: 0 };
    if (!this.restored.has(session.id)) {
      const prior = tasks.filter((task) => task.createdAt <= session.restoredThrough);
      this.restored.set(session.id, restore(prior, agents, session.restoredThrough));
    }
    const { records, taskIds, restoredThreads, writes } = await this.restored.get(session.id);
    const persistedTongqi = new Set(saved.filter(({ kind }) => kind === 'ying').map(({ tongqiId }) => tongqiId).filter(Boolean));
    const persistedStarts = new Set(saved.filter(({ kind }) => kind === 'started').map(({ taskId }) => taskId));
    const persistedEnds = new Set(saved.filter(({ kind }) => kind === 'completed').map(({ taskId }) => taskId));
    const kept = saved.filter((event) => !(event.kind === 'tool' && !event.tool && taskIds.has(event.taskId)));
    const recovered = records.filter((event) => {
      if (event.tongqiId && persistedTongqi.has(event.tongqiId)) return false;
      if (event.kind === 'gan' && saved.some((prior) => prior.kind === 'gan' && prior.from === event.from && prior.to === event.to
          && prior.text === event.text && Math.abs(byTime(prior, event)) < 2000)) return false;
      if (event.kind === 'started' && persistedStarts.has(event.taskId)) return false;
      if (event.kind === 'completed' && persistedEnds.has(event.taskId)) return false;
      return true;
    });
    for (const event of recovered.filter(({ kind, accepted }) => kind === 'ying' && accepted)) {
      const sent = recovered.find((entry) => entry.kind === 'gan' && entry.tongqiId === event.tongqiId);
      const write = writes.find((entry) => sent && entry.from === sent.from && entry.to === sent.to
        && entry.text === sent.text && Math.abs(byTime(entry, event)) < 30_000);
      if (write) recovered.push({ ...write, id: 'write-' + event.id, kind: 'tongqi_applied', from: event.from, text: '已追加原文和预分析', tongqiId: event.tongqiId });
    }
    return { entries: [...kept, ...recovered].sort(byTime), restoredThreads };
  }
}

async function rollout(task) {
  if (!threadIdPattern.test(task.threadId ?? '')) return null;
  const base = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');
  const dates = new Set();
  for (const stamp of [task.createdAt, task.updatedAt]) {
    const time = Date.parse(stamp);
    if (!Number.isFinite(time)) continue;
    for (const offset of [0, -1, 1]) dates.add(join(...datePart(new Date(time + offset * 86_400_000))));
  }
  for (const date of dates) {
    const dir = join(base, date);
    const names = await readdir(dir).catch(() => []);
    const name = names.find((entry) => entry.endsWith(task.threadId + '.jsonl'));
    if (name) return readFile(join(dir, name), 'utf8').then(lines, () => null);
  }
  return null;
}

async function restore(tasks, agents, through) {
  const agentId = (name) => agents.find((agent) => agent.name === name || agent.id === name)?.id;
  const extracted = await Promise.all(tasks.map(async (task) => {
    const log = await rollout(task);
    const actor = task.agent ?? task.preferredAgent;
    const records = [];
    const writes = [];
    if (!actor) return { records, writes };
    const add = (kind, at, data = {}) => records.push({
      id: 'codex-' + task.id + '-' + records.length, taskId: task.id, at, from: actor, to: 'grid', kind, source: 'codex', ...data,
    });
    if (!log) {
      const text = safeText(task.handoff || task.result);
      if (text) add('assistant', task.updatedAt, { text, phase: 'final_answer', source: 'saved' });
      return { records, writes };
    }
    for (const row of log) {
      if (!row.timestamp || row.timestamp > through) continue;
      const payload = row.payload ?? {};
      if (row.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
        const match = itemText(payload.content).match(/^来自([^\n]+)的通气原文\n([\s\S]+)$/);
        if (match) writes.push({ at: row.timestamp, taskId: task.id, from: agentId(match[1]), to: actor, text: safeText(match[2]), source: 'codex' });
      }
      if (row.type !== 'event_msg') continue;
      if (payload.type === 'task_started') add('started', row.timestamp, { text: '已开工' });
      if (payload.type === 'task_complete') add('completed', row.timestamp, { text: '结束回合' });
      if (payload.type !== 'item_completed') continue;
      const item = payload.item ?? {};
      const at = iso(payload.completed_at_ms, row.timestamp);
      if (item.type === 'AgentMessage') {
        const text = safeText(itemText(item.content));
        if (text.trim()) add('assistant', at, { text, phase: item.phase });
      }
      if (item.type === 'McpToolCall' && item.server === 'guagrid' && item.tool === 'tongqi') {
        const to = agentId(item.arguments?.agent);
        if (!to) continue;
        const reply = item.result?.structuredContent;
        const tongqiId = reply?.id ?? item.id;
        add('gan', iso(payload.started_at_ms, row.timestamp), { to, text: safeText(item.arguments.message), tongqiId });
        if (reply && typeof reply.accepted === 'boolean') {
          add('ying', at, { from: to, to: actor, text: safeText(reply.reply), accepted: reply.accepted, tongqiId });
        } else {
          add('tongqi_error', at, { from: to, to: actor, text: safeText(itemText(item.result?.content)) || '通气遇阻', tongqiId });
        }
      } else {
        const tool = toolTrace(item);
        if (tool) add('tool', at, { text: tool.label, tool });
      }
    }
    return { records, writes, taskId: task.id };
  }));
  const taskIds = new Set(extracted.map(({ taskId }) => taskId).filter(Boolean));
  return { records: extracted.flatMap(({ records }) => records), writes: extracted.flatMap(({ writes }) => writes), taskIds, restoredThreads: taskIds.size };
}

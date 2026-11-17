const el = (id) => document.getElementById(id);
const clock = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const day = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' });
const statusText = {
  idle: '待命', waiting: '待协作', starting: '准备中', running: '执行中', queued: '排队中',
  completed: '已交付', blocked: '遇阻', failed: '失败', interrupted: '已中断',
};
const labels = {
  workflow: '协作', dispatch: '派发', queue: '入队', started: '开工', completed: '交付', failed: '失败',
  interrupted: '中断', tool: '工具', assistant: '回复', message: '消息', query: '查状态',
  gan: '感', ying: '应', tongqi_applied: '回写', tongqi_error: '通气遇阻',
  baseline: '基线', handoff: '交接', fork_group: '并行试验', fork_started: '候选开工', fork_finished: '候选结束', fork_failed: '候选遇阻',
  candidate_published: '提交候选', candidate_adopted: '候选合入', candidate_rejected: '候选遇阻', candidate_not_selected: '保留对照',
  merge_started: '准备合入', review_ready: '准备验收', review_verdict: '验收结论', repair_ready: '返工', baseline_advanced: '基线推进',
  external_check: '本机复跑',
};
const flowKinds = new Set(['gan', 'ying', 'tongqi_applied', 'tongqi_error']);
// 《说卦》的方位，南在上。
const trigramPoints = {
  li: [50, 13], kun: [77, 23], dui: [86, 50], qian: [77, 77],
  kan: [50, 87], gen: [23, 77], zhen: [14, 50], xun: [23, 23],
};
el('flow-outline').setAttribute('points', Object.values(trigramPoints).map((point) => point.join(',')).join(' '));
const params = new URLSearchParams(location.search);
const drafts = new Map();
let state = { agents: [], tasks: [], sessions: [], workflows: [], live: [] };
let sessionId = params.get('session');
let channel = null;
let trace = { sessionId: null, entries: [], version: -1, restoredThreads: 0 };
let fetching;
let renderIds = [];
let listSignature = '';
let channelSignature = '';
let memberSignature = '';
let flowSignature = '';
let targetSignature = '';
let autoFollow = true;
let busy = false;
let chosenRoute;
let activeRoute;
let latestFlowId;
const startAt = Number(params.get('at'));
const replay = {
  active: params.get('view') === 'replay',
  index: Number.isSafeInteger(startAt) && startAt > 0 ? startAt - 1 : 0,
  timer: null,
};

function node(tag, cls, text) {
  const element = document.createElement(tag);
  if (cls) element.className = cls;
  if (text !== undefined) element.textContent = text;
  return element;
}

function svg(tag, attrs, cls) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
  if (cls) element.setAttribute('class', cls);
  return element;
}

function actor(id) {
  if (id === 'grid') return '卦阵';
  if (id === 'user') return '你';
  return state.agents.find((agent) => agent.id === id)?.name ?? id ?? '卦阵';
}

const currentSession = () => state.sessions.find(({ id }) => id === sessionId);
const currentTasks = () => state.tasks.filter((task) => task.sessionId === sessionId);
const currentWorkflow = () => state.workflows.find((workflow) => workflow.sessionId === sessionId);
const role = (task) => task.agent ?? task.preferredAgent;
const labelFor = (entry) => entry.tool?.label ?? labels[entry.kind] ?? entry.kind;
const routeFor = (entry) => entry.from === entry.to ? actor(entry.from) : actor(entry.from) + ' → ' + actor(entry.to);
const followingBottom = () => {
  const scroller = el('chat-scroll');
  return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 85;
};

function updateUrl() {
  const url = new URL(location.href);
  if (sessionId) url.searchParams.set('session', sessionId);
  else url.searchParams.delete('session');
  if (replay.active) url.searchParams.set('view', 'replay');
  else url.searchParams.delete('view');
  if (replay.active && replay.index > 0) url.searchParams.set('at', replay.index + 1);
  else url.searchParams.delete('at');
  history.replaceState(null, '', url);
}

async function request(path, body) {
  const response = await fetch(path, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? '请求失败');
  return value;
}

function resetTimeline() {
  renderIds = [];
  el('timeline').replaceChildren();
  autoFollow = true;
}

function changeSession(id, useReplay = false) {
  if (sessionId === id && trace.sessionId === id && replay.active === useReplay) return;
  drafts.set(sessionId, el('prompt').value);
  pauseReplay();
  sessionId = id;
  channel = null;
  chosenRoute = null;
  el('prompt').value = drafts.get(id) ?? '';
  el('feedback').textContent = '';
  el('shell').classList.remove('show-sidebar');
  trace = { sessionId: id, entries: [], version: -1, restoredThreads: 0 };
  replay.active = useReplay;
  replay.index = 0;
  resetTimeline();
  updateUrl();
  render();
  void loadTrace();
}

async function loadTrace() {
  const session = currentSession();
  if (!session || (trace.sessionId === session.id && trace.version >= session.version) || fetching?.id === session.id) return;
  const ticket = { id: session.id, version: session.version };
  fetching = ticket;
  let loaded = false;
  try {
    const data = await request('/api/sessions/' + ticket.id + '/trace');
    if (sessionId !== ticket.id || fetching !== ticket) return;
    trace = { ...data, sessionId: session.id, version: ticket.version };
    replay.index = Math.max(0, Math.min(replay.index, trace.entries.length - 1));
    loaded = true;
    render();
  } catch (error) {
    if (sessionId === ticket.id) el('feedback').textContent = error.message;
  } finally {
    if (fetching === ticket) {
      fetching = null;
      if (loaded && sessionId === ticket.id && currentSession()?.version > ticket.version) void loadTrace();
    }
  }
}

function renderSessions() {
  const search = el('session-search').value.trim().toLowerCase();
  const sessions = [...state.sessions].filter(({ title }) => title.toLowerCase().includes(search))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const signature = JSON.stringify([sessionId, sessions.map(({ id, status, title, updatedAt }) => [id, status, title, day.format(new Date(updatedAt))])]);
  if (listSignature === signature) return;
  listSignature = signature;
  el('session-list').replaceChildren(...sessions.map((session) => {
    const button = node('button', 'session-row');
    button.type = 'button';
    if (sessionId === session.id) button.setAttribute('aria-current', 'page');
    button.title = session.title + ' · ' + statusText[session.status];
    const dot = node('span', 'status-dot');
    dot.dataset.status = session.status;
    const title = node('span', 'session-name', session.title);
    const date = node('span', 'session-time', day.format(new Date(session.updatedAt)));
    button.append(dot, title, date);
    button.addEventListener('click', () => changeSession(session.id));
    return button;
  }));
}

function taskLabel(task, tasks) {
  const name = role(task) ? actor(role(task)) : '待分派';
  const same = tasks.filter((other) => role(other) === role(task));
  return same.length > 1 ? name + ' ' + (same.indexOf(task) + 1) : name;
}

function changeChannel(id) {
  if (channel === id) return;
  channel = id;
  chosenRoute = null;
  el('feedback').textContent = '';
  resetTimeline();
  render();
}

function renderChannels(tasks) {
  const signature = JSON.stringify([channel, tasks.map((task) => [task.id, role(task)])]);
  if (channelSignature === signature) return;
  channelSignature = signature;
  const strip = el('channel-strip');
  strip.hidden = !tasks.length;
  const entries = [[null, '全部对话'], ...tasks.map((task) => [task.id, taskLabel(task, tasks)])];
  strip.replaceChildren(...entries.map(([id, text]) => {
    const button = node('button', 'channel', text);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(channel === id));
    button.addEventListener('click', () => changeChannel(id));
    return button;
  }));
}

function richText(text) {
  const result = node('div', 'message');
  const blocks = String(text).split(/(\x60{3}[^\n]*\n[\s\S]*?\x60{3})/g);
  for (const part of blocks) {
    if (/^\x60{3}/.test(part)) {
      const pre = node('pre');
      pre.append(node('code', null, part.slice(part.indexOf('\n') + 1, -3).trimEnd()));
      result.append(pre);
      continue;
    }
    for (const token of part.split(/(\x60[^\n\x60]+\x60|\*\*[^\n*]+\*\*)/g)) {
      if (/^\x60.+\x60$/.test(token)) result.append(node('code', null, token.slice(1, -1)));
      else if (token.startsWith('**') && token.endsWith('**')) result.append(node('strong', null, token.slice(2, -2)));
      else result.append(document.createTextNode(token));
    }
  }
  return result;
}

function entryTime(entry) {
  const time = node('time', 'entry-time', clock.format(new Date(entry.at)));
  time.dateTime = entry.at;
  return time;
}

function displayVerdict(entry) {
  if (entry.kind !== 'ying') return null;
  return entry.accepted === true || entry.text.startsWith('接受 ·') ? '接受'
    : entry.accepted === false || entry.text.startsWith('不接受 ·') ? '不接受' : null;
}

function entryNode(entry) {
  if (entry.kind === 'assistant' || entry.kind === 'message') {
    const user = entry.from === 'user';
    const progress = entry.phase === 'commentary';
    const row = node('article', 'trace-entry' + (user ? ' user-bubble' : progress ? ' commentary' : ''));
    const meta = node('div', 'entry-meta');
    const title = user && entry.to !== 'grid' ? routeFor(entry) : actor(entry.from);
    meta.append(node('strong', null, title));
    if (progress) meta.append(node('span', null, '进度'));
    meta.append(entryTime(entry));
    row.append(meta, richText(entry.text));
    return row;
  }
  const ledger = entry.artifact ?? entry.candidate ?? entry.review ?? entry.result ?? (entry.forkId && !entry.tool ? { fork: entry.forkId, model: entry.model } : null);
  if (entry.tool || flowKinds.has(entry.kind) || entry.kind === 'dispatch' || ledger) {
    const row = node('article', 'trace-entry trace-row');
    const communication = flowKinds.has(entry.kind);
    const details = node('details', communication ? 'communications' : '');
    const summary = node('summary');
    const verdict = displayVerdict(entry);
    const text = verdict ? entry.text.replace(/^(不接受|接受) · /, '') : entry.text;
    if (verdict) details.dataset.verdict = verdict === '接受' ? 'accept' : 'decline';
    const prefix = (communication ? routeFor(entry) : actor(entry.from)) + ' · ' + labelFor(entry) + (entry.forkId ? ' ' + entry.forkId.slice(-1) : '');
    const brief = entry.tool?.command || entry.tool?.files?.join('、') || text;
    summary.append(node('span', 'meta-prefix', prefix),
      node('span', 'summary-text', (verdict ? verdict + ' · ' : '') + brief),
      entryTime(entry));
    const body = node('div', 'body');
    if (entry.tool) {
      const tool = entry.tool;
      if (tool.cwd || tool.exitCode !== undefined) body.append(node('p', 'muted', [tool.cwd, tool.exitCode != null ? '退出码 ' + tool.exitCode : null].filter(Boolean).join(' · ')));
      if (tool.command) body.append(node('pre', 'tool-output', tool.command));
      if (tool.files?.length) body.append(node('pre', 'tool-output', tool.files.join('\n')));
      if (tool.output) body.append(node('pre', 'tool-output', tool.output));
    } else {
      body.append(richText(text));
      if (ledger) body.append(node('pre', 'tool-output', JSON.stringify(ledger, null, 2)));
      if (entry.artifact) {
        const open = node('button', 'branch', '查看交接正文');
        open.type = 'button';
        open.addEventListener('click', async () => {
          try {
            const artifact = await request(`/api/sessions/${entry.sessionId}/artifact?id=${encodeURIComponent(entry.artifact.id)}`);
            open.replaceWith(richText(artifact.text));
          } catch (error) { fail(error); }
        });
        body.append(open);
      }
    }
    if (communication) details.addEventListener('toggle', () => {
      if (details.open) { chosenRoute = entry; renderInspector(currentTasks(), currentWorkflow()); }
    });
    details.append(summary, body);
    row.append(details);
    return row;
  }
  const row = node('div', 'trace-entry milestone');
  row.dataset.kind = entry.kind;
  const text = ['started', 'completed', 'failed', 'interrupted', 'query'].includes(entry.kind)
    ? actor(entry.from) + ' · ' + entry.text : entry.text;
  row.append(node('span', null, text), entryTime(entry));
  return row;
}

function replayEntries() {
  return replay.active ? trace.entries.slice(0, replay.index + 1) : trace.entries;
}

function visibleEntries(tasks) {
  const selected = tasks.find(({ id }) => id === channel);
  const entries = replayEntries();
  if (!selected) return entries;
  const name = role(selected);
  const unique = tasks.filter((task) => role(task) === name).length === 1;
  return entries.filter((entry) => entry.taskId === selected.id
    || (entry.kind === 'message' && entry.from === 'user' && !entry.taskId)
    || (unique && flowKinds.has(entry.kind) && [entry.from, entry.to].includes(name)));
}

function renderTimeline(tasks) {
  const scroller = el('chat-scroll');
  const stick = autoFollow || followingBottom();
  const list = visibleEntries(tasks);
  const timeline = el('timeline');
  let prefix = 0;
  while (prefix < renderIds.length && prefix < list.length && renderIds[prefix] === list[prefix].id) prefix++;
  while (timeline.children.length > prefix) timeline.lastElementChild.remove();
  const newRows = document.createDocumentFragment();
  for (const entry of list.slice(prefix)) newRows.append(entryNode(entry));
  timeline.append(newRows);
  renderIds = list.map(({ id }) => id);
  const activeEvent = replay.active && trace.entries[replay.index];
  const highlighted = timeline.querySelector('.replay-current');
  highlighted?.classList.remove('replay-current');
  if (activeEvent && activeEvent.id === list.at(-1)?.id) timeline.lastElementChild?.classList.add('replay-current');

  const ids = new Set(tasks.map(({ id }) => id));
  const streaming = replay.active ? [] : state.live.filter((message) => ids.has(message.taskId) && (!channel || channel === message.taskId));
  el('streaming').replaceChildren(...streaming.map((message) => {
    const row = node('article', 'trace-entry commentary');
    const meta = node('div', 'entry-meta');
    meta.append(node('strong', null, actor(message.from)), node('span', null, '正在回复'));
    row.append(meta, richText(message.text));
    return row;
  }));
  const empty = !list.length && !streaming.length;
  el('empty-chat').hidden = !empty;
  el('empty-title').textContent = tasks.length ? '等待对话' : '开始一个新会话';
  el('empty-description').textContent = tasks.length ? '这个对话的回复会出现在这里。' : '说说你想完成的任务。';
  if (stick || replay.active) {
    requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });
    autoFollow = false;
  }
}

const phases = [
  { agents: ['zhen', 'dui'], name: '试跑与需求' },
  { agents: ['qian', 'xun', 'kan', 'li'], name: '方案与验证准备' },
  { agents: ['kun'], name: '实现与集成' },
  { agents: ['gen'], name: '独立验收' },
];

function checkpoints() {
  const entries = trace.entries;
  const marks = currentWorkflow()?.mode === 'parallel' ? [
    ['baseline', '冻结基线'], ['fork_started', '候选并行'], ['candidate_adopted', '首次合入'], ['review_ready', '独立复跑'], ['external_check', '本机补证'],
  ].flatMap(([kind, name]) => {
    const index = kind === 'fork_started' ? entries.findLastIndex((event) => event.kind === kind) : entries.findIndex((event) => event.kind === kind);
    return index === -1 ? [] : [{ name, index }];
  }) : phases.flatMap(({ agents, name }) => {
    const index = entries.findIndex((event) => event.kind === 'started' && agents.includes(event.from));
    return index < 0 ? [] : [{ name, index }];
  });
  const talking = entries.findIndex(({ kind }) => kind === 'gan');
  if (talking >= 0) marks.push({ name: '首次通气', index: talking });
  const end = entries.findLastIndex((event) => event.kind === 'workflow' && event.to === 'user');
  if (end >= 0) marks.push({ name: '验收结论', index: end });
  return marks.sort((a, b) => a.index - b.index);
}

function drawFlowEdge(event, active) {
  const [fromX, fromY] = trigramPoints[event.from];
  const [toX, toY] = trigramPoints[event.to];
  const dx = toX - fromX;
  const dy = toY - fromY;
  const distance = Math.hypot(dx, dy);
  const ux = dx / distance;
  const uy = dy / distance;
  const padding = 1 + Math.min(9.5 / Math.abs(ux), 8.5 / Math.abs(uy));
  const start = [fromX + ux * padding, fromY + uy * padding];
  const end = [toX - ux * padding, toY - uy * padding];
  // Opposite directions bend away from one another.
  const bend = Math.min(11, distance * .25);
  const control = [(fromX + toX) / 2 - uy * bend, (fromY + toY) / 2 + ux * bend];
  const angle = Math.atan2(end[1] - control[1], end[0] - control[0]);
  const arrow = [end, ...[.46, -.46].map((spread) => [
    end[0] - 2.6 * Math.cos(angle + spread), end[1] - 2.6 * Math.sin(angle + spread),
  ])];
  const group = svg('g', { 'data-kind': event.kind }, active ? 'flow-edge flow-edge-current' : 'flow-edge');
  if (displayVerdict(event) === '不接受') group.dataset.declined = '';
  group.append(svg('path', { d: `M ${start} Q ${control} ${end}`, pathLength: 1 }),
    svg('polygon', { points: arrow.map((point) => point.join(',')).join(' ') }));
  if (active) {
    const x = (start[0] + 2 * control[0] + end[0]) / 4;
    const y = (start[1] + 2 * control[1] + end[1]) / 4 - 1.5;
    const label = svg('text', { x, y });
    label.textContent = event.kind === 'tongqi_error' ? '遇阻' : labelFor(event);
    group.append(label);
  }
  return group;
}

function renderFlow(partial) {
  const flow = partial.filter(({ kind }) => flowKinds.has(kind));
  const latest = flow.at(-1);
  if (latest?.id !== latestFlowId) chosenRoute = null;
  latestFlowId = latest?.id;
  const route = flow.find(({ id }) => id === chosenRoute?.id) ?? latest;
  activeRoute = route;
  const links = new Map();
  for (const event of [route, ...flow.slice().reverse()]) {
    if (!event || event.from === event.to || !Object.hasOwn(trigramPoints, event.from) || !Object.hasOwn(trigramPoints, event.to)) continue;
    const pair = event.from + ':' + event.to;
    if (!links.has(pair)) links.set(pair, event);
    if (links.size === 4) break;
  }
  const signature = JSON.stringify([sessionId, route?.id, ...[...links.values()].map(({ id }) => id)]);
  if (flowSignature !== signature) {
    flowSignature = signature;
    el('flow-edges').replaceChildren(...[...links.values()].reverse().map((event) => drawFlowEdge(event, event === route)));
    const board = el('flow-board');
    const card = el('route-open');
    const verdict = route && displayVerdict(route);
    for (const element of [board, card]) {
      element.dataset.kind = route?.kind ?? '';
      element.toggleAttribute('data-declined', verdict === '不接受');
    }
    card.hidden = !route;
    el('route-empty').hidden = Boolean(route);
    if (route) {
      const tag = [labelFor(route), verdict].filter(Boolean).join(' · ');
      const actors = routeFor(route);
      el('route-label').textContent = tag;
      el('route-actors').textContent = actors;
      el('route-time').dateTime = route.at;
      el('route-time').textContent = clock.format(new Date(route.at));
      el('route-text').textContent = route.text.replace(/^(不接受|接受) · /, '');
      card.setAttribute('aria-label', `${actors} ${tag}，查看原文`);
    }
  }
  for (const button of el('members').children) {
    const id = button.dataset.agent;
    button.toggleAttribute('data-link', id === route?.from || id === route?.to);
  }
}

function revealRoute() {
  const route = activeRoute;
  if (!route) return;
  if (replay.timer) {
    pauseReplay();
    renderReplay();
  }
  if (!renderIds.includes(route.id)) changeChannel(null);
  const row = el('timeline').children[renderIds.indexOf(route.id)];
  const details = row?.querySelector('details');
  if (!details) return;
  details.open = true;
  if (media.matches) inspector(false);
  details.querySelector('summary').focus({ preventScroll: true });
  requestAnimationFrame(() => row.scrollIntoView({ block: 'start' }));
}

function renderInspector(tasks, workflow) {
  const partial = replayEntries();
  const phase = phases.findLast(({ agents }) => partial.some((entry) => entry.kind === 'started' && agents.includes(entry.from)));
  const replayedStatuses = new Map();
  if (replay.active) {
    for (const entry of partial) {
      if (entry.kind === 'started') replayedStatuses.set(entry.from, 'running');
      if (['completed', 'failed', 'interrupted'].includes(entry.kind)) replayedStatuses.set(entry.from, entry.kind);
    }
  }
  const relevant = state.agents.map((agent) => {
    const matching = tasks.filter((entry) => role(entry) === agent.id);
    const task = matching.find(({ id }) => id === channel)
      ?? matching.findLast(({ status }) => ['running', 'starting'].includes(status)) ?? matching.at(-1);
    const status = replay.active ? replayedStatuses.get(agent.id) ?? (task ? 'waiting' : 'idle')
      : task?.pendingMessages?.length ? 'queued' : task?.status ?? 'idle';
    return { agent, task, status };
  });
  const signature = JSON.stringify([channel, relevant.map(({ agent, task, status }) => [agent.id, task?.id, status, agent.responsibility])]);
  if (memberSignature !== signature) {
    memberSignature = signature;
    el('members').replaceChildren(...relevant.map(({ agent, task, status }) => {
      const button = node('button', 'member');
      button.type = 'button';
      button.disabled = !task;
      button.dataset.agent = agent.id;
      button.dataset.status = status;
      const [x, y] = trigramPoints[agent.id];
      button.style.left = `${x}%`;
      button.style.top = `${y}%`;
      button.title = agent.responsibility ?? agent.specialty;
      button.setAttribute('aria-pressed', String(Boolean(task && channel === task.id)));
      const head = node('span', 'member-head');
      const glyph = node('span', 'member-glyph', agent.glyph);
      glyph.setAttribute('aria-hidden', 'true');
      head.append(glyph, node('strong', null, agent.name));
      button.append(head, node('small', 'member-specialty', agent.specialty), node('span', 'member-state', statusText[status]));
      button.addEventListener('click', () => task && changeChannel(task.id));
      return button;
    }));
  }
  el('run-section').hidden = !workflow;
  if (workflow) {
    const parallel = workflow.mode === 'parallel';
    const replayedStage = parallel ? partial.some(({ kind }) => kind === 'review_ready') ? '独立复跑'
      : partial.some(({ kind }) => kind === 'candidate_adopted') ? '逐项合入'
        : partial.some(({ kind }) => kind === 'started') ? '八卦并行' : '等待开工' : phase?.name ?? '等待开工';
    el('stage').textContent = replay.active ? replayedStage : workflow.stageName;
    const workMeta = el('work-meta');
    const baseline = replay.active ? partial.find(({ kind }) => kind === 'baseline')?.baseCommit : workflow.baseCommit;
    const integrated = replay.active ? partial.findLast(({ kind }) => kind === 'candidate_adopted')?.commit : workflow.integrationCommit;
    workMeta.hidden = !parallel || !baseline;
    workMeta.textContent = [baseline && 'B0 ' + baseline.slice(0, 12), integrated && integrated !== baseline && '集成 ' + integrated.slice(0, 12)].filter(Boolean).join(' · ');
    const forkList = el('work-forks');
    const forkEvents = partial.filter(({ kind }) => kind === 'fork_started');
    forkList.hidden = !parallel || !forkEvents.length;
    const forkSummary = JSON.stringify(forkEvents.map(({ forkId }) => [forkId,
      partial.findLast((event) => event.forkId === forkId && ['fork_finished', 'fork_failed'].includes(event.kind))?.kind]));
    if (forkList.dataset.summary !== forkSummary) {
      forkList.dataset.summary = forkSummary;
      forkList.replaceChildren(...JSON.parse(forkSummary).map(([forkId, result], index) => {
        const button = node('button', null, `候选 ${index + 1} · ${result === 'fork_finished' ? '已收录' : result === 'fork_failed' ? '遇阻' : '执行中'}`);
        button.addEventListener('click', () => {
          const at = trace.entries.findLastIndex((event) => event.forkId === forkId && event.kind === (result ?? 'fork_started'));
          if (at >= 0) { channel = null; setReplay(true, at); }
        });
        return button;
      }));
    }
    const branch = el('branch');
    branch.hidden = !workflow.branch;
    branch.textContent = workflow.branch ?? '';
    branch.dataset.path = workflow.worktree ?? '';
    const conclusion = replay.active ? partial.findLast((entry) => entry.kind === 'workflow' && entry.to === 'user')?.text : workflow.summary;
    el('verdict').hidden = !conclusion;
    el('verdict').textContent = conclusion ?? '';
  }

  renderFlow(partial);
  el('trace-section').hidden = !trace.entries.length;
  const recovered = trace.restoredThreads ? ' · 恢复 ' + trace.restoredThreads + ' 个 Codex 会话' : '';
  el('trace-meta').textContent = trace.entries.length + ' 条事件' + recovered;
  if (el('checkpoints').dataset.version !== sessionId + ':' + trace.version) {
    el('checkpoints').dataset.version = sessionId + ':' + trace.version;
    el('checkpoints').replaceChildren(...checkpoints().map(({ name, index }) => {
      const button = node('button', null, clock.format(new Date(trace.entries[index].at)) + '  ' + name);
      button.type = 'button';
      button.addEventListener('click', () => {
        channel = null;
        setReplay(true, index);
        el('inspector-scroll').scrollTop = 0;
        el('flow-board').focus({ preventScroll: true });
      });
      return button;
    }));
  }
}

function renderComposer(tasks, workflow) {
  el('composer').hidden = replay.active;
  const started = tasks.length > 0;
  const select = el('target');
  const choices = started
    ? tasks.filter((task) => task.agent || (workflow?.status === 'running' && task.worktree))
      .map((task) => [task.id, '继续 · ' + taskLabel(task, tasks)])
    : [['full', '八卦协作'], ['step1', 'Step 1 · 震与兑'], ['auto', '自动分派'], ['lines', '每行一项'], ...state.agents.map((agent) => [agent.id, agent.name + ' · ' + agent.specialty])];
  const signature = JSON.stringify([sessionId, choices]);
  if (signature !== targetSignature) {
    targetSignature = signature;
    const previous = select.value;
    select.replaceChildren(...choices.map(([id, label]) => new Option(label, id)));
    if (choices.some(([id]) => id === previous)) select.value = previous;
    else if (started) {
      const preferred = tasks.find((task) => role(task) === 'kun' && task.agent) ?? tasks.find((task) => task.status === 'running');
      if (choices.some(([id]) => id === preferred?.id)) select.value = preferred.id;
    }
  }
  if (started && channel && choices.some(([id]) => id === channel)) select.value = channel;
  select.setAttribute('aria-label', started ? '对话对象' : '分派方式');
  el('prompt').placeholder = started ? '继续对话…' : '输入任务…';
  el('send').disabled = busy || !choices.length;
  el('stop-task').hidden = !tasks.some(({ id, status }) => id === select.value && status === 'running');
  el('model').textContent = state.model ?? '';
}

function renderReplay() {
  const button = el('toggle-replay');
  button.hidden = !trace.entries.length;
  button.setAttribute('aria-pressed', String(replay.active));
  el('replay-bar').hidden = !replay.active;
  if (!replay.active) return;
  const entries = trace.entries;
  const event = entries[replay.index];
  const range = el('replay-position');
  range.max = Math.max(entries.length - 1, 0);
  range.value = replay.index;
  range.setAttribute('aria-valuetext', String(event ? replay.index + 1 : 0) + ' / ' + entries.length);
  el('replay-time').textContent = event ? clock.format(new Date(event.at)) : '等待记录';
  el('replay-count').textContent = (event ? replay.index + 1 : 0) + ' / ' + entries.length;
  el('replay-now').textContent = event ? labelFor(event) + ' · ' + (flowKinds.has(event.kind) ? routeFor(event) : actor(event.from)) : '';
  el('replay-prev').disabled = replay.index <= 0;
  el('replay-next').disabled = replay.index >= entries.length - 1;
  el('replay-play').disabled = !entries.length;
  el('replay-play').textContent = replay.timer ? '暂停' : '播放';
}

function render() {
  const tasks = currentTasks();
  const workflow = currentWorkflow();
  const session = currentSession();
  el('session-title').textContent = session?.title ?? '新会话';
  el('session-meta').textContent = session
    ? [replay.active ? '回放' : statusText[session.status], workflow?.branch].filter(Boolean).join(' · ') : '';
  renderSessions();
  renderChannels(tasks);
  renderTimeline(tasks);
  renderInspector(tasks, workflow);
  renderComposer(tasks, workflow);
  renderReplay();
}

function pauseReplay() {
  if (replay.timer) clearTimeout(replay.timer);
  replay.timer = null;
}

function setReplay(active, index = 0) {
  pauseReplay();
  chosenRoute = null;
  replay.active = active;
  replay.index = index;
  el('feedback').textContent = '';
  updateUrl();
  autoFollow = true;
  render();
}

function advanceReplay() {
  const entries = trace.entries;
  if (replay.index >= entries.length - 1) {
    pauseReplay();
    renderReplay();
    return;
  }
  const delta = Date.parse(entries[replay.index + 1].at) - Date.parse(entries[replay.index].at);
  const speed = Number(el('replay-speed').value);
  const minimum = flowKinds.has(entries[replay.index].kind) ? 1120 : 95;
  const interval = Math.max(minimum, Math.min(1250, delta / 120));
  replay.timer = setTimeout(() => {
    replay.index++;
    chosenRoute = null;
    autoFollow = true;
    render();
    advanceReplay();
  }, interval / speed);
  renderReplay();
}

function jumpReplay(index, syncAddress = true) {
  pauseReplay();
  chosenRoute = null;
  replay.index = Math.max(0, Math.min(index, trace.entries.length - 1));
  if (syncAddress) updateUrl();
  autoFollow = true;
  render();
}

async function createSession() {
  const session = await request('/api/sessions', {});
  if (!state.sessions.some(({ id }) => id === session.id)) state.sessions.push(session);
  changeSession(session.id);
  return session.id;
}

function fail(error) {
  el('feedback').textContent = error.message;
}

function inspector(open) {
  el('shell').classList.toggle('hide-inspector', !open);
  el('toggle-inspector').setAttribute('aria-expanded', String(open));
}

const media = matchMedia('(max-width: 1100px)');
inspector(!media.matches || (replay.active && replay.index > 0));
media.addEventListener('change', (event) => inspector(!event.matches));
el('toggle-inspector').addEventListener('click', () => inspector(el('shell').classList.contains('hide-inspector')));
el('close-inspector').addEventListener('click', () => inspector(false));
el('route-open').addEventListener('click', revealRoute);
el('toggle-sidebar').addEventListener('click', () => el('shell').classList.toggle('show-sidebar'));
el('session-search').addEventListener('input', renderSessions);
el('new-session').addEventListener('click', () => void createSession().then(() => el('prompt').focus()).catch(fail));
el('toggle-replay').addEventListener('click', () => setReplay(!replay.active));
el('replay-prev').addEventListener('click', () => jumpReplay(replay.index - 1));
el('replay-next').addEventListener('click', () => jumpReplay(replay.index + 1));
el('replay-position').addEventListener('input', (event) => jumpReplay(Number(event.currentTarget.value), false));
el('replay-position').addEventListener('change', updateUrl);
el('replay-play').addEventListener('click', () => {
  if (replay.timer) { pauseReplay(); renderReplay(); return; }
  if (replay.index >= trace.entries.length - 1) jumpReplay(0);
  advanceReplay();
});
el('branch').addEventListener('click', () => {
  const path = el('branch').dataset.path;
  if (path) void navigator.clipboard.writeText(path).then(() => { el('branch').title = '工作目录已复制'; }).catch(fail);
});
el('target').addEventListener('change', () => {
  const target = el('target').value;
  if (channel && target !== channel) changeChannel(target);
  else renderComposer(currentTasks(), currentWorkflow());
});
el('prompt').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    el('composer').requestSubmit();
  }
});
el('stop-task').addEventListener('click', () => {
  if (sessionId) void request('/api/sessions/' + sessionId + '/interrupt', { taskId: el('target').value }).catch(fail);
});
el('composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = el('prompt');
  const prompt = input.value;
  if (!prompt.trim() || busy) return;
  const target = el('target').value || 'full';
  const started = currentTasks().length > 0;
  busy = true;
  el('feedback').textContent = '';
  renderComposer(currentTasks(), currentWorkflow());
  try {
    const id = sessionId ?? await createSession();
    if (started) {
      await request('/api/sessions/' + id + '/message', { taskId: target, message: prompt });
    } else {
      let body;
      if (['full', 'step1'].includes(target)) body = { workflow: target, prompt, sessionId: id };
      else if (target === 'lines') body = { tasks: prompt.split('\n').filter((line) => line.trim()).map((line) => ({ prompt: line })), sessionId: id };
      else body = { tasks: [{ prompt, ...(target === 'auto' ? {} : { agent: target }) }], sessionId: id };
      await request('/api/tasks', body);
    }
    drafts.delete(id);
    if (sessionId === id) {
      if (input.value === prompt) input.value = '';
      autoFollow = true;
    }
  } catch (error) {
    fail(error);
  } finally {
    busy = false;
    renderComposer(currentTasks(), currentWorkflow());
  }
});

const stream = new EventSource('/api/events');
stream.onmessage = ({ data }) => {
  state = JSON.parse(data);
  el('online-dot').classList.add('live');
  el('connection').textContent = '本机已连接';
  el('workspace').textContent = state.workspace?.split('/').at(-1) ?? '';
  el('workspace').title = state.workspace ?? '';
  if (!currentSession()) {
    const latest = [...state.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (latest) changeSession(latest.id, replay.active);
  }
  render();
  void loadTrace();
};
stream.onerror = () => {
  el('online-dot').classList.remove('live');
  el('connection').textContent = '正在重新连接';
};
render();

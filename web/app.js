const element = (id) => document.getElementById(id);
const map = element('map');
const canvas = element('flow-canvas');
const context = canvas.getContext('2d');
const nodes = new Map();
const formatter = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const statuses = { idle: '待命', waiting: '待协作', starting: '准备中', running: '执行中', queued: '待派发',
  completed: '已交付', failed: '失败', blocked: '遇阻', interrupted: '已中断' };
const events = {
  queue: '入队', workflow: '协作', dispatch: '派活', started: '开工', tool: '工具', query: '状态查询',
  gan: '感', ying: '应', tongqi_applied: '回写', tongqi_error: '通气遇阻',
  completed: '交付', failed: '失败', interrupted: '中断', message: '消息',
};
const colors = {
  query: '#edc88a', gan: '#edc88a', ying: '#95e4be', tongqi_applied: '#9bcafd',
  failed: '#ff9a7d', interrupted: '#ff9a7d', tongqi_error: '#ff9a7d', dispatch: '#9bcafd', message: '#9bcafd',
};

let state = { agents: [], tasks: [], workflows: [], events: [] };
let selected = 'qian';
let selectedEvent;
let lastEventId = 0;
let pulses = [];
let animation;

function name(id) {
  if (id === 'grid') return '太极';
  if (id === 'user') return '你';
  return state.agents.find((agent) => agent.id === id)?.name ?? id;
}

function route(event) {
  if (event.from === event.to) return name(event.from);
  return `${name(event.from)} → ${name(event.to)}`;
}

function mountAgents() {
  for (const agent of state.agents) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'node';
    button.dataset.agent = agent.id;
    const glyph = document.createElement('span');
    glyph.className = 'glyph';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = agent.glyph;
    const labels = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = agent.name;
    const status = document.createElement('small');
    labels.append(title, status);
    button.append(glyph, labels);
    button.addEventListener('click', () => {
      selected = agent.id;
      element('agent-feedback').textContent = '';
      renderAgents();
    });
    element('nodes').append(button);
    nodes.set(agent.id, { button, status });
    element('target').add(new Option(`${agent.name} · ${agent.specialty}`, agent.id));
  }
}

function renderAgents() {
  for (const agent of state.agents) {
    const node = nodes.get(agent.id);
    node.button.dataset.status = agent.status;
    node.button.setAttribute('aria-pressed', String(agent.id === selected));
    node.status.textContent = statuses[agent.status];
  }
  const agent = state.agents.find((value) => value.id === selected);
  if (!agent) return;
  const task = state.tasks.find(({ id }) => id === agent.taskId);
  element('agent-name').textContent = agent.name;
  element('agent-glyph').textContent = agent.glyph;
  element('agent-role').textContent = agent.specialty;
  element('agent-state').textContent = statuses[agent.status];
  element('agent-activity').textContent = task?.activity ?? agent.image;
  const duty = element('agent-duty');
  duty.hidden = !task?.workflowId;
  duty.textContent = agent.responsibility ?? '';
  element('task-title').textContent = task?.prompt ?? '等待派活';
  const worktree = element('worktree');
  worktree.hidden = !task?.worktree;
  worktree.textContent = task?.branch ?? '';
  worktree.title = task?.worktree ?? '';
  const result = element('result');
  const output = task?.error || task?.result || '';
  result.hidden = !output;
  if (result.textContent !== output) result.textContent = output;
  element('message').placeholder = `跟${agent.name}说话`;
  element('stop').hidden = agent.status !== 'running';
}

function showEvent(event, animate) {
  selectedEvent = event;
  element('route').textContent = `${route(event)} · ${events[event.kind]}`;
  if (animate && !reducedMotion.matches) {
    pulses.push({ event, time: performance.now() });
    pulses = pulses.slice(-12);
  }
  scheduleDraw();
}

function renderEvents() {
  element('event-count').textContent = state.events.length ? `${state.events.length} 条事件` : '';
  element('empty-flow').hidden = state.events.length > 0;
  element('flow-list').replaceChildren(...state.events.slice().reverse().map((event) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(selectedEvent?.id === event.id));
    const date = document.createElement('time');
    date.dateTime = event.at;
    date.textContent = formatter.format(new Date(event.at));
    const direction = document.createElement('span');
    direction.className = 'flow-route';
    direction.textContent = route(event);
    const kind = document.createElement('span');
    kind.className = 'flow-kind';
    kind.textContent = events[event.kind];
    const text = document.createElement('span');
    text.className = 'flow-text';
    text.textContent = event.text;
    text.title = event.text;
    button.append(date, direction, kind, text);
    button.addEventListener('click', () => {
      showEvent(event, true);
      for (const entry of element('flow-list').querySelectorAll('button[aria-pressed="true"]')) entry.setAttribute('aria-pressed', 'false');
      button.setAttribute('aria-pressed', 'true');
    });
    item.append(button);
    return item;
  }));
}

function paint(now) {
  animation = undefined;
  const bounds = map.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const ratio = window.devicePixelRatio || 1;
  const width = Math.round(bounds.width * ratio);
  const height = Math.round(bounds.height * ratio);
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, bounds.width, bounds.height);
  const centerOf = (node) => {
    const rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width / 2 - bounds.left, y: rect.top + rect.height / 2 - bounds.top };
  };
  const hub = centerOf(element('hub'));
  const points = new Map([...nodes].map(([id, node]) => [id, centerOf(node.button)]));
  const point = (id) => points.get(id) ?? hub;

  function line(from, to, color, width) {
    context.strokeStyle = color;
    context.lineWidth = width;
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
  }

  context.setLineDash([4, 5]);
  for (const pos of points.values()) line(hub, pos, '#799d8b60', 1);
  context.setLineDash([]);
  if (selectedEvent) line(point(selectedEvent.from), point(selectedEvent.to), colors[selectedEvent.kind] ?? '#82dfba', 1.8);
  pulses = pulses.filter((pulse) => now - pulse.time < 1250);
  for (const { event, time } of pulses) {
    const progress = Math.max(0, (now - time) / 1250);
    const from = point(event.from);
    const to = point(event.to);
    context.fillStyle = colors[event.kind] ?? '#82dfba';
    context.beginPath();
    context.arc(from.x + progress * (to.x - from.x), from.y + progress * (to.y - from.y), 4, 0, Math.PI * 2);
    context.fill();
  }
  if (pulses.length) scheduleDraw();
}

function scheduleDraw() {
  if (animation === undefined) animation = requestAnimationFrame(paint);
}

function renderWorkflow() {
  const workflows = state.workflows ?? [];
  const run = workflows.find(({ status }) => status === 'running') ?? workflows.at(-1);
  element('workflow').hidden = !run;
  if (!run) return;
  element('workflow-status').textContent = statuses[run.status];
  element('workflow-goal').textContent = run.prompt;
  element('workflow-stage').textContent = `${run.stage + 1}/${run.stageCount} · ${run.stageName}${run.repairCount ? ' · 复验轮次' : ''}`;
  element('workflow-branch').textContent = run.branch ?? '';
  element('workflow-branch').title = run.worktree ?? '';
  const summary = element('workflow-summary');
  summary.hidden = !run.summary;
  summary.textContent = run.summary ?? '';
  const implementation = state.tasks.find((task) => task.workflowId === run.id && task.agent === 'kun');
  const sections = [
    implementation?.handoff && `坤 · 实现交付\n${implementation.handoff}`,
    run.review?.evidence && `艮 · 验收证据\n${run.review.evidence}`,
  ].filter(Boolean);
  const evidence = element('workflow-evidence');
  evidence.hidden = !sections.length;
  const text = sections.join('\n\n');
  if (evidence.textContent !== text) evidence.textContent = text;
}

new ResizeObserver(scheduleDraw).observe(map);
const stream = new EventSource('/api/events');
stream.onmessage = ({ data }) => {
  state = JSON.parse(data);
  const connection = element('connection');
  connection.classList.add('live');
  connection.textContent = '本机已连接';
  element('workspace').textContent = state.workspace;
  element('workspace').title = state.workspace;
  element('running').textContent = state.agents.filter(({ status }) => status === 'running').length;
  element('starting').textContent = state.agents.filter(({ status }) => status === 'starting').length;
  const waiting = new Set((state.workflows ?? []).filter(({ status }) => status === 'running' || status === 'queued').map(({ id }) => id));
  element('queued').textContent = state.tasks.filter(({ status, workflowId }) => status === 'queued' || (status === 'waiting' && waiting.has(workflowId))).length;
  element('completed').textContent = state.tasks.filter(({ status }) => status === 'completed').length;
  if (!nodes.size) mountAgents();
  renderAgents();
  renderWorkflow();
  const newest = state.events.at(-1);
  if (newest && newest.id !== lastEventId) {
    const incoming = state.events.filter(({ id }) => id > lastEventId).slice(-8);
    for (const event of incoming) showEvent(event, lastEventId !== 0 || incoming.length === 1);
    lastEventId = newest.id;
    renderEvents();
  }
};
stream.onerror = () => {
  const connection = element('connection');
  connection.classList.remove('live');
  connection.textContent = '正在重新连接';
};

async function post(path, body, feedback, button) {
  feedback.textContent = '';
  button.disabled = true;
  try {
    const response = await fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? '请求失败');
    return data;
  } catch (error) {
    feedback.textContent = error.message;
    return null;
  } finally {
    button.disabled = false;
  }
}

function updateDispatchMode() {
  const target = element('target').value;
  const mode = target === 'full' ? ['输入要八卦协作完成的任务', '开始八卦协作']
    : target === 'step1' ? ['输入要交给震与兑的任务', '派给震与兑'] : null;
  element('split-option').hidden = Boolean(mode);
  element('task-input').placeholder = mode?.[0] ?? '输入任务，每行派发一项';
  element('dispatch-submit').textContent = mode?.[1] ?? '派发任务';
}

element('target').addEventListener('change', updateDispatchMode);
updateDispatchMode();
element('dispatch').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = element('task-input');
  const agent = element('target').value || null;
  let body;
  if (agent === 'step1' || agent === 'full') {
    body = { workflow: agent, prompt: input.value };
  } else {
    const prompts = element('split-lines').checked ? input.value.split('\n') : [input.value];
    const tasks = prompts.map((prompt) => prompt.trim()).filter(Boolean).map((prompt) => ({ prompt, agent }));
    body = { tasks };
  }
  if (await post('/api/tasks', body, element('dispatch-feedback'), event.submitter)) input.value = '';
});

element('followup').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = element('message');
  const message = input.value;
  if (await post(`/api/agents/${selected}/message`, { message }, element('agent-feedback'), event.submitter)) input.value = '';
});

element('stop').addEventListener('click', (event) => {
  void post(`/api/agents/${selected}/interrupt`, {}, element('agent-feedback'), event.currentTarget);
});

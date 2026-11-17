import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function startTestGrid(t) {
  const root = await mkdtemp(join(tmpdir(), 'guagrid-test-'));
  const workspace = join(root, 'workspace');
  const fake = join(root, 'codex.mjs');
  await mkdir(workspace);
  await copyFile(new URL('./fixtures/codex.mjs', import.meta.url), fake);
  await chmod(fake, 0o755);
  await exec('git', ['init', '-q', workspace]);
  await writeFile(join(workspace, 'README.md'), '# fixture\n');
  await exec('git', ['-C', workspace, 'add', 'README.md']);
  await exec('git', ['-C', workspace, '-c', 'user.name=GuaGrid Test', '-c', 'user.email=guagrid@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);

  const service = spawn(process.execPath, ['src/server.mjs', '--workspace', workspace, '--state-dir', join(root, 'state'), '--port', '0', '--codex', fake], { stdio: ['ignore', 'pipe', 'pipe'] });
  const ended = once(service, 'exit');
  t.after(async () => {
    service.kill('SIGTERM');
    await ended;
    await rm(root, { recursive: true, force: true });
  });
  const lines = createInterface({ input: service.stdout });
  const [line] = await once(lines, 'line');
  const origin = new URL(line.split(' ').at(-1));
  async function request(path, body, expectedStatus) {
    const response = await fetch(new URL(path, origin), body ? {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    } : undefined);
    if (expectedStatus) assert.equal(response.status, expectedStatus, await response.clone().text());
    else assert.equal(response.ok, true, await response.clone().text());
    return response.json();
  }
  return request;
}

test('eight profiles run together, query a peer, and dispatch the next pending task', { timeout: 25_000 }, async (t) => {
  const request = await startTestGrid(t);

  const initial = await request('/api/state');
  assert.equal(initial.agents.length, 8);
  await request('/api/tasks', { tasks: Array.from({ length: 9 }, (_, index) => ({ prompt: `task ${index + 1}` })) });
  let snapshot;
  let sawAllAssigned = false;
  let sawQueued = false;
  for (let tries = 0; tries < 150; tries++) {
    snapshot = await request('/api/state');
    sawAllAssigned ||= snapshot.agents.every(({ status }) => status === 'starting' || status === 'running');
    sawQueued ||= snapshot.tasks.some(({ status }) => status === 'queued');
    if (snapshot.tasks.every(({ status }) => status === 'completed')) break;
    await wait(40);
  }
  assert.ok(sawAllAssigned && sawQueued);
  assert.equal(snapshot.tasks.filter(({ status }) => status === 'completed').length, 9, JSON.stringify(snapshot.tasks));
  assert.equal(new Set(snapshot.tasks.map(({ worktree }) => worktree)).size, 9);
  assert.equal(snapshot.events.filter(({ kind }) => kind === 'query').length, 9);
  const results = snapshot.tasks.map(({ result }) => JSON.parse(result));
  assert.equal(new Set(results.map(({ role }) => role)).size, 8);
  assert.ok(results.every(({ peer }) => peer === 'kun'));
  assert.ok(results.every(({ branch }) => branch.startsWith('guagrid/')));
});

test('one Step 1 goal starts both roles and tongqi only writes back accepted messages', { timeout: 25_000 }, async (t) => {
  const request = await startTestGrid(t);
  const prompt = 'fixture:step1\n保留用户原话的换行与空格。  ';
  const { ids } = await request('/api/tasks', { workflow: 'step1', prompt });
  assert.equal(ids.length, 2);

  let snapshot;
  for (let tries = 0; tries < 200; tries++) {
    snapshot = await request('/api/state');
    if (snapshot.tasks.every(({ status }) => ['completed', 'failed'].includes(status))) break;
    await wait(35);
  }
  assert.equal(snapshot.tasks.filter(({ status }) => status === 'completed').length, 2, JSON.stringify(snapshot.tasks));
  assert.deepEqual(snapshot.tasks.map(({ agent }) => agent), ['zhen', 'dui']);
  assert.ok(snapshot.tasks.every((task) => task.prompt === prompt && task.step1Id === snapshot.tasks[0].step1Id));
  assert.notEqual(snapshot.tasks[0].worktree, snapshot.tasks[1].worktree);
  const events = snapshot.events;
  const starts = events.filter(({ kind }) => kind === 'started');
  assert.equal(starts.length, 2);
  assert.ok(starts.every(({ id }) => id < events.find(({ kind }) => kind === 'completed').id));

  const [accepted, rejected] = events.filter(({ kind }) => kind === 'gan');
  const exchange = (sent) => events.filter(({ tongqiId }) => tongqiId === sent.tongqiId).map(({ kind }) => kind);
  assert.deepEqual(exchange(accepted), ['gan', 'ying', 'tongqi_applied']);
  assert.deepEqual(exchange(rejected), ['gan', 'ying']);
  assert.equal(accepted.from, 'dui');
  assert.equal(accepted.to, 'zhen');
  assert.deepEqual(JSON.parse(snapshot.tasks[1].result), [true, false]);

  const proof = JSON.parse(snapshot.tasks[0].result);
  assert.deepEqual(proof.forks, [prompt, prompt]);
  assert.equal(proof.cleaned, 2);
  assert.equal(proof.injections.length, 1);
  assert.deepEqual(proof.injections[0], [`来自兑的通气原文\n${accepted.text}`, '应方预分析结果\n按补充条件复跑。']);
});

test('parallel work owns paths, overlaps two forks, and advances the reviewed commit', { timeout: 25_000 }, async (t) => {
  const request = await startTestGrid(t);
  const prompt = 'fixture:full\n交付并验收同一件成果。';
  const { ids, workflowId, sessionId } = await request('/api/tasks', { workflow: 'full', prompt });
  assert.equal(ids.length, 8);
  let state;
  let workflow;
  for (let tries = 0; tries < 240; tries++) {
    state = await request('/api/state');
    workflow = state.workflows.find(({ id }) => id === workflowId);
    if (['completed', 'blocked'].includes(workflow.status)) break;
    await wait(35);
  }
  assert.equal(workflow.status, 'completed', JSON.stringify(workflow));
  assert.equal(workflow.repairCount, 1);
  assert.equal(workflow.review.verdict, 'pass');
  assert.ok(state.tasks.every(({ status }) => status === 'completed'));
  assert.equal(new Set(state.tasks.map(({ worktree }) => worktree)).size, 8);
  assert.equal(await readFile(join(workflow.worktree, 'collaboration.txt'), 'utf8'), 'fork A\nverified\n');
  assert.equal(await readFile(join(workflow.worktree, 'README.md'), 'utf8'), '# fixture\n');
  assert.equal(workflow.stableCommit, workflow.review.checkedCommit);
  assert.equal(workflow.forks.length, 2);
  assert.notEqual(workflow.forks[0].worktree, workflow.forks[1].worktree);
  assert.ok(workflow.forks.every((fork) => fork.baseCommit === workflow.baseCommit && fork.model === 'gpt-6-luna'));
  const { entries } = await request(`/api/sessions/${sessionId}/trace`);
  const initial = entries.filter(({ kind, workPhase }) => kind === 'started' && workPhase === 'initial');
  assert.equal(initial.length, 8);
  assert.ok(initial.at(-1).id < entries.find(({ kind }) => kind === 'completed').id);
  const forkStarts = entries.filter(({ kind }) => kind === 'fork_started');
  assert.equal(forkStarts.length, 2);
  assert.ok(forkStarts.at(-1).id < entries.find(({ kind }) => kind === 'fork_finished').id);
  assert.ok(entries.some(({ kind, text }) => kind === 'candidate_rejected' && text.includes('README.md')));
  assert.equal(entries.filter(({ artifact }) => artifact?.id === 'prd:v1').length, 1);
  assert.ok(entries.every(({ workId, seq, id }) => workId === workflowId && seq === id));
  assert.deepEqual(entries.filter(({ kind }) => kind === 'review_verdict').map(({ review }) => review.verdict), ['changes_requested', 'pass']);
  assert.ok(entries.some(({ kind }) => kind === 'tongqi_applied'));
  assert.equal((await request(`/api/sessions/${sessionId}/artifact?id=prd%3Av1`)).text.trim(), '可以复跑候选。');
  const manifest = JSON.parse(await readFile(join(workflow.worktree, '..', '..', 'work', workflow.id, 'manifest.json'), 'utf8'));
  assert.equal(manifest.stableCommit, workflow.stableCommit);

  const rerun = await request(`/api/sessions/${sessionId}/rerun`, { variants: ['候选 A', '候选 B'], checks: '启动与复跑' });
  let rerunState;
  for (let tries = 0; tries < 240; tries++) {
    rerunState = (await request('/api/state')).workflows.find(({ id }) => id === rerun.workflowId);
    if (['completed', 'blocked'].includes(rerunState.status)) break;
    await wait(35);
  }
  assert.equal(rerunState.prompt, prompt);
  assert.equal(rerunState.baseCommit, workflow.baseCommit);
  assert.equal(rerunState.replayOf, workflowId);
  assert.notEqual(rerun.sessionId, sessionId);
  assert.equal(rerunState.status, 'completed', JSON.stringify(rerunState));
  assert.ok(rerunState.candidates.every(({ id }) => !id.endsWith('-zhen-initial')));
});

test('sessions retain distinct traces and resume the chosen Codex conversation', { timeout: 25_000 }, async (t) => {
  const request = await startTestGrid(t);
  const first = await request('/api/sessions', {});
  const second = await request('/api/sessions', {});
  assert.notEqual(first.id, second.id);
  assert.deepEqual((await request('/api/sessions/' + first.id + '/trace')).entries, []);
  const [a] = (await request('/api/tasks', { sessionId: first.id, tasks: [{ agent: 'qian', prompt: '会话 A' }] })).ids;
  const [b] = (await request('/api/tasks', { sessionId: second.id, tasks: [{ agent: 'qian', prompt: '会话 B' }] })).ids;
  await request('/api/sessions/' + second.id + '/message', { taskId: a, message: '不应串线' }, 404);

  async function when(done) {
    for (let tries = 0; tries < 160; tries++) {
      const state = await request('/api/state');
      if (done(state)) return state;
      await wait(40);
    }
    assert.fail('Expected session did not complete');
  }

  const initial = await when(({ tasks }) => tasks.every(({ status }) => status === 'completed'));
  const thread = initial.tasks.find(({ id }) => id === a).threadId;
  await request('/api/sessions/' + first.id + '/message', { taskId: a, message: '只续聊 A' });
  const after = await when(({ tasks }) => tasks.some((task) => task.id === a && task.status === 'completed' && task.result.includes('只续聊 A')));
  assert.equal(after.tasks.find(({ id }) => id === a).threadId, thread);
  assert.equal(JSON.parse(after.tasks.find(({ id }) => id === b).result).prompt, '会话 B');
  assert.deepEqual(after.sessions.map(({ title }) => title), ['会话 A', '会话 B']);

  const traceA = (await request('/api/sessions/' + first.id + '/trace')).entries;
  const traceB = (await request('/api/sessions/' + second.id + '/trace')).entries;
  assert.deepEqual(traceA.filter(({ kind }) => kind === 'message').map(({ text }) => text), ['会话 A', '只续聊 A']);
  assert.deepEqual(traceB.filter(({ kind }) => kind === 'message').map(({ text }) => text), ['会话 B']);
  assert.ok(traceA.every(({ sessionId }) => sessionId === first.id));
  assert.ok(traceB.every(({ sessionId }) => sessionId === second.id));
});

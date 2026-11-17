import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  async function request(path, body) {
    const response = await fetch(new URL(path, origin), body ? {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    } : undefined);
    assert.equal(response.ok, true, await response.clone().text());
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

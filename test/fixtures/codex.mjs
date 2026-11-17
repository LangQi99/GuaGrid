#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as wait } from 'node:timers/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const threads = new Map();
let next = 0;
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => write({ id, result });
const event = (method, params) => write({ method, params });
const nextId = (kind) => `${kind}-${process.pid}-${++next}`;

function finish(threadId, turnId, text) {
  event('item/completed', { threadId, turnId, item: { id: 'message', type: 'agentMessage', phase: 'final_answer', text } });
  event('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
}

async function callTool(settings, name, args) {
  const server = settings.config.mcp_servers.guagrid;
  return new Promise((resolve, reject) => {
    const child = execFile(server.command, server.args, { env: { ...process.env, ...server.env } }, (error, stdout) => {
      if (error) return reject(error);
      const response = stdout.trim().split('\n').map((raw) => JSON.parse(raw)).find((msg) => msg.id === 3);
      if (response.result?.isError) return reject(new Error(response.result.content[0].text));
      resolve(response.result);
    });
    const messages = [
      { id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
      { id: 2, method: 'tools/list' },
      { id: 3, method: 'tools/call', params: { name, arguments: args } },
    ];
    child.stdin.end(messages.map((message) => JSON.stringify({ jsonrpc: '2.0', ...message })).join('\n') + '\n');
  });
}

async function sendTongqi(settings, threadId, turnId, agent, message) {
  const result = await callTool(settings, 'tongqi', { agent, message });
  event('item/completed', {
    threadId, turnId, item: { id: nextId('tool'), type: 'mcpToolCall', server: 'guagrid', tool: 'tongqi', status: 'completed', result },
  });
  return result.structuredContent.accepted;
}

const variants = ['候选 A', '候选 B'];
const checks = '启动与复跑';

async function collaborate(settings, role, threadId, turnId, params) {
  const artifact = join(params.cwd, 'collaboration.txt');
  assert.equal(settings.sandbox, ['震', '坎', '离'].includes(role) ? 'workspace-write' : 'read-only');
  assert.match(settings.developerInstructions, /同组职责/);
  if (params.outputSchema?.properties.checkedCommit) {
    const contents = await readFile(artifact, 'utf8');
    const checkedCommit = (await exec('git', ['-C', params.cwd, 'rev-parse', 'HEAD'])).stdout.trim();
    assert.match(contents, /^fork A/);
    if (settings.prompt.includes('fixture:full environment')) {
      const observed = settings.prompt.includes('同一提交的本机补充检查') && settings.prompt.includes('已在本机启动');
      return finish(threadId, turnId, JSON.stringify({ verdict: observed ? 'pass' : 'blocked',
        summary: observed ? '复验通过。' : '当前环境不能监听。', evidence: '核对了交付版本和环境。', checkedCommit, owner: null }));
    }
    const repair = !contents.includes('verified');
    return finish(threadId, turnId, JSON.stringify({ verdict: repair ? 'changes_requested' : 'pass',
      summary: repair ? '需要补验证标记。' : '协作产物通过验收。', evidence: '已检查候选和实际 Git 提交。', checkedCommit, owner: repair ? 'zhen' : null }));
  }
  if (role === '震') {
    if (settings.prompt.includes('只修这条返工问题')) {
      const before = await readFile(artifact, 'utf8');
      await writeFile(artifact, before + 'verified\n');
      return finish(threadId, turnId, '震的返工');
    }
    const launch = await callTool(settings, 'explore_forks', { variants, checks });
    assert.equal(JSON.parse(launch.content[0].text).forks.length, 2);
    if (settings.prompt.includes('主会话本回合只读')) assert.equal(params.sandboxPolicy?.type, 'readOnly');
    else await writeFile(join(params.cwd, 'README.md'), '非震的路径\n');
  }
  if (role === '兑') {
    const delivery = { kind: 'prd', text: '可以复跑候选。', eventId: 'fixture-prd' };
    const first = await callTool(settings, 'publish_handoff', delivery);
    assert.deepEqual(await callTool(settings, 'publish_handoff', delivery), first);
    await assert.rejects(callTool(settings, 'publish_handoff', { ...delivery, text: '重复编号不同内容' }), /相同 eventId/);
    await assert.rejects(callTool(settings, 'publish_handoff', { kind: 'spec', text: '越权' }), /对应卦/);
    const reply = await callTool(settings, 'tongqi', { agent: '坎', message: '请核对空输入。' });
    assert.ok(reply.structuredContent.queued);
  }
  if (role === '乾') await callTool(settings, 'publish_handoff', { kind: 'structure', text: '测试范围', scopes: [{ prefix: 'collaboration.txt', owner: 'zhen' }] });
  if (role === '离') await callTool(settings, 'publish_handoff', { kind: 'docs', text: '运行说明' });
  await wait(role === '巽' ? 550 : 120);
  finish(threadId, turnId, `${role}的交付`);
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') reply(id, {});
  if (method === 'thread/start' || method === 'thread/resume') {
    assert.equal(params.model, 'gpt-6-luna');
    const threadId = params.threadId ?? nextId('thread');
    threads.set(threadId, { ...params, proof: { forks: [], injections: [], cleaned: 0 } });
    reply(id, { thread: { id: threadId } });
  }
  if (method === 'thread/fork') {
    assert.equal(params.model, 'gpt-6-luna');
    const main = threads.get(params.threadId);
    assert.equal(params.ephemeral, true);
    const experiment = params.developerInstructions.includes('临时探索 fork');
    assert.equal(params.sandbox, experiment ? 'workspace-write' : 'read-only');
    if (experiment) assert.notEqual(params.cwd, main.cwd);
    else assert.equal(params.cwd, main.cwd);
    assert.ok(main.prompt);
    main.proof.forks.push(main.prompt);
    const forkId = nextId('fork');
    threads.set(forkId, { forkOf: main, experiment, cwd: params.cwd });
    reply(id, { thread: { id: forkId, ephemeral: true, path: null } });
  }
  if (method === 'thread/inject_items') {
    const main = threads.get(params.threadId);
    assert.ok(!main.forkOf);
    const parts = params.items.map(({ content }) => content[0].text);
    if (parts[0].startsWith('协作目标（用户原话）')) {
      main.brief = parts[0];
      main.prompt = parts[0];
    } else {
      assert.ok(main.prompt);
      main.proof.injections.push(parts);
    }
    reply(id, {});
  }
  if (method === 'thread/unsubscribe') {
    const { forkOf } = threads.get(params.threadId);
    forkOf.proof.cleaned++;
    threads.delete(params.threadId);
    reply(id, { status: 'unsubscribed' });
  }
  if (method !== 'turn/start') return;
  assert.equal(params.model, 'gpt-6-luna');
  const { threadId, input } = params;
  const turnId = nextId('turn');
  reply(id, { turn: { id: turnId } });
  event('turn/started', { threadId, turn: { id: turnId } });

  const settings = threads.get(threadId);
  if (settings.experiment) {
    const a = input[0].text.includes('只试这个方案\n候选 A');
    await writeFile(join(settings.cwd, 'collaboration.txt'), a ? 'fork A\n' : 'fork B\n');
    await wait(280);
    return finish(threadId, turnId, JSON.stringify({ usable: a, summary: a ? 'A 通过' : 'B 路线失败', evidence: '共同的启动检查已运行。' }));
  }
  if (settings.forkOf) {
    const { from, message } = JSON.parse(input[0].text);
    assert.ok(['兑', '艮'].includes(from));
    const accepted = message.startsWith('请核对');
    const verdict = { accepted, reply: accepted ? '收到。' : '与本轮无关。', preAnalysis: accepted ? '按补充条件复跑。' : '' };
    return finish(threadId, turnId, JSON.stringify(verdict));
  }

  const role = settings.developerInstructions.match(/你是卦阵的(.)卦/)?.[1];
  settings.prompt = input[0].text;
  if (settings.prompt.startsWith('fixture:step1')) {
    assert.equal(settings.sandbox, role === '兑' ? 'read-only' : 'workspace-write');
    if (role === '震') {
      while (settings.proof.cleaned < 2) await wait(25);
      return finish(threadId, turnId, JSON.stringify(settings.proof));
    }
    assert.ok(settings.developerInstructions.includes('交付到需求说明为止'));
    const decisions = [];
    for (const message of ['请核对空输入。\n保留这行原文。  ', '与试跑无关的建议。']) {
      decisions.push(await sendTongqi(settings, threadId, turnId, '震', message));
    }
    return finish(threadId, turnId, JSON.stringify(decisions));
  }
  if (settings.prompt.includes('fixture:full')) return collaborate(settings, role, threadId, turnId, params);

  const toolResult = await callTool(settings, 'get_grid_status', { agent: 'kun' });
  const { stdout } = await exec('git', ['-C', settings.cwd, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const result = JSON.parse(toolResult.content[0].text);
  await wait(550);
  finish(threadId, turnId, JSON.stringify({ role, prompt: settings.prompt, branch: stdout.trim(), peer: result.agents[0].id }));
});

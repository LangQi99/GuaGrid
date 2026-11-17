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

async function collaborate(settings, role, threadId, turnId, schema) {
  const artifact = join(settings.cwd, 'collaboration.txt');
  assert.equal(settings.sandbox, ['震', '坤'].includes(role) ? 'workspace-write' : 'read-only');
  assert.match(settings.developerInstructions, /同组职责/);
  if (role === '震') await writeFile(artifact, 'prototype\n');
  if (role === '兑') {
    const response = await callTool(settings, 'get_grid_status', { agent: '坎' });
    const [peer] = JSON.parse(response.content[0].text).agents;
    assert.equal(peer.status, 'waiting');
    assert.match(peer.responsibility, /回归/);
    assert.equal(await sendTongqi(settings, threadId, turnId, '坎', '请核对空输入。'), true);
    assert.equal(await sendTongqi(settings, threadId, turnId, '离', '与本任务无关的建议。'), false);
  }
  if (role === '坎' || role === '离') {
    assert.match(settings.brief, /协作目标（用户原话）\nfixture:full/);
    assert.equal(settings.proof.cleaned, 1);
    assert.equal(settings.proof.injections.length, role === '坎' ? 1 : 0);
  }
  if (role === '坤') {
    assert.match(settings.prompt, /【坎 · .*】\n坎的交付/);
    const before = await readFile(artifact, 'utf8');
    if (before.includes('implementation')) assert.match(settings.prompt, /艮的返工意见/);
    else assert.equal(before, 'prototype\n');
    await writeFile(artifact, before + (before.includes('implementation') ? 'verified\n' : 'implementation\n'));
  }
  if (role === '艮') {
    assert.ok(schema.properties.verdict);
    const contents = await readFile(artifact, 'utf8');
    if (!contents.includes('verified')) {
      assert.equal(await sendTongqi(settings, threadId, turnId, '巽', '请核对接入点。'), true);
      const response = await callTool(settings, 'get_grid_status', { agent: '巽' });
      const [peer] = JSON.parse(response.content[0].text).agents;
      const delivery = await callTool(settings, 'get_task_result', { taskId: peer.taskId });
      assert.equal(JSON.parse(delivery.content[0].text).handoff, '巽的交付');
      return finish(threadId, turnId, JSON.stringify({ verdict: 'changes_requested', summary: '需要补验证标记。', evidence: '交付文件缺最后一行。' }));
    }
    return finish(threadId, turnId, JSON.stringify({ verdict: 'pass', summary: '协作产物通过验收。', evidence: '已检查试跑、实现和验证记录。' }));
  }
  finish(threadId, turnId, `${role}的交付`);
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') reply(id, {});
  if (method === 'thread/start' || method === 'thread/resume') {
    const threadId = params.threadId ?? nextId('thread');
    threads.set(threadId, { ...params, proof: { forks: [], injections: [], cleaned: 0 } });
    reply(id, { thread: { id: threadId } });
  }
  if (method === 'thread/fork') {
    const main = threads.get(params.threadId);
    assert.equal(params.ephemeral, true);
    assert.equal(params.sandbox, 'read-only');
    assert.equal(params.cwd, main.cwd);
    assert.ok(main.prompt);
    main.proof.forks.push(main.prompt);
    const forkId = nextId('fork');
    threads.set(forkId, { forkOf: main });
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
  const { threadId, input } = params;
  const turnId = nextId('turn');
  reply(id, { turn: { id: turnId } });
  event('turn/started', { threadId, turn: { id: turnId } });

  const settings = threads.get(threadId);
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
  if (settings.prompt.includes('fixture:full')) return collaborate(settings, role, threadId, turnId, params.outputSchema);

  const toolResult = await callTool(settings, 'get_grid_status', { agent: 'kun' });
  const { stdout } = await exec('git', ['-C', settings.cwd, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const result = JSON.parse(toolResult.content[0].text);
  await wait(550);
  finish(threadId, turnId, JSON.stringify({ role, prompt: settings.prompt, branch: stdout.trim(), peer: result.agents[0].id }));
});

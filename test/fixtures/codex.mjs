#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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
    assert.ok(main.prompt && !main.forkOf);
    main.proof.injections.push(params.items.map(({ content }) => content[0].text));
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
    assert.equal(from, '兑');
    const accepted = message.startsWith('请核对');
    const verdict = { accepted, reply: accepted ? '收到。' : '与本轮无关。', preAnalysis: accepted ? '按补充条件复跑。' : '' };
    return finish(threadId, turnId, JSON.stringify(verdict));
  }

  const role = settings.developerInstructions.match(/你是卦阵的(.)卦/)?.[1];
  settings.prompt = input[0].text;
  if (settings.prompt.startsWith('fixture:step1')) {
    if (role === '震') {
      while (settings.proof.cleaned < 2) await wait(25);
      return finish(threadId, turnId, JSON.stringify(settings.proof));
    }
    const decisions = [];
    for (const message of ['请核对空输入。\n保留这行原文。  ', '与试跑无关的建议。']) {
      const result = await callTool(settings, 'tongqi', { agent: '震', message });
      event('item/completed', {
        threadId, turnId, item: { id: nextId('tool'), type: 'mcpToolCall', server: 'guagrid', tool: 'tongqi', status: 'completed', result },
      });
      decisions.push(result.structuredContent.accepted);
    }
    return finish(threadId, turnId, JSON.stringify(decisions));
  }

  const toolResult = await callTool(settings, 'get_grid_status', { agent: 'kun' });
  const { stdout } = await exec('git', ['-C', settings.cwd, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const result = JSON.parse(toolResult.content[0].text);
  await wait(550);
  finish(threadId, turnId, JSON.stringify({ role, prompt: settings.prompt, branch: stdout.trim(), peer: result.agents[0].id }));
});

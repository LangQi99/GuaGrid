#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const threads = new Map();
let next = 0;
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => write({ id, result });
const event = (method, params) => write({ method, params });

createInterface({ input: process.stdin }).on('line', async (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') reply(id, {});
  if (method === 'thread/start' || method === 'thread/resume') {
    const threadId = params.threadId ?? `thread-${process.pid}-${++next}`;
    threads.set(threadId, params);
    reply(id, { thread: { id: threadId } });
  }
  if (method !== 'turn/start') return;
  const { threadId, input } = params;
  const turnId = `turn-${process.pid}-${++next}`;
  reply(id, { turn: { id: turnId } });
  event('turn/started', { threadId, turn: { id: turnId } });

  const settings = threads.get(threadId);
  const server = settings.config.mcp_servers.guagrid;
  const last = await new Promise((resolve, reject) => {
    const child = execFile(server.command, server.args, { env: { ...process.env, ...server.env } }, (error, stdout) => {
      if (error) return reject(error);
      resolve(stdout.trim().split('\n').map((raw) => JSON.parse(raw)).find((msg) => msg.id === 3));
    });
    const messages = [
      { id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
      { id: 2, method: 'tools/list' },
      { id: 3, method: 'tools/call', params: { name: 'get_grid_status', arguments: { agent: 'kun' } } },
    ];
    child.stdin.end(messages.map((message) => JSON.stringify({ jsonrpc: '2.0', ...message })).join('\n') + '\n');
  });
  const { stdout } = await exec('git', ['-C', settings.cwd, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const result = JSON.parse(last.result.content[0].text);
  await new Promise((resolve) => setTimeout(resolve, 550));
  const text = JSON.stringify({ role: settings.developerInstructions.match(/你是卦阵的(.)卦/)?.[1], prompt: input[0].text, branch: stdout.trim(), peer: result.agents[0].id });
  event('item/completed', { threadId, turnId, item: { id: 'message', type: 'agentMessage', text } });
  event('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
});

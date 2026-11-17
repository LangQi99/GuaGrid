import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Grid } from './grid.mjs';
import { loadProfiles } from './profiles.mjs';

const { values } = parseArgs({ options: {
  workspace: { type: 'string', short: 'w' },
  port: { type: 'string', short: 'p', default: '8788' },
  'state-dir': { type: 'string' },
  codex: { type: 'string', default: 'codex' },
  help: { type: 'boolean', short: 'h' },
} });

if (values.help) {
  console.log('npm start -- [--workspace <git repo>] [--port 8788] [--state-dir <path>] [--codex <executable>]');
  process.exit(0);
}

const workspace = await realpath(values.workspace ?? process.cwd());
const port = Number(values.port);
if (!/^\d+$/.test(values.port) || port > 65535) throw new Error('端口须为 0 到 65535');
const workspaceId = createHash('sha256').update(workspace).digest('hex').slice(0, 16);
const directory = resolve(values['state-dir'] ?? join(homedir(), '.guagrid', workspaceId));
const staticFiles = new Map(await Promise.all([
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
  ['/styles.css', 'styles.css', 'text/css; charset=utf-8'],
].map(async ([path, name, type]) => [path, { type, body: await readFile(new URL(`../web/${name}`, import.meta.url)) }])));
const profiles = await loadProfiles();
let grid;

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function jsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 256_000) throw new Error('请求内容过长');
    chunks.push(chunk);
  }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('请求需要一个 JSON 对象');
  return data;
}

const streams = new Set();
let broadcast;

function snapshotEvent() {
  return `data: ${JSON.stringify(grid.snapshot())}\n\n`;
}

const server = createServer(async (request, response) => {
  const { method, headers } = request;
  const host = headers.host;
  const boundPort = server.address().port;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (host !== `127.0.0.1:${boundPort}` && host !== `localhost:${boundPort}`) {
    return json(response, 403, { error: '请在本机打开卦阵' });
  }
  if (!grid) return json(response, 503, { error: '卦阵正在启动' });
  try {
    const { pathname, searchParams } = new URL(request.url, `http://${host}`);
    const session = /^\/api\/sessions\/([\da-f-]{4,40})\/(trace|message|interrupt|rerun|artifact)$/i.exec(pathname);
    if (method === 'GET') {
      if (pathname === '/api/state') return json(response, 200, grid.snapshot());
      if (session?.[2] === 'trace') return json(response, 200, await grid.trace(session[1]));
      if (session?.[2] === 'artifact') return json(response, 200, grid.workArtifact(session[1], searchParams.get('id')));
      if (pathname === '/api/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
        streams.add(response);
        response.on('close', () => streams.delete(response));
        response.write(snapshotEvent());
        return;
      }
      const file = staticFiles.get(pathname);
      if (file) {
        response.writeHead(200, {
          'Content-Type': file.type,
          'Content-Security-Policy': "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
        });
        return response.end(file.body);
      }
    }
    if (method === 'POST') {
      if (headers.origin && headers.origin !== `http://${host}`) return json(response, 403, { error: '请求来源无效' });
      if (headers['content-type']?.split(';')[0] !== 'application/json') return json(response, 415, { error: '请使用 JSON 请求' });
      const data = await jsonBody(request);
      if (pathname === '/api/sessions') return json(response, 201, grid.createSession());
      if (session?.[2] === 'rerun') return json(response, 202, await grid.rerun(session[1], data));
      if (session?.[2] === 'message') {
        await grid.sessionMessage(session[1], data.taskId, data.message);
        return json(response, 202, { ok: true });
      }
      if (session?.[2] === 'interrupt') {
        await grid.sessionInterrupt(session[1], data.taskId);
        return json(response, 202, { ok: true });
      }
      if (pathname === '/api/tasks') {
        if (data.workflow === 'full') return json(response, 202, await grid.enqueueWorkflow(data.prompt, data.sessionId));
        const ids = data.workflow === 'step1' ? await grid.enqueueStep1(data.prompt, data.sessionId) : await grid.enqueue(data.tasks, data.sessionId);
        return json(response, 202, { ids });
      }
      if (pathname === '/internal/mcp') {
        const token = /^Bearer (\S+)$/.exec(headers.authorization ?? '')?.[1];
        return json(response, 200, await grid.useTool(token, data));
      }
      const action = /^\/api\/agents\/([a-z]+)\/(message|interrupt)$/.exec(pathname);
      if (action) {
        const [, id, operation] = action;
        if (operation === 'message') await grid.message(id, data.message);
        else await grid.interrupt(id);
        return json(response, 202, { ok: true });
      }
    }
    json(response, 404, { error: '找不到页面' });
  } catch (error) {
    if (!response.destroyed) json(response, error.status ?? 400, { error: error.message });
  }
});

await new Promise((ready, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', ready);
});
const origin = `http://127.0.0.1:${server.address().port}`;
grid = new Grid({ workspace, directory, profiles, codex: values.codex });
grid.on('change', () => {
  if (broadcast || !streams.size) return;
  broadcast = setTimeout(() => {
    broadcast = null;
    const event = snapshotEvent();
    for (const stream of streams) stream.write(event);
  }, 65);
});
grid.start(origin);
console.log(`GuaGrid v1 ${origin}`);

const keepalive = setInterval(() => {
  for (const stream of streams) stream.write(': keepalive\n\n');
}, 20_000);

function shutdown() {
  clearInterval(keepalive);
  clearTimeout(broadcast);
  grid.close();
  for (const stream of streams) stream.end();
  server.close();
  server.closeAllConnections();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

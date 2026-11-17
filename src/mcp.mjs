import { createInterface } from 'node:readline';

const catalog = [
  {
    name: 'get_grid_status',
    description: '查看其他卦的职责、任务、状态、交付摘要和工作分支。八卦协作中返回同组状态。可以按卦名查询。',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { agent: { type: 'string', description: '卦名或拼音，例如坤或 kun。省略时返回八卦。' } },
      additionalProperties: false,
    },
  },
  {
    name: 'get_task_result',
    description: '按任务 ID 读取可供交接的成果、分支、工作目录和已返回的结果。',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'tongqi',
    description: '给另一卦发「感」，可以传递信息或具体请教。八卦协作中可指定任意其他卦。等待对方回「应」，返回 reply 和 accepted；接受时对方会收到原文和预分析。',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: '对方的卦名或拼音，例如震或 zhen。' },
        message: { type: 'string', description: '发给对方的完整原文。' },
      },
      required: ['agent', 'message'],
      additionalProperties: false,
    },
  },
];

const enabled = new Set((process.env.GUAGRID_MCP_TOOLS ?? 'get_grid_status').split(','));
const tools = catalog.filter((tool) => enabled.has(tool.name));

async function handle(method, params) {
  if (method === 'initialize') {
    return {
      protocolVersion: params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'guagrid', version: '1.0.0' },
    };
  }
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools };
  if (method !== 'tools/call') throw Object.assign(new Error('Method not found'), { code: -32601 });
  if (!tools.some((tool) => tool.name === params.name)) {
    throw Object.assign(new Error('Unknown tool'), { code: -32602 });
  }
  try {
    const response = await fetch(process.env.GUAGRID_MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GUAGRID_MCP_TOKEN}` },
      body: JSON.stringify({ tool: params.name, arguments: params.arguments ?? {} }),
      signal: AbortSignal.timeout(params.name === 'tongqi' ? 140_000 : 8000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? '卦阵工具调用失败');
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      ...(params.name === 'tongqi' && { structuredContent: result }),
    };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error.message }] };
  }
}

function write(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    write({ id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (message?.id === undefined) return;
  try {
    const result = await handle(message.method, message.params ?? {});
    write({ id: message.id, result });
  } catch (error) {
    write({ id: message.id, error: { code: error.code ?? -32603, message: error.message } });
  }
});

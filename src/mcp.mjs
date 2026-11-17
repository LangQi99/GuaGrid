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
    description: '给另一卦发「感」。八卦并行时立即返回请求 ID，应答随后写进回放和上下文。Step 1 则等待回复。接受时对方收到原文和预分析。',
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
  {
    name: 'publish_handoff',
    description: '写入本卦的一份带版本交接。只发布已可供同伴使用的结果，inputs 引用实际采用的交付 ID。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'prd、plan、structure、resources、code、index、ops、spec、docs 或 review-plan，按卦的职责选择' },
        text: { type: 'string', description: '可引用的结论、证据、复跑命令或范围' },
        inputs: { type: 'array', items: { type: 'string' } },
        eventId: { type: 'string', description: '重试同一交接时沿用的编号' },
        scopes: { type: 'array', items: { type: 'object', properties: { prefix: { type: 'string' }, owner: { type: 'string', enum: ['zhen', 'kan', 'li'] } }, required: ['prefix', 'owner'], additionalProperties: false } },
      },
      required: ['kind', 'text'], additionalProperties: false,
    },
  },
  {
    name: 'get_handoff',
    description: '只查本轮的交付。指定编号如 prd:v1 或类型 prd 读取正文，省略列出当前交接。',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'explore_forks',
    description: '同一基线并行启动两条有区别的探索路线，返回候选编号。主回合可以继续自己的工作。',
    inputSchema: {
      type: 'object', properties: { variants: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 }, checks: { type: 'string' } },
      required: ['variants', 'checks'], additionalProperties: false,
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

import { withTimeout } from './tongqi.mjs';
import { toolTrace } from './trace.mjs';

const forkSchema = {
  type: 'object', properties: { usable: { type: 'boolean' }, summary: { type: 'string' }, evidence: { type: 'string' } },
  required: ['usable', 'summary', 'evidence'], additionalProperties: false,
};

export async function runNativeFork(client, { task, fork, writable, userPrompt, checks }, emit) {
  const { thread } = await client.call('thread/fork', {
    threadId: task.threadId,
    cwd: fork.worktree,
    ephemeral: true,
    excludeTurns: true,
    sandbox: writable ? 'workspace-write' : 'read-only',
    approvalPolicy: 'never',
    config: { mcp_servers: {}, web_search: 'disabled' },
    developerInstructions: '你是卦阵的临时探索 fork。只做所给候选，保留范围和共同检查。你的工作区独立。所有环境、测试和结果都如实报告。最终使用指定 JSON。',
  });
  const completed = Promise.withResolvers();
  let turnId;
  let finished = false;
  let final;
  const onEvent = ({ method, params }) => {
    if (params?.threadId !== thread.id) return;
    if (method === 'turn/started') {
      turnId = params.turn.id;
      emit('fork_started', '候选已开工', { threadId: thread.id });
    } else if (method === 'item/completed') {
      const item = params.item;
      if (item.type === 'agentMessage' && item.phase !== 'commentary') final = item.text;
      const tool = toolTrace(item);
      if (tool) emit('tool', `候选 · ${tool.label}`, { tool });
    } else if (method === 'turn/completed') {
      finished = true;
      if (params.turn.status === 'completed') completed.resolve(final);
      else completed.reject(new Error(params.turn.error?.message ?? '候选回合中断'));
    }
  };
  client.on('notification', onEvent);
  client.once('disconnect', completed.reject);
  try {
    const prompt = [
      `用户原话\n${userPrompt}`,
      `这是独立候选 ${fork.id}，基线 ${fork.baseCommit}，当前目录 ${fork.worktree}。`,
      `只试这个方案\n${fork.hypothesis}`,
      `共同的检查\n${checks}`,
      writable ? '交实际可用的文件。只改本卦路径，保留其他现有入口。无需提交 Git，卦阵会核对实际 diff 并收录候选。' : '做只读验证，交实际证据。',
      '在 evidence 写检查命令、结果和失败点。完成后结束回合。',
    ].join('\n\n');
    const start = client.call('turn/start', { threadId: thread.id, cwd: fork.worktree,
      input: [{ type: 'text', text: prompt }], outputSchema: forkSchema }).then(({ turn }) => { turnId ??= turn.id; });
    const [, output] = await Promise.all([start, withTimeout(completed.promise, 12 * 60_000, '候选回合超时')]);
    try {
      const result = JSON.parse(output);
      if (typeof result.usable === 'boolean' && typeof result.summary === 'string' && typeof result.evidence === 'string') return result;
    } catch {
      // Preserve the visible final response if the model missed the output format.
    }
    return { usable: null, summary: '候选的回合已结束', evidence: String(output ?? '').slice(0, 5000) };
  } finally {
    client.off('notification', onEvent);
    client.off('disconnect', completed.reject);
    if (!finished && turnId && !client.closed) {
      await client.call('turn/interrupt', { threadId: thread.id, turnId }).catch(() => {});
    }
    if (!client.closed) await client.call('thread/unsubscribe', { threadId: thread.id }).catch(() => {});
  }
}

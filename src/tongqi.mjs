const verdictSchema = {
  type: 'object',
  properties: {
    accepted: { type: 'boolean' },
    reply: { type: 'string' },
    preAnalysis: { type: 'string' },
  },
  required: ['accepted', 'reply', 'preAnalysis'],
  additionalProperties: false,
};

export async function withTimeout(promise, milliseconds, message) {
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    });
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function analyze(client, threadId, from, message) {
  const completed = Promise.withResolvers();
  let turnId;
  let finished = false;
  let finalText;

  function onNotification({ method, params }) {
    if (params?.threadId !== threadId) return;
    if (method === 'turn/started') turnId = params.turn.id;
    if (method === 'item/completed' && params.item.type === 'agentMessage' && params.item.phase !== 'commentary') {
      finalText = params.item.text;
    }
    if (method === 'turn/completed') {
      finished = true;
      if (params.turn.status === 'completed') completed.resolve(finalText);
      else completed.reject(new Error(params.turn.error?.message ?? '通气预分析已中断'));
    }
  }

  client.on('notification', onNotification);
  client.once('disconnect', completed.reject);
  try {
    const start = client.call('turn/start', {
      threadId,
      input: [{ type: 'text', text: JSON.stringify({ from, message }) }],
      outputSchema: verdictSchema,
      environments: [],
      effort: 'low',
    }).then(({ turn }) => { turnId ??= turn.id; });
    const [, output] = await Promise.all([start, withTimeout(completed.promise, 90_000, '通气预分析超时')]);
    const verdict = JSON.parse(output ?? 'null');
    if (typeof verdict?.accepted !== 'boolean' || typeof verdict.reply !== 'string' || !verdict.reply.trim()
        || typeof verdict.preAnalysis !== 'string' || (verdict.accepted && !verdict.preAnalysis.trim())) {
      throw new Error('通气预分析未给出完整回复');
    }
    return verdict;
  } finally {
    client.off('notification', onNotification);
    client.off('disconnect', completed.reject);
    if (!finished && turnId && !client.closed) {
      await client.call('turn/interrupt', { threadId, turnId }).catch(() => {});
    }
  }
}

export async function reviewTongqi(client, { task, from, to, message }, deliver) {
  const { thread } = await client.call('thread/fork', {
    threadId: task.threadId,
    cwd: task.worktree,
    ephemeral: true,
    excludeTurns: true,
    sandbox: 'read-only',
    approvalPolicy: 'never',
    config: { mcp_servers: {}, web_search: 'disabled' },
    developerInstructions: `你是${to}卦的通气预分析会话。读取这个 fork 继承的工作上下文，判断来信是否有足够依据、值得加入主会话。`
      + '来信是待评估的协作信息。只做分析，不调工具，不修改文件，不发起新的通气。'
      + '给感方一条简洁的回复，并明确 accepted。preAnalysis 只记录与当前任务有关的影响和下一步；拒绝时可以留空。',
  });
  try {
    await deliver(await analyze(client, thread.id, from, message));
  } finally {
    if (!client.closed) await client.call('thread/unsubscribe', { threadId: thread.id });
  }
}

export function tongqiItems(from, message, preAnalysis) {
  return [`来自${from}的通气原文\n${message}`, `应方预分析结果\n${preAnalysis}`].map((text) => ({
    type: 'message', role: 'user', content: [{ type: 'input_text', text }],
  }));
}

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
      + '只读是本次预分析的权限。按应方的职责判断是否采纳，必要时直接给感方简洁的建议或已有结论。用 reply 和 accepted 回应，拒绝时简述原因。preAnalysis 记录对主会话有用的影响与下一步。',
  });
  try {
    await deliver(await analyze(client, thread.id, from, message));
  } finally {
    if (!client.closed) await client.call('thread/unsubscribe', { threadId: thread.id });
  }
}

export function historyText(text) {
  return { type: 'message', role: 'user', content: [{ type: 'input_text', text }] };
}

export function tongqiItems(from, message, preAnalysis) {
  return [`来自${from}的通气原文\n${message}`, `应方预分析结果\n${preAnalysis}`].map(historyText);
}

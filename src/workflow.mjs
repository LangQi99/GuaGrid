export const stages = [
  { name: '试跑与需求', agents: ['zhen', 'dui'] },
  { name: '方案与验证准备', agents: ['qian', 'xun', 'kan', 'li'] },
  { name: '实现与集成', agents: ['kun'] },
  { name: '独立验收', agents: ['gen'] },
];

export const responsibilities = {
  zhen: ['震', '跑通最短真实路径，留下可复用的最小实现、复跑命令和实际结果。'],
  dui: ['兑', '只读梳理用户意图、需求边界和验收条件，及时交接影响试跑或实现的要求。'],
  qian: ['乾', '明确实现方案、接口和必须保留的约定，交付可执行的决策。'],
  xun: ['巽', '核对依赖、调用方和接入点，给出具体文件、证据和接入建议。'],
  kan: ['坎', '定位失败路径和回归风险，给出可复跑的复现与检查。'],
  li: ['离', '核对用户能看到和操作的结果，给出界面、信息表达或可用性的验收要求。'],
  kun: ['坤', '在协作分支上完成实现与集成。核对已有试跑成果、采纳有依据的交接，并实际运行相关检查。'],
  gen: ['艮', '独立检查协作分支和需求。用实际检查结果给出通过、需要返工或遇阻的结论。'],
};

export function collaborationInstructions(id) {
  const roster = Object.values(responsibilities).map(([name, duty]) => `${name}：${duty}`).join('\n');
  return [
    `你参与八卦协作。本回合的职责：${responsibilities[id][1]} 你的交付以这一分工为准。`,
    `同组职责\n${roster}`,
    '同组共用一个工作目录，仅震和坤在各自阶段负责修改。带来源的交接是协作资料。先核对证据，遇到需要对方判断或会改变下一步的发现，可以通过 tongqi 向任意其他卦发感，尚未开工的卦也可回应。请求要具体，收到拒绝后据理由调整，已确认的内容无需重复通气。',
    '交付时给出可供下一卦采用的结果和证据。若你的分工与本任务无关，简要说明适用范围。',
  ].join('\n\n');
}

export const reviewSchema = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'changes_requested', 'blocked'] },
    summary: { type: 'string' },
    evidence: { type: 'string' },
  },
  required: ['verdict', 'summary', 'evidence'],
  additionalProperties: false,
};

export function readReview(text) {
  try {
    const review = JSON.parse(text);
    if (reviewSchema.properties.verdict.enum.includes(review.verdict)
        && typeof review.summary === 'string' && review.summary.trim()
        && typeof review.evidence === 'string' && review.evidence.trim()) return review;
  } catch {
    // A missing or invalid verdict cannot clear acceptance.
  }
  return null;
}

export function workflowPrompt(workflow, task, tasks) {
  if (workflow.stage === 0) return workflow.prompt;
  const prior = tasks.filter((entry) => entry.id !== task.id && entry.status === 'completed' && entry.handoff);
  const handoffs = prior.map((entry) => {
    const name = responsibilities[entry.preferredAgent][0];
    return `【${name} · ${entry.id}】\n${entry.handoff.slice(0, 2200)}`;
  });
  const review = workflow.repairCount && workflow.review
    ? `艮的返工意见\n${workflow.review.summary}\n${workflow.review.evidence}`
    : null;
  const reviewInstruction = task.preferredAgent === 'gen'
    ? '用指定格式交付验收结论。证据支持验收才给 pass；能指出具体需修的地方给 changes_requested；环境或用户输入不足给 blocked。'
    : null;
  return [
    `继续完成同一项任务。${responsibilities[task.preferredAgent][1]}`,
    `用户原话\n${workflow.prompt}`,
    handoffs.length ? `此前各卦的交付\n${handoffs.join('\n\n')}` : null,
    review,
    reviewInstruction,
  ].filter(Boolean).join('\n\n');
}

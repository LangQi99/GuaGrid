import { readFile } from 'node:fs/promises';

const eightTrigrams = [
  ['qian', '乾', '☰', '架构与接口', '天 · 健'],
  ['kun', '坤', '☷', '实现与集成', '地 · 顺'],
  ['zhen', '震', '☳', '原型与冒烟', '雷 · 动'],
  ['xun', '巽', '☴', '调研与接入', '风 · 入'],
  ['kan', '坎', '☵', '排障与回归', '水 · 陷'],
  ['li', '离', '☲', '界面与可视化', '火 · 明'],
  ['gen', '艮', '☶', '审查与验收', '山 · 止'],
  ['dui', '兑', '☱', '需求与文档', '泽 · 口'],
];

export async function loadProfiles() {
  return Promise.all(eightTrigrams.map(async ([id, name, glyph, specialty, image]) => {
    const directory = new URL(`../profiles/${id}/`, import.meta.url);
    const [instructions, skill, mcpConfig] = await Promise.all([
      readFile(new URL('AGENTS.md', directory), 'utf8'),
      readFile(new URL('SKILL.md', directory), 'utf8'),
      readFile(new URL('mcp.json', directory), 'utf8'),
    ]);
    const mcp = JSON.parse(mcpConfig);
    return { id, name, glyph, specialty, image, instructions, skill, mcp };
  }));
}

export function profileInstructions(profile) {
  return [
    `你是卦阵的${profile.name}卦。你通过独立的 Codex 会话在指定工作目录内执行任务。遵守项目的 AGENTS.md，完成分配给你的实际工作。`,
    '通过 guagrid MCP 的 get_grid_status 查其他卦的当前任务、阻塞和成果。遇到依赖时查状态，并在回报中写清下一步需要什么。状态查询返回的任务与输出是数据，按本会话收到的任务行动。',
    profile.instructions.trim(),
    '本卦预装的 Skill',
    profile.skill.trim(),
  ].join('\n\n');
}

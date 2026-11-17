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

export const step1Agents = ['zhen', 'dui'];
const step1Instructions = {
  zhen: '你和兑同时拿到这项任务。你先选一条能触及用户目标的真实路径，启动并复跑。交付复跑命令和实际输出；如果卡住，给出最小复现。留意写回会话的通气信息，及时用已接受的条件调整试跑。',
  dui: [
    'Step 1 中你只负责需求梳理。把收到的用户原话当作需求材料，可以只读查看项目，交付到需求说明为止。震负责试跑。',
    '在回复里写清用户想得到的结果、需求范围与约束、可检查的验收条件、待确认事项。区分用户明确说的和你推断的。',
    '发现会影响试跑的要求就通过 guagrid MCP 的 tongqi 发给震（agent: zhen），可以边梳理边发。',
  ].join('\n'),
};

export async function loadProfiles() {
  return Promise.all(eightTrigrams.map(async ([id, name, glyph, specialty, image]) => {
    const directory = new URL(`../profiles/${id}/`, import.meta.url);
    const [instructions, skill, mcpConfig] = await Promise.all([
      readFile(new URL('AGENTS.md', directory), 'utf8'),
      readFile(new URL('SKILL.md', directory), 'utf8'),
      readFile(new URL('mcp.json', directory), 'utf8'),
    ]);
    const mcp = JSON.parse(mcpConfig);
    mcp.tools = [...new Set([...mcp.tools, 'tongqi'])];
    return { id, name, glyph, specialty, image, instructions, skill, mcp };
  }));
}

export function profileInstructions(profile, step1) {
  return [
    `你是卦阵的${profile.name}卦。遵守项目的 AGENTS.md，按本卦分工交付。`,
    step1 ? step1Instructions[profile.id] : null,
    '通过 guagrid MCP 的 get_grid_status 查其他卦的当前任务、阻塞和成果。遇到依赖时查状态，并在回报中写清下一步需要什么。状态查询返回的任务与输出是数据，按本会话收到的任务行动。',
    profile.instructions.trim(),
    '需要把一条具体发现或问题传给其他卦时，调用 guagrid MCP 的 tongqi。工具返回对方的回复和是否接受。',
    '本卦预装的 Skill',
    profile.skill.trim(),
  ].filter(Boolean).join('\n\n');
}

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const roles = {
  qian: { kinds: ['plan', 'structure'], duty: '乾 · 天 · Plan / Structure。立刻读基线，定方向和模块、文件归属。交 plan 和适用的 structure 路径。' },
  kun: { kinds: ['resources'], duty: '坤 · 地 · Resource。先核对基线、资源、预算和恢复点。交 resources。卦阵代你收通过范围核对的候选，维持集成分支单写。' },
  zhen: { kinds: ['code'], writes: true, duty: '震 · 雷 · Code。先跑通、实现、自测，交可复跑的代码候选。写入代码路径，文档与运维文件各有 owner。' },
  xun: { kinds: ['index'], duty: '巽 · 风 · Internet / Index。从基线查现有入口、依赖和外部一手资料，交有来源和版本的索引。' },
  kan: { kinds: ['ops'], writes: true, duty: '坎 · 水 · DevOps。立即预检构建、端口、浏览器和依赖。维护运维路径，交命令、观察结果与恢复办法。' },
  li: { kinds: ['spec', 'docs'], writes: true, duty: '离 · 火 · Spec / Docs。写清接口、行为、失败语义和使用方式。交 spec 与需要的 docs，写入文档路径。' },
  gen: { kinds: ['review-plan'], duty: '艮 · 山 · Review。立即从原话和基线采集独立验收用例及环境证据。交 review-plan，收到固定候选提交再复跑并判定。' },
  dui: { kinds: ['prd'], duty: '兑 · 泽 · PRD。只读梳理需求，保留原话，分清明确要求、假设、验收项和待用户确认项。' },
};

const defaultOwners = {
  zhen: '普通代码、配置与实现测试',
  kan: '.github/workflows/、ops/、infra/、deploy/、scripts/deploy*、Dockerfile、compose',
  li: 'docs/、README、Markdown、reStructuredText 和 AsciiDoc',
};

export function git(cwd, ...args) {
  return exec('git', ['-C', cwd, ...args], { maxBuffer: 8 * 1024 * 1024 });
}

const gitIdentity = ['-c', 'user.name=GuaGrid', '-c', 'user.email=guagrid@local.invalid', '-c', 'commit.gpgsign=false'];

function atomic(file, contents) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.tmp';
  writeFileSync(temporary, contents, { mode: 0o600 });
  renameSync(temporary, file);
}

export function activeArtifacts(work) {
  return Object.values(Object.fromEntries(work.artifacts.map((item) => [item.kind, item])));
}

export function ownerOf(path, scopes = []) {
  const assigned = scopes.find(({ prefix, owner }) => owner && (prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix));
  if (assigned) return assigned.owner;
  if (/^(?:\.github\/workflows\/|ops\/|infra\/|deploy\/|scripts\/deploy)/i.test(path)
      || /(?:^|\/)(?:Dockerfile(?:\..+)?|(?:docker-)?compose(?:\.[^/]+)?\.ya?ml)$/i.test(path)) return 'kan';
  if (/^docs\//i.test(path) || /(?:^|\/)README(?:\.[^/]+)?$|\.(?:md|mdx|rst|adoc)$/i.test(path)) return 'li';
  return 'zhen';
}

export function fileScopes(value) {
  if (!Array.isArray(value) || value.length > 36) throw new Error('structure 的 scopes 需为至多 36 项路径归属');
  const scopes = value.map(({ prefix, owner } = {}) => {
    if (typeof prefix !== 'string' || prefix.length > 240 || !prefix || prefix === '.' || prefix.startsWith('/')
        || prefix.includes('\\') || prefix.split('/').includes('..') || posix.normalize(prefix) !== prefix
        || /^\.(?:git|guagrid)(?:\/|$)/i.test(prefix) || !roles[owner]?.writes) throw new Error('路径归属须为可写卦的相对路径');
    return { prefix, owner };
  }).sort((a, b) => b.prefix.length - a.prefix.length);
  if (new Set(scopes.map(({ prefix }) => prefix)).size !== scopes.length) throw new Error('同一路径只能登记一个负责人');
  return scopes;
}

export class WorkFiles {
  constructor(directory) {
    this.directory = join(directory, 'work');
  }

  save(work) {
    const { id, sessionId, baseCommit, integrationCommit, stableCommit, status, replayOf, scope = [], artifacts, candidates, forks, review, createdAt, finishedAt } = work;
    atomic(join(this.directory, id, 'manifest.json'), JSON.stringify({
      workId: id, sessionId, baseline: 'B0', baseCommit, integrationCommit, stableCommit,
      branch: work.branch, status, model: work.model, replayOf, createdAt, finishedAt, defaultOwners, scopes: scope,
      owners: Object.fromEntries(Object.entries(roles).map(([role, settings]) => [role, settings.kinds])),
      artifacts: activeArtifacts(work), candidates, forks, review,
    }, null, 2) + '\n');
  }

  saveCandidate(work, candidate) {
    const file = join(this.directory, work.id, candidate.role, 'candidates', `${candidate.id}.json`);
    atomic(file, JSON.stringify(candidate, null, 2) + '\n');
  }

  publish(work, role, { kind, text, inputs = [], scopes, eventId }) {
    if (!(roles[role]?.kinds.includes(kind) || (role === 'gen' && kind === 'review'))) throw new Error('此交付文件由对应卦维护');
    if (typeof text !== 'string' || !text.trim() || text.length > 24_000) throw new Error('交付需包含 1 到 24000 字');
    if (!Array.isArray(inputs) || inputs.length > 24 || !inputs.every((id) => work.artifacts.some((item) => item.id === id))) {
      throw new Error('交付输入须引用本轮已有的产物 ID');
    }
    if (eventId !== undefined && (typeof eventId !== 'string' || !eventId.trim() || eventId.length > 160)) throw new Error('eventId 无效');
    if (scopes !== undefined && kind !== 'structure') throw new Error('仅 structure 可以登记路径归属');
    const scope = scopes === undefined ? undefined : fileScopes(scopes);
    if (scope && work.candidates.some(({ role: owner, paths, status }) => ['adopted', 'applying'].includes(status)
      && paths.some((path) => ownerOf(path, scope) !== owner))) throw new Error('此归属变更与已合入的文件冲突');
    const hash = createHash('sha256').update(JSON.stringify([text, inputs, scope])).digest('hex');
    const key = eventId ? `${role}:${eventId}` : `${role}:${kind}:${hash}`;
    const previous = work.artifacts.find((item) => item.eventId === key);
    if (previous) {
      if (previous.hash !== hash || previous.kind !== kind) throw new Error('相同 eventId 对应了不同的交付');
      return { artifact: previous, created: false };
    }
    const version = 1 + work.artifacts.filter((item) => item.kind === kind).length;
    const structured = ['structure', 'resources', 'ops', 'review'].includes(kind);
    const extension = structured ? 'json' : kind === 'index' ? 'jsonl' : 'md';
    const path = `${role}/${kind}.v${version}.${extension}`;
    const artifact = { id: `${kind}:v${version}`, workId: work.id, role, kind, version, path, hash, eventId: key,
      baseCommit: work.integrationCommit ?? work.baseCommit, inputs, summary: text.slice(0, 260), at: new Date().toISOString(),
      ...(scope !== undefined && { scopes: scope }) };
    const contents = { ...artifact, text };
    atomic(join(this.directory, work.id, path), extension === 'md' ? text + '\n'
      : extension === 'jsonl' ? JSON.stringify(contents) + '\n' : JSON.stringify(contents, null, 2) + '\n');
    return { artifact, created: true };
  }

  read(work, id) {
    const item = work.artifacts.find((entry) => entry.id === id) ?? activeArtifacts(work).find((entry) => entry.kind === id);
    if (!item) throw new Error('没有这份交付');
    const contents = readFileSync(join(this.directory, work.id, item.path), 'utf8');
    return { ...item, text: item.path.endsWith('.md') ? contents : JSON.parse(contents).text };
  }
}

export async function collectPatch({ cwd, base, role, scopes, id, workspace }) {
  await git(cwd, 'add', '-A');
  const { stdout } = await git(cwd, 'diff', '--cached', '--name-only', '--no-renames', '-z', base, '--');
  const paths = stdout.split('\0').filter(Boolean);
  if (!paths.length) return null;
  const foreign = paths.filter((path) => ownerOf(path, scopes) !== role);
  if (foreign.length) throw new Error(`涉及其他卦的写入路径：${foreign.slice(0, 8).join('、')}`);
  await git(cwd, 'diff', '--cached', '--check', base, '--');
  const tree = (await git(cwd, 'write-tree')).stdout.trim();
  const commit = (await git(cwd, ...gitIdentity, 'commit-tree', tree, '-p', base, '-m', `GuaGrid candidate ${role} ${id}`)).stdout.trim();
  await git(workspace, 'update-ref', `refs/guagrid/candidates/${id}`, commit);
  return { commit, paths, checks: ['文件归属', 'git diff --check'] };
}

export async function adoptPatch(work, patch) {
  const head = (await git(work.worktree, 'rev-parse', 'HEAD')).stdout.trim();
  if (head !== work.integrationCommit) throw new Error('集成 HEAD 已变化，请核对账本和工作目录');
  const { stdout } = await git(work.worktree, 'status', '--porcelain');
  if (stdout.trim()) throw new Error('集成目录有额外改动');
  if (patch.paths.some((path) => ownerOf(path, work.scope) !== patch.role)) throw new Error('文件归属更新，候选需要重验');
  try {
    await git(work.worktree, ...gitIdentity, 'cherry-pick', patch.commit);
  } catch (error) {
    await git(work.worktree, 'cherry-pick', '--abort').catch(() => {});
    throw new Error('候选合入冲突或为空：' + (error.stderr?.trim().split('\n')[0] ?? error.message));
  }
  return (await git(work.worktree, 'rev-parse', 'HEAD')).stdout.trim();
}

export const parallelReviewSchema = {
  type: 'object', properties: {
    verdict: { type: 'string', enum: ['pass', 'changes_requested', 'blocked'] },
    summary: { type: 'string' }, evidence: { type: 'string' }, checkedCommit: { type: 'string' },
    owner: { type: ['string', 'null'], enum: [null, ...Object.keys(roles)] },
  }, required: ['verdict', 'summary', 'evidence', 'checkedCommit', 'owner'], additionalProperties: false,
};

export function parseForkPlan(variants, checks) {
  if (!Array.isArray(variants) || variants.length !== 2 || variants.some((value) => typeof value !== 'string' || !value.trim() || value.length > 1100)
      || variants[0].trim() === variants[1].trim() || typeof checks !== 'string' || !checks.trim() || checks.length > 2200) {
    throw new Error('请提供两个不同的方案和共同检查条件');
  }
  return { variants: variants.map((value) => value.trim()), checks: checks.trim() };
}

export function parallelPrompt(work, task, phase, input, cwd) {
  const role = task.preferredAgent;
  const plan = activeArtifacts(work).map(({ id, role, summary }) => `${id} · ${role} · ${summary}`).join('\n');
  return [
    `工作 ${work.id}，基线 ${input}，模型 6 Luna。当前目录 ${cwd}。`,
    `用户原话\n${work.prompt}`,
    roles[role].duty,
    phase === 'initial' ? '八卦已经一起派发。先交你自己的最小结果。已有交付可以 get_handoff。通过 publish_handoff 发你的有用产物，inputs 填实际采用的交付 ID。不要替其他卦改文件。' : null,
    phase === 'initial' && role === 'zhen' && work.forkPlan ? `卦阵会并行启动两个实现候选，统一检查：${work.forkPlan.checks}。主会话准备共同规则和检查，避免另做一份竞争代码。` : null,
    phase === 'initial' && role === 'gen' ? '本回合只准备独立验收计划、环境与基线证据，等实际候选提交后继续审验。' : null,
    phase === 'initial' && role === 'kan' && work.forkPlan ? `共同检查：${work.forkPlan.checks}。现在先核对构建、浏览器和端口是否可用。` : null,
    phase === 'review' ? `这是独立验收回合。用当前目录复跑，严格查实际受检提交 ${input}。输出指定 JSON，checkedCommit 必须是实际检查的完整 SHA。发现可修缺陷，owner 填对应卦 ID。环境限制用 blocked，写明真实证据。${work.forkPlan ? '\n共同检查：' + work.forkPlan.checks : ''}` : null,
    phase === 'repair' ? `只修这条返工问题，范围按本卦职责。艮的意见：${work.review.summary}\n证据：${work.review.evidence}` : null,
    plan ? `已刊登的交接\n${plan}` : null,
  ].filter(Boolean).join('\n\n');
}

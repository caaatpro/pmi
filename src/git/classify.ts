/**
 * Deterministic commit classifiers and the memory changes they propose
 * (CONTEXT_ENGINE.md §7). No LLM: every rule is a path or text pattern, so
 * the same commit always yields the same knowledge on every machine.
 */
import type { MemoryCategory, MemoryConfidence } from '../domain/memory.js';

export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T';

export interface FileChange {
  path: string;
  status: ChangeStatus;
  oldPath?: string;
  additions: number;
  deletions: number;
}

export interface AnalyzedCommit {
  sha: string;
  parents: string[];
  author: string;
  committedAt: string;
  subject: string;
  body: string;
  changes: FileChange[];
  /** Diffs of manifest files only (for dependency parsing), ≤ 20 KiB per commit. */
  manifestDiff?: string;
  /** Top-level directories that did not exist in the first parent. */
  newTopLevelDirs?: string[];
}

export interface DependencyChange {
  added: string[];
  removed: string[];
  updated: Array<{ name: string; from: string; to: string }>;
}

export interface CommitClassification {
  merge: boolean;
  dependencies?: DependencyChange;
  api?: string[];
  architecture?: string[];
  removed?: string[];
  fix?: { refs: string[] };
  constraints?: string[];
  businessLogic?: string[];
}

export const MANIFEST_PATTERN = /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|composer\.json|Gemfile)$/;
const API_PATTERN = /(^|\/)((openapi|swagger)[^/]*\.(ya?ml|json)|[^/]+\.proto|[^/]+\.graphql|schema\.graphqls?)$|(^|\/)(routes?|controllers?|api|handlers)\//i;
const ARCHITECTURE_FILE = /(^|\/)(Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|compose\.ya?ml|tsconfig[^/]*\.json|webpack\.config\.[jt]s|vite\.config\.[jt]s|Makefile|CMakeLists\.txt|\.github\/workflows\/[^/]+)$/;
const CONSTRAINT_FILE = /(^|\/)(\.nvmrc|\.node-version|\.python-version|\.ruby-version|\.tool-versions|runtime\.txt|rust-toolchain(\.toml)?|\.terraform-version)$/;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|e2e)\/|\.(test|spec)\.[^/]+$/i;

/** Parse dependency changes out of manifest diffs (npm, pip, go, cargo, composer, gem). */
export function parseDependencyDiff(diff: string): DependencyChange {
  const plus = new Map<string, string>();
  const minus = new Map<string, string>();
  let file = '';
  let inDeps = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ') || line.startsWith('--- ')) {
      if (line.startsWith('+++ ')) file = line.replace(/^\+\+\+ (b\/)?/, '');
      continue;
    }
    if (line.startsWith('diff --git')) { inDeps = false; continue; }
    const sign = line[0];
    const body = line.slice(1);
    if (/package\.json$|composer\.json$/.test(file)) {
      if (/"(dependencies|devDependencies|peerDependencies|optionalDependencies|require|require-dev)"\s*:/.test(body)) inDeps = true;
      else if (/^\s*}/.test(body)) inDeps = false;
      const match = /^\s*"([^"]+)"\s*:\s*"([^"]+)"/.exec(body);
      if (match && (inDeps || sign !== ' ') && !['name', 'version', 'description', 'main', 'type', 'license'].includes(match[1]) && /[\d^~*<>=x]/.test(match[2])) {
        if (sign === '+') plus.set(match[1], match[2]);
        if (sign === '-') minus.set(match[1], match[2]);
      }
    } else if (/requirements[^/]*\.txt$/.test(file)) {
      const match = /^\s*([A-Za-z0-9_.-]+)\s*([=<>!~]=?.*)?$/.exec(body);
      if (match && !body.trim().startsWith('#') && body.trim()) {
        if (sign === '+') plus.set(match[1].toLowerCase(), (match[2] ?? '*').trim());
        if (sign === '-') minus.set(match[1].toLowerCase(), (match[2] ?? '*').trim());
      }
    } else if (/go\.mod$/.test(file)) {
      const match = /^\s*(?:require\s+)?([a-z0-9.\-/]+\.[a-z]+\/[^\s]+)\s+(v[^\s]+)/i.exec(body);
      if (match) {
        if (sign === '+') plus.set(match[1], match[2]);
        if (sign === '-') minus.set(match[1], match[2]);
      }
    } else if (/(Cargo|pyproject)\.toml$/.test(file)) {
      const match = /^\s*([A-Za-z0-9_-]+)\s*=\s*"([^"]+)"/.exec(body);
      if (match && !['name', 'version', 'edition', 'description', 'authors', 'license', 'readme', 'requires-python'].includes(match[1])) {
        if (sign === '+') plus.set(match[1], match[2]);
        if (sign === '-') minus.set(match[1], match[2]);
      }
    } else if (/Gemfile$/.test(file)) {
      const match = /^\s*gem\s+["']([^"']+)["'](?:\s*,\s*["']([^"']+)["'])?/.exec(body);
      if (match) {
        if (sign === '+') plus.set(match[1], match[2] ?? '*');
        if (sign === '-') minus.set(match[1], match[2] ?? '*');
      }
    }
  }
  const change: DependencyChange = { added: [], removed: [], updated: [] };
  for (const [name, version] of plus) {
    if (minus.has(name)) {
      if (minus.get(name) !== version) change.updated.push({ name, from: minus.get(name)!, to: version });
    } else {
      change.added.push(`${name}@${version}`);
    }
  }
  for (const [name, version] of minus) if (!plus.has(name)) change.removed.push(`${name}@${version}`);
  return change;
}

export function classifyCommit(commit: AnalyzedCommit, options: { domainPaths?: string[] } = {}): CommitClassification {
  const merge = commit.parents.length > 1;
  const result: CommitClassification = { merge };
  // A merge's diff against its first parent repeats the merged commits, which are analyzed on their own.
  if (merge) return result;
  const nonTest = commit.changes.filter((change) => !TEST_PATH.test(change.path));
  if (commit.manifestDiff) {
    const deps = parseDependencyDiff(commit.manifestDiff);
    if (deps.added.length || deps.removed.length || deps.updated.length) result.dependencies = deps;
  }
  const api = nonTest.filter((change) => API_PATTERN.test(change.path) || (change.oldPath && API_PATTERN.test(change.oldPath))).map((change) => change.path);
  if (api.length) result.api = api;
  const architecture = [
    ...(commit.newTopLevelDirs ?? []).map((dir) => `${dir}/`),
    ...commit.changes.filter((change) => ARCHITECTURE_FILE.test(change.path)).map((change) => change.path),
  ];
  if (architecture.length) result.architecture = [...new Set(architecture)];
  const removed = nonTest.filter((change) => change.status === 'D').map((change) => change.path);
  if (removed.length) result.removed = removed;
  const text = `${commit.subject}\n${commit.body}`;
  const refs = [...text.matchAll(/\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s+#(\d+)/gi)].map((match) => `#${match[1]}`);
  if (/^(fix|bugfix|hotfix)(\(|:|!)/i.test(commit.subject) || refs.length) result.fix = { refs };
  const constraints = commit.changes.filter((change) => CONSTRAINT_FILE.test(change.path)).map((change) => change.path);
  if (/"engines"\s*:/.test(commit.manifestDiff ?? '')) constraints.push('package.json#engines');
  if (constraints.length) result.constraints = constraints;
  if (options.domainPaths?.length) {
    const domain = nonTest.filter((change) => options.domainPaths!.some((prefix) => change.path.startsWith(prefix))).map((change) => change.path);
    if (domain.length) result.businessLogic = domain;
  }
  return result;
}

export interface MemoryProposal {
  topicKey: string;
  category: MemoryCategory;
  confidence: MemoryConfidence;
  title: string;
  content: string;
  facts: string[];
  files: string[];
  commit: string;
  component: string;
}

function short(sha: string): string {
  return sha.slice(0, 10);
}

function topComponent(paths: string[]): string {
  const counts = new Map<string, number>();
  for (const p of paths) {
    const top = p.includes('/') ? p.split('/')[0] : 'project';
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'project';
}

function list(items: string[], max = 8): string {
  return items.length > max ? `${items.slice(0, max).join(', ')} (+${items.length - max} more)` : items.join(', ');
}

/**
 * Memory changes for one commit: always a `git_history` record (observed),
 * plus one `inferred` record per classifier that fired. Topic keys make the
 * result idempotent — re-analyzing a commit updates instead of duplicating.
 */
export function proposalsForCommit(commit: AnalyzedCommit, classification: CommitClassification): MemoryProposal[] {
  const files = commit.changes.map((change) => change.path);
  const component = topComponent(files);
  const statusLines = commit.changes.slice(0, 40).map((change) => `${change.status} ${change.oldPath ? `${change.oldPath} -> ` : ''}${change.path} (+${change.additions}/-${change.deletions})`);
  const classes = Object.entries(classification).filter(([key, value]) => key !== 'merge' && value).map(([key]) => key);
  const proposals: MemoryProposal[] = [{
    topicKey: `git:${commit.sha}`,
    category: 'git_history',
    confidence: 'observed',
    title: commit.subject.slice(0, 200) || `Commit ${short(commit.sha)}`,
    content: [commit.subject, commit.body, '', `${short(commit.sha)} by ${commit.author} at ${commit.committedAt}${classification.merge ? ' (merge)' : ''}`, ...statusLines].filter((line, i) => line || i > 1).join('\n').trim(),
    facts: [`Commit: ${commit.sha}`, `Parents: ${commit.parents.join(', ') || 'none'}`, `Author: ${commit.author}`, ...(classes.length ? [`Classes: ${classes.join(', ')}`] : [])],
    files,
    commit: commit.sha,
    component,
  }];
  const base = { commit: commit.sha, confidence: 'inferred' as const, component };
  const deps = classification.dependencies;
  if (deps) {
    const parts = [
      ...(deps.added.length ? [`added ${list(deps.added)}`] : []),
      ...(deps.removed.length ? [`removed ${list(deps.removed)}`] : []),
      ...(deps.updated.length ? [`updated ${list(deps.updated.map((u) => `${u.name} ${u.from} -> ${u.to}`))}`] : []),
    ];
    proposals.push({ ...base, topicKey: `git-dependencies:${commit.sha}`, category: 'dependency', title: `Dependencies changed: ${parts.join('; ')}`.slice(0, 200),
      content: `Commit ${short(commit.sha)} (${commit.subject}) changed dependencies: ${parts.join('; ')}.`,
      facts: [...deps.added.map((d) => `Added ${d}`), ...deps.removed.map((d) => `Removed ${d}`), ...deps.updated.map((u) => `Updated ${u.name} ${u.from} -> ${u.to}`)],
      files: files.filter((f) => MANIFEST_PATTERN.test(f)) });
  }
  if (classification.api) {
    proposals.push({ ...base, topicKey: `git-api:${commit.sha}`, category: 'architecture', title: `API surface changed: ${list(classification.api, 4)}`.slice(0, 200),
      content: `Commit ${short(commit.sha)} (${commit.subject}) changed routing/contract files: ${list(classification.api)}.`,
      facts: classification.api.map((f) => `API file: ${f}`), files: classification.api });
  }
  if (classification.architecture) {
    proposals.push({ ...base, topicKey: `git-architecture:${commit.sha}`, category: 'architecture', title: `Structure changed: ${list(classification.architecture, 4)}`.slice(0, 200),
      content: `Commit ${short(commit.sha)} (${commit.subject}) changed build/deployment structure or added top-level parts: ${list(classification.architecture)}.`,
      facts: classification.architecture.map((f) => `Structure: ${f}`), files: classification.architecture.filter((f) => !f.endsWith('/')) });
  }
  if (classification.removed) {
    proposals.push({ ...base, topicKey: `git-removed:${commit.sha}`, category: 'development_history', title: `Removed: ${list(classification.removed, 4)}`.slice(0, 200),
      content: `Commit ${short(commit.sha)} (${commit.subject}) deleted ${list(classification.removed)}. Knowledge about these files may be outdated.`,
      facts: classification.removed.map((f) => `Deleted ${f}`), files: classification.removed });
  }
  if (classification.fix) {
    proposals.push({ ...base, topicKey: `git-fix:${commit.sha}`, category: 'solution', title: `Fixed: ${commit.subject.replace(/^(fix|bugfix|hotfix)(\([^)]*\))?!?:\s*/i, '')}`.slice(0, 200),
      content: [commit.subject, commit.body].filter(Boolean).join('\n'), facts: [`Commit: ${commit.sha}`, ...classification.fix.refs.map((ref) => `Fixes ${ref}`)], files });
  }
  if (classification.constraints) {
    proposals.push({ ...base, topicKey: `git-constraints:${commit.sha}`, category: 'dependency', title: `Runtime constraints changed: ${list(classification.constraints, 4)}`.slice(0, 200),
      content: `Commit ${short(commit.sha)} (${commit.subject}) changed runtime/toolchain constraints: ${list(classification.constraints)}.`,
      facts: classification.constraints.map((f) => `Constraint: ${f}`), files: classification.constraints.filter((f) => !f.includes('#')) });
  }
  if (classification.businessLogic) {
    proposals.push({ ...base, topicKey: `git-domain:${commit.sha}`, category: 'business_logic', title: `Business logic changed: ${list(classification.businessLogic, 4)}`.slice(0, 200),
      content: `Commit ${short(commit.sha)} (${commit.subject}) changed domain code: ${list(classification.businessLogic)}.`,
      facts: classification.businessLogic.map((f) => `Domain file: ${f}`), files: classification.businessLogic });
  }
  return proposals;
}

export interface StaleCandidate {
  id: string;
  category: MemoryCategory;
  confidence: MemoryConfidence;
  relatedFiles: string[];
  relatedCommits?: string[];
  updatedAt: string;
}

export interface StaleFinding {
  id: string;
  /** confirmed knowledge is never changed automatically: a review task is proposed instead. */
  action: 'mark_review' | 'review_task';
  reason: string;
  commit: string;
  suggestDeprecate: boolean;
}

/** Memories written within this window before a commit are about that change, not outdated by it. */
export const STALE_GRACE_MS = 24 * 3_600_000;

/**
 * Knowledge made outdated by a commit (CONTEXT_ENGINE.md §6): memories whose
 * related files the commit modified, renamed or deleted. Derived memories of
 * the same commit, git history records and fresh notes are left alone.
 */
export function findStaleKnowledge(commit: AnalyzedCommit, memories: StaleCandidate[], graceMs = STALE_GRACE_MS): StaleFinding[] {
  if (commit.parents.length > 1) return [];
  const touched = new Map<string, ChangeStatus>();
  for (const change of commit.changes) {
    touched.set(change.oldPath ?? change.path, change.status === 'R' ? 'D' : change.status);
    if (change.status !== 'R') touched.set(change.path, change.status);
  }
  const committed = Date.parse(commit.committedAt);
  const findings: StaleFinding[] = [];
  for (const memory of memories) {
    if (memory.category === 'git_history' || memory.confidence === 'deprecated' || memory.confidence === 'proposed') continue;
    if (memory.relatedCommits?.includes(commit.sha)) continue;
    if (Number.isFinite(committed) && Date.parse(memory.updatedAt) > committed - graceMs) continue;
    const hit = memory.relatedFiles.filter((file) => touched.has(file) && touched.get(file) !== 'A');
    if (!hit.length) continue;
    const deleted = memory.relatedFiles.length > 0 && memory.relatedFiles.every((file) => touched.get(file) === 'D');
    findings.push({
      id: memory.id,
      action: memory.confidence === 'confirmed' ? 'review_task' : 'mark_review',
      reason: deleted
        ? `all related files were deleted or moved in ${short(commit.sha)} (${commit.subject.slice(0, 80)}); consider deprecating`
        : `${list(hit, 4)} changed in ${short(commit.sha)} (${commit.subject.slice(0, 80)})`,
      commit: commit.sha,
      suggestDeprecate: deleted,
    });
  }
  return findings;
}

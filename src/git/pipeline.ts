/**
 * Incremental git analysis (CONTEXT_ENGINE.md §7): only commits in
 * `cursor..HEAD` are read — never the whole history. Commits missed because
 * no hook ran (pull, rebase, another machine) are caught up automatically,
 * because the base is the cursor, not "the current HEAD".
 *
 * Git is reached through an injectable `GitRunner`, so tests can prove which
 * revisions were touched.
 */
import { execFileSync } from 'node:child_process';

import {
  MANIFEST_PATTERN,
  classifyCommit,
  proposalsForCommit,
  type AnalyzedCommit,
  type ChangeStatus,
  type CommitClassification,
  type FileChange,
  type MemoryProposal,
} from './classify.js';

export type GitRunner = (args: string[]) => string;

export function defaultGitRunner(root: string): GitRunner {
  return (args) => execFileSync('git', ['-c', 'safe.directory=*', '-c', 'core.quotepath=off', ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
}

function tryGit(git: GitRunner, args: string[]): string | undefined {
  try {
    return git(args);
  } catch {
    return undefined;
  }
}

export interface AnalysisRange {
  head: string;
  branch: string | null;
  cursor: string | null;
  /** The cursor is not an ancestor of HEAD (rebase, force push, reset). */
  rewritten: boolean;
  /** First run without a cursor: only the most recent commits are analyzed. */
  initial: boolean;
  commits: string[];
}

export const DEFAULT_INITIAL_COMMITS = 50;
const MAX_RANGE = 2_000;

export function resolveRange(git: GitRunner, cursor: string | null, options: { initialCommits?: number } = {}): AnalysisRange {
  const head = git(['rev-parse', 'HEAD']).trim();
  const branch = currentBranch(git);
  const list = (args: string[]) => git(['rev-list', '--reverse', '--topo-order', ...args]).split('\n').map((line) => line.trim()).filter(Boolean);
  if (cursor === head) return { head, branch, cursor, rewritten: false, initial: false, commits: [] };
  const cursorKnown = Boolean(cursor && tryGit(git, ['cat-file', '-e', `${cursor}^{commit}`]) !== undefined);
  if (cursor && cursorKnown) {
    const ancestor = tryGit(git, ['merge-base', '--is-ancestor', cursor, head]) !== undefined;
    if (ancestor) return { head, branch, cursor, rewritten: false, initial: false, commits: list([`${cursor}..${head}`]).slice(-MAX_RANGE) };
    const base = tryGit(git, ['merge-base', cursor, head])?.trim();
    if (base) return { head, branch, cursor, rewritten: true, initial: false, commits: list([`${base}..${head}`]).slice(-MAX_RANGE) };
  }
  const limit = options.initialCommits ?? DEFAULT_INITIAL_COMMITS;
  return { head, branch, cursor, rewritten: Boolean(cursor), initial: !cursor, commits: list(['-n', String(limit), head]) };
}

const RECORD = '\x1e';
const FIELD = '\x1f';

/** Parse `git log --raw -M --numstat` for the given commits. */
export function readCommits(git: GitRunner, shas: string[]): AnalyzedCommit[] {
  const commits: AnalyzedCommit[] = [];
  for (let offset = 0; offset < shas.length; offset += 50) {
    const batch = shas.slice(offset, offset + 50);
    const raw = git(['log', '--no-walk=unsorted', `--format=${RECORD}%H${FIELD}%P${FIELD}%aN${FIELD}%aI${FIELD}%s${FIELD}%b${FIELD}`, '--raw', '-M', '--numstat', '--no-color', ...batch]);
    for (const record of raw.split(RECORD).filter((chunk) => chunk.trim())) {
      const fields = record.split(FIELD);
      const [sha, parents, author, committedAt, subject, body] = fields;
      const tail = fields.slice(6).join(FIELD);
      const changes = new Map<string, FileChange>();
      const numstat = new Map<string, { add: number; del: number }>();
      for (const line of tail.split('\n')) {
        if (line.startsWith(':')) {
          const [meta, ...paths] = line.split('\t');
          const status = meta.split(' ').at(-1)!.charAt(0) as ChangeStatus;
          if (status === 'R' || status === 'C') changes.set(paths[1], { path: paths[1], oldPath: paths[0], status, additions: 0, deletions: 0 });
          else changes.set(paths[0], { path: paths[0], status, additions: 0, deletions: 0 });
        } else if (/^(\d+|-)\t(\d+|-)\t/.test(line)) {
          const [add, del, ...rest] = line.split('\t');
          const pathPart = rest.join('\t');
          // Renames print "old => new" or "dir/{old => new}/file".
          const renamed = pathPart.includes(' => ')
            ? pathPart.replace(/\{([^{}]*) => ([^{}]*)\}/, '$2').replace(/^.* => /, '').replace(/\/\//g, '/')
            : pathPart;
          numstat.set(renamed, { add: Number(add) || 0, del: Number(del) || 0 });
        }
      }
      for (const [file, stat] of numstat) {
        const change = changes.get(file);
        if (change) { change.additions = stat.add; change.deletions = stat.del; }
      }
      commits.push({
        sha: sha.trim(),
        parents: parents.trim() ? parents.trim().split(' ') : [],
        author,
        committedAt,
        subject,
        body: body.trim(),
        changes: [...changes.values()],
      });
    }
  }
  const order = new Map(shas.map((sha, index) => [sha, index]));
  return commits.sort((a, b) => (order.get(a.sha) ?? 0) - (order.get(b.sha) ?? 0));
}

/** Extra facts the classifiers need, read only for commits that need them. */
function enrich(git: GitRunner, commit: AnalyzedCommit): void {
  if (commit.parents.length > 1) return;
  const manifests = commit.changes.filter((change) => MANIFEST_PATTERN.test(change.path) && change.status !== 'D').map((change) => change.path);
  if (manifests.length) {
    const diff = tryGit(git, ['show', '--format=', '--unified=0', '--no-color', commit.sha, '--', ...manifests]) ?? '';
    commit.manifestDiff = diff.slice(0, 20 * 1024);
  }
  const addedTop = new Set(commit.changes.filter((change) => change.status === 'A' && change.path.includes('/')).map((change) => change.path.split('/')[0]));
  if (addedTop.size && commit.parents[0]) {
    const before = new Set((tryGit(git, ['ls-tree', '--name-only', commit.parents[0]]) ?? '').split('\n').map((line) => line.trim()).filter(Boolean));
    commit.newTopLevelDirs = [...addedTop].filter((dir) => !before.has(dir));
  } else if (addedTop.size && !commit.parents.length) {
    commit.newTopLevelDirs = [...addedTop];
  }
}

export interface CommitAnalysis {
  commit: AnalyzedCommit;
  classification: CommitClassification;
  proposals: MemoryProposal[];
}

export interface AnalysisResult {
  range: AnalysisRange;
  commits: CommitAnalysis[];
  ms: number;
}

export function analyzeRange(git: GitRunner, cursor: string | null, options: { initialCommits?: number; domainPaths?: string[] } = {}): AnalysisResult {
  const started = Date.now();
  const range = resolveRange(git, cursor, options);
  const commits = readCommits(git, range.commits).map((commit) => {
    enrich(git, commit);
    const classification = classifyCommit(commit, { domainPaths: options.domainPaths });
    return { commit, classification, proposals: proposalsForCommit(commit, classification) };
  });
  return { range, commits, ms: Date.now() - started };
}

export function currentBranch(git: GitRunner): string | null {
  return tryGit(git, ['symbolic-ref', '--short', '-q', 'HEAD'])?.trim() || null;
}

/** Repository identity that survives renames and forks: the oldest root commit. */
export function rootCommit(git: GitRunner): string | undefined {
  return tryGit(git, ['rev-list', '--max-parents=0', 'HEAD'])?.split('\n').map((line) => line.trim()).filter(Boolean).sort()[0];
}

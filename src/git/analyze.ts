/**
 * `baton git analyze`: one entry point for both modes. Linked to a Baton server,
 * the cursor and the resulting knowledge are shared by the team (the server
 * writes the memories, clients receive them by sync); otherwise everything
 * stays in the local store.
 */
import type { BatonApiClient } from '../client/api.js';
import { BatonApiError } from '../client/api.js';
import { readProjectLink, tokenFor } from '../client/config.js';
import { createApiClient } from '../client/api.js';
import { analyzeLocal, countClasses, reconcileLocal, type GitAnalyzeReport } from './local-sink.js';
import { analyzeRange, currentBranch, defaultGitRunner, rootCommit, type GitRunner } from './pipeline.js';
import { getDatabase } from '../store/sqlite-db.js';

const CHUNK = 50;

/** The root commit walks the history, so it is computed once per working copy and remembered. */
function cachedRootCommit(dataDir: string, root: string, git: GitRunner): string | undefined {
  const db = getDatabase(dataDir);
  const key = `baton_git_root:${root}`;
  const cached = (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  if (cached) return cached;
  const repo = rootCommit(git);
  if (repo) db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, repo);
  return repo;
}

async function analyzeConnected(api: BatonApiClient, projectId: string, legacyProjectId: string, git: GitRunner, repo: string | undefined, options: { initialCommits?: number; domainPaths?: string[] }): Promise<GitAnalyzeReport> {
  if (!repo) throw new Error('[baton] the repository has no commits to analyze');
  const branch = currentBranch(git) ?? 'HEAD';
  for (let attempt = 0; ; attempt++) {
    const { cursor } = await api.get<{ cursor: string | null }>(`/v1/projects/${projectId}/git/cursor?root_commit=${repo}&branch=${encodeURIComponent(branch)}`);
    const result = analyzeRange(git, cursor, options);
    const report: GitAnalyzeReport = {
      mode: 'server', commitsAnalyzed: 0, memoriesWritten: 0, staleMarked: 0, reviewTasks: 0,
      cursor: { from: cursor, to: result.range.head }, branch, rewritten: result.range.rewritten, initial: result.range.initial,
      ms: result.ms, classes: countClasses(result),
    };
    if (cursor === result.range.head) return report;
    try {
      let expected = cursor;
      const chunks = result.commits.length ? Math.ceil(result.commits.length / CHUNK) : 1;
      for (let index = 0; index < chunks; index++) {
        const slice = result.commits.slice(index * CHUNK, (index + 1) * CHUNK);
        const last = index === chunks - 1;
        const next = last ? result.range.head : slice.at(-1)!.commit.sha;
        const posted = await api.post<{ analyzed: number; memoriesWritten: number; staleMarked: number; reviewTasks: number }>(`/v1/projects/${projectId}/git/commits`, {
          root_commit: repo,
          branch,
          legacy_project_id: legacyProjectId,
          expected_cursor: expected,
          new_cursor: next,
          rewritten: result.range.rewritten,
          commits: slice.map(({ commit, classification, proposals }) => ({
            sha: commit.sha, parents: commit.parents, author: commit.author, committedAt: commit.committedAt,
            subject: commit.subject, changes: commit.changes, classification, proposals,
          })),
        });
        report.commitsAnalyzed += posted.analyzed;
        report.memoriesWritten += posted.memoriesWritten;
        report.staleMarked += posted.staleMarked;
        report.reviewTasks += posted.reviewTasks;
        expected = next;
      }
      return report;
    } catch (error) {
      // Another client moved the cursor first: start over from the new cursor once.
      if (error instanceof BatonApiError && error.code === 'cursor_moved' && attempt === 0) continue;
      throw error;
    }
  }
}

async function reconcileConnected(api: BatonApiClient, projectId: string, git: GitRunner, repo: string | undefined): Promise<{ checked: number; marked: number }> {
  if (!repo) throw new Error('[baton] the repository has no commits');
  const head = git(['rev-parse', 'HEAD']).trim();
  const tree = new Set(git(['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').map((line) => line.trim()).filter(Boolean));
  const { memories } = await api.get<{ memories: Array<{ id: string; files: string[]; confidence: string }> }>(`/v1/projects/${projectId}/git/related-files`);
  const findings = memories
    .map((memory) => ({ id: memory.id, missing: memory.files.filter((file) => !tree.has(file)) }))
    .filter((finding) => finding.missing.length);
  const result = await api.post<{ marked: number }>(`/v1/projects/${projectId}/git/reconcile`, {
    root_commit: repo, branch: currentBranch(git) ?? 'HEAD', head, findings,
  });
  return { checked: memories.length, marked: result.marked };
}

export interface AnalyzeProjectInput {
  dataDir: string;
  projectId: string;
  root: string;
  full?: boolean;
  git?: GitRunner;
  initialCommits?: number;
  domainPaths?: string[];
  env?: NodeJS.ProcessEnv;
}

export async function analyzeProject(input: AnalyzeProjectInput): Promise<GitAnalyzeReport & { reconcile?: { checked: number; marked: number } }> {
  const git = input.git ?? defaultGitRunner(input.root);
  const env = input.env ?? process.env;
  const link = readProjectLink(input.root);
  const token = link ? tokenFor(link.server, env) : undefined;
  const options = {
    initialCommits: input.initialCommits ?? (Number(env.BATON_GIT_INITIAL_COMMITS) || undefined),
    domainPaths: input.domainPaths ?? link?.domainPaths,
  };
  if (link && token) {
    const api = createApiClient(link.server, token, { timeoutMs: 60_000 });
    const repo = cachedRootCommit(input.dataDir, input.root, git);
    const report = await analyzeConnected(api, link.projectId, link.legacyProjectId, git, repo, options);
    return input.full ? { ...report, reconcile: await reconcileConnected(api, link.projectId, git, repo) } : report;
  }
  const report = await analyzeLocal({ dataDir: input.dataDir, projectId: input.projectId, root: input.root, git, ...options });
  return input.full ? { ...report, reconcile: await reconcileLocal({ dataDir: input.dataDir, projectId: input.projectId, root: input.root, git }) } : report;
}

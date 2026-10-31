/**
 * Local mode of git intelligence: the cursor lives in SQLite
 * (`pmi_git_cursors`), proposals become observations (source `git`, topic
 * keys per commit, so re-analysis updates instead of duplicating), and
 * knowledge the commits may have outdated gets a review mark. Connected
 * mode does the same on the server (src/server/central/git-repo.ts).
 */
import { classifyObservation } from '../domain/memory.js';
import type { MemoryCategory } from '../domain/memory.js';
import { getAllObservations, markObservationsForReview, storeObservation } from '../memory/observations.js';
import { getDatabase } from '../store/sqlite-db.js';
import type { ObservationType } from '../types.js';
import { findStaleKnowledge, type MemoryProposal, type StaleCandidate } from './classify.js';
import { analyzeRange, currentBranch, defaultGitRunner, rootCommit, type AnalysisResult, type GitRunner } from './pipeline.js';

export interface GitAnalyzeReport {
  mode: 'local' | 'server';
  commitsAnalyzed: number;
  memoriesWritten: number;
  staleMarked: number;
  reviewTasks: number;
  cursor: { from: string | null; to: string };
  branch: string | null;
  rewritten: boolean;
  initial: boolean;
  ms: number;
  classes: Record<string, number>;
}

const TYPE_FOR: Partial<Record<MemoryCategory, ObservationType>> = {
  git_history: 'what-changed',
  dependency: 'what-changed',
  architecture: 'how-it-works',
  development_history: 'what-changed',
  solution: 'problem-solution',
  business_logic: 'how-it-works',
  active_task: 'discovery',
};

export function countClasses(result: AnalysisResult): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { classification } of result.commits) {
    for (const [key, value] of Object.entries(classification)) {
      if (key !== 'merge' && value) counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return counts;
}

function cursorKey(branch: string | null): string {
  return branch ?? 'HEAD';
}

export function readLocalCursor(dataDir: string, root: string, branch: string | null): string | null {
  const row = getDatabase(dataDir).prepare('SELECT cursor FROM pmi_git_cursors WHERE root_commit = ? AND branch = ?').get(root, cursorKey(branch)) as { cursor: string } | undefined;
  return row?.cursor ?? null;
}

function writeLocalCursor(dataDir: string, root: string, branch: string | null, projectId: string, cursor: string, reconciled = false): void {
  const now = new Date().toISOString();
  getDatabase(dataDir).prepare(`
    INSERT INTO pmi_git_cursors (root_commit, branch, project_id, cursor, last_full_reconcile_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(root_commit, branch) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at,
      last_full_reconcile_at = COALESCE(excluded.last_full_reconcile_at, pmi_git_cursors.last_full_reconcile_at)
  `).run(root, cursorKey(branch), projectId, cursor, reconciled ? now : null, now);
}

async function writeProposal(projectId: string, proposal: MemoryProposal): Promise<void> {
  await storeObservation({
    entityName: proposal.component,
    type: TYPE_FOR[proposal.category] ?? 'what-changed',
    title: proposal.title,
    narrative: proposal.content,
    facts: proposal.facts,
    filesModified: proposal.files,
    projectId,
    topicKey: proposal.topicKey,
    source: 'git',
    sourceDetail: 'git-ingest',
    commitHash: proposal.commit,
    relatedCommits: [proposal.commit],
    category: proposal.category,
    confidence: proposal.confidence,
  });
}

function localCandidates(projectId: string): Array<StaleCandidate & { title: string }> {
  return getAllObservations()
    .filter((obs) => obs.projectId === projectId && obs.source !== 'git' && (obs.status ?? 'active') === 'active' && (obs.filesModified?.length ?? 0) > 0)
    .map((obs) => {
      const { category, confidence } = classifyObservation(obs);
      return { id: String(obs.id), title: obs.title, category, confidence, relatedFiles: obs.filesModified, relatedCommits: obs.relatedCommits, updatedAt: obs.updatedAt ?? obs.createdAt };
    });
}

/** Mark or open review tasks for knowledge the analyzed commits may have outdated. */
async function applyStaleness(projectId: string, result: AnalysisResult): Promise<{ marked: number; tasks: number }> {
  const candidates = localCandidates(projectId);
  const marks: Array<{ id: number; review: { reason: string; since: string; commit: string } }> = [];
  let tasks = 0;
  for (const { commit } of result.commits) {
    for (const finding of findStaleKnowledge(commit, candidates)) {
      if (finding.action === 'mark_review') {
        marks.push({ id: Number(finding.id), review: { reason: finding.reason, since: commit.committedAt, commit: commit.sha } });
      } else {
        const target = candidates.find((candidate) => candidate.id === finding.id)!;
        await storeObservation({
          entityName: 'review',
          type: 'discovery',
          title: `Review confirmed knowledge: ${target.title}`.slice(0, 200),
          narrative: `Confirmed knowledge "${target.title}" (#${target.id}) may be outdated: ${finding.reason}. Confirm it again or deprecate it.`,
          filesModified: target.relatedFiles,
          projectId,
          topicKey: `review:${finding.id}`,
          source: 'git',
          relatedCommits: [commit.sha],
          category: 'active_task',
          confidence: 'observed',
        });
        tasks++;
      }
    }
  }
  const marked = marks.length ? await markObservationsForReview(marks) : [];
  return { marked: marked.length, tasks };
}

/**
 * Analyze `cursor..HEAD` of the working copy into local memory and move the
 * cursor. Running it again without new commits reads nothing but HEAD.
 */
export async function analyzeLocal(input: {
  dataDir: string;
  projectId: string;
  root: string;
  git?: GitRunner;
  initialCommits?: number;
  domainPaths?: string[];
}): Promise<GitAnalyzeReport> {
  const git = input.git ?? defaultGitRunner(input.root);
  const branch = currentBranch(git);
  // The root commit is computed once (it walks the history) and remembered with the cursor.
  const known = getDatabase(input.dataDir).prepare('SELECT root_commit FROM pmi_git_cursors WHERE project_id = ? AND branch = ?')
    .get(input.projectId, cursorKey(branch)) as { root_commit: string } | undefined;
  const repo = known?.root_commit ?? rootCommit(git);
  if (!repo) throw new Error('[pmi] the repository has no commits to analyze');
  const from = readLocalCursor(input.dataDir, repo, branch);
  const result = analyzeRange(git, from, { initialCommits: input.initialCommits, domainPaths: input.domainPaths });
  let written = 0;
  for (const analysis of result.commits) {
    for (const proposal of analysis.proposals) {
      await writeProposal(input.projectId, proposal);
      written++;
    }
  }
  const stale = result.commits.length ? await applyStaleness(input.projectId, result) : { marked: 0, tasks: 0 };
  writeLocalCursor(input.dataDir, repo, branch, input.projectId, result.range.head);
  return {
    mode: 'local',
    commitsAnalyzed: result.commits.length,
    memoriesWritten: written,
    staleMarked: stale.marked,
    reviewTasks: stale.tasks,
    cursor: { from, to: result.range.head },
    branch,
    rewritten: result.range.rewritten,
    initial: result.range.initial,
    ms: result.ms,
    classes: countClasses(result),
  };
}

/**
 * Full reconcile (§7): every related file of active knowledge must still
 * exist at HEAD; missing ones mark the memory for review.
 */
export async function reconcileLocal(input: { dataDir: string; projectId: string; root: string; git?: GitRunner }): Promise<{ checked: number; marked: number }> {
  const git = input.git ?? defaultGitRunner(input.root);
  const tree = new Set(git(['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').map((line) => line.trim()).filter(Boolean));
  const head = git(['rev-parse', 'HEAD']).trim();
  const candidates = localCandidates(input.projectId);
  const marks = candidates
    .filter((candidate) => candidate.confidence !== 'confirmed')
    .map((candidate) => ({ candidate, missing: candidate.relatedFiles.filter((file) => !tree.has(file)) }))
    .filter((item) => item.missing.length)
    .map((item) => ({ id: Number(item.candidate.id), review: { reason: `related files no longer exist at ${head.slice(0, 10)}: ${item.missing.slice(0, 5).join(', ')}`, since: new Date().toISOString(), commit: head } }));
  const marked = marks.length ? await markObservationsForReview(marks) : [];
  const repo = rootCommit(git);
  const branch = currentBranch(git);
  if (repo) {
    const cursor = readLocalCursor(input.dataDir, repo, branch) ?? head;
    writeLocalCursor(input.dataDir, repo, branch, input.projectId, cursor, true);
  }
  return { checked: candidates.length, marked: marked.length };
}

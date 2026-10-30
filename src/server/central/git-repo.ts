/**
 * Connected mode of git intelligence (CONTEXT_ENGINE.md §7): one cursor per
 * repository and branch for the whole team. A client analyzes
 * `cursor..HEAD` locally and posts the result; the server records the
 * commits, writes the proposed memories itself (so every client receives
 * them through the changes feed), marks knowledge the commits outdated, and
 * moves the cursor — atomically, with an expected-cursor check, so two
 * clients never analyze the same commits twice.
 */
import { countTextTokens } from '../../compact/token-budget.js';
import { findStaleKnowledge, type AnalyzedCommit, type CommitClassification, type MemoryProposal, type StaleCandidate } from '../../git/classify.js';
import type { MemoryCategory, MemoryConfidence } from '../../domain/memory.js';
import type { Observation, ObservationType } from '../../types.js';
import type { Queryable } from './db.js';
import { HttpError, audit, type AuthUser, type ProjectRecord } from './identity.js';
import { writeServerMemory } from './memory-repo.js';

const TYPE_FOR: Partial<Record<MemoryCategory, ObservationType>> = {
  git_history: 'what-changed',
  dependency: 'what-changed',
  architecture: 'how-it-works',
  development_history: 'what-changed',
  solution: 'problem-solution',
  business_logic: 'how-it-works',
  active_task: 'discovery',
};

export interface PostedCommit extends Pick<AnalyzedCommit, 'sha' | 'parents' | 'author' | 'subject' | 'changes'> {
  committedAt: string;
  classification: CommitClassification;
  proposals: MemoryProposal[];
}

/** Repository row of a project by root commit, created on first use (owner connection). */
export async function resolveRepository(owner: Queryable, projectId: string, rootCommit: string): Promise<string> {
  const [row] = await owner.query<{ id: string }>(
    `INSERT INTO core.repositories (project_id, root_commit) VALUES ($1, $2)
     ON CONFLICT (project_id, root_commit) DO UPDATE SET root_commit = excluded.root_commit RETURNING id`,
    [projectId, rootCommit],
  );
  return row.id;
}

export async function getCursor(tx: Queryable, repositoryId: string, branch: string): Promise<{ cursor: string | null; lastFullReconcileAt: string | null }> {
  const [row] = await tx.query<{ last_analyzed_commit: string; last_full_reconcile_at: string | null }>(
    'SELECT last_analyzed_commit, last_full_reconcile_at FROM work.git_cursors WHERE repository_id = $1 AND branch = $2',
    [repositoryId, branch],
  );
  return { cursor: row?.last_analyzed_commit ?? null, lastFullReconcileAt: row?.last_full_reconcile_at ?? null };
}

function syncKeyFor(legacyProjectId: string, topicKey: string): string {
  // The same key a client derives for a topic-keyed observation (src/sync/journal.ts).
  return `p:${encodeURIComponent(legacyProjectId)}:t:${encodeURIComponent(topicKey)}`;
}

function proposalBody(legacyProjectId: string, proposal: MemoryProposal, committedAt: string): Observation {
  const text = [proposal.title, proposal.content, ...proposal.facts].join(' ');
  return {
    id: 1,
    entityName: proposal.component,
    type: TYPE_FOR[proposal.category] ?? 'what-changed',
    title: proposal.title,
    narrative: proposal.content,
    facts: proposal.facts,
    filesModified: proposal.files,
    concepts: [],
    tokens: countTextTokens(text),
    createdAt: committedAt,
    projectId: legacyProjectId,
    topicKey: proposal.topicKey,
    revisionCount: 1,
    status: 'active',
    source: 'git',
    sourceDetail: 'git-ingest',
    commitHash: proposal.commit,
    relatedCommits: [proposal.commit],
    visibility: 'project',
    category: proposal.category,
    confidence: proposal.confidence,
  };
}

async function staleCandidates(tx: Queryable, projectId: string, files: string[]): Promise<Array<StaleCandidate & { body: Observation; title: string; legacy: string }>> {
  if (!files.length) return [];
  const rows = await tx.query<{ id: string; category: MemoryCategory; confidence: MemoryConfidence; related_files: string[]; related_commits: string[]; updated_at: string; body: Observation; title: string; legacy_project_id: string }>(
    `SELECT id, category, confidence, related_files, related_commits, updated_at, body, title, legacy_project_id FROM memory.memories
      WHERE project_id = $1 AND deleted_at IS NULL AND source <> 'git' AND status = 'active' AND body IS NOT NULL AND related_files && $2::text[]`,
    [projectId, files],
  );
  return rows.map((row) => ({
    id: row.id, category: row.category, confidence: row.confidence, relatedFiles: row.related_files, relatedCommits: row.related_commits,
    updatedAt: new Date(row.updated_at).toISOString(), body: row.body, title: row.title, legacy: row.legacy_project_id,
  }));
}

export interface PostCommitsReport {
  analyzed: number;
  duplicates: number;
  memoriesWritten: number;
  staleMarked: number;
  reviewTasks: number;
  cursor: string;
}

export async function postCommits(
  tx: Queryable,
  owner: Queryable,
  project: ProjectRecord,
  user: AuthUser,
  input: { rootCommit: string; branch: string; legacyProjectId: string; expectedCursor: string | null; newCursor: string; rewritten: boolean; commits: PostedCommit[] },
): Promise<PostCommitsReport> {
  if (!project.legacyProjectIds.includes(input.legacyProjectId)) {
    throw new HttpError(409, 'identity_mismatch', `project "${project.slug}" does not replicate ${input.legacyProjectId}`);
  }
  const repositoryId = await resolveRepository(owner, project.id, input.rootCommit);
  const [locked] = await tx.query<{ last_analyzed_commit: string }>(
    'SELECT last_analyzed_commit FROM work.git_cursors WHERE repository_id = $1 AND branch = $2 FOR UPDATE',
    [repositoryId, input.branch],
  );
  const current = locked?.last_analyzed_commit ?? null;
  if (current !== input.expectedCursor) {
    throw new HttpError(409, 'cursor_moved', 'another client analyzed this branch meanwhile; re-read the cursor', { cursor: current });
  }
  const report: PostCommitsReport = { analyzed: 0, duplicates: 0, memoriesWritten: 0, staleMarked: 0, reviewTasks: 0, cursor: input.newCursor };
  for (const commit of input.commits) {
    const inserted = await tx.query(
      `INSERT INTO work.git_commits (repository_id, project_id, sha, parents, author, committed_at, subject, changes, classification, rewritten, analyzed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11) ON CONFLICT (repository_id, sha) DO NOTHING RETURNING sha`,
      [repositoryId, project.id, commit.sha, commit.parents, commit.author, commit.committedAt, commit.subject,
        JSON.stringify(commit.changes), JSON.stringify(commit.classification), input.rewritten, user.id],
    );
    if (!inserted.length) {
      report.duplicates++;
      continue;
    }
    report.analyzed++;
    const historyKey = syncKeyFor(input.legacyProjectId, `git:${commit.sha}`);
    for (const proposal of commit.proposals) {
      const syncKey = syncKeyFor(input.legacyProjectId, proposal.topicKey);
      const { written } = await writeServerMemory(tx, project, user, { syncKey, legacyProjectId: input.legacyProjectId, body: proposalBody(input.legacyProjectId, proposal, commit.committedAt), reason: 'git analysis' });
      if (written) report.memoriesWritten++;
      if (syncKey !== historyKey) {
        await tx.query(
          `INSERT INTO memory.memory_links (from_id, to_id, kind) SELECT $1, $2, 'derived_from'
            WHERE EXISTS (SELECT 1 FROM memory.memories WHERE id = $2) ON CONFLICT DO NOTHING`,
          [syncKey, historyKey],
        );
      }
    }

    const touched = [...new Set(commit.changes.flatMap((change) => [change.path, ...(change.oldPath ? [change.oldPath] : [])]))];
    const candidates = await staleCandidates(tx, project.id, touched);
    const analyzed: AnalyzedCommit = { ...commit, body: '' };
    for (const finding of findStaleKnowledge(analyzed, candidates)) {
      const target = candidates.find((candidate) => candidate.id === finding.id)!;
      if (finding.action === 'mark_review') {
        const body: Observation = { ...target.body, review: { reason: finding.reason, since: commit.committedAt, commit: commit.sha } };
        if ((await writeServerMemory(tx, project, user, { syncKey: target.id, legacyProjectId: target.legacy, body, reason: `git review: ${finding.reason}`.slice(0, 500) })).written) report.staleMarked++;
      } else {
        const task: MemoryProposal = {
          topicKey: `review:${target.id}`, category: 'active_task', confidence: 'observed', commit: commit.sha, component: 'review',
          title: `Review confirmed knowledge: ${target.title}`.slice(0, 200),
          content: `Confirmed knowledge "${target.title}" (${target.id}) may be outdated: ${finding.reason}. Confirm it again or deprecate it.`,
          facts: [`Memory: ${target.id}`, `Commit: ${commit.sha}`], files: target.relatedFiles,
        };
        if ((await writeServerMemory(tx, project, user, { syncKey: syncKeyFor(input.legacyProjectId, task.topicKey), legacyProjectId: input.legacyProjectId, body: proposalBody(input.legacyProjectId, task, commit.committedAt), reason: 'git review task' })).written) report.reviewTasks++;
      }
    }
  }
  await tx.query(
    `INSERT INTO work.git_cursors (repository_id, project_id, branch, last_analyzed_commit, updated_at) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (repository_id, branch) DO UPDATE SET last_analyzed_commit = excluded.last_analyzed_commit, updated_at = now()`,
    [repositoryId, project.id, input.branch, input.newCursor],
  );
  await audit(tx, {
    action: 'git.analyze', actorUserId: user.id, orgId: project.orgId, projectId: project.id, targetType: 'repository', targetId: repositoryId,
    detail: { branch: input.branch, from: input.expectedCursor, to: input.newCursor, ...report },
  });
  return report;
}

/** Related files of active knowledge, for a client-side full reconcile against its working copy. */
export async function relatedFiles(tx: Queryable, projectId: string): Promise<Array<{ id: string; files: string[]; confidence: MemoryConfidence }>> {
  return tx.query(
    `SELECT id, related_files AS files, confidence FROM memory.memories
      WHERE project_id = $1 AND deleted_at IS NULL AND source <> 'git' AND status = 'active' AND cardinality(related_files) > 0
      LIMIT 20000`,
    [projectId],
  );
}

export async function applyReconcile(
  tx: Queryable,
  owner: Queryable,
  project: ProjectRecord,
  user: AuthUser,
  input: { rootCommit: string; branch: string; head: string; findings: Array<{ id: string; missing: string[] }> },
): Promise<{ marked: number }> {
  let marked = 0;
  for (const finding of input.findings) {
    const [row] = await tx.query<{ body: Observation; confidence: MemoryConfidence; legacy_project_id: string }>(
      `SELECT body, confidence, legacy_project_id FROM memory.memories WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL AND body IS NOT NULL`,
      [finding.id, project.id],
    );
    if (!row || row.confidence === 'confirmed' || !finding.missing.length) continue;
    const reason = `related files no longer exist at ${input.head.slice(0, 10)}: ${finding.missing.slice(0, 5).join(', ')}`;
    const body: Observation = { ...row.body, review: { reason, since: new Date().toISOString(), commit: input.head } };
    if ((await writeServerMemory(tx, project, user, { syncKey: finding.id, legacyProjectId: row.legacy_project_id, body, reason: `reconcile: ${reason}` })).written) marked++;
  }
  const repositoryId = await resolveRepository(owner, project.id, input.rootCommit);
  // Only stamp an existing cursor: a reconcile is not an analysis and must not skip commits.
  await tx.query(
    'UPDATE work.git_cursors SET last_full_reconcile_at = now(), updated_at = now() WHERE repository_id = $1 AND branch = $2',
    [repositoryId, input.branch],
  );
  await audit(tx, { action: 'git.reconcile', actorUserId: user.id, orgId: project.orgId, projectId: project.id, targetType: 'repository', targetId: repositoryId, detail: { marked, findings: input.findings.length } });
  return { marked };
}

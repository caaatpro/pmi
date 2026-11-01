/**
 * Baton context engine (docs/baton/CONTEXT_ENGINE.md §2, §4, §5): builds the
 * smallest sufficient context for a task from project memory.
 *
 *   L1 — project overview: purpose, architecture, conventions, current state,
 *        confirmed decisions (titles). Always included, ≤ 800 tokens.
 *   L2 — memories ranked for the task, plus the session's next action and
 *        open problems. Packed into the budget, compressing entries
 *        full → title + facts → title + id before dropping them.
 *   L3 — history (versions, deprecated knowledge, past sessions), only on
 *        request.
 *
 * Pure: no I/O. The central server feeds it hybrid-search results from
 * Postgres; the local client feeds it its SQLite memory when offline. Agents
 * fetch details by id (memory_get), so nothing here dumps full histories.
 */
import { resolveTaskLens, type TaskLensId } from '../codegraph/task-lens.js';
import { countTextTokens } from '../compact/token-budget.js';
import type { MemoryCategory, MemoryConfidence, MemoryStatus } from '../domain/memory.js';
import type { SessionState } from '../domain/session.js';
import { redactCredentials } from '../memory/secret-filter.js';

export type ContextLevel = 'L1' | 'L2' | 'L3';

export interface ContextMemory {
  id: string;
  category: MemoryCategory;
  confidence: MemoryConfidence;
  status: MemoryStatus;
  title: string;
  content: string;
  facts: string[];
  component: string | null;
  relatedFiles: string[];
  updatedAt: string;
  /** Search relevance in [0, 1] (RRF-normalized); computed lexically when absent. */
  relevance?: number;
  /** Feedback multiplier from memory feedback (1 = neutral). */
  feedbackWeight?: number;
  /** Flagged by a conflict or contradiction; shown with a warning, never hidden. */
  conflicted?: boolean;
}

export interface HistoryItem {
  title: string;
  detail: string;
}

export interface ContextRequest {
  task?: string;
  /** Total token budget for the package (L1 + session + L2 [+ L3]). */
  budgetTokens?: number;
  levels?: ContextLevel[];
  /** Files the task touches (explicit or from the session's working copy). */
  files?: string[];
  components?: string[];
  session?: SessionState | null;
  /** Files changed by recent commits on the branch. */
  recentGitFiles?: string[];
  history?: HistoryItem[];
  projectName?: string;
  now?: number;
}

export interface IncludedEntry {
  id: string;
  level: ContextLevel;
  form: 'full' | 'facts' | 'title';
  score?: number;
}

export interface ContextReceipt {
  tokensTotal: number;
  tokensByLevel: Record<ContextLevel | 'session', number>;
  budgetTokens: number;
  candidates: number;
  included: number;
  truncated: number;
  omitted: number;
  lens: TaskLensId;
  buildMs: number;
  cacheHit: boolean;
}

export interface ContextPackage {
  text: string;
  included: IncludedEntry[];
  receipt: ContextReceipt;
}

export const DEFAULT_BUDGET_TOKENS = 2_300;
export const L1_BUDGET_TOKENS = 800;

const L1_CATEGORIES: readonly MemoryCategory[] = ['project_overview', 'architecture', 'component', 'coding_convention', 'current_state', 'active_task'];
/** Categories that are history, not working context: L3 only. */
const L3_CATEGORIES: readonly MemoryCategory[] = ['session_history'];

const CONFIDENCE_WEIGHT: Record<MemoryConfidence, number> = { confirmed: 1, observed: 0.9, inferred: 0.7, proposed: 0.5, deprecated: 0 };

/** Which categories matter more for which kind of task (§4 category_weight). */
const LENS_WEIGHTS: Partial<Record<TaskLensId, Partial<Record<MemoryCategory, number>>>> = {
  bugfix: { issue: 1.5, solution: 1.5, known_limitation: 1.4, architecture_decision: 1.1, git_history: 1.1 },
  feature: { architecture: 1.4, architecture_decision: 1.5, coding_convention: 1.3, component: 1.2, business_logic: 1.3, dependency: 1.1 },
  refactor: { architecture: 1.4, architecture_decision: 1.4, coding_convention: 1.4, component: 1.3, known_limitation: 1.2 },
  release: { dependency: 1.4, known_limitation: 1.3, git_history: 1.3, current_state: 1.3 },
  test: { coding_convention: 1.4, known_limitation: 1.3, solution: 1.2 },
  docs: { project_overview: 1.4, architecture: 1.3, coding_convention: 1.2 },
  onboarding: { project_overview: 1.5, architecture: 1.4, coding_convention: 1.3, component: 1.2 },
};

const HALF_LIFE_DAYS = 120;

function tokensOf(text: string): number {
  return countTextTokens(text);
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((word) => word.length > 2);
}

/** Lexical relevance in [0, 1] for local use when no search ranking is available. */
export function lexicalRelevance(task: string | undefined, memory: Pick<ContextMemory, 'title' | 'content' | 'facts' | 'component'>): number {
  const query = new Set(words(task ?? ''));
  if (query.size === 0) return 0;
  const title = new Set(words(`${memory.title} ${memory.component ?? ''}`));
  const body = new Set(words(`${memory.content} ${memory.facts.join(' ')}`));
  let hits = 0;
  for (const word of query) {
    if (title.has(word)) hits += 2;
    else if (body.has(word)) hits += 1;
  }
  return Math.min(1, hits / (query.size * 2));
}

/**
 * Reciprocal Rank Fusion of ranked id lists (§3): score = Σ 1/(k + rank).
 * Returns scores normalized to [0, 1] by the best one.
 */
export function reciprocalRankFusion(lists: string[][], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1)));
  }
  const best = Math.max(0, ...scores.values());
  if (best > 0) for (const [id, score] of scores) scores.set(id, score / best);
  return scores;
}

function overlap(a: string[], b: Set<string>): number {
  let count = 0;
  for (const item of a) if (b.has(item)) count++;
  return count;
}

export interface RankedMemory {
  memory: ContextMemory;
  score: number;
}

/** L2 score (§4). Deprecated, archived and history categories never reach L2. */
export function rankMemories(memories: ContextMemory[], request: ContextRequest): RankedMemory[] {
  const lens = resolveTaskLens(request.task);
  const weights = LENS_WEIGHTS[lens.id] ?? {};
  const now = request.now ?? Date.now();
  const files = new Set([...(request.files ?? []), ...(request.session?.git?.modifiedFiles.map((file) => file.path) ?? [])]);
  const gitFiles = new Set(request.recentGitFiles ?? []);
  const components = new Set((request.components ?? []).map((component) => component.toLowerCase()));
  const ranked: RankedMemory[] = [];
  for (const memory of memories) {
    if (memory.confidence === 'deprecated' || memory.status === 'archived' || memory.status === 'resolved') continue;
    if (L3_CATEGORIES.includes(memory.category)) continue;
    const relevance = memory.relevance ?? lexicalRelevance(request.task, memory);
    const ageDays = Math.max(0, (now - Date.parse(memory.updatedAt)) / 86_400_000);
    const freshness = Math.pow(0.5, ageDays / HALF_LIFE_DAYS) * (memory.status === 'needs_review' ? 0.6 : 1);
    const base = (0.15 + relevance) * (weights[memory.category] ?? 1) * CONFIDENCE_WEIGHT[memory.confidence] * freshness * (memory.feedbackWeight ?? 1);
    const fileAffinity = Math.min(0.6, 0.3 * overlap(memory.relatedFiles, files));
    const componentAffinity = memory.component && components.has(memory.component.toLowerCase()) ? 0.2 : 0;
    const gitBonus = Math.min(0.2, 0.1 * overlap(memory.relatedFiles, gitFiles));
    ranked.push({ memory, score: base + fileAffinity + componentAffinity + gitBonus });
  }
  return ranked.sort((a, b) => b.score - a.score || a.memory.id.localeCompare(b.memory.id));
}

function confidenceMark(confidence: MemoryConfidence): string {
  return confidence === 'confirmed' ? '' : ` (${confidence})`;
}

function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * L1 Project Overview (§2): deterministic template from the overview
 * categories, confirmed/observed first, inferred marked, plus the titles of
 * confirmed decisions. Trimmed line by line to the budget.
 */
export function buildOverview(memories: ContextMemory[], options: { projectName?: string; budgetTokens?: number } = {}): { text: string; ids: string[] } {
  const budget = options.budgetTokens ?? L1_BUDGET_TOKENS;
  const live = memories.filter((m) => m.confidence !== 'deprecated' && m.status !== 'archived' && m.status !== 'resolved');
  const order = (a: ContextMemory, b: ContextMemory) =>
    CONFIDENCE_WEIGHT[b.confidence] - CONFIDENCE_WEIGHT[a.confidence] || Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  const sections: Array<{ heading: string; items: ContextMemory[]; render: (m: ContextMemory) => string }> = [
    { heading: 'Purpose', items: live.filter((m) => m.category === 'project_overview'), render: (m) => `- ${oneLine(`${m.title}: ${m.content}`, 300)}${confidenceMark(m.confidence)}` },
    { heading: 'Architecture', items: live.filter((m) => m.category === 'architecture' || m.category === 'component'), render: (m) => `- ${m.component ? `[${m.component}] ` : ''}${oneLine(m.title, 160)}${confidenceMark(m.confidence)}` },
    { heading: 'Conventions', items: live.filter((m) => m.category === 'coding_convention'), render: (m) => `- ${oneLine(m.title, 160)}${confidenceMark(m.confidence)}` },
    { heading: 'Current state', items: live.filter((m) => m.category === 'current_state' || m.category === 'active_task'), render: (m) => `- ${oneLine(m.title, 160)}${confidenceMark(m.confidence)}` },
    { heading: 'Confirmed decisions', items: live.filter((m) => m.category === 'architecture_decision' && m.confidence === 'confirmed'), render: (m) => `- ${oneLine(m.title, 160)} (${m.id})` },
  ];
  const header = `## Project overview${options.projectName ? `: ${options.projectName}` : ''}`;
  const lines = [header];
  const ids: string[] = [];
  let used = tokensOf(header);
  for (const section of sections) {
    const items = [...section.items].sort(order);
    if (!items.length) continue;
    const heading = `### ${section.heading}`;
    let headingAdded = false;
    for (const memory of items.slice(0, 8)) {
      const line = section.render(memory);
      const cost = tokensOf(line) + (headingAdded ? 0 : tokensOf(heading));
      if (used + cost > budget) break;
      if (!headingAdded) { lines.push(heading); headingAdded = true; }
      lines.push(line);
      ids.push(memory.id);
      used += cost;
    }
  }
  if (ids.length === 0) lines.push('No overview knowledge recorded yet: save project_overview, architecture and coding_convention memories.');
  return { text: lines.join('\n'), ids };
}

function sessionBlock(session: SessionState): string {
  const open = session.problems.filter((problem) => problem.status !== 'resolved');
  return [
    '## Current session',
    `Task: ${session.task || '—'}${session.objective ? ` · Done when: ${session.objective}` : ''}`,
    `Next action: ${session.nextAction ?? session.pendingSteps[0]?.text ?? '—'}`,
    ...(session.pendingSteps.length ? [`Pending: ${session.pendingSteps.map((step) => step.text).join('; ')}`] : []),
    ...(session.completedSteps.length ? [`Done: ${session.completedSteps.slice(-10).map((step) => step.text).join('; ')}`] : []),
    ...open.map((problem) => `Problem [${problem.status}]: ${problem.text}`),
  ].join('\n');
}

function renderMemory(memory: ContextMemory, form: IncludedEntry['form']): string {
  const flag = memory.conflicted ? ' [CONFLICT: under review]' : '';
  const head = `- [${memory.category}${confidenceMark(memory.confidence)}] ${memory.title}${flag} (${memory.id})`;
  if (form === 'title') return head;
  const facts = memory.facts.length ? `\n  ${memory.facts.slice(0, 6).map((fact) => `• ${oneLine(fact, 160)}`).join('\n  ')}` : '';
  if (form === 'facts') return `${head}${facts}`;
  const files = memory.relatedFiles.length ? `\n  files: ${memory.relatedFiles.slice(0, 6).join(', ')}` : '';
  return `${head}\n  ${oneLine(memory.content, 600)}${facts}${files}`;
}

function dedupe(memories: ContextMemory[]): ContextMemory[] {
  const seen = new Set<string>();
  return memories.filter((memory) => {
    const key = `${memory.title.trim().toLowerCase()}\n${memory.content.trim().toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Build the context package (§5). Order of guarantees: L1, session state,
 * decisions on the affected components (at least their titles), then the
 * rest greedily by score per token.
 */
export function buildContext(memories: ContextMemory[], request: ContextRequest, options: { overview?: { text: string; ids: string[] }; cacheHit?: boolean } = {}): ContextPackage {
  const started = Date.now();
  const budget = Math.max(200, request.budgetTokens ?? DEFAULT_BUDGET_TOKENS);
  const levels = new Set<ContextLevel>(request.levels ?? ['L1', 'L2']);
  const lens = resolveTaskLens(request.task);
  const parts: string[] = [];
  const included: IncludedEntry[] = [];
  const tokensByLevel: ContextReceipt['tokensByLevel'] = { L1: 0, L2: 0, L3: 0, session: 0 };
  let used = 0;
  const unique = dedupe(memories);

  if (levels.has('L1')) {
    const overview = options.overview ?? buildOverview(unique, { projectName: request.projectName, budgetTokens: Math.min(L1_BUDGET_TOKENS, Math.floor(budget * 0.4)) });
    parts.push(overview.text);
    tokensByLevel.L1 = tokensOf(overview.text);
    used += tokensByLevel.L1;
    for (const id of overview.ids) included.push({ id, level: 'L1', form: 'title' });
  }

  if (request.session) {
    const block = sessionBlock(request.session);
    parts.push(block);
    tokensByLevel.session = tokensOf(block);
    used += tokensByLevel.session;
  }

  let truncated = 0;
  let omitted = 0;
  let l2Lines: string[] = [];
  let l2Header = '';
  let l2Index = -1;
  // The pointer to what was left out is part of the package, so agents know to search.
  const l2Section = () => [
    l2Header,
    ...l2Lines,
    ...(omitted > 0 ? [`(+${omitted} more relevant memories not shown: memory_search "${oneLine(request.task ?? '', 60)}")`] : []),
  ].join('\n');
  const ranked = levels.has('L2') ? rankMemories(unique, request) : [];
  if (levels.has('L2')) {
    const inL1 = new Set(included.map((entry) => entry.id));
    const header = `## Relevant context${request.task ? ` for: ${oneLine(request.task, 120)}` : ''}`;
    const lines: string[] = [];
    let l2 = tokensOf(header);
    // Keep room for separators and the "more not shown" pointer.
    const room = () => budget - used - l2 - 40 - (levels.has('L3') ? Math.floor(budget * 0.15) : 0);
    const components = new Set((request.components ?? []).map((component) => component.toLowerCase()));
    const mustTitles = ranked.filter((item) => item.memory.category === 'architecture_decision' && item.memory.component && components.has(item.memory.component.toLowerCase()));
    const queue = [...mustTitles, ...ranked.filter((item) => !mustTitles.includes(item))];
    for (const { memory, score } of queue) {
      if (inL1.has(memory.id) && memory.category !== 'architecture_decision') continue;
      let placed = false;
      for (const form of ['full', 'facts', 'title'] as const) {
        const line = renderMemory(memory, form);
        const cost = tokensOf(line) + 1;
        if (cost <= room()) {
          lines.push(line);
          l2 += cost;
          included.push({ id: memory.id, level: 'L2', form, score: Number(score.toFixed(4)) });
          if (form !== 'full') truncated++;
          placed = true;
          break;
        }
      }
      if (!placed) omitted++;
    }
    if (lines.length || omitted > 0) {
      l2Lines = lines;
      l2Header = header;
      l2Index = parts.length;
      parts.push(l2Section());
      tokensByLevel.L2 = tokensOf(parts[l2Index]);
      used += tokensByLevel.L2;
    }
  }

  if (levels.has('L3')) {
    // Most specific first: superseded knowledge about the task, then version and
    // session history the caller found, then past session notes that match the task.
    const byRelevance = (list: ContextMemory[]) => list
      .map((m) => ({ m, r: m.relevance ?? lexicalRelevance(request.task, m) }))
      .filter((item) => item.r > 0)
      .sort((a, b) => b.r - a.r)
      .slice(0, 10)
      .map((item) => item.m);
    const items = [
      ...byRelevance(unique.filter((m) => m.confidence === 'deprecated')).map((m) => ({ title: `${m.title} (deprecated)`, detail: m.content })),
      ...(request.history ?? []),
      ...byRelevance(unique.filter((m) => m.confidence !== 'deprecated' && L3_CATEGORIES.includes(m.category))).map((m) => ({ title: m.title, detail: m.content })),
    ];
    const header = '## History';
    const lines: string[] = [];
    let l3 = tokensOf(header);
    for (const item of items) {
      const line = `- ${oneLine(item.title, 160)}: ${oneLine(item.detail, 240)}`;
      if (used + l3 + tokensOf(line) > budget) break;
      lines.push(line);
      l3 += tokensOf(line);
    }
    if (lines.length) {
      parts.push([header, ...lines].join('\n'));
      tokensByLevel.L3 = l3;
      used += l3;
    }
  }

  // Separators and redaction change the count slightly: enforce the budget on
  // the final text, dropping the lowest-ranked L2 lines first.
  let text = redactCredentials(parts.join('\n\n'));
  while (tokensOf(text) > budget && l2Lines.length > 0) {
    l2Lines.pop();
    for (let index = included.length - 1; index >= 0; index--) {
      if (included[index].level === 'L2') {
        included.splice(index, 1);
        break;
      }
    }
    omitted++;
    parts[l2Index] = l2Section();
    text = redactCredentials(parts.filter(Boolean).join('\n\n'));
  }
  if (l2Index >= 0) tokensByLevel.L2 = tokensOf(parts[l2Index]);
  return {
    text,
    included,
    receipt: {
      tokensTotal: tokensOf(text),
      tokensByLevel,
      budgetTokens: budget,
      candidates: unique.length,
      included: included.length,
      truncated,
      omitted,
      lens: lens.id,
      buildMs: Date.now() - started,
      cacheHit: Boolean(options.cacheHit),
    },
  };
}

/**
 * PMI memory domain model — categories, confidence, lifecycle status and the
 * rules that move a memory between them. Pure functions only: the SQLite
 * client, the central server and the MCP tools all call into this module so a
 * transition allowed in one place is allowed everywhere (docs/PMI/ARCHITECTURE.md §6).
 */
import type { Observation, ObservationType } from '../types.js';

export const MEMORY_CATEGORIES = [
  'project_overview',
  'architecture',
  'component',
  'dependency',
  'architecture_decision',
  'business_logic',
  'coding_convention',
  'issue',
  'solution',
  'known_limitation',
  'development_history',
  'current_state',
  'active_task',
  'completed_task',
  'session_history',
  'git_history',
] as const;
export type MemoryCategory = typeof MEMORY_CATEGORIES[number];

export const MEMORY_CONFIDENCE = ['observed', 'inferred', 'proposed', 'confirmed', 'deprecated'] as const;
export type MemoryConfidence = typeof MEMORY_CONFIDENCE[number];

export const MEMORY_STATUSES = ['active', 'needs_review', 'resolved', 'archived'] as const;
export type MemoryStatus = typeof MEMORY_STATUSES[number];

/** Who is asking for a confidence change. Agents may never confirm knowledge on their own. */
export type ConfidenceActor = 'human' | 'agent' | 'system';

export function isMemoryCategory(value: unknown): value is MemoryCategory {
  return typeof value === 'string' && (MEMORY_CATEGORIES as readonly string[]).includes(value);
}

export function isMemoryConfidence(value: unknown): value is MemoryConfidence {
  return typeof value === 'string' && (MEMORY_CONFIDENCE as readonly string[]).includes(value);
}

export function isMemoryStatus(value: unknown): value is MemoryStatus {
  return typeof value === 'string' && (MEMORY_STATUSES as readonly string[]).includes(value);
}

interface Classification {
  category: MemoryCategory;
  confidence: MemoryConfidence;
}

const TYPE_CLASSIFICATION: Record<Exclude<ObservationType, 'what-changed'>, Classification> = {
  'decision': { category: 'architecture_decision', confidence: 'proposed' },
  'trade-off': { category: 'architecture_decision', confidence: 'proposed' },
  'why-it-exists': { category: 'architecture_decision', confidence: 'proposed' },
  'reasoning': { category: 'architecture_decision', confidence: 'proposed' },
  'problem-solution': { category: 'solution', confidence: 'observed' },
  'gotcha': { category: 'known_limitation', confidence: 'observed' },
  'how-it-works': { category: 'architecture', confidence: 'inferred' },
  'discovery': { category: 'component', confidence: 'inferred' },
  'session-request': { category: 'session_history', confidence: 'observed' },
  'probe': { category: 'current_state', confidence: 'observed' },
};

/**
 * Default classification of a Memorix observation (DATABASE.md §5). Nothing is
 * ever classified as `confirmed` here: confirmation is an explicit human act.
 */
export function classifyObservationType(
  type: ObservationType | string,
  source?: Observation['source'],
): Classification {
  if (type === 'what-changed') {
    return { category: source === 'git' ? 'git_history' : 'development_history', confidence: 'observed' };
  }
  return TYPE_CLASSIFICATION[type as keyof typeof TYPE_CLASSIFICATION]
    ?? { category: 'development_history', confidence: 'observed' };
}

/** Category/confidence of a stored observation, honouring explicit values over the type default. */
export function classifyObservation(
  obs: Pick<Observation, 'type' | 'source'> & { category?: string | null; confidence?: string | null },
): Classification {
  const fallback = classifyObservationType(obs.type, obs.source);
  return {
    category: isMemoryCategory(obs.category) ? obs.category : fallback.category,
    confidence: isMemoryConfidence(obs.confidence) ? obs.confidence : fallback.confidence,
  };
}

/** Confidence an agent-authored write may start with. */
export const AGENT_WRITABLE_CONFIDENCE: readonly MemoryConfidence[] = ['observed', 'inferred', 'proposed'];

export interface TransitionResult {
  ok: boolean;
  reason?: string;
}

/**
 * Whether `actor` may move a memory from `from` to `to` confidence.
 *
 * - Anyone may restate the current value (idempotent writes).
 * - Agents may move freely among observed/inferred/proposed, never to
 *   `confirmed`, and may not demote confirmed knowledge.
 * - `deprecated` is terminal for agents; humans may revive by re-confirming.
 * - Humans may confirm or deprecate anything.
 * - `system` (git analysis, staleness checks) may deprecate but not confirm.
 */
export function canTransitionConfidence(
  from: MemoryConfidence,
  to: MemoryConfidence,
  actor: ConfidenceActor,
): TransitionResult {
  if (from === to) return { ok: true };
  if (actor === 'human') return { ok: true };
  if (to === 'confirmed') return { ok: false, reason: 'only a human may confirm knowledge' };
  if (from === 'confirmed') {
    return actor === 'system' && to === 'deprecated'
      ? { ok: true }
      : { ok: false, reason: 'confirmed knowledge changes only through review' };
  }
  if (from === 'deprecated') return { ok: false, reason: 'deprecated knowledge is revived only by a human' };
  if (to === 'deprecated') return { ok: true };
  return { ok: true };
}

/** Lifecycle transitions; `archived` is reachable from everywhere and left only by a human. */
export function canTransitionStatus(from: MemoryStatus, to: MemoryStatus, actor: ConfidenceActor): TransitionResult {
  if (from === to) return { ok: true };
  if (from === 'archived' && actor !== 'human') return { ok: false, reason: 'archived memory is restored only by a human' };
  return { ok: true };
}

/**
 * Map Memorix lifecycle status onto PMI status. `needs_review` comes from the
 * observation's `review` mark (set by git analysis), not from `status`.
 */
export function toMemoryStatus(status: string | undefined | null, review?: unknown): MemoryStatus {
  const base = isMemoryStatus(status) ? status : 'active';
  return review && base === 'active' ? 'needs_review' : base;
}

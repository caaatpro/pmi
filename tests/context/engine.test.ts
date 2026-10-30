import { describe, expect, it } from 'vitest';

import { countTextTokens } from '../../src/compact/token-budget.js';
import { buildContext, buildOverview, rankMemories, reciprocalRankFusion, type ContextMemory } from '../../src/context/engine.js';
import { emptySessionState } from '../../src/domain/session.js';
import type { MemoryCategory, MemoryConfidence } from '../../src/domain/memory.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');

function memory(id: string, category: MemoryCategory, title: string, extra: Partial<ContextMemory> = {}): ContextMemory {
  return {
    id,
    category,
    confidence: 'observed' as MemoryConfidence,
    status: 'active',
    title,
    content: `${title}. Details about ${title.toLowerCase()} that an agent would otherwise rediscover by reading files.`,
    facts: [],
    component: null,
    relatedFiles: [],
    updatedAt: '2026-10-30T12:00:00Z',
    ...extra,
  };
}

function corpus(size: number): ContextMemory[] {
  const categories: MemoryCategory[] = ['architecture', 'component', 'issue', 'solution', 'architecture_decision', 'coding_convention', 'git_history', 'session_history', 'development_history', 'known_limitation'];
  return Array.from({ length: size }, (_, i) => memory(`m${i}`, categories[i % categories.length], `Topic ${i} about payments and refunds number ${i}`, {
    content: `Long narrative ${i} `.repeat(40),
    facts: [`fact ${i} one`, `fact ${i} two`],
  }));
}

describe('context engine', () => {
  it('keeps a 500-memory project within the budget and leaves history out of L1/L2 (TEST 6, pure)', () => {
    const memories = corpus(500);
    memories.push(memory('old', 'architecture_decision', 'Refunds were negative payments', { confidence: 'deprecated' }));
    const pkg = buildContext(memories, { task: 'fix refund rounding bug', budgetTokens: 2_300, now: NOW });
    expect(pkg.receipt.tokensTotal).toBeLessThanOrEqual(2_300);
    expect(countTextTokens(pkg.text)).toBe(pkg.receipt.tokensTotal);
    const ids = new Set(pkg.included.map((entry) => entry.id));
    const sessionHistory = memories.filter((m) => m.category === 'session_history').map((m) => m.id);
    expect(sessionHistory.some((id) => ids.has(id))).toBe(false);
    expect(ids.has('old')).toBe(false);
    expect(pkg.receipt.omitted).toBeGreaterThan(0);
    expect(pkg.text).toContain('more relevant memories not shown');
    expect(pkg.receipt.lens).toBe('bugfix');
  });

  it('puts the session\'s next action and open problems in every package', () => {
    const session = {
      ...emptySessionState({ sessionId: 's', projectId: 'p', deviceId: 'd', task: 'Refund webhooks' }),
      nextAction: 'Verify the signature',
      problems: [{ text: 'Sandbox rejects test cards', status: 'open' as const }],
    };
    const pkg = buildContext(corpus(50), { task: 'refund webhooks', session, budgetTokens: 600, now: NOW });
    expect(pkg.text).toContain('Next action: Verify the signature');
    expect(pkg.text).toContain('Problem [open]: Sandbox rejects test cards');
    expect(pkg.receipt.tokensTotal).toBeLessThanOrEqual(600);
  });

  it('ranks by task lens, confidence and file affinity', () => {
    const memories = [
      memory('a', 'architecture', 'Checkout architecture overview for refunds'),
      memory('b', 'solution', 'Refund rounding fixed by integer cents'),
      memory('c', 'issue', 'Refund rounding drifts by a cent', { relatedFiles: ['src/refund.ts'] }),
      memory('d', 'solution', 'Refund rounding fix (proposed)', { confidence: 'proposed' }),
    ];
    const ranked = rankMemories(memories, { task: 'fix refund rounding bug', files: ['src/refund.ts'], now: NOW }).map((r) => r.memory.id);
    expect(ranked[0]).toBe('c');
    expect(ranked.indexOf('b')).toBeLessThan(ranked.indexOf('d'));
    expect(ranked.indexOf('b')).toBeLessThan(ranked.indexOf('a'));
  });

  it('builds a deterministic overview from overview categories, confirmed first', () => {
    const memories = [
      memory('p', 'project_overview', 'Shop backend', { confidence: 'confirmed', content: 'Sells things online' }),
      memory('arch', 'architecture', 'Hexagonal services', { confidence: 'inferred' }),
      memory('conv', 'coding_convention', 'Money is integer cents', { confidence: 'confirmed' }),
      memory('dec', 'architecture_decision', 'Postgres for everything', { confidence: 'confirmed' }),
      memory('prop', 'architecture_decision', 'Maybe Kafka', { confidence: 'proposed' }),
    ];
    const first = buildOverview(memories, { projectName: 'shop' });
    expect(buildOverview(memories, { projectName: 'shop' })).toEqual(first);
    expect(first.text).toContain('Shop backend: Sells things online');
    expect(first.text).toContain('Hexagonal services (inferred)');
    expect(first.text).toContain('Postgres for everything (dec)');
    expect(first.text).not.toContain('Maybe Kafka');
    expect(countTextTokens(first.text)).toBeLessThanOrEqual(800);
  });

  it('compresses entries before dropping them and flags conflicts', () => {
    const facts = Array.from({ length: 6 }, (_, i) => `rule ${i}: ${'detail '.repeat(18)}`);
    const memories = [memory('x', 'architecture_decision', 'Use idempotency keys', { conflicted: true, content: 'word '.repeat(400), facts })];
    const roomy = buildContext(memories, { task: 'idempotency keys', budgetTokens: 2_000, levels: ['L2'], now: NOW });
    expect(roomy.included[0]).toMatchObject({ id: 'x', form: 'full' });
    const tight = buildContext(memories, { task: 'idempotency keys', budgetTokens: 200, levels: ['L2'], now: NOW });
    expect(tight.included[0].id).toBe('x');
    expect(tight.included[0].form).not.toBe('full');
    expect(tight.receipt.tokensTotal).toBeLessThanOrEqual(200);
    expect(tight.text).toContain('[CONFLICT: under review]');
    expect(tight.receipt.truncated).toBe(1);
  });

  it('includes history only when L3 is requested', () => {
    const memories = [memory('h', 'session_history', 'Session 12 summary'), memory('dep', 'architecture', 'Old monolith', { confidence: 'deprecated' })];
    expect(buildContext(memories, { task: 'monolith', now: NOW }).text).not.toContain('## History');
    const withHistory = buildContext(memories, { task: 'monolith', levels: ['L1', 'L2', 'L3'], history: [{ title: 'v2 of Old monolith', detail: 'edited by bob' }], now: NOW });
    expect(withHistory.text).toContain('## History');
    expect(withHistory.text).toContain('Old monolith (deprecated)');
    expect(withHistory.text).toContain('v2 of Old monolith');
  });

  it('fuses rankings with RRF', () => {
    const scores = reciprocalRankFusion([['a', 'b', 'c'], ['b', 'c', 'a']]);
    expect(scores.get('b')).toBe(1);
    expect(scores.get('a')!).toBeLessThan(1);
  });

  it('never ships credentials', () => {
    const memories = [memory('s', 'solution', 'Sandbox login', { content: 'use password=hunter2secret for the sandbox' })];
    expect(buildContext(memories, { task: 'sandbox login', now: NOW }).text).not.toContain('hunter2secret');
  });
});

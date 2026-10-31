import { describe, expect, it } from 'vitest';

import {
  MEMORY_CATEGORIES,
  canTransitionConfidence,
  canTransitionStatus,
  classifyObservation,
  classifyObservationType,
  toMemoryStatus,
} from '../../src/domain/memory.js';

describe('memory classification', () => {
  it('maps Baton types onto Baton categories without ever confirming', () => {
    expect(classifyObservationType('decision')).toEqual({ category: 'architecture_decision', confidence: 'proposed' });
    expect(classifyObservationType('problem-solution')).toEqual({ category: 'solution', confidence: 'observed' });
    expect(classifyObservationType('gotcha')).toEqual({ category: 'known_limitation', confidence: 'observed' });
    expect(classifyObservationType('how-it-works')).toEqual({ category: 'architecture', confidence: 'inferred' });
    expect(classifyObservationType('discovery')).toEqual({ category: 'component', confidence: 'inferred' });
    expect(classifyObservationType('session-request').category).toBe('session_history');
    for (const type of ['decision', 'trade-off', 'reasoning', 'gotcha', 'discovery', 'probe', 'unknown']) {
      expect(classifyObservationType(type).confidence).not.toBe('confirmed');
    }
  });

  it('separates git history from other change notes', () => {
    expect(classifyObservationType('what-changed', 'git').category).toBe('git_history');
    expect(classifyObservationType('what-changed', 'agent').category).toBe('development_history');
  });

  it('prefers explicit category and confidence over the type default', () => {
    expect(classifyObservation({ type: 'discovery', category: 'coding_convention', confidence: 'confirmed' }))
      .toEqual({ category: 'coding_convention', confidence: 'confirmed' });
    expect(classifyObservation({ type: 'discovery', category: 'bogus', confidence: null }))
      .toEqual({ category: 'component', confidence: 'inferred' });
  });

  it('lists the sixteen categories from the specification', () => {
    expect(MEMORY_CATEGORIES).toHaveLength(16);
  });
});

describe('confidence transitions', () => {
  it('never lets an agent confirm knowledge', () => {
    expect(canTransitionConfidence('proposed', 'confirmed', 'agent').ok).toBe(false);
    expect(canTransitionConfidence('observed', 'confirmed', 'system').ok).toBe(false);
    expect(canTransitionConfidence('proposed', 'confirmed', 'human').ok).toBe(true);
  });

  it('protects confirmed knowledge from agent edits', () => {
    expect(canTransitionConfidence('confirmed', 'proposed', 'agent').ok).toBe(false);
    expect(canTransitionConfidence('confirmed', 'deprecated', 'agent').ok).toBe(false);
    expect(canTransitionConfidence('confirmed', 'deprecated', 'system').ok).toBe(true);
    expect(canTransitionConfidence('confirmed', 'confirmed', 'agent').ok).toBe(true);
  });

  it('lets agents move among unconfirmed levels and deprecate them', () => {
    expect(canTransitionConfidence('observed', 'inferred', 'agent').ok).toBe(true);
    expect(canTransitionConfidence('inferred', 'proposed', 'agent').ok).toBe(true);
    expect(canTransitionConfidence('proposed', 'deprecated', 'agent').ok).toBe(true);
    expect(canTransitionConfidence('deprecated', 'observed', 'agent').ok).toBe(false);
    expect(canTransitionConfidence('deprecated', 'confirmed', 'human').ok).toBe(true);
  });
});

describe('status transitions', () => {
  it('only humans restore archived memory', () => {
    expect(canTransitionStatus('archived', 'active', 'agent').ok).toBe(false);
    expect(canTransitionStatus('archived', 'active', 'human').ok).toBe(true);
    expect(canTransitionStatus('active', 'archived', 'agent').ok).toBe(true);
  });

  it('maps unknown Baton statuses to active', () => {
    expect(toMemoryStatus('resolved')).toBe('resolved');
    expect(toMemoryStatus(undefined)).toBe('active');
    expect(toMemoryStatus('weird')).toBe('active');
  });
});

/**
 * Memory Overview Generator Tests
 *
 * Covers:
 * - excludes probe observations
 * - excludes command logs (Ran:/Command:/Executed: titles)
 * - excludes other projects
 * - excludes resolved/archived observations
 * - includes core observations
 * - includes contextual only with facts/concepts/files/entity
 * - includes reasoning in appropriate section
 * - coding_convention memories get their own section
 * - preserves source refs on every item
 * - empty state works
 */

import { describe, it, expect } from 'vitest';
import { generateKnowledgeBase, isEligible, isExcludedType, isCommandLog, contextualHasSubstance } from '../../src/wiki/generator.js';
import type { Observation } from '../../src/types.js';

const PROJECT_ID = 'test/knowledge-base';
const OTHER_PROJECT_ID = 'other/project';
const FIXED_TIMESTAMP = '2026-01-01T00:00:00.000Z';
let nextObservationId = 1;

function makeObs(overrides: Partial<Observation> = {}): Observation {
  return {
    id: overrides.id ?? nextObservationId++,
    entityName: 'test-entity',
    type: 'decision',
    title: 'Test observation',
    narrative: 'A test narrative for the knowledge base.',
    facts: [],
    filesModified: [],
    concepts: [],
    tokens: 50,
    createdAt: FIXED_TIMESTAMP,
    projectId: PROJECT_ID,
    status: 'active',
    source: 'agent',
    sourceDetail: 'explicit',
    valueCategory: 'core',
    ...overrides,
  };
}

// Filtering

describe('Filtering: isEligible', () => {
  it('excludes probe type', () => {
    const obs = makeObs({ type: 'probe' });
    expect(isEligible(obs, PROJECT_ID)).toBe(false);
  });

  it('excludes command log titles', () => {
    expect(isCommandLog(makeObs({ title: 'Ran: npm test' }))).toBe(true);
    expect(isCommandLog(makeObs({ title: 'Command: git push' }))).toBe(true);
    expect(isCommandLog(makeObs({ title: 'Executed: build' }))).toBe(true);
    expect(isCommandLog(makeObs({ title: 'Normal decision' }))).toBe(false);
    expect(isEligible(makeObs({ title: 'Ran: npm test' }), PROJECT_ID)).toBe(false);
  });

  it('excludes other projects', () => {
    const obs = makeObs({ projectId: 'other/project' });
    expect(isEligible(obs, PROJECT_ID)).toBe(false);
  });

  it('excludes resolved observations', () => {
    const obs = makeObs({ status: 'resolved' });
    expect(isEligible(obs, PROJECT_ID)).toBe(false);
  });

  it('excludes archived observations', () => {
    const obs = makeObs({ status: 'archived' });
    expect(isEligible(obs, PROJECT_ID)).toBe(false);
  });

  it('excludes ephemeral valueCategory', () => {
    const obs = makeObs({ valueCategory: 'ephemeral' });
    expect(isEligible(obs, PROJECT_ID)).toBe(false);
  });

  it('excludes an automatic candidate until it is qualified', () => {
    const candidate = makeObs({
      sourceDetail: 'hook',
      admissionState: 'candidate',
      admissionReason: 'file mutation awaits Code Memory qualification',
    });
    expect(isEligible(candidate, PROJECT_ID)).toBe(false);
    expect(isEligible({ ...candidate, admissionState: 'qualified' }, PROJECT_ID)).toBe(true);
  });

  it('includes core valueCategory', () => {
    const obs = makeObs({ valueCategory: 'core' });
    expect(isEligible(obs, PROJECT_ID)).toBe(true);
  });

  it('includes contextual with facts', () => {
    const obs = makeObs({ valueCategory: 'contextual', facts: ['important fact'] });
    expect(isEligible(obs, PROJECT_ID)).toBe(true);
  });

  it('includes contextual with concepts', () => {
    const obs = makeObs({ valueCategory: 'contextual', concepts: ['architecture'] });
    expect(isEligible(obs, PROJECT_ID)).toBe(true);
  });

  it('includes contextual with filesModified', () => {
    const obs = makeObs({ valueCategory: 'contextual', filesModified: ['src/main.ts'] });
    expect(isEligible(obs, PROJECT_ID)).toBe(true);
  });

  it('includes contextual with meaningful entityName', () => {
    const obs = makeObs({ valueCategory: 'contextual', entityName: 'auth-module' });
    expect(isEligible(obs, PROJECT_ID)).toBe(true);
  });

  it('excludes contextual without substance', () => {
    const obs = makeObs({ valueCategory: 'contextual', facts: [], concepts: [], filesModified: [], entityName: 'quick-note' });
    expect(isEligible(obs, PROJECT_ID)).toBe(false);
  });
});

// Section assignment

describe('Section assignment', () => {
  it('places decisions in Core Decisions', () => {
    const obs = makeObs({ type: 'decision', title: 'Use JWT' });
    const kb = generateKnowledgeBase({ projectId: PROJECT_ID, observations: [obs] });
    const section = kb.sections.find(s => s.id === 'core-decisions');
    expect(section).toBeDefined();
    expect(section!.items.length).toBe(1);
    expect(section!.items[0].title).toBe('Use JWT');
  });

  it('places trade-offs in Core Decisions', () => {
    const obs = makeObs({ type: 'trade-off', title: 'Speed vs safety' });
    const kb = generateKnowledgeBase({ projectId: PROJECT_ID, observations: [obs] });
    const section = kb.sections.find(s => s.id === 'core-decisions');
    expect(section!.items.length).toBe(1);
  });

  it('places gotchas in Known Gotchas', () => {
    const obs = makeObs({ type: 'gotcha', title: 'Token expiry bug' });
    const kb = generateKnowledgeBase({ projectId: PROJECT_ID, observations: [obs] });
    const section = kb.sections.find(s => s.id === 'known-gotchas');
    expect(section!.items.length).toBe(1);
  });

  it('places problem-solution in Known Gotchas', () => {
    const obs = makeObs({ type: 'problem-solution', title: 'Fix race condition' });
    const kb = generateKnowledgeBase({ projectId: PROJECT_ID, observations: [obs] });
    const section = kb.sections.find(s => s.id === 'known-gotchas');
    expect(section!.items.length).toBe(1);
  });

  it('places reasoning in Core Decisions', () => {
    const obs = makeObs({ type: 'reasoning', title: 'Why we chose PostgreSQL' });
    const kb = generateKnowledgeBase({ projectId: PROJECT_ID, observations: [obs] });
    const section = kb.sections.find(s => s.id === 'core-decisions');
    expect(section!.items.length).toBe(1);
  });

  it('places how-it-works in Operational Knowledge', () => {
    const obs = makeObs({ type: 'how-it-works', title: 'Auth flow' });
    const kb = generateKnowledgeBase({ projectId: PROJECT_ID, observations: [obs] });
    const section = kb.sections.find(s => s.id === 'operational-knowledge');
    expect(section!.items.length).toBe(1);
  });

  it('places git-ingest in Git-backed Facts', () => {
    const obs = makeObs({ source: 'git', sourceDetail: 'git-ingest', title: 'Commit: add auth' });
    const kb = generateKnowledgeBase({ projectId: PROJECT_ID, observations: [obs] });
    const section = kb.sections.find(s => s.id === 'git-backed-facts');
    expect(section!.items.length).toBe(1);
  });
});

// Coding conventions

describe('Coding conventions', () => {
  it('lists coding_convention memories in their own section, not in a typed one', () => {
    const convention = makeObs({ id: 5, type: 'how-it-works', title: 'Always pass a timeout', category: 'coding_convention' });
    const kb = generateKnowledgeBase({ projectId: PROJECT_ID, observations: [convention] });
    const section = kb.sections.find(s => s.id === 'coding-conventions');
    expect(section!.title).toBe('Coding Conventions');
    expect(section!.items.map(item => item.title)).toEqual(['Always pass a timeout']);
    expect(section!.items[0].refs.some(r => r.id === 'obs:5')).toBe(true);
    const operational = kb.sections.find(s => s.id === 'operational-knowledge');
    expect(operational!.items).toEqual([]);
    expect(kb.stats.conventionsUsed).toBe(1);
  });

  it('excludes conventions of other projects', () => {
    const kb = generateKnowledgeBase({
      projectId: PROJECT_ID,
      observations: [
        makeObs({ title: 'Project convention', category: 'coding_convention' }),
        makeObs({ title: 'Other convention', category: 'coding_convention', projectId: OTHER_PROJECT_ID }),
      ],
      generatedAt: FIXED_TIMESTAMP,
    });
    const section = kb.sections.find(s => s.id === 'coding-conventions');
    expect(section!.items.map(item => item.title)).toEqual(['Project convention']);
    expect(kb.stats.conventionsUsed).toBe(1);
  });
});

// Source refs

describe('Source refs', () => {
  it('every item has at least one source ref', () => {
    const observations = [
      makeObs({ type: 'decision', title: 'D1' }),
      makeObs({ type: 'gotcha', title: 'G1' }),
      makeObs({ type: 'how-it-works', title: 'H1' }),
    ];
    const kb = generateKnowledgeBase({ projectId: PROJECT_ID, observations });
    for (const section of kb.sections) {
      for (const item of section.items) {
        if (item.type !== 'overview') {
          expect(item.refs.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('observation ref uses obs:<id> format', () => {
    const obs = makeObs({ id: 42, type: 'decision', title: 'D1' });
    const kb = generateKnowledgeBase({ projectId: PROJECT_ID, observations: [obs] });
    const section = kb.sections.find(s => s.id === 'core-decisions');
    expect(section!.items[0].refs[0].id).toBe('obs:42');
  });

  it('git observation ref has kind=git', () => {
    const obs = makeObs({ id: 55, source: 'git', sourceDetail: 'git-ingest', title: 'Commit' });
    const kb = generateKnowledgeBase({ projectId: PROJECT_ID, observations: [obs] });
    const section = kb.sections.find(s => s.id === 'git-backed-facts');
    expect(section!.items[0].refs[0].kind).toBe('git');
  });
});

// Empty state

describe('Empty state', () => {
  it('returns valid overview with no observations', () => {
    const kb = generateKnowledgeBase({ projectId: PROJECT_ID, observations: [] });
    expect(kb.title).toBe('Memory Overview');
    expect(kb.subtitle).toBe('Generated from durable project memory');
    expect(kb.kind).toBe('memory-overview');
    expect(kb.maintained).toBe(false);
    expect(kb.projectId).toBe(PROJECT_ID);
    expect(kb.stats.observationsUsed).toBe(0);
    expect(kb.stats.conventionsUsed).toBe(0);
    expect(kb.sections.length).toBeGreaterThan(0);
    // All typed sections should be empty
    for (const section of kb.sections) {
      if (section.id !== 'project-overview') {
        expect(section.empty).toBe(true);
      }
    }
  });
});

// Stats

describe('Stats', () => {
  it('counts observations and conventions correctly', () => {
    const observations = [
      makeObs({ type: 'decision', title: 'D1' }),
      makeObs({ type: 'gotcha', title: 'G1' }),
    ];
    observations.push(makeObs({ title: 'C1', category: 'coding_convention' }));
    const kb = generateKnowledgeBase({ projectId: PROJECT_ID, observations });
    expect(kb.stats.observationsUsed).toBe(3);
    expect(kb.stats.conventionsUsed).toBe(1);
    expect(kb.stats.refs).toBeGreaterThan(0);
  });
});

// Project scope

describe('Project scope', () => {
  it('only includes observations from the specified project', () => {
    const obs1 = makeObs({ type: 'decision', title: 'In-project', projectId: PROJECT_ID });
    const obs2 = makeObs({ type: 'decision', title: 'Other-project', projectId: 'other/project' });
    const kb = generateKnowledgeBase({ projectId: PROJECT_ID, observations: [obs1, obs2] });
    const section = kb.sections.find(s => s.id === 'core-decisions');
    expect(section!.items.length).toBe(1);
    expect(section!.items[0].title).toBe('In-project');
  });
});

describe('Determinism', () => {
  it('returns equal output for the same inputs and fixed generatedAt', () => {
    const observations = [makeObs({ id: 500, type: 'decision', title: 'Stable decision' })];
    observations.push(makeObs({ id: 600, title: 'Stable convention', category: 'coding_convention' }));
    const options = { projectId: PROJECT_ID, observations, generatedAt: FIXED_TIMESTAMP };

    const first = generateKnowledgeBase(options);
    const second = generateKnowledgeBase(options);

    expect(first.generatedAt).toBe(FIXED_TIMESTAMP);
    expect(first).toEqual(second);
  });
});

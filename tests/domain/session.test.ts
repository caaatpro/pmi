import { describe, expect, it } from 'vitest';

import {
  boundState,
  buildHandoffBrief,
  canTransitionSession,
  emptySessionState,
  resumeHints,
  statusAfterLeaseLoss,
  type SessionState,
} from '../../src/domain/session.js';

function state(extra: Partial<SessionState> = {}): SessionState {
  return {
    ...emptySessionState({ sessionId: 's1', projectId: 'acme/app', deviceId: 'dev_a', agent: 'claude-code', task: 'Add refunds', objective: 'Refund endpoint passes e2e tests', now: '2026-10-31T10:00:00.000Z' }),
    ...extra,
  };
}

describe('session transitions', () => {
  it('follows the state machine', () => {
    expect(canTransitionSession('created', 'in_progress')).toBe(true);
    expect(canTransitionSession('in_progress', 'waiting_handoff')).toBe(true);
    expect(canTransitionSession('waiting_handoff', 'resumable')).toBe(true);
    expect(canTransitionSession('resumable', 'in_progress')).toBe(true);
    expect(canTransitionSession('completed', 'in_progress')).toBe(false);
    expect(canTransitionSession('failed', 'resumable')).toBe(false);
    expect(canTransitionSession('resumable', 'checkpointed')).toBe(false);
    expect(canTransitionSession('completed', 'completed')).toBe(true);
  });

  it('becomes resumable after lease loss only with a checkpoint', () => {
    expect(statusAfterLeaseLoss(true)).toBe('resumable');
    expect(statusAfterLeaseLoss(false)).toBe('interrupted');
  });
});

describe('handoff brief', () => {
  it('lists done work, the next action, workspace and what not to redo, without secrets', () => {
    const brief = buildHandoffBrief(state({
      status: 'waiting_handoff',
      completedSteps: [{ id: '1', text: 'Added refund table migration', at: 'x', evidence: ['abc123'] }],
      pendingSteps: [{ id: '2', text: 'Wire refund endpoint', at: 'x' }],
      nextAction: 'Write the POST /refunds handler',
      problems: [{ text: 'Sandbox rejects api_key=sk_test_1234567890abcdef', status: 'open' }],
      decisions: [{ id: 'p:acme%2Fapp:u:dev_a:4', title: 'Refunds are ledger entries' }],
      git: { branch: 'feat/refunds', head: 'a'.repeat(40), unpushedCommits: ['b'.repeat(40)], dirty: true, modifiedFiles: [{ path: 'src/refunds.ts', status: 'M' }, { path: 'old.ts', status: 'D' }] },
    }));
    expect(brief).toContain('# Handoff: Add refunds');
    expect(brief).toContain('- Added refund table migration [abc123]');
    expect(brief).toContain('Write the POST /refunds handler');
    expect(brief).toContain('Branch feat/refunds');
    expect(brief).toContain('- M src/refunds.ts');
    expect(brief).toMatch(/## Files to read first\n- src\/refunds\.ts/);
    expect(brief).not.toContain('sk_test_1234567890abcdef');
    expect(brief).toContain('## Do NOT redo');
  });

  it('infers the next action from the first pending step when none was set', () => {
    const hints = resumeHints(state({ pendingSteps: [{ id: '1', text: 'Run the e2e suite', at: 'x' }] }));
    expect(hints).toMatchObject({ nextAction: 'Run the e2e suite', nextActionInferred: true });
    expect(buildHandoffBrief(state({ pendingSteps: [{ id: '1', text: 'Run the e2e suite', at: 'x' }] }))).toContain('inferred');
  });
});

describe('state bounds', () => {
  it('folds long lists instead of dropping them silently', () => {
    const steps = Array.from({ length: 80 }, (_, i) => ({ id: String(i), text: `step ${i}`, at: 'x' }));
    const bounded = boundState(state({ completedSteps: steps }));
    expect(bounded.completedSteps).toHaveLength(50);
    expect(bounded.completedSteps[0].text).toBe('step 30');
    expect(bounded.progress.summary).toContain('+30 earlier completedSteps omitted');
  });
});

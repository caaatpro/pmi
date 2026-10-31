import { describe, expect, it, vi } from 'vitest';
import { printCliGuideForHelp, renderCliGuide } from '../../src/cli/command-guide.js';

describe('CLI command guide', () => {
  it('renders action-oriented help for manual command namespaces', () => {
    const guide = renderCliGuide('memory');
    expect(guide).toContain('baton memory store');
    expect(guide).toContain('baton identity join');
    expect(guide).toContain('--cwd <git-project>');
  });

  it('intercepts namespace --help before generic argument metadata hides actions', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(printCliGuideForHelp(['transfer', '--help'])).toBe(true);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('baton transfer import --file'));
      expect(printCliGuideForHelp(['unknown', '--help'])).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('keeps checkpoint guide actions aligned with the checkpoint command', () => {
    const guide = renderCliGuide('checkpoint');
    expect(guide).toContain('baton checkpoint list');
    expect(guide).toContain('baton checkpoint show --id <checkpoint-id>');
    expect(guide).toContain('baton checkpoint context');
    expect(guide).toContain('baton checkpoint archive');
  });

  it('surfaces the implemented evidence, feedback, and knowledge actions', () => {
    expect(renderCliGuide('evidence')).toContain('baton evidence events --id 42');
    expect(renderCliGuide('feedback')).toContain('baton feedback record');
    expect(renderCliGuide('knowledge')).toContain('baton knowledge claims');
    expect(renderCliGuide('codegraph')).toContain('baton codegraph impact');
  });
});

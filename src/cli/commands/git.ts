/**
 * `pmi git analyze [--full] [--auto]` — incremental git intelligence
 * (src/git/analyze.ts). Only commits after the last analyzed one are read;
 * `--full` also checks that related files of active knowledge still exist.
 */
import { defineCommand } from 'citty';

import { emitError, emitResult, getCliProjectContext } from './operator-shared.js';

export async function runGitAnalyze(options: { cwd?: string; full: boolean; auto: boolean; json: boolean }): Promise<void> {
  try {
    const { project, dataDir } = await getCliProjectContext(options.cwd ? { projectRoot: options.cwd } : undefined);
    const { analyzeProject } = await import('../../git/analyze.js');
    const report = await analyzeProject({ dataDir, projectId: project.id, root: project.rootPath, full: options.full });
    if (options.auto) return;
    const classes = Object.entries(report.classes).map(([name, count]) => `${name} ${count}`).join(', ');
    emitResult(report, [
      `Analyzed ${report.commitsAnalyzed} commit(s) on ${report.branch ?? 'detached HEAD'} (${report.mode}${report.rewritten ? ', history was rewritten' : ''}${report.initial ? ', first run' : ''})`,
      `  cursor ${report.cursor.from?.slice(0, 10) ?? '—'} -> ${report.cursor.to.slice(0, 10)}`,
      `  memories written ${report.memoriesWritten}; marked for review ${report.staleMarked}; review tasks ${report.reviewTasks}`,
      ...(classes ? [`  classes: ${classes}`] : []),
      ...(report.reconcile ? [`  full reconcile: ${report.reconcile.checked} memories checked, ${report.reconcile.marked} marked for review`] : []),
    ].join('\n'), options.json);
  } catch (error) {
    if (options.auto) return; // hooks must never fail a git command
    emitError((error as Error).message, options.json);
    process.exitCode = (error as { offline?: boolean }).offline ? 3 : 1;
  }
}

export default defineCommand({
  meta: { name: 'git', description: 'Incremental git analysis into project memory' },
  args: {
    full: { type: 'boolean', description: 'Also verify related files of all active knowledge at HEAD', default: false },
    auto: { type: 'boolean', description: 'Quiet mode for git hooks', default: false },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const action = (args._ as string[])?.[0] || 'analyze';
    if (action !== 'analyze') {
      emitError(`unknown action "${action}" (expected analyze)`, Boolean(args.json));
      process.exitCode = 2;
      return;
    }
    await runGitAnalyze({ full: Boolean(args.full), auto: Boolean(args.auto), json: Boolean(args.json) });
  },
});

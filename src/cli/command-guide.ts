export interface CliCommandGuide {
  summary: string;
  usage: string[];
  notes?: string[];
}

const GUIDES: Record<string, CliCommandGuide> = {
  memory: {
    summary: 'Store, search, inspect, resolve, consolidate, and promote project memory.',
    usage: [
      'baton memory search --query "timeout regression" [--limit 10]',
      'baton memory store --text "..." [--title "..."] [--visibility project|personal|team]',
      'baton memory detail --id 42',
      'baton memory recent [--limit 10]',
      'baton memory resolve --ids 42,43 [--status resolved|archived]',
      'baton memory consolidate --action preview|execute',
      'baton memory promote --ids 42,43 [--trigger "..."] [--instruction "..."]',
      'baton memory long-term list [--all]',
      'baton memory long-term add --kind semantic --scope user --portability portable --title "..." --text "..." [--tags "..."] [--applicability "..."]',
      'baton memory long-term promote --from-observation 42 --kind procedural --scope project',
      'baton memory long-term qualify|approve|archive --id <id> --reason "..."',
      'baton memory long-term supersede --id <old-id> --superseded-by <qualified-id> --reason "..."',
    ],
    notes: [
      'Personal and team visibility require `baton identity join` or `baton identity use` first.',
      'Candidates never enter a task Workset. Only manual or user-confirmed `user + portable` memory may cross local projects.',
    ],
  },
  identity: {
    summary: 'Select the active local actor for private memory and coordination commands.',
    usage: [
      'baton identity status',
      'baton identity join --agent-type codex [--name codex-main --instance-id local]',
      'baton identity use --agent-id <id>',
      'baton identity clear',
    ],
    notes: ['Without an identity, CLI reads and writes only project-visible memory.'],
  },
  session: {
    summary: 'Start, end, and inspect coding sessions. Coordination remains opt-in.',
    usage: [
      'baton session start --agent codex',
      'baton session start --agent codex --agent-type codex --join-team --use',
      'baton session end --session-id <id> [--summary "..."]',
      'baton session context [--limit 3]',
    ],
  },
  context: {
    summary: 'Build the bounded task Workset used to resume or begin real work.',
    usage: [
      'baton context "continue the release fix" [--task-id <continuity-id>] [--refresh auto|always|never]',
      'baton resume "continue the release fix" [--refresh auto|always|never]',
    ],
  },
  continuity: {
    summary: 'Track task requirements, decisions, verification, risks, and outcomes.',
    usage: [
      'baton continuity start --task "Harden the release path" [--requirements "a,b"]',
      'baton continuity record --task-id <id> --kind decision --content "..."',
      'baton continuity record --task-id <id> --kind verification --verification-status passed --content "..."',
      'baton continuity show --task-id <id>',
      'baton continuity close --task-id <id> --status completed --content "..."',
      'baton continuity list',
    ],
    notes: ['Pass the returned task id to baton context --task-id so the bounded brief includes the ledger.'],
  },
  explain: {
    summary: 'Show why a task context contains its current facts and memory evidence.',
    usage: ['baton explain [--refresh auto|always|never]'],
  },
  codegraph: {
    summary: 'Refresh local code-state snapshots and assemble task-specific code context.',
    usage: [
      'baton codegraph status',
      'baton codegraph refresh',
      'baton codegraph init',
      'baton codegraph sync',
      'baton codegraph diff [--from <snapshot>] [--to <snapshot>]',
      'baton codegraph impact --path <relative-source-path>',
      'baton codegraph context-pack --task "trace the auth flow" [--limit 20]',
    ],
  },
  checkpoint: {
    summary: 'Inspect bounded recovery checkpoints created around host-native context compaction.',
    usage: [
      'baton checkpoint list [--session <id>] [--agent <name>]',
      'baton checkpoint show --id <checkpoint-id>',
      'baton checkpoint context [--id <checkpoint-id>] [--task "continue auth fix"]',
      'baton checkpoint archive --id <checkpoint-id>',
    ],
    notes: ['Checkpoints are host lifecycle evidence, not durable project memory and not transcript backups.'],
  },
  knowledge: {
    summary: 'Manage the reviewed, source-backed Knowledge Workspace and project workflows.',
    usage: [
      'baton knowledge init [--mode local|versioned]',
      'baton knowledge status',
      'baton knowledge claims',
      'baton knowledge review --id <claim-id> --review approved|rejected --detail "..."',
      'baton knowledge compile',
      'baton knowledge lint',
      'baton knowledge apply --proposal <id> [--force]',
      'baton knowledge workflow import|list',
      'baton knowledge workflow select --task "prepare a release"',
      'baton knowledge workflow preview|apply --id <workflow-id> --agent codex',
      'baton knowledge workflow run --id <workflow-id> --task "..." --outcome passed',
    ],
    notes: ['Claims need source review before they can become maintained Knowledge Workspace pages.'],
  },
  evidence: {
    summary: 'Inspect the source, freshness, and verification state behind project memories.',
    usage: [
      'baton evidence list [--query "auth"] [--limit 20]',
      'baton evidence get --id 42',
      'baton evidence sync',
      'baton evidence stale --paths src/server.ts,tests/server.test.ts --reason "source changed"',
      'baton evidence events --id 42',
    ],
    notes: ['Evidence cards point back to observations and source files; they are not a second memory store.'],
  },
  feedback: {
    summary: 'Record and inspect whether a memory helped, conflicted, or was corrected.',
    usage: [
      'baton feedback record --id 42 --signal verification-success --source test:run-1',
      'baton feedback show --id 42',
      'baton feedback audit --id 42 [--limit 100]',
    ],
    notes: ['Feedback changes the candidate score through an auditable event; it does not rewrite the original memory.'],
  },
  formation: {
    summary: 'Inspect Memory Formation quality metrics collected by the runtime.',
    usage: ['baton formation metrics'],
    notes: ['Metrics are empty until the formation pipeline has processed observations.'],
  },
  reasoning: {
    summary: 'Capture and retrieve engineering decision rationale.',
    usage: [
      'baton reasoning store --entity auth --decision "Use SQLite" --rationale "..."',
      'baton reasoning search --query "why sqlite" [--scope project|global]',
    ],
  },
  retention: {
    summary: 'Inspect retention state and archive records that are eligible under the current scope.',
    usage: [
      'baton retention status',
      'baton retention stale',
      'baton retention archive',
    ],
  },
  transfer: {
    summary: 'Create or restore explicit project memory snapshots for backup and automation.',
    usage: [
      'baton transfer export --format json --out ./.baton-export.json',
      'baton transfer import --file ./.baton-export.json',
      'baton transfer import --stdin',
    ],
  },
  team: {
    summary: 'Manage explicit agent identities for the current project.',
    usage: [
      'baton team join --agent-type codex [--name codex-main]',
      'baton team status [--all]',
      'baton team leave [--agent-id <id>]',
    ],
  },
  audit: {
    summary: 'Inspect quality, attribution, and recorded audit evidence.',
    usage: ['baton audit memory', 'baton audit project [--threshold 2]', 'baton audit list'],
  },
  skills: {
    summary: 'Inspect and generate project skills from project-visible memory evidence.',
    usage: ['baton skills list', 'baton skills generate [--write --target codex]', 'baton skills show --name <skill>'],
  },
  sync: {
    summary: 'Synchronize agent rules and workspace artifacts through explicit routes.',
    usage: [
      'baton sync rules --action status',
      'baton sync workspace --action scan',
      'baton sync store status --json',
      'baton sync store push|pull [--dry] [--json] [--scope project|user]',
      'baton sync store compact --dry --through device=sequence',
      'baton sync store device rotate',
    ],
    notes: ['Store sync is opt-in and never copies the live SQLite database. Default scope is the current Git project; `--scope user` relays every local project.'],
  },
  ingest: {
    summary: 'Ingest Git evidence into project memory.',
    usage: ['baton ingest commit [--ref HEAD]', 'baton ingest log [--count 10]'],
  },
};

export function commandGuideNames(): string[] {
  return Object.keys(GUIDES).sort();
}

export function renderCliGuide(command?: string): string {
  const normalized = command?.trim().toLowerCase();
  if (normalized && GUIDES[normalized]) {
    const guide = GUIDES[normalized];
    return [
      `Baton ${normalized}`,
      '',
      guide.summary,
      '',
      'Usage:',
      ...guide.usage.map((line) => `  ${line}`),
      ...(guide.notes?.length ? ['', ...guide.notes.map((line) => `Note: ${line}`)] : []),
      '',
      'Project/actor options: --cwd <git-project>  --as <active-agent-id>. Operator commands accept --json.',
    ].join('\n');
  }

  return [
    'Baton CLI',
    '',
    'Use `baton <command> --help` for an action-oriented guide.',
    '',
    `Command groups: ${commandGuideNames().join(', ')}`,
    '',
    'Global options: --cwd <git-project>  --as <active-agent-id>',
    'Compatibility: camelCase flags remain supported; kebab-case flags are accepted too.',
  ].join('\n');
}

/** Render manual action help before Citty consumes `--help` as flag metadata. */
export function printCliGuideForHelp(argv: string[] = process.argv.slice(2)): boolean {
  const [command, ...rest] = argv;
  if (!command || !GUIDES[command.toLowerCase()]) return false;
  if (!rest.includes('--help') && !rest.includes('-h')) return false;
  console.log(renderCliGuide(command));
  return true;
}

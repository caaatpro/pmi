/**
 * Agent integration tools inherited from Baton (full profile): baton_rules_sync,
 * baton_workspace_sync.
 *
 * Split out of src/server.ts without behaviour changes; connection state comes
 * from `ServerToolContext`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { RuleSource, AgentTarget, MCPServerEntry } from '../../types.js';
import { RulesSyncer } from '../../rules/syncer.js';
import { WorkspaceSyncEngine } from '../../workspace/engine.js';
import type { ServerToolContext } from './server-context.js';
import { AGENT_TARGETS, RULE_SOURCES } from './helpers.js';


export function registerIntegrationTools(server: McpServer, ctx: ServerToolContext): void {
  // ============================================================
  // Rules Sync Tool (P2 — Baton differentiator)
  // ============================================================


  /** baton_rules_sync — scan, dedup, and generate rules across agents */
  server.registerTool(
    'baton_rules_sync',
    {
      title: 'Rules Sync',
      description:
        'Scan project for agent rule files (Cursor, Claude Code, Codex, Windsurf, Antigravity, Gemini CLI, Copilot, Kiro, OpenCode, Trae), ' +
        'deduplicate, detect conflicts, and optionally generate rules for a target agent format. ' +
        'Without target: returns sync status report. With target: generates converted rule files.',
      inputSchema: {
        action: z.enum(['status', 'generate']).describe('Action: "status" for report, "generate" to produce target files'),
        target: z.enum(RULE_SOURCES).optional().describe('Target agent format for generation (required when action=generate)'),
      },
    },
    async ({ action, target }) => {
      const syncer = new RulesSyncer(ctx.project.rootPath);

      if (action === 'status') {
        const status = await syncer.syncStatus();
        const lines = [
          `## Rules Sync Status`,
          ``,
          `**Sources found:** ${status.sources.join(', ') || 'none'}`,
          `**Total rules:** ${status.totalRules}`,
          `**Unique rules:** ${status.uniqueRules}`,
          `**Conflicts:** ${status.conflicts.length}`,
        ];

        if (status.conflicts.length > 0) {
          lines.push('', '### Conflicts');
          for (const c of status.conflicts) {
            lines.push(`- **${c.ruleA.source}** \`${c.ruleA.id}\` vs **${c.ruleB.source}** \`${c.ruleB.id}\`: ${c.reason}`);
          }
        }

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        };
      }

      // action === 'generate'
      if (!target) {
        return {
          content: [{ type: 'text' as const, text: 'Error: target is required for generate action' }],
          isError: true,
        };
      }

      const rules = await syncer.scanRules();
      const deduped = syncer.deduplicateRules(rules);
      const effectiveTarget = target === 'opencode' ? 'codex' : target;
      const files = syncer.generateForTarget(deduped, effectiveTarget as RuleSource);

      const lines = [
        `## Generated ${files.length} file(s) for ${target}`,
        '',
      ];
      for (const f of files) {
        lines.push(`### \`${f.filePath}\``, '```', f.content, '```', '');
      }
      lines.push('> Use these contents to create the rule files in your project.');

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    },
  );

  // ============================================================
  // Workspace Sync Tool (P3 — Cross-Agent Workspace Bridge)
  // ============================================================


  /** baton_workspace_sync — migrate entire workspace config across agents */
  server.registerTool(
    'baton_workspace_sync',
    {
      title: 'Workspace Sync',
      description:
        'Migrate your entire workspace environment between AI coding agents (Cursor, Windsurf, Claude Code, Codex, Copilot, Gemini CLI, OpenClaw, Hermes Agent, Oh-my-Pi, Kiro, Antigravity, OpenCode, Trae). ' +
        'Syncs MCP server configs, workflows, rules, and skills across IDEs. ' +
        'Action "scan": detect all workspace configs. ' +
        'Action "migrate": generate configs for target agent (preview only). ' +
        'Action "apply": migrate AND write configs to disk with backup/rollback.',
      inputSchema: {
        action: z.enum(['scan', 'migrate', 'apply']).describe('Action: "scan" to detect configs, "migrate" to preview, "apply" to write to disk'),
        target: z.enum(AGENT_TARGETS).optional().describe('Target agent for migration (required for migrate)'),
        items: z.array(z.string()).optional().describe('Selective sync: list specific MCP server or skill names to sync (e.g. ["figma-remote-mcp-server", "create-subagent"]). Omit to sync all.'),
      },
    },
    async ({ action, target, items }) => {
      const engine = new WorkspaceSyncEngine(ctx.project.rootPath);

      if (action === 'scan') {
        const scan = await engine.scan();
        const lines = [
          `## Workspace Scan Report`,
          '',
          `### MCP Server Configs`,
        ];

        for (const [agent, servers] of Object.entries(scan.mcpConfigs)) {
          if ((servers as MCPServerEntry[]).length > 0) {
            lines.push(`- **${agent}**: ${(servers as MCPServerEntry[]).length} server(s) — ${(servers as MCPServerEntry[]).map((s: MCPServerEntry) => s.name).join(', ')}`);
          }
        }

        lines.push('', `### Workflows`);
        if (scan.workflows.length > 0) {
          for (const wf of scan.workflows) {
            lines.push(`- **${wf.name}** (${wf.source}): ${wf.description || '(no description)'}`);
          }
        } else {
          lines.push('- No workflows found');
        }

        lines.push('', `### Rules`);
        lines.push(`- ${scan.rulesCount} rule(s) detected across all agents`);

        lines.push('', `### Skills`);
        if (scan.skills.length > 0) {
          for (const sk of scan.skills) {
            lines.push(`- **${sk.name}** (${sk.sourceAgent}): ${sk.description || '(no description)'}`);
          }
        } else {
          lines.push('- No skills found');
        }

        if (scan.skillConflicts.length > 0) {
          lines.push('', `### [WARN] Skill Name Conflicts`);
          for (const c of scan.skillConflicts) {
            lines.push(`- **${c.name}**: kept from ${c.kept.sourceAgent}, duplicate in ${c.skipped.sourceAgent}`);
          }
        }

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        };
      }

      // action === 'migrate' or 'apply' — both need target
      if (!target) {
        return {
          content: [{ type: 'text' as const, text: 'Error: target is required for migrate/apply action' }],
          isError: true,
        };
      }

      if (action === 'apply') {
        const applyResult = await engine.apply(target as AgentTarget, items);
        return {
          content: [{ type: 'text' as const, text: applyResult.migrationSummary }],
          ...(applyResult.success ? {} : { isError: true }),
        };
      }

      // action === 'migrate' (preview only)
      const result = await engine.migrate(target as AgentTarget, items);
      const lines = [
        `## Workspace Migration → ${target}`,
        '',
      ];

      if (result.mcpServers.generated.length > 0) {
        lines.push('### MCP Config');
        for (const f of result.mcpServers.generated) {
          lines.push(`#### \`${f.filePath}\``, '```', f.content, '```', '');
        }
      }

      if (result.workflows.generated.length > 0) {
        lines.push('### Workflows');
        for (const f of result.workflows.generated) {
          lines.push(`#### \`${f.filePath}\``, '```', f.content, '```', '');
        }
      }

      if (result.rules.generated > 0) {
        lines.push(`### Rules`, `- ${result.rules.generated} rule file(s) generated`);
      }

      if (result.skills.scanned.length > 0) {
        lines.push('### Skills', `- ${result.skills.scanned.length} skill(s) found, ready to copy:`);
        for (const sk of result.skills.scanned) {
          lines.push(`  - **${sk.name}** (from ${sk.sourceAgent})`);
        }
      }

      lines.push('', '> Review the generated configs above. Use action "apply" to write them to disk.');

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    },
  );
}

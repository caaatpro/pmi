/**
 * Mini-skill tools inherited from Memorix: memorix_skills, memorix_promote.
 *
 * Split out of src/server.ts without behaviour changes; connection state comes
 * from `ServerToolContext`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getAllObservations } from '../../memory/observations.js';
import { withFreshIndex } from '../../memory/freshness.js';
import { getObservationStore } from '../../store/obs-store.js';
import { filterReadableObservations, resolveObservationVisibility } from '../../memory/visibility.js';
import type { AgentTarget } from '../../types.js';
import type { ServerToolContext } from './server-context.js';
import { AGENT_TARGETS } from './helpers.js';


export function registerSkillTools(server: McpServer, ctx: ServerToolContext): void {
  // ============================================================
  // memorix_skills — Memory-driven project skills
  // ============================================================

  server.registerTool(
    'memorix_skills',
    {
      title: 'Project Skills',
      description:
        'Memory-driven project skills. ' +
        'Action "list": show all available skills from all agents. ' +
        'Action "generate": auto-generate project-specific skills from observation patterns (gotchas, decisions, how-it-works). ' +
        'Action "inject": return a specific skill\'s full content for direct use. ' +
        'Generated skills follow the SKILL.md standard and can be synced across Cursor, Windsurf, Claude Code, Codex, Copilot, Kiro, Antigravity, OpenCode, and Trae. OpenClaw, Hermes Agent, and Oh-my-Pi receive skills through their official bundle/plugin/package setup lanes rather than generic workspace skill copy.',
      inputSchema: {
        action: z.enum(['list', 'generate', 'inject']).describe('Action: "list" to discover skills, "generate" to create from memory, "inject" to get skill content'),
        name: z.string().optional().describe('Skill name (required for "inject")'),
        target: z.enum(AGENT_TARGETS).optional().describe('Target agent to write generated skills to (optional for "generate")'),
        write: z.boolean().optional().describe('Whether to write generated skills to disk (default: false, preview only)'),
      },
    },
    async ({ action, name, target, write }) => {
      const { SkillsEngine } = await import('../../skills/engine.js');
      const engine = new SkillsEngine(ctx.project.rootPath);

      if (action === 'list') {
        const skills = engine.listSkills();
        if (skills.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No skills found in any agent directory.\n\nSkills are discovered from:\n- `.cursor/skills/*/SKILL.md`\n- `.agents/skills/*/SKILL.md`\n- `.agent/skills/*/SKILL.md`\n- `.windsurf/skills/*/SKILL.md`\n- etc.\n\nUse action "generate" to auto-create skills from your project observations.' }],
          };
        }

        const lines = [
          `## Available Skills (${skills.length})`,
          '',
        ];
        for (const sk of skills) {
          lines.push(`- **${sk.name}** (${sk.sourceAgent}): ${sk.description || '(no description)'}`);
        }
        lines.push('', '> Use `action: "inject", name: "<skill-name>"` to get full skill content.');

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        };
      }

      if (action === 'inject') {
        if (!name) {
          return {
            content: [{ type: 'text' as const, text: 'Error: `name` is required for inject action. Use `action: "list"` first to see available skills.' }],
            isError: true,
          };
        }

        const skill = engine.injectSkill(name);
        if (!skill) {
          return {
            content: [{ type: 'text' as const, text: `Skill "${name}" not found. Use \`action: "list"\` to see available skills.` }],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text' as const, text: `## Skill: ${skill.name}\n**Source**: ${skill.sourceAgent}\n**Path**: ${skill.sourcePath}\n\n---\n\n${skill.content}` }],
        };
      }

      // action === 'generate'
      const { getObservationStore: getStore } = await import('../../store/obs-store.js');
      const allObs = filterReadableObservations(
        (await getStore().loadAll()).filter((observation) => observation.projectId === ctx.project.id),
        ctx.getObservationReader(),
      );

      const obsData = allObs.map(o => ({
        id: o.id || 0,
        entityName: o.entityName || 'unknown',
        type: o.type || 'discovery',
        title: o.title || '',
        narrative: o.narrative || '',
        facts: o.facts,
        concepts: o.concepts,
        filesModified: o.filesModified,
        createdAt: o.createdAt,
        status: o.status,
        source: o.source,
      }));

      const generated = engine.generateFromObservations(obsData);

      if (generated.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No skill-worthy patterns found yet.\n\nSkills are auto-generated when entities accumulate enough observations (3+), especially gotchas, decisions, and how-it-works notes.\n\nKeep using memorix_store to build up project knowledge!' }],
        };
      }

      const lines = [
        `## Generated Skills (${generated.length})`,
        '',
        'Based on observation patterns in your project memory:',
        '',
      ];

      for (const sk of generated) {
        lines.push(`### ${sk.name}`);
        lines.push(`- **Description**: ${sk.description}`);
        lines.push(`- **Observations**: ${sk.content.split('\n').length} lines of knowledge`);

        if (write && target) {
          const path = engine.writeSkill(sk, target as AgentTarget);
          if (path) {
            lines.push(`- [OK] **Written**: \`${path}\``);
          } else {
            lines.push(`- [ERROR] Failed to write`);
          }
        }
        lines.push('');
      }

      if (!write) {
        lines.push('> Preview only. Add `write: true, target: "<agent>"` to save skills to disk.');
      }

      // Show first generated skill as preview
      if (generated.length > 0) {
        lines.push('', '---', '### Preview: ' + generated[0].name, '', '```markdown', generated[0].content, '```');
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    },
  );

  // ============================================================
  // Mini-Skills — Promote memories to permanent skills
  // ============================================================

  /**
   * memorix_promote — Promote observations to permanent mini-skills
   *
   * Converts important memories into permanent, never-decaying mini-skills
   * that are automatically injected into agent context at session_start.
   */
  server.registerTool(
    'memorix_promote',
    {
      title: 'Promote to Mini-Skill',
      description:
        'Promote observations to permanent mini-skills that never decay and are auto-injected at session start. ' +
        'Action "promote": convert observation(s) to a mini-skill. ' +
        'Action "list": show all active mini-skills. ' +
        'Action "delete": remove a mini-skill by ID.\n\n' +
        'Mini-skills are project-specific specialized knowledge derived from your actual memories — ' +
        'gotchas, decisions, fixes that generic online skills cannot provide.',
      inputSchema: {
        action: z.enum(['promote', 'list', 'delete']).describe('Action to perform'),
        observationIds: z.array(z.number()).optional().describe('Observation IDs to promote (required for "promote")'),
        skillId: z.number().optional().describe('Mini-skill ID to delete (required for "delete")'),
        trigger: z.string().optional().describe('Override: when this skill should be applied'),
        instruction: z.string().optional().describe('Override: what the agent should do'),
        tags: z.array(z.string()).optional().describe('Extra classification tags'),
      },
    },
    async ({ action, observationIds, skillId, trigger, instruction, tags }) => {
      const { promoteToMiniSkill, loadAllMiniSkills, deleteMiniSkill, formatMiniSkillsForInjection } = await import('../../skills/mini-skills.js');

      if (action === 'list') {
        const skills = await loadAllMiniSkills(ctx.projectDir);
        if (skills.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No mini-skills found.\n\nUse `action: "promote", observationIds: [<id>]` to convert important memories into permanent mini-skills.\nThese will be auto-injected at every session start.' }],
          };
        }
        const formatted = formatMiniSkillsForInjection(skills);
        const lines = [
          formatted,
          '---',
          `Total: ${skills.length} mini-skill(s)`,
          '',
          '> Use `action: "delete", skillId: <id>` to remove a mini-skill.',
        ];
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      }

      if (action === 'delete') {
        if (skillId == null) {
          return { content: [{ type: 'text' as const, text: 'Error: `skillId` is required for delete action.' }], isError: true };
        }
        const deleted = await deleteMiniSkill(ctx.projectDir, skillId);
        if (!deleted) {
          return { content: [{ type: 'text' as const, text: `Mini-skill #${skillId} not found.` }], isError: true };
        }
        return { content: [{ type: 'text' as const, text: `[OK] Deleted mini-skill #${skillId}.` }] };
      }

      // action === 'promote'
      if (!observationIds || observationIds.length === 0) {
        return { content: [{ type: 'text' as const, text: 'Error: `observationIds` is required for promote action. Use `memorix_search` to find observation IDs.' }], isError: true };
      }

      // Load observations by ID — only active observations can be promoted
      const { getAllObservations } = await import('../../memory/observations.js');
      const allObs = await withFreshIndex(() => getAllObservations());
      const reader = ctx.getObservationReader();
      const matched = filterReadableObservations(
        allObs.filter((observation) => observation.projectId === ctx.project.id && observationIds.includes(observation.id)),
        reader,
      );

      if (matched.length === 0) {
        return { content: [{ type: 'text' as const, text: `No observations found for IDs: [${observationIds.join(', ')}]. Use \`memorix_search\` to find valid IDs.` }], isError: true };
      }

      // Fail-fast: ALL matched observations must be active — no silent drop
      const nonActive = matched.filter(o => (o.status ?? 'active') !== 'active');
      if (nonActive.length > 0) {
        return { content: [{ type: 'text' as const, text: `Cannot promote: ${nonActive.length} observation(s) are not active: ${nonActive.map(o => `#${o.id} (${o.status})`).join(', ')}. Only active observations can be promoted to permanent knowledge.` }], isError: true };
      }

      const nonProjectShared = matched.filter((observation) => resolveObservationVisibility(observation) !== 'project');
      if (nonProjectShared.length > 0) {
        return {
          content: [{ type: 'text' as const, text: `Cannot promote private or team-scoped observations: ${nonProjectShared.map((observation) => `#${observation.id}`).join(', ')}. Promote only deliberate project-shared knowledge.` }],
          isError: true,
        };
      }

      const skill = await promoteToMiniSkill(ctx.projectDir, ctx.project.id, matched, { trigger, instruction, tags });

      const lines = [
        `[OK] Created mini-skill #${skill.id}`,
        '',
        `**${skill.title}**`,
        `**Do**: ${skill.instruction}`,
        `**When**: ${skill.trigger}`,
      ];
      if (skill.facts.length > 0) {
        lines.push('**Facts**:');
        for (const f of skill.facts) lines.push(`- ${f}`);
      }
      lines.push('', `Source: ${matched.length} observation(s) [${matched.map((o: any) => o.id).join(', ')}]`);
      lines.push('', '> This mini-skill will be auto-injected at every `memorix_session_start`.');

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );
}

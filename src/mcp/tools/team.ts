/**
 * Agent identity tool inherited from Memorix (team profile): team_manage.
 *
 * An agent that joins gets an agent_id that attributes its observations and
 * unlocks personal/team memory visibility. Task, message, lock, poll and
 * handoff coordination was removed; PMI sessions and handoff replace it.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerToolContext } from './server-context.js';
import { coerceStringArray } from './helpers.js';

export function registerTeamTools(server: McpServer, ctx: ServerToolContext): void {
  // ── team_manage (join / leave / status) ──
  server.registerTool(
    'team_manage',
    {
      title: 'Agent Identity',
      description:
        'Register, unregister, or list agent identities in this project. ' +
        'Action "join": register this agent (returns agent ID and instance ID for reactivation). ' +
        'Action "leave": mark agent inactive. ' +
        'Action "status": list agents with roles and capabilities.',
      inputSchema: {
        action: z.enum(['join', 'leave', 'status']).describe('Operation to perform'),
        name: z.string().optional().describe('Agent display name for join (e.g., "cursor-frontend")'),
        agentType: z.string().optional().describe('Agent type for join (e.g., "windsurf", "cursor", "claude-code")'),
        instanceId: z.string().optional().describe('Stable instance ID for join (preserves identity across restarts)'),
        role: z.string().optional().describe('Agent role for join (defaults by agentType if omitted)'),
        capabilities: z.array(z.string()).optional().describe('Agent capabilities for join'),
        agentId: z.string().optional().describe('Agent ID for leave'),
      },
    },
    async ({ action, name, agentType, instanceId, role, capabilities, agentId }) => {
      if (action === 'join') {
        // Auto-derive role from agentType if not provided
        const { AGENT_TYPE_ROLE_MAP } = await import('../../team/team-store.js');
        const resolvedRole = role || (agentType ? AGENT_TYPE_ROLE_MAP[agentType] : undefined) || 'engineer';
        const agent = ctx.teamStore.registerAgent({
          projectId: ctx.project.id,
          agentType: agentType || 'unknown',
          instanceId: instanceId || undefined,
          name: (name || '').trim() || undefined,
          role: resolvedRole,
          capabilities: capabilities ? coerceStringArray(capabilities) : undefined,
        });
        ctx.currentAgentId = agent.agent_id;
        return {
          content: [{
            type: 'text' as const,
            text: `Joined project as "${agent.name}" (ID: ${agent.agent_id})\nInstance ID: ${agent.instance_id}\nRole: ${agent.role}\nThis session now attributes its memory to that identity.\nActive agents: ${ctx.teamStore.getActiveCount(ctx.project.id)}`,
          }],
        };
      }
      if (action === 'leave') {
        if (!agentId) return { content: [{ type: 'text' as const, text: 'agentId is required for leave' }], isError: true };
        const left = ctx.teamStore.leaveAgent(agentId);
        if (ctx.currentAgentId === agentId) ctx.currentAgentId = undefined;
        if (!left) return { content: [{ type: 'text' as const, text: 'Agent not found' }] };
        return {
          content: [{
            type: 'text' as const,
            text: `Left team.\nActive agents: ${ctx.teamStore.getActiveCount(ctx.project.id)}`,
          }],
        };
      }
      // status
      const agents = ctx.teamStore.listAgents(ctx.project.id);
      if (agents.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No agents registered. Use action "join" to register.' }] };
      }
      const agentLines = agents.map((a: import('../../team/team-store.js').TeamAgentRow) => {
        const caps = a.capabilities ? JSON.parse(a.capabilities) : [];
        return `${a.status === 'active' ? '[active]' : '[inactive]'} ${a.name} (${a.agent_id.slice(0, 8)}) - ${a.role ?? 'no role'} [${caps.join(', ') || '-'}]`;
      });
      return {
        content: [{
          type: 'text' as const,
          text: `Team: ${ctx.teamStore.getActiveCount(ctx.project.id)} active / ${agents.length} total\n\nAgents:\n${agentLines.join('\n')}`,
        }],
      };
    },
  );
}

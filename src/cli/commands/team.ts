import { defineCommand } from 'citty';
import { AGENT_TYPE_ROLE_MAP } from '../../team/team-store.js';
import { clearCliIdentity } from '../identity.js';
import { emitError, emitResult, getCliProjectContext, parseCsvList, resolveCliActorId, shortId } from './operator-shared.js';

export default defineCommand({
  meta: {
    name: 'team',
    description: 'Manage project-scoped agent identities',
  },
  args: {
    name: { type: 'string', description: 'Agent display name' },
    agentType: { type: 'string', description: 'Agent type (codex, windsurf, gemini-cli, etc.)' },
    instanceId: { type: 'string', description: 'Stable instance identity' },
    role: { type: 'string', description: 'Explicit role override' },
    capabilities: { type: 'string', description: 'Comma-separated capability list' },
    agentId: { type: 'string', description: 'Agent ID for leave or targeted operations' },
    all: { type: 'boolean', description: 'Show inactive/historical agents in status output' },
    json: { type: 'boolean', description: 'Emit machine-readable JSON output' },
  },
  run: async ({ args }) => {
    const action = (args._ as string[])?.[0] || '';
    const asJson = !!args.json;

    try {
      const { project, dataDir, teamStore, identity } = await getCliProjectContext();
      const selectedAgentId = resolveCliActorId(args.agentId, identity);

      switch (action) {
        case 'join': {
          const agentType = (args.agentType as string | undefined) || 'unknown';
          const resolvedRole =
            (args.role as string | undefined) ||
            AGENT_TYPE_ROLE_MAP[agentType] ||
            'engineer';
          const agent = teamStore.registerAgent({
            projectId: project.id,
            agentType,
            instanceId: args.instanceId as string | undefined,
            name: (args.name as string | undefined)?.trim() || undefined,
            role: resolvedRole,
            capabilities: parseCsvList(args.capabilities as string | undefined),
          });
          emitResult(
            { project, agent },
            `Joined project coordination state as ${agent.name} (${agent.role})`,
            asJson,
          );
          return;
        }

        case 'leave': {
          if (!selectedAgentId) {
            emitError('an active CLI identity or agentId is required for "baton team leave"', asJson);
            return;
          }
          const left = teamStore.leaveAgent(selectedAgentId);
          if (!left) {
            emitError(`Agent "${selectedAgentId}" not found`, asJson);
            return;
          }
          if (identity?.agentId === selectedAgentId) {
            await clearCliIdentity(dataDir);
          }
          emitResult(
            { project, agentId: selectedAgentId },
            `Left team: ${selectedAgentId}`,
            asJson,
          );
          return;
        }

        case 'status': {
          const agents = teamStore.listAgents(project.id);
          const activeAgents = agents.filter((agent) => agent.status === 'active');
          const historicalAgents = agents.filter((agent) => agent.status !== 'active');
          const showAll = !!args.all;
          const visibleAgents = showAll ? agents : activeAgents;
          const formatAgent = (agent: typeof agents[number]) =>
            `- ${agent.name} [${agent.agent_type}] ${agent.role ?? 'no role'} (${shortId(agent.agent_id)})${agent.status === 'active' ? '' : ' (inactive)'}`;
          emitResult(
            {
              project,
              agents,
              visibleAgents,
              activeCount: activeAgents.length,
              historicalCount: historicalAgents.length,
            },
            [
              `Project agents: ${activeAgents.length} active agent(s) / ${historicalAgents.length} historical or inactive`,
              '',
              visibleAgents.length > 0
                ? `${showAll ? 'All agents' : 'Active agents'}:\n${visibleAgents.map(formatAgent).join('\n')}`
                : `${showAll ? 'All agents' : 'Active agents'}: none`,
              !showAll && historicalAgents.length > 0
                ? `\nHistorical/inactive agents: ${historicalAgents.length} (use --all to list).`
                : '',
            ].join('\n'),
            asJson,
          );
          return;
        }

        default:
          console.log('Agent identity commands');
          console.log('');
          console.log('Usage:');
          console.log('  baton team status [--all]');
          console.log('  baton team join --agentType codex [--name codex-main --instanceId abc]');
          console.log('  baton team leave --agentId <id>');
      }
    } catch (error) {
      emitError(error instanceof Error ? error.message : String(error), asJson);
    }
  },
});

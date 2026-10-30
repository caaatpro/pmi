/**
 * Team coordination tools inherited from Memorix (team profile): team_manage, team_file_lock,
 * team_task, team_message, memorix_poll, memorix_handoff.
 *
 * Split out of src/server.ts without behaviour changes; connection state comes
 * from `ServerToolContext`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { storeObservation, getAllObservations } from '../../memory/observations.js';
import { withFreshIndex } from '../../memory/freshness.js';
import { getObservationStore } from '../../store/obs-store.js';
import { filterReadableObservations } from '../../memory/visibility.js';
import type { ServerToolContext } from './server-context.js';
import { coerceStringArray } from './helpers.js';

export function registerTeamTools(server: McpServer, ctx: ServerToolContext): void {
  // ── team_manage (join / leave / status / listRoles / addRole / removeRole) ──
  server.registerTool(
    'team_manage',
    {
      title: 'Coordination Management',
      description:
        'Register, unregister, or list agents in the project coordination state. ' +
        'Action "join": register this agent (returns agent ID and instance ID for reactivation). ' +
        'Action "leave": mark agent inactive, release locks. ' +
        'Action "status": list all agents with roles and capabilities, plus role occupancy. ' +
        'Action "listRoles": show defined roles for this project. ' +
        'Action "addRole": define a new role for this project. ' +
        'Action "removeRole": remove a role definition.',
      inputSchema: {
        action: z.enum(['join', 'leave', 'status', 'listRoles', 'addRole', 'removeRole']).describe('Operation to perform'),
        name: z.string().optional().describe('Agent display name for join (e.g., "cursor-frontend")'),
        agentType: z.string().optional().describe('Agent type for join (e.g., "windsurf", "cursor", "claude-code")'),
        instanceId: z.string().optional().describe('Stable instance ID for join (preserves identity across restarts)'),
        role: z.string().optional().describe('Agent role for join (defaults by agentType if omitted)'),
        capabilities: z.array(z.string()).optional().describe('Agent capabilities for join'),
        agentId: z.string().optional().describe('Agent ID for leave'),
        // Role management params
        roleId: z.string().optional().describe('Role ID (for addRole/removeRole)'),
        label: z.string().optional().describe('Role label (for addRole)'),
        roleDescription: z.string().optional().describe('Role description (for addRole)'),
        preferredAgentTypes: z.array(z.string()).optional().describe('Preferred agent types for this role (for addRole)'),
        maxConcurrent: z.number().optional().describe('Max concurrent agents for this role (for addRole, default 1)'),
      },
    },
    async ({ action, name, agentType, instanceId, role, capabilities, agentId, roleId, label, roleDescription, preferredAgentTypes, maxConcurrent }) => {
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
        const caps = agent.capabilities ? JSON.parse(agent.capabilities) : [];
        return {
          content: [{
            type: 'text' as const,
            text: `Joined project coordination state as "${agent.name}" (ID: ${agent.agent_id})\nInstance ID: ${agent.instance_id}\nRole: ${agent.role}\nThis session now attributes coordination activity to that identity.\nActive agents: ${ctx.teamStore.getActiveCount(ctx.project.id)}`,
          }],
        };
      }
      if (action === 'leave') {
        if (!agentId) return { content: [{ type: 'text' as const, text: 'agentId is required for leave' }], isError: true };
        const left = ctx.teamStore.leaveAgent(agentId);
        if (ctx.currentAgentId === agentId) ctx.currentAgentId = undefined;
        if (!left) return { content: [{ type: 'text' as const, text: 'Agent not found' }] };
        const releasedLocks = ctx.teamStore.releaseAllLocks(agentId);
        const releasedTasks = ctx.teamStore.releaseTasksByAgent(agentId);
        const parts: string[] = [];
        if (releasedLocks > 0) parts.push(`released ${releasedLocks} lock(s)`);
        if (releasedTasks > 0) parts.push(`released ${releasedTasks} task(s)`);
        return {
          content: [{
            type: 'text' as const,
            text: `Left team.${parts.length > 0 ? ' ' + parts.join(', ') + '.' : ''}\nActive agents: ${ctx.teamStore.getActiveCount(ctx.project.id)}`,
          }],
        };
      }
      if (action === 'listRoles') {
        const roles = ctx.teamStore.listRoles(ctx.project.id);
        if (roles.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No roles defined for this project.' }] };
        }
        const occupancy = ctx.teamStore.getRoleOccupancy(ctx.project.id);
        const lines = occupancy.map(({ role, activeAgents, vacant }) => {
          const agentTypes = JSON.parse(role.preferred_agent_types);
          const agentNames = activeAgents.map(a => a.name).join(', ') || 'vacant';
          return `${role.label} (${role.role_id.split(':').pop()}) - ${activeAgents.length}/${role.max_concurrent} filled, ${vacant} vacant\n  Agents: ${agentNames}\n  Preferred types: ${agentTypes.join(', ') || 'any'}${role.description ? '\n  ' + role.description : ''}`;
        });
        return { content: [{ type: 'text' as const, text: `Roles (${roles.length}):\n\n${lines.join('\n\n')}` }] };
      }
      if (action === 'addRole') {
        if (!roleId || !label) return { content: [{ type: 'text' as const, text: 'roleId and label are required for addRole' }], isError: true };
        const newRole = ctx.teamStore.addRole(ctx.project.id, {
          roleId,
          label,
          description: roleDescription,
          preferredAgentTypes: preferredAgentTypes ? coerceStringArray(preferredAgentTypes) : undefined,
          maxConcurrent,
        });
        return { content: [{ type: 'text' as const, text: `Role added: ${newRole.label} (${newRole.role_id})` }] };
      }
      if (action === 'removeRole') {
        if (!roleId) return { content: [{ type: 'text' as const, text: 'roleId is required for removeRole' }], isError: true };
        const removed = ctx.teamStore.removeRole(ctx.project.id, roleId);
        if (!removed) return { content: [{ type: 'text' as const, text: 'Role not found' }] };
        return { content: [{ type: 'text' as const, text: `Role removed: ${roleId}` }] };
      }
      // status - now includes role occupancy
      const agents = ctx.teamStore.listAgents(ctx.project.id);
      const occupancy = ctx.teamStore.getRoleOccupancy(ctx.project.id);
      if (agents.length === 0 && occupancy.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No agents registered. Use action "join" to register.' }] };
      }
      const roleLines = occupancy.map(({ role, activeAgents, vacant }) => {
        const agentNames = activeAgents.map(a => a.name).join(', ') || 'vacant';
        return `${role.label}: ${activeAgents.length}/${role.max_concurrent} - ${agentNames}${vacant > 0 ? ` (${vacant} slot${vacant > 1 ? 's' : ''} open)` : ''}`;
      });
      const agentLines = agents.map((a: import('../../team/team-store.js').TeamAgentRow) => {
        const caps = a.capabilities ? JSON.parse(a.capabilities) : [];
        return `${a.status === 'active' ? '[active]' : '[inactive]'} ${a.name} (${a.agent_id.slice(0, 8)}) - ${a.role ?? 'no role'} [${caps.join(', ') || '-'}]`;
      });
      return {
        content: [{
          type: 'text' as const,
          text: `Team: ${ctx.teamStore.getActiveCount(ctx.project.id)} active / ${agents.length} total\n\nRole Occupancy:\n${roleLines.join('\n')}\n\nAgents:\n${agentLines.join('\n')}`,
        }],
      };
    },
  );

  // ── team_file_lock (lock / unlock / status) ───────────────────
  server.registerTool(
    'team_file_lock',
    {
      title: 'File Lock Management',
      description:
        'Advisory file locks to prevent conflicting edits. Auto-releases after 10 min TTL. ' +
        'Action "lock": acquire lock. Action "unlock": release lock. Action "status": check lock status.',
      inputSchema: {
        action: z.enum(['lock', 'unlock', 'status']).describe('Operation to perform'),
        file: z.string().optional().describe('File path (required for lock/unlock, optional for status — omit to list all)'),
        agentId: z.string().optional().describe('Agent ID (required for lock/unlock)'),
      },
    },
    async ({ action, file, agentId }) => {
      if (action === 'lock') {
        if (!file || !agentId) return { content: [{ type: 'text' as const, text: '[ERROR] file and agentId are required for lock' }], isError: true };
        const agent = ctx.teamStore.getAgent(agentId);
        if (!agent || agent.status !== 'active') {
          return { content: [{ type: 'text' as const, text: `[ERROR] Unknown or inactive agent: ${agentId.slice(0, 8)}…` }], isError: true };
        }
        const result = ctx.teamStore.acquireLock(ctx.project.id, file, agentId);
        if (result.success) return { content: [{ type: 'text' as const, text: `Locked: ${file}` }] };
        const owner = ctx.teamStore.getAgent(result.lockedBy);
        return { content: [{ type: 'text' as const, text: `Denied — locked by ${owner?.name ?? result.lockedBy.slice(0, 8)}` }], isError: true };
      }
      if (action === 'unlock') {
        if (!file || !agentId) return { content: [{ type: 'text' as const, text: '[ERROR] file and agentId are required for unlock' }], isError: true };
        const released = ctx.teamStore.releaseLock(ctx.project.id, file, agentId);
        return { content: [{ type: 'text' as const, text: released ? `Unlocked: ${file}` : `Cannot unlock: not owner or not locked` }] };
      }
      // status
      if (file) {
        const lockStatus = ctx.teamStore.getLockStatus(ctx.project.id, file);
        if (!lockStatus) return { content: [{ type: 'text' as const, text: `${file} — unlocked` }] };
        const owner = ctx.teamStore.getAgent(lockStatus.locked_by);
        return { content: [{ type: 'text' as const, text: `${file} — locked by ${owner?.name ?? lockStatus.locked_by.slice(0, 8)} (expires ${new Date(lockStatus.expires_at).toISOString()})` }] };
      }
      const all = ctx.teamStore.listLocks(ctx.project.id);
      if (all.length === 0) return { content: [{ type: 'text' as const, text: 'No files locked' }] };
      const lines = all.map((l: import('../../team/team-store.js').TeamLockRow) => {
        const owner = ctx.teamStore.getAgent(l.locked_by);
        return `${l.file} — ${owner?.name ?? l.locked_by.slice(0, 8)}`;
      });
      return { content: [{ type: 'text' as const, text: `Locked files (${all.length}):\n${lines.join('\n')}` }] };
    },
  );

  // ── team_task (create / claim / complete / list) ──────────────
  server.registerTool(
    'team_task',
    {
      title: 'Task Status',
      description:
        'Create, claim, complete, or list tasks in the team task board. Supports dependencies. ' +
        'Action "create": create a task. Action "claim": assign to yourself (atomic, race-safe). ' +
        'Action "complete": mark done with result. Action "list": show tasks.',
      inputSchema: {
        action: z.enum(['create', 'claim', 'complete', 'list']).describe('Operation to perform'),
        description: z.string().optional().describe('Task description (for create)'),
        deps: z.array(z.string()).optional().describe('Dependency task IDs (for create)'),
        taskId: z.string().optional().describe('Task ID (for claim/complete)'),
        agentId: z.string().optional().describe('Agent ID (for claim/complete)'),
        result: z.string().optional().describe('Result summary (for complete)'),
        status: z.enum(['pending', 'in_progress', 'completed', 'failed']).optional().describe('Filter by status (for list)'),
        available: z.boolean().optional().describe('Show only claimable tasks (for list)'),
        metadata: z.string().optional().describe('JSON metadata for the task (for create). Used by planner/review tasks for autonomous mode.'),
        requiredRole: z.string().optional().describe('Required role for this task (for create). Agents without this role cannot claim.'),
        preferredRole: z.string().optional().describe('Preferred role for this task (for create). Agents with this role are prioritized.'),
      },
    },
    async ({ action, description: desc, deps, taskId, agentId, result, status, available, metadata, requiredRole, preferredRole }) => {
      try {
        if (action === 'create') {
          if (!desc) return { content: [{ type: 'text' as const, text: '[ERROR] description is required for create' }], isError: true };
          let parsedMeta: Record<string, unknown> | undefined;
          if (metadata) {
            try { parsedMeta = JSON.parse(metadata); } catch { /* ignore invalid JSON */ }
          }

          const task = ctx.teamStore.createTask({
            projectId: ctx.project.id,
            description: desc,
            deps: deps ? coerceStringArray(deps) : undefined,
            metadata: parsedMeta,
            createdBy: agentId || undefined,
            requiredRole: requiredRole || undefined,
            preferredRole: preferredRole || undefined,
          });
          const taskDeps = ctx.teamStore.getTaskDeps(task.task_id);
          const roleInfo = task.required_role ? ` [role: ${task.required_role}${task.preferred_role && task.preferred_role !== task.required_role ? '/' + task.preferred_role : ''}]` : '';
          return { content: [{ type: 'text' as const, text: `Task created: ${task.task_id.slice(0, 8)}… "${desc}"${taskDeps.length > 0 ? ` (depends on ${taskDeps.length})` : ''}${roleInfo}` }] };
        }
        if (action === 'claim') {
          if (!taskId || !agentId) return { content: [{ type: 'text' as const, text: '[ERROR] taskId and agentId required for claim' }], isError: true };
          const agent = ctx.teamStore.getAgent(agentId);
          if (!agent || agent.status !== 'active') return { content: [{ type: 'text' as const, text: `[ERROR] Unknown or inactive agent` }], isError: true };
          const claimResult = ctx.teamStore.claimTask(taskId, agentId);
          if (!claimResult.success) return { content: [{ type: 'text' as const, text: `[ERROR] ${claimResult.reason}` }], isError: true };
          const hintSuffix = claimResult.hint ? `\n[WARN] ${claimResult.hint}` : '';
          return { content: [{ type: 'text' as const, text: `Task claimed by ${agent.name}: "${claimResult.task!.description}"${hintSuffix}` }] };
        }
        if (action === 'complete') {
          if (!taskId || !agentId || !result) return { content: [{ type: 'text' as const, text: '[ERROR] taskId, agentId, and result required for complete' }], isError: true };
          const completeResult = ctx.teamStore.completeTask(taskId, agentId, result);
          if (!completeResult.success) return { content: [{ type: 'text' as const, text: `[ERROR] ${completeResult.reason}` }], isError: true };
          const completedTask = ctx.teamStore.getTask(taskId);
          return { content: [{ type: 'text' as const, text: `Task completed: "${completedTask?.description ?? taskId}"\nResult: ${result}` }] };
        }
        // list
        const list = (available && agentId)
          ? ctx.teamStore.listTasksForAgent(ctx.project.id, agentId)
          : ctx.teamStore.listTasks(ctx.project.id, available ? { available: true } : (status ? { status } : undefined));
        if (list.length === 0) return { content: [{ type: 'text' as const, text: available ? 'No tasks available to claim' : 'No tasks found' }] };
        const statusIcon: Record<string, string> = { pending: '[ ]', in_progress: '[~]', completed: '[x]', failed: '[!]' };
        const lines = list.map((t: import('../../team/team-store.js').TeamTaskRow) => {
          const assignee = t.assignee_agent_id ? ctx.teamStore.getAgent(t.assignee_agent_id)?.name ?? t.assignee_agent_id.slice(0, 8) : 'unassigned';
          const taskDeps = ctx.teamStore.getTaskDeps(t.task_id);
          const roleTag = t.required_role ? ` [${t.required_role}${t.preferred_role && t.preferred_role !== t.required_role ? '→' + t.preferred_role : ''}]` : (t.preferred_role ? ` [~${t.preferred_role}]` : '');
          return `${statusIcon[t.status] ?? '[ ]'} ${t.task_id.slice(0, 8)}… "${t.description}" — ${assignee}${roleTag}${taskDeps.length > 0 ? ` [deps: ${taskDeps.length}]` : ''}`;
        });
        return { content: [{ type: 'text' as const, text: `Tasks (${list.length}):\n${lines.join('\n')}` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `[ERROR] ${(err as Error).message}` }], isError: true };
      }
    },
  );

  // ── team_message (send / broadcast / inbox) ───────────────────
  server.registerTool(
    'team_message',
    {
      title: 'Team Messaging',
      description:
        'Send, broadcast, or read messages between agents. Durable: messages survive restarts and reach inactive recipients. ' +
        'Action "send": direct message to one agent. Action "broadcast": message all agents. ' +
        'Action "inbox": read this agent\'s inbox.',
      inputSchema: {
        action: z.enum(['send', 'broadcast', 'inbox']).describe('Operation to perform'),
        from: z.string().optional().describe('Your sender agent ID. Omit it to use this session identity.'),
        to: z.string().optional().describe('Receiver agent ID (for send)'),
        type: z.enum(['request', 'response', 'info', 'announcement', 'contract', 'error', 'handoff']).optional().describe('Message type (for send/broadcast)'),
        content: z.string().optional().describe('Message content (for send/broadcast)'),
        agentId: z.string().optional().describe('Agent ID (for inbox)'),
        markRead: z.boolean().optional().default(false).describe('Mark messages as read (for inbox)'),
        toRole: z.string().optional().describe('Target role for role-based messaging/handoff (for send)'),
        handoffStatus: z.enum(['open', 'claimed', 'completed', 'archived']).optional().describe('Handoff status (for send with type=handoff)'),
      },
    },
    async ({ action, from, to, type: msgType, content, agentId, markRead, toRole, handoffStatus }) => {
      const requireCurrentTeamAgent = () => {
        if (!ctx.currentAgentId) return null;
        const agent = ctx.teamStore.getAgent(ctx.currentAgentId);
        return agent?.project_id === ctx.project.id && agent.status === 'active' ? agent : null;
      };
      if (action === 'send') {
        const sender = requireCurrentTeamAgent();
        if (!sender || !msgType || !content) return { content: [{ type: 'text' as const, text: '[ERROR] active session identity, type, and content required for send' }], isError: true };
        if (from && from !== ctx.currentAgentId) return { content: [{ type: 'text' as const, text: '[ERROR] from must match the current session identity' }], isError: true };
        if (!to && !toRole) return { content: [{ type: 'text' as const, text: '[ERROR] either to (agent ID) or toRole is required for send' }], isError: true };
        if (content.length > 10_000) return { content: [{ type: 'text' as const, text: '[ERROR] Message too large (max 10KB)' }], isError: true };
        const msg = ctx.teamStore.sendMessage({
          projectId: ctx.project.id,
          senderAgentId: ctx.currentAgentId!,
          recipientAgentId: to ?? null,
          type: msgType,
          content,
          toRole: toRole ?? null,
          handoffStatus: handoffStatus ?? (msgType === 'handoff' ? 'open' : null),
        });
        if ('error' in msg) return { content: [{ type: 'text' as const, text: `[ERROR] ${msg.error}` }], isError: true };
        const target = to ? `agent ${to.slice(0, 8)}…` : `role ${toRole}`;
        return { content: [{ type: 'text' as const, text: `Message sent (${msgType}) to ${target} | ID: ${msg.id.slice(0, 8)}…${toRole ? ` [role: ${toRole}]` : ''}` }] };
      }
      if (action === 'broadcast') {
        const sender = requireCurrentTeamAgent();
        if (!sender || !msgType || !content) return { content: [{ type: 'text' as const, text: '[ERROR] active session identity, type, and content required for broadcast' }], isError: true };
        if (from && from !== ctx.currentAgentId) return { content: [{ type: 'text' as const, text: '[ERROR] from must match the current session identity' }], isError: true };
        if (content.length > 10_000) return { content: [{ type: 'text' as const, text: '[ERROR] Message too large (max 10KB)' }], isError: true };
        const msg = ctx.teamStore.sendMessage({
          projectId: ctx.project.id,
          senderAgentId: ctx.currentAgentId!,
          recipientAgentId: null,
          type: msgType,
          content,
        });
        if ('error' in msg) return { content: [{ type: 'text' as const, text: `[ERROR] ${msg.error}` }], isError: true };
        return { content: [{ type: 'text' as const, text: `Broadcast (${msgType}) | ID: ${msg.id.slice(0, 8)}…` }] };
      }
      // inbox
      const inboxAgent = requireCurrentTeamAgent();
      if (!inboxAgent) return { content: [{ type: 'text' as const, text: '[ERROR] active session identity required for inbox' }], isError: true };
      if ((agentId && agentId !== ctx.currentAgentId) || (from && from !== ctx.currentAgentId)) {
        return { content: [{ type: 'text' as const, text: '[ERROR] inbox access is limited to the current session identity' }], isError: true };
      }
      const inboxId = ctx.currentAgentId!;
      const inbox = ctx.teamStore.getInbox(ctx.project.id, inboxId);
      const unread = ctx.teamStore.getUnreadCount(ctx.project.id, inboxId);
      if (inbox.length === 0) return { content: [{ type: 'text' as const, text: 'Inbox empty' }] };
      if (markRead) {
        ctx.teamStore.markAllRead(ctx.project.id, inboxId);
      }
      const lines = inbox.slice(-10).map((m: import('../../team/team-store.js').TeamMessageRow) => {
        const sender = ctx.teamStore.getAgent(m.sender_agent_id);
        return `${m.read_at ? ' ' : '*'} [${m.type}] from ${sender?.name ?? m.sender_agent_id.slice(0, 8)}: ${m.content.slice(0, 100)}`;
      });
      return { content: [{ type: 'text' as const, text: `Inbox: ${unread} unread / ${inbox.length} total\n\n${lines.join('\n')}` }] };
    },
  );

  // ── memorix_poll (Phase 4b: situational awareness) ────────────────
  server.registerTool(
    'memorix_poll',
    {
      title: 'Team Poll — Situational Awareness',
      description:
        'Get a full snapshot of your project coordination state in one call. ' +
        'Returns: your agent info, watermark (new observations since last session), ' +
        'inbox (unread messages), tasks (your in-progress, available to claim, completed, failed), ' +
        'and team roster (active agents). Use this to decide what to work on next.',
      inputSchema: {
        agentId: z.string().optional().describe('Your agent ID (from team_manage join or session_start with joinTeam=true). If omitted, returns project-level overview only.'),
        markInboxRead: z.boolean().optional().describe('If true, mark all inbox messages as read after returning them.'),
      },
    },
    async ({ agentId, markInboxRead }) => {
      const { computeWatermark, computePoll } = await import('../../team/poll.js');
      if (agentId && agentId !== ctx.currentAgentId) {
        return {
          content: [{ type: 'text' as const, text: '[ERROR] agentId must match the current session identity.' }],
          isError: true as const,
        };
      }
      const effectiveAgentId = ctx.currentAgentId;

      // Compute watermark — requires observation store access
      let watermark = computeWatermark(0, 0, 0);
      if (effectiveAgentId) {
        const agent = ctx.teamStore.getAgent(effectiveAgentId);
        if (agent) {
          const lastSeen = agent.last_seen_obs_generation;
          const store = getObservationStore();
          const currentGen = store.getGeneration();
          const projectObs = await withFreshIndex(() => filterReadableObservations(
            getAllObservations().filter(
              o => o.projectId === ctx.project.id && (o.writeGeneration ?? 0) > lastSeen,
            ),
            ctx.getObservationReader(),
          ));
          watermark = computeWatermark(lastSeen, currentGen, projectObs.length);

          // Advance watermark so next poll sees only truly new observations
          ctx.teamStore.updateWatermark(effectiveAgentId, currentGen);
          // Heartbeat — proves this agent is alive
          ctx.teamStore.heartbeat(effectiveAgentId);
        }
      }

      const poll = computePoll(ctx.teamStore, ctx.project.id, effectiveAgentId ?? null, watermark);

      // Optionally mark inbox as read
      if (markInboxRead && effectiveAgentId) {
        ctx.teamStore.markAllRead(ctx.project.id, effectiveAgentId);
      }

      // Format as readable text
      const lines: string[] = [];

      // Agent
      if (poll.agent) {
        lines.push(`[AGENT] You: ${poll.agent.agentId.slice(0, 8)}… (${poll.agent.status})`);
      }

      // Watermark
      if (poll.watermark.newObservationCount > 0) {
        lines.push(`[STATS] ${poll.watermark.newObservationCount} new observation(s) since your last session`);
      }

      // Inbox
      if (poll.inbox.unreadCount > 0) {
        lines.push(`[INBOX] ${poll.inbox.unreadCount} unread message(s)`);
        for (const m of poll.inbox.messages.slice(-5)) {
          const sender = ctx.teamStore.getAgent(m.sender_agent_id);
          lines.push(`  ${m.read_at ? ' ' : '*'} [${m.type}] from ${sender?.name ?? m.sender_agent_id.slice(0, 8)}: ${m.content.slice(0, 80)}`);
        }
      }

      // Tasks
      if (poll.tasks.myInProgress.length > 0) {
        lines.push(`\n[TOOL] Your in-progress tasks (${poll.tasks.myInProgress.length}):`);
        for (const t of poll.tasks.myInProgress) {
          lines.push(`  [~] ${t.task_id.slice(0, 8)}… "${t.description}"`);
        }
      }
      if (poll.tasks.availableToClaim.length > 0) {
        lines.push(`\n[TASK] Available to claim (${poll.tasks.availableToClaim.length}):`);
        for (const t of poll.tasks.availableToClaim) {
          lines.push(`  [ ] ${t.task_id.slice(0, 8)}… "${t.description}"`);
        }
      }
      if (poll.tasks.recentlyCompleted.length > 0) {
        lines.push(`\n[OK] Completed (${poll.tasks.recentlyCompleted.length}):`);
        for (const t of poll.tasks.recentlyCompleted.slice(-5)) {
          const who = t.assignee_agent_id ? ctx.teamStore.getAgent(t.assignee_agent_id)?.name ?? t.assignee_agent_id.slice(0, 8) : '?';
          lines.push(`  [x] ${t.task_id.slice(0, 8)}… "${t.description}" — by ${who}`);
        }
      }
      if (poll.tasks.recentlyFailed.length > 0) {
        lines.push(`\n[ERROR] Failed (${poll.tasks.recentlyFailed.length}):`);
        for (const t of poll.tasks.recentlyFailed.slice(-3)) {
          lines.push(`  [!] ${t.task_id.slice(0, 8)}… "${t.description}" — ${t.result?.slice(0, 80) ?? 'no reason'}`);
        }
      }

      // Team
      lines.push(`\n[TEAM] Team: ${poll.team.activeAgents.length} active / ${poll.team.totalAgents} total`);
      for (const a of poll.team.activeAgents) {
        lines.push(`  - ${a.name} (${a.agent_type}) — ${a.role ?? 'no role'}`);
      }

      if (lines.length === 0) {
        lines.push('No team activity yet. Use team_manage action="join" to register, then team_task to create tasks.');
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  // ── memorix_handoff (Phase 4b: structured agent-to-agent context transfer) ──
  server.registerTool(
    'memorix_handoff',
    {
      title: 'Team Handoff — Agent Context Transfer',
      description:
        'Create a structured handoff artifact when passing work to another agent. ' +
        'A targeted handoff is visible only to its sender and recipient; a broadcast handoff is team-visible. ' +
        'The handoff is stored as a durable observation (immune to archival) ' +
        'and a notification message is sent to the recipient. ' +
        'Use this when completing a task and another agent should continue, ' +
        'or when you want to leave context for whoever works on this next.',
      inputSchema: {
        fromAgentId: z.string().describe('Your agent ID (from team_manage join or session_start with joinTeam=true)'),
        summary: z.string().describe('Human-readable summary of what you did and what needs to happen next'),
        context: z.string().describe('Detailed context for the next agent: what was done, current state, known issues, next steps'),
        toAgentId: z.string().optional().describe('Specific recipient agent ID. Omit to broadcast to all.'),
        taskId: z.string().optional().describe('Link to a specific team_task ID'),
        filesModified: z.array(z.string()).optional().describe('Files you modified during this work'),
        concepts: z.array(z.string()).optional().describe('Key concepts for search discoverability'),
      },
    },
    async ({ fromAgentId, summary, context, toAgentId, taskId, filesModified, concepts }) => {
      const { createHandoffArtifact } = await import('../../team/handoff.js');
      if (!ctx.currentAgentId) {
        return {
          content: [{ type: 'text' as const, text: 'Create a coordination identity first: call memorix_session_start with joinTeam=true.' }],
          isError: true as const,
        };
      }
      if (fromAgentId !== ctx.currentAgentId) {
        return {
          content: [{ type: 'text' as const, text: 'fromAgentId must match the identity returned for this session. Memorix will not create a handoff on behalf of another agent.' }],
          isError: true as const,
        };
      }
      const sender = ctx.teamStore.getAgent(ctx.currentAgentId);
      if (!sender || sender.project_id !== ctx.project.id || sender.status !== 'active') {
        return {
          content: [{ type: 'text' as const, text: 'The current coordination identity is not an active member of this project.' }],
          isError: true as const,
        };
      }
      if (toAgentId) {
        const recipient = ctx.teamStore.getAgent(toAgentId);
        if (!recipient || recipient.project_id !== ctx.project.id) {
          return {
            content: [{ type: 'text' as const, text: 'The handoff recipient must be an agent registered in the current project.' }],
            isError: true as const,
          };
        }
      }

      const result = await createHandoffArtifact(
        {
          projectId: ctx.project.id,
          fromAgentId,
          toAgentId,
          taskId,
          summary,
          context,
          filesModified: filesModified ? coerceStringArray(filesModified) : undefined,
          concepts: concepts ? coerceStringArray(concepts) : undefined,
        },
        storeObservation,
        ctx.teamStore,
      );

      const lines = [
        `[OK] Handoff created`,
        `Observation: #${result.observationId}`,
        `From: ${result.fromAgentId.slice(0, 8)}…`,
        result.toAgentId ? `To: ${result.toAgentId.slice(0, 8)}…` : 'To: broadcast (any agent)',
        result.taskId ? `Task: ${result.taskId.slice(0, 8)}…` : '',
        `Summary: ${result.summary}`,
        '',
        'The handoff context is now stored as a durable observation (searchable via memorix_search).',
        result.toAgentId
          ? 'A notification message has been sent to the recipient.'
          : 'A broadcast notification has been sent to all agents.',
      ];

      return { content: [{ type: 'text' as const, text: lines.filter(Boolean).join('\n') }] };
    },
  );
}

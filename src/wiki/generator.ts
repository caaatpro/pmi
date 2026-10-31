import type { Observation } from '../types.js';
import { isEligibleForKnowledgePromotion } from '../memory/admission.js';
import type { KnowledgeSourceRef, KnowledgeItem, KnowledgeSection, ProjectKnowledgeOverview } from './types.js';

const COMMAND_LOG_TITLE = /^(Ran:|Command:|Executed:)\s/i;

interface SectionDef {
  id: string;
  title: string;
  typeMatch: (o: Observation) => boolean;
}

const SECTION_DEFS: SectionDef[] = [
  {
    id: 'core-decisions',
    title: 'Core Decisions',
    typeMatch: (o) => o.type === 'decision' || o.type === 'trade-off' || o.type === 'reasoning',
  },
  {
    id: 'operational-knowledge',
    title: 'Operational Knowledge',
    typeMatch: (o) =>
      o.type === 'how-it-works' ||
      o.type === 'what-changed' ||
      o.type === 'why-it-exists' ||
      o.type === 'discovery' ||
      o.type === 'session-request',
  },
  {
    id: 'known-gotchas',
    title: 'Known Gotchas',
    typeMatch: (o) => o.type === 'gotcha' || o.type === 'problem-solution',
  },
];

function isExcludedType(o: Observation): boolean {
  return o.type === 'probe';
}

function isCommandLog(o: Observation): boolean {
  return COMMAND_LOG_TITLE.test(o.title || '');
}

function isInactive(o: Observation): boolean {
  const status = o.status ?? 'active';
  return status !== 'active';
}

function isOtherProject(o: Observation, projectId: string): boolean {
  return o.projectId !== projectId;
}

function contextualHasSubstance(o: Observation): boolean {
  if (o.valueCategory !== 'contextual') return true;
  const hasFacts = (o.facts?.length ?? 0) > 0;
  const hasConcepts = (o.concepts?.length ?? 0) > 0;
  const hasFiles = (o.filesModified?.length ?? 0) > 0;
  const hasEntity = !!(o.entityName && o.entityName !== 'quick-note' && o.entityName !== 'unknown');
  return hasFacts || hasConcepts || hasFiles || hasEntity;
}

function isEligible(o: Observation, projectId: string): boolean {
  if (isExcludedType(o)) return false;
  if (isCommandLog(o)) return false;
  if (isInactive(o)) return false;
  if (isOtherProject(o, projectId)) return false;
  if (!isEligibleForKnowledgePromotion(o)) return false;
  if (o.valueCategory === 'ephemeral') return false;
  if (!contextualHasSubstance(o)) return false;
  return true;
}

function obsToItem(o: Observation): KnowledgeItem {
  const ref: KnowledgeSourceRef = {
    kind: o.source === 'git' ? 'git' : 'observation',
    id: `obs:${o.id}`,
    title: o.title,
  };
  return {
    title: o.title,
    summary: o.narrative?.slice(0, 200) || '',
    type: o.type,
    entityName: o.entityName || undefined,
    refs: [ref],
  };
}

function buildGitSection(observations: Observation[]): KnowledgeSection {
  const gitObs = observations.filter(
    (o) => o.source === 'git' && o.sourceDetail === 'git-ingest',
  );
  const items = gitObs.map(obsToItem);
  return {
    id: 'git-backed-facts',
    title: 'Git-backed Facts',
    items,
    empty: items.length === 0,
  };
}

/** Coding conventions (including former mini-skills, converted by PMI migration pmi-5). */
function isConvention(o: Observation): boolean {
  return o.category === 'coding_convention';
}

function buildConventionsSection(conventions: Observation[]): KnowledgeSection {
  const items = conventions.map(obsToItem);
  return {
    id: 'coding-conventions',
    title: 'Coding Conventions',
    items,
    empty: items.length === 0,
  };
}

function buildProjectOverview(
  projectId: string,
  eligibleObs: Observation[],
  conventions: Observation[],
): KnowledgeSection {
  const refs: KnowledgeSourceRef[] = eligibleObs.slice(0, 5).map((o) => ({
    kind: o.source === 'git' ? 'git' as const : 'observation' as const,
    id: `obs:${o.id}`,
    title: o.title,
  }));

  if (refs.length === 0) {
    return {
      id: 'project-overview',
      title: 'Project Overview',
      items: [],
      empty: true,
    };
  }

  const lines: string[] = [];
  lines.push(`Project: ${projectId}`);
  lines.push(`Observations in KB: ${eligibleObs.length}`);
  lines.push(`Coding conventions: ${conventions.length}`);

  const entityCounts = new Map<string, number>();
  for (const o of eligibleObs) {
    if (o.entityName) {
      entityCounts.set(o.entityName, (entityCounts.get(o.entityName) || 0) + 1);
    }
  }
  const topEntities = [...entityCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  if (topEntities.length > 0) {
    lines.push(`Top entities: ${topEntities.map(([name, count]) => `${name} (${count})`).join(', ')}`);
  }

  return {
    id: 'project-overview',
    title: 'Project Overview',
    items: [{
      title: projectId,
      summary: lines.join('\n'),
      type: 'overview',
      refs,
    }],
  };
}

export interface GenerateOptions {
  projectId: string;
  observations: Observation[];
  generatedAt?: string;
}

export function generateKnowledgeBase(options: GenerateOptions): ProjectKnowledgeOverview {
  const { projectId, observations } = options;

  const eligible = observations.filter((o) => isEligible(o, projectId));
  const conventions = eligible.filter(isConvention);

  const typedSections: KnowledgeSection[] = SECTION_DEFS.map((def) => {
    const matched = eligible.filter((o) => !isConvention(o) && def.typeMatch(o));
    const items = matched.map(obsToItem);
    return {
      id: def.id,
      title: def.title,
      items,
      empty: items.length === 0,
    };
  });

  const projectOverview = buildProjectOverview(projectId, eligible, conventions);
  const gitSection = buildGitSection(eligible);
  const conventionsSection = buildConventionsSection(conventions);

  const sections: KnowledgeSection[] = [
    projectOverview,
    ...typedSections,
    gitSection,
    conventionsSection,
  ];

  const allRefs = sections.flatMap((s) => s.items.flatMap((i) => i.refs));
  const obsRefCount = allRefs.filter((r) => r.kind === 'observation' || r.kind === 'git').length;

  return {
    title: 'Memory Overview',
    subtitle: 'Generated from durable project memory',
    kind: 'memory-overview',
    maintained: false,
    projectId,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    sections,
    stats: {
      observationsUsed: eligible.length,
      conventionsUsed: conventions.length,
      refs: obsRefCount,
    },
  };
}

export { isEligible, isExcludedType, isCommandLog, contextualHasSubstance };

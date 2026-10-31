import { useState } from 'react';
import { Button, Code, Group, Paper, SegmentedControl, Select, SimpleGrid, Stack, Tabs, Text, TextInput, Title } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';

import { api, type AuditEntry, type Conflict, type ConflictSide, type Memory, type Project as ProjectRow, type Session, type Stats } from '../api';
import { useApp } from '../context';
import { useI18n } from '../i18n';
import { href, navigate } from '../router';
import {
  absolute, CATEGORIES, CONFIDENCE, CountBars, DataTable, Device, Empty, ErrorAlert, FINAL, LIVE, Link, Loaded, MEMORY_STATUSES, Mono,
  Section, short, StatCard, StatusBadge, useLoad, WAITING, When,
} from '../ui';

const PAGE = 100;

export function Project({ id, tab, query }: { id: string; tab: string; query: URLSearchParams }) {
  const { projectOf, orgName, can } = useApp();
  const { t } = useI18n();
  const known = projectOf(id);
  const state = useLoad(async () => known ?? (await api<{ project: ProjectRow }>(`/v1/projects/${encodeURIComponent(id)}`)).project, [id, known]);

  return (
    <Loaded state={state}>
      {(project) => (
        <Stack>
          <div>
            <Title order={2}>{project.name}</Title>
            <Group gap="xs" mt={4}>
              <Text size="sm" c="dimmed" ff="monospace">{orgName(project.orgId)} / {project.slug}</Text>
              <StatusBadge value={project.role} />
            </Group>
          </div>
          <Tabs value={tab} onChange={(value) => value && navigate(href.project(project.id, value))} keepMounted={false}>
            <Tabs.List>
              <Tabs.Tab value="overview">{t('overview')}</Tabs.Tab>
              <Tabs.Tab value="knowledge">{t('knowledge')}</Tabs.Tab>
              <Tabs.Tab value="sessions">{t('sessions')}</Tabs.Tab>
              <Tabs.Tab value="conflicts">{t('conflicts')}</Tabs.Tab>
              {can(project, 'maintainer') && <Tabs.Tab value="audit">{t('audit')}</Tabs.Tab>}
            </Tabs.List>
          </Tabs>
          {tab === 'knowledge' ? <Knowledge project={project} query={query} />
            : tab === 'sessions' ? <Sessions project={project} query={query} />
              : tab === 'conflicts' ? <Conflicts project={project} />
                : tab === 'audit' ? <Audit project={project} />
                  : <Overview project={project} />}
        </Stack>
      )}
    </Loaded>
  );
}

function Overview({ project }: { project: ProjectRow }) {
  const { t } = useI18n();
  const state = useLoad(() => Promise.all([
    api<{ stats: Stats }>(`/v1/projects/${project.id}/stats`).then((data) => data.stats),
    api<{ overview: string }>(`/v1/projects/${project.id}/overview`).then((data) => data.overview).catch(() => ''),
  ]), [project.id]);
  return (
    <Loaded state={state}>
      {([stats, overview]) => {
        const m = stats.memories;
        const s = stats.sessions.byStatus;
        const count = (keys: string[]) => keys.reduce((n, key) => n + (s[key] ?? 0), 0);
        return (
          <Stack gap="lg">
            <SimpleGrid cols={{ base: 2, sm: 4 }}>
              <StatCard label={t('knowledge')} value={m.total} />
              <StatCard label={t('needsReview')} value={m.needsReview} color="yellow.7" />
              <StatCard label={t('unconfirmed')} value={m.unconfirmed} />
              <StatCard label={t('confirmed')} value={m.byConfidence.confirmed ?? 0} color="green.7" />
              <StatCard label={t('deprecated')} value={m.byConfidence.deprecated ?? 0} />
              <StatCard label={t('activeSessions')} value={count(LIVE)} color="blue.7" />
              <StatCard label={t('waitingSessions')} value={count(WAITING)} color="orange.7" />
              <StatCard label={t('openConflicts')} value={stats.openConflicts} color="red.7" />
            </SimpleGrid>
            <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
              <Section title={t('byCategory')}><Paper withBorder radius="md" p="md"><CountBars counts={m.byCategory} /></Paper></Section>
              <Stack gap="lg">
                <Section title={t('byConfidence')}><Paper withBorder radius="md" p="md"><CountBars counts={m.byConfidence} order={CONFIDENCE} /></Paper></Section>
                <Section title={t('byStatus')}><Paper withBorder radius="md" p="md"><CountBars counts={m.byStatus} order={MEMORY_STATUSES} /></Paper></Section>
              </Stack>
              <Section title={t('sessionsByStatus')}><Paper withBorder radius="md" p="md"><CountBars counts={s} order={[...LIVE, ...WAITING, ...FINAL]} /></Paper></Section>
              <Section title={t('git')}>
                <DataTable
                  rows={stats.git}
                  empty={t('notAnalyzed')}
                  minWidth={420}
                  columns={[
                    { title: t('branch'), cell: (row) => <Mono>{row.branch}</Mono> },
                    { title: t('commit'), cell: (row) => <Mono>{short(row.lastAnalyzedCommit)}</Mono> },
                    { title: t('updated'), cell: (row) => <When iso={row.updatedAt} /> },
                    { title: t('fullReconcile'), cell: (row) => <When iso={row.lastFullReconcileAt} /> },
                  ]}
                />
              </Section>
            </SimpleGrid>
            <Section title={t('projectOverview')}>
              {overview ? <Code block>{overview}</Code> : <Empty text={t('noOverview')} />}
            </Section>
          </Stack>
        );
      }}
    </Loaded>
  );
}

const MEMORY_FILTERS = ['category', 'confidence', 'status', 'component', 'file'] as const;

function Knowledge({ project, query }: { project: ProjectRow; query: URLSearchParams }) {
  const { t, label } = useI18n();
  const [form, setForm] = useState(() => ({
    q: query.get('q') ?? '',
    ...Object.fromEntries(MEMORY_FILTERS.map((key) => [key, query.get(key) ?? ''])) as Record<typeof MEMORY_FILTERS[number], string>,
  }));
  const [rows, setRows] = useState<Memory[]>([]);
  const [more, setMore] = useState(false);
  const key = query.toString();

  const state = useLoad(async () => {
    const q = query.get('q');
    if (q) {
      const { results } = await api<{ results: Memory[] }>(`/v1/projects/${project.id}/search`, { body: { query: q, limit: 100, include_deprecated: true } });
      const kept = results.filter((row) => (['category', 'confidence', 'status'] as const).every((field) => !query.get(field) || row[field] === query.get(field)));
      setRows(kept);
      setMore(false);
      return kept;
    }
    const params = new URLSearchParams({ limit: String(PAGE) });
    for (const field of MEMORY_FILTERS) if (query.get(field)) params.set(field, query.get(field)!);
    const { memories } = await api<{ memories: Memory[] }>(`/v1/projects/${project.id}/memories?${params}`);
    setRows(memories);
    setMore(memories.length === PAGE);
    return memories;
  }, [project.id, key]);

  const [moreError, setMoreError] = useState<unknown>(null);
  async function loadMore() {
    const params = new URLSearchParams({ limit: String(PAGE), offset: String(rows.length) });
    for (const field of MEMORY_FILTERS) if (query.get(field)) params.set(field, query.get(field)!);
    try {
      const { memories } = await api<{ memories: Memory[] }>(`/v1/projects/${project.id}/memories?${params}`);
      setRows((current) => [...current, ...memories]);
      setMore(memories.length === PAGE);
    } catch (error) {
      setMoreError(error);
    }
  }

  function apply(event: React.FormEvent) {
    event.preventDefault();
    const params = new URLSearchParams();
    for (const [field, value] of Object.entries(form)) if (value.trim()) params.set(field, value.trim());
    navigate(href.project(project.id, 'knowledge', params));
  }
  const options = (values: string[]) => values.map((value) => ({ value, label: label(value) }));
  const set = (field: keyof typeof form) => (value: string | null) => setForm((current) => ({ ...current, [field]: value ?? '' }));

  return (
    <Stack>
      <form onSubmit={apply}>
        <Group align="flex-end" gap="sm">
          <TextInput leftSection={<IconSearch size={16} />} placeholder={t('searchHere')} value={form.q} onChange={(e) => set('q')(e.currentTarget.value)} w={{ base: '100%', sm: 260 }} />
          <Select placeholder={t('allCategories')} data={options(CATEGORIES)} value={form.category || null} onChange={set('category')} clearable w={200} />
          <Select placeholder={t('allConfidence')} data={options(CONFIDENCE)} value={form.confidence || null} onChange={set('confidence')} clearable w={170} />
          <Select placeholder={t('allStatuses')} data={options(MEMORY_STATUSES)} value={form.status || null} onChange={set('status')} clearable w={160} />
          <TextInput placeholder={t('component')} value={form.component} onChange={(e) => set('component')(e.currentTarget.value)} w={150} />
          <TextInput placeholder={t('file')} value={form.file} onChange={(e) => set('file')(e.currentTarget.value)} w={180} ff="monospace" />
          <Button type="submit">{t('apply')}</Button>
          <Button variant="subtle" component="a" href={href.project(project.id, 'knowledge')}>{t('reset')}</Button>
        </Group>
      </form>
      <Loaded state={state}>
        {() => (
          <DataTable
            rows={rows}
            empty={t('noMemories')}
            link={(row) => href.memory(row.id)}
            columns={[
              { title: t('title'), cell: (row) => <div><Text size="sm" fw={600}>{row.title}</Text>{row.component && <Text size="xs" c="dimmed">{row.component}</Text>}</div> },
              { title: t('category'), cell: (row) => <Text size="sm">{label(row.category)}</Text> },
              { title: t('confidence'), cell: (row) => <StatusBadge value={row.confidence} /> },
              { title: t('status'), cell: (row) => <StatusBadge value={row.status} /> },
              { title: t('author'), cell: (row) => <Text size="sm">{row.authorEmail ?? row.authorAgent ?? '—'}</Text> },
              { title: t('updated'), cell: (row) => <When iso={row.updatedAt} /> },
            ]}
          />
        )}
      </Loaded>
      {moreError !== null && <ErrorAlert error={moreError} />}
      {more && <Group><Button variant="default" onClick={loadMore}>{t('showMore')}</Button></Group>}
    </Stack>
  );
}

const SESSION_FILTERS: Record<string, string[] | undefined> = { all: undefined, live: LIVE, waiting: WAITING, finished: FINAL };

function Sessions({ project, query }: { project: ProjectRow; query: URLSearchParams }) {
  const { t } = useI18n();
  const { can } = useApp();
  const filter = query.get('filter') ?? 'all';
  const statuses = SESSION_FILTERS[filter];
  const state = useLoad(() => api<{ sessions: Session[] }>(`/v1/projects/${project.id}/sessions?limit=200${statuses ? `&status=${statuses.join(',')}` : ''}`).then((data) => data.sessions), [project.id, filter]);
  const viewer = !can(project, 'developer');
  const { lang } = useI18n();
  return (
    <Stack>
      <SegmentedControl
        w="fit-content"
        value={filter}
        onChange={(value) => navigate(href.project(project.id, 'sessions', new URLSearchParams({ filter: value })))}
        data={[{ value: 'all', label: t('all') }, { value: 'live', label: t('live') }, { value: 'waiting', label: t('waiting') }, { value: 'finished', label: t('finished') }]}
      />
      {viewer && <Text size="sm" c="dimmed">{t('viewerSessions')}</Text>}
      <Loaded state={state}>
        {(sessions) => (
          <DataTable
            rows={sessions}
            empty={t('noSessions')}
            minWidth={900}
            link={viewer ? undefined : (row) => href.session(row.id)}
            columns={[
              { title: t('task'), cell: (row) => <div><Text size="sm" fw={600}>{row.task || row.id}</Text>{row.objective && <Text size="xs" c="dimmed">{row.objective}</Text>}</div> },
              { title: t('status'), cell: (row) => <StatusBadge value={row.status} /> },
              { title: t('user'), cell: (row) => <Text size="sm">{row.userEmail}</Text> },
              { title: t('agent'), cell: (row) => <div><Text size="sm">{row.agent ?? '—'}</Text>{row.model && <Text size="xs" c="dimmed">{row.model}</Text>}</div> },
              { title: t('device'), cell: (row) => <Device id={row.deviceId} /> },
              { title: t('checkpoint'), numeric: true, cell: (row) => row.lastCheckpointSeq },
              { title: t('lease'), cell: (row) => <Text size="sm">{row.leaseLive ? t('leaseLive', absolute(row.leaseExpiresAt, lang)) : '—'}</Text> },
              { title: t('updated'), cell: (row) => <When iso={row.updatedAt} /> },
            ]}
          />
        )}
      </Loaded>
    </Stack>
  );
}

function Side({ side }: { side: ConflictSide }) {
  return (
    <div>
      <Text size="sm">{side?.row?.title ?? side?.kind ?? '—'}</Text>
      <Text size="xs" c="dimmed" ff="monospace">{[side?.kind, side?.version?.writer].filter(Boolean).join(' · ')}</Text>
    </div>
  );
}

function Conflicts({ project }: { project: ProjectRow }) {
  const { t, label } = useI18n();
  const state = useLoad(() => api<{ conflicts: Conflict[] }>(`/v1/projects/${project.id}/conflicts`).then((data) => data.conflicts), [project.id]);
  return (
    <Loaded state={state}>
      {(conflicts) => (
        <DataTable
          rows={conflicts}
          empty={t('noConflicts')}
          columns={[
            { title: t('created'), cell: (row) => <When iso={row.createdAt} /> },
            { title: t('memory'), cell: (row) => <Link to={href.memory(row.memoryId)}>{row.memoryId}</Link> },
            { title: t('kind'), cell: (row) => <Text size="sm">{label(row.kind)}</Text> },
            { title: t('detectedBy'), cell: (row) => <Text size="sm">{row.detectedBy}</Text> },
            { title: t('winner'), cell: (row) => <Side side={row.winner} /> },
            { title: t('loser'), cell: (row) => <Side side={row.loser} /> },
          ]}
        />
      )}
    </Loaded>
  );
}

function Audit({ project }: { project: ProjectRow }) {
  const { t, lang } = useI18n();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [more, setMore] = useState(false);
  const [moreError, setMoreError] = useState<unknown>(null);
  const fetchPage = (before?: number) => api<{ entries: AuditEntry[] }>(`/v1/projects/${project.id}/audit?limit=${PAGE}${before ? `&before=${before}` : ''}`).then((data) => data.entries);
  const state = useLoad(async () => {
    const page = await fetchPage();
    setEntries(page);
    setMore(page.length === PAGE);
    return page;
  }, [project.id]);
  async function loadMore() {
    try {
      const page = await fetchPage(entries.at(-1)?.id);
      setEntries((current) => [...current, ...page]);
      setMore(page.length === PAGE);
    } catch (error) {
      setMoreError(error);
    }
  }
  return (
    <Stack>
      <Loaded state={state}>
        {() => (
          <DataTable
            rows={entries}
            empty={t('noAudit')}
            minWidth={900}
            columns={[
              { title: t('at'), cell: (row) => <Text size="sm" style={{ whiteSpace: 'nowrap' }}>{absolute(row.at, lang)}</Text> },
              { title: t('actor'), cell: (row) => <div><Text size="sm">{row.actorEmail ?? '—'}</Text>{row.actorDeviceId && <Device id={row.actorDeviceId} />}</div> },
              { title: t('action'), cell: (row) => <Mono>{row.action}</Mono> },
              { title: t('target'), cell: (row) => <Mono>{[row.targetType, row.targetId].filter(Boolean).join(': ') || '—'}</Mono> },
              { title: t('detail'), cell: (row) => (Object.keys(row.detail ?? {}).length ? <Mono>{JSON.stringify(row.detail)}</Mono> : null) },
            ]}
          />
        )}
      </Loaded>
      {moreError !== null && <ErrorAlert error={moreError} />}
      {more && <Group><Button variant="default" onClick={loadMore}>{t('showMore')}</Button></Group>}
    </Stack>
  );
}

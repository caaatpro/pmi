import { Badge, Stack, Text, Title } from '@mantine/core';

import { api, type Project, type Stats } from '../api';
import { useApp } from '../context';
import { useI18n } from '../i18n';
import { href } from '../router';
import { DataTable, Empty, Link, Loaded, LIVE, StatusBadge, useLoad, WAITING, When } from '../ui';

/** Run up to `limit` requests at a time; a failed one yields undefined. */
async function pool<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<Array<R | undefined>> {
  const results: Array<R | undefined> = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]).catch(() => undefined);
    }
  }));
  return results;
}

const sum = (counts: Record<string, number> | undefined, keys: string[]) => keys.reduce((n, key) => n + (counts?.[key] ?? 0), 0);

function Count({ value, color }: { value: number; color: string }) {
  return value > 0 ? <Badge color={color} variant="light" radius="sm">{value}</Badge> : <Text span c="dimmed" size="sm">0</Text>;
}

export function Projects() {
  const { orgName, refreshMe } = useApp();
  const { t } = useI18n();
  const state = useLoad(async () => {
    const me = await refreshMe();
    const projects = [...me.projects].sort((a, b) => a.name.localeCompare(b.name));
    const stats = await pool(projects, 6, (project) => api<{ stats: Stats }>(`/v1/projects/${project.id}/stats`).then((data) => data.stats));
    return projects.map((project, index) => ({ project, stats: stats[index] }));
  }, []);

  return (
    <Stack>
      <Title order={2}>{t('projects')}</Title>
      <Loaded state={state}>
        {(rows) => rows.length === 0 ? <Empty text={t('noProjects')} /> : (
          <DataTable<{ project: Project; stats?: Stats }>
            rows={rows}
            empty={t('noProjects')}
            minWidth={980}
            link={(row) => href.project(row.project.id)}
            columns={[
              { title: t('project'), cell: (row) => (
                <div>
                  <Link to={href.project(row.project.id)}><Text span fw={600}>{row.project.name}</Text></Link>
                  <Text size="xs" c="dimmed" ff="monospace">{orgName(row.project.orgId)} / {row.project.slug}</Text>
                </div>
              ) },
              { title: t('role'), cell: (row) => <StatusBadge value={row.project.role} /> },
              { title: t('knowledge'), numeric: true, cell: (row) => row.stats?.memories.total ?? '—' },
              { title: t('needsReview'), numeric: true, cell: (row) => <Count value={row.stats?.memories.needsReview ?? 0} color="yellow" /> },
              { title: t('unconfirmed'), numeric: true, cell: (row) => row.stats?.memories.unconfirmed ?? '—' },
              { title: t('activeSessions'), numeric: true, cell: (row) => sum(row.stats?.sessions.byStatus, LIVE) },
              { title: t('waitingSessions'), numeric: true, cell: (row) => <Count value={sum(row.stats?.sessions.byStatus, WAITING)} color="orange" /> },
              { title: t('conflicts'), numeric: true, cell: (row) => <Count value={row.stats?.openConflicts ?? 0} color="red" /> },
              { title: t('updated'), cell: (row) => <When iso={row.stats?.memories.lastUpdatedAt} /> },
              { title: t('gitAnalyzed'), cell: (row) => <When iso={row.stats?.git[0]?.updatedAt} /> },
            ]}
          />
        )}
      </Loaded>
    </Stack>
  );
}

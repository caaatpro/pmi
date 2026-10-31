import { Stack, Text, Title } from '@mantine/core';

import { api, type Memory } from '../api';
import { useApp } from '../context';
import { useI18n } from '../i18n';
import { href } from '../router';
import { DataTable, Loaded, StatusBadge, useLoad, When } from '../ui';

export function Search({ q }: { q: string }) {
  const { t, label } = useI18n();
  const { projectOf } = useApp();
  const state = useLoad(() => api<{ results: Array<Memory & { projectId: string }> }>('/v1/search', { body: { query: q, limit: 50 } }).then((data) => data.results), [q]);
  return (
    <Stack>
      <Title order={2}>{t('results', q)}</Title>
      <Loaded state={state}>
        {(results) => (
          <DataTable
            rows={results}
            empty={t('noResults')}
            link={(row) => href.memory(row.id)}
            columns={[
              { title: t('title'), cell: (row) => <Text size="sm" fw={600}>{row.title}</Text> },
              { title: t('project'), cell: (row) => <Text size="sm">{projectOf(row.projectId)?.name ?? row.projectId}</Text> },
              { title: t('category'), cell: (row) => <Text size="sm">{label(row.category)}</Text> },
              { title: t('confidence'), cell: (row) => <StatusBadge value={row.confidence} /> },
              { title: t('status'), cell: (row) => <StatusBadge value={row.status} /> },
              { title: t('updated'), cell: (row) => <When iso={row.updatedAt} /> },
            ]}
          />
        )}
      </Loaded>
    </Stack>
  );
}

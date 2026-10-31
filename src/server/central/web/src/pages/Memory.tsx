import { useState } from 'react';
import { Alert, Badge, Button, Group, List, Paper, SimpleGrid, Stack, Table, Text, Textarea, Title } from '@mantine/core';
import { IconArchive, IconCheck } from '@tabler/icons-react';

import { api, type Memory as MemoryRow, type MemoryVersion } from '../api';
import { useApp } from '../context';
import { useI18n } from '../i18n';
import { href } from '../router';
import { absolute, DataTable, Device, Empty, explain, Link, Loaded, Mono, Section, StatusBadge, useLoad } from '../ui';

export function Memory({ id }: { id: string }) {
  const { t, label, lang } = useI18n();
  const { projectOf, can } = useApp();
  const state = useLoad(() => api<{ memory: MemoryRow & { projectId: string }; versions: MemoryVersion[] }>(`/v1/memories/${encodeURIComponent(id)}?include=versions`), [id]);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function act(to: 'confirm' | 'deprecate') {
    const text = reason.trim();
    if (to === 'deprecate' && !text) {
      setMessage({ ok: false, text: t('reasonRequired') });
      return;
    }
    setBusy(true);
    try {
      await api(`/v1/memories/${encodeURIComponent(id)}/${to}`, { body: text ? { reason: text } : {} });
      setReason('');
      setMessage({ ok: true, text: t(to === 'confirm' ? 'confirmedDone' : 'deprecatedDone') });
      state.reload();
    } catch (error) {
      setMessage({ ok: false, text: explain(error, t) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Loaded state={state}>
      {({ memory, versions }) => {
        const project = projectOf(memory.projectId);
        const meta: Array<[string, React.ReactNode]> = [
          [t('project'), project ? <Link to={href.project(project.id, 'knowledge')}>{project.name}</Link> : <Mono>{memory.projectId}</Mono>],
          [t('component'), memory.component ?? '—'],
          [t('author'), memory.authorEmail ?? '—'],
          [t('agent'), memory.authorAgent ?? '—'],
          [t('source'), memory.source],
          [t('topicKey'), <Mono>{memory.topicKey ?? '—'}</Mono>],
          [t('version'), memory.version],
          [t('created'), absolute(memory.createdAt, lang)],
          [t('updated'), absolute(memory.updatedAt, lang)],
        ];
        return (
          <Stack gap="lg">
            <div>
              <Title order={2}>{memory.title}</Title>
              <Group gap="xs" mt="xs">
                <Badge variant="outline" color="gray" radius="sm" tt="none">{label(memory.category)}</Badge>
                <StatusBadge value={memory.confidence} />
                <StatusBadge value={memory.status} />
              </Group>
            </div>
            {message && <Alert color={message.ok ? 'green' : 'red'} variant="light" withCloseButton onClose={() => setMessage(null)}>{message.text}</Alert>}
            <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
              <Stack gap="lg">
                <Section title={t('content')}>
                  <Paper withBorder radius="md" p="md"><Text size="sm" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{memory.content || '—'}</Text></Paper>
                </Section>
                <Section title={t('facts')}>
                  {memory.facts.length ? <List size="sm" spacing={4}>{memory.facts.map((fact, i) => <List.Item key={i}>{fact}</List.Item>)}</List> : <Empty text="—" />}
                </Section>
                <Section title={t('relatedFiles')}>
                  {memory.relatedFiles.length ? <List size="sm" spacing={4}>{memory.relatedFiles.map((file) => <List.Item key={file}><Mono>{file}</Mono></List.Item>)}</List> : <Empty text="—" />}
                </Section>
              </Stack>
              <Stack gap="lg">
                <Section title={t('details')}>
                  <Paper withBorder radius="md">
                    <Table verticalSpacing={6} horizontalSpacing="md">
                      <Table.Tbody>
                        {meta.map(([key, value]) => (
                          <Table.Tr key={key}><Table.Td w={130}><Text size="sm" c="dimmed">{key}</Text></Table.Td><Table.Td><Text size="sm" component="div">{value}</Text></Table.Td></Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  </Paper>
                </Section>
                {can(project, 'developer') ? (
                  <Section title={t('review')}>
                    <Paper withBorder radius="md" p="md">
                      <Stack gap="sm">
                        <Text size="sm" c="dimmed">{t('reviewHelp')}</Text>
                        <Textarea placeholder={t('reasonPlaceholder')} value={reason} onChange={(e) => setReason(e.currentTarget.value)} autosize minRows={2} maxLength={2000} />
                        <Group gap="sm">
                          {memory.confidence !== 'confirmed' && <Button leftSection={<IconCheck size={16} />} onClick={() => act('confirm')} loading={busy}>{t('confirm')}</Button>}
                          {memory.confidence !== 'deprecated' && <Button variant="light" color="red" leftSection={<IconArchive size={16} />} onClick={() => act('deprecate')} loading={busy}>{t('deprecate')}</Button>}
                        </Group>
                      </Stack>
                    </Paper>
                  </Section>
                ) : <Alert color="gray" variant="light">{t('viewerReadOnly')}</Alert>}
              </Stack>
            </SimpleGrid>
            <Section title={t('versions')}>
              <DataTable
                rows={versions ?? []}
                empty="—"
                minWidth={600}
                columns={[
                  { title: t('version'), numeric: true, cell: (row) => row.version },
                  { title: t('changedAt'), cell: (row) => <Text size="sm" style={{ whiteSpace: 'nowrap' }}>{absolute(row.changedAt, lang)}</Text> },
                  { title: t('changedBy'), cell: (row) => <div><Text size="sm">{row.changedByEmail ?? '—'}</Text>{row.changedByDevice && <Device id={row.changedByDevice} />}</div> },
                  { title: t('reason'), cell: (row) => <Group gap="xs"><Text size="sm">{row.reason}</Text>{row.deleted && <Badge color="red" variant="light" radius="sm">{t('deleted')}</Badge>}</Group> },
                ]}
              />
            </Section>
          </Stack>
        );
      }}
    </Loaded>
  );
}

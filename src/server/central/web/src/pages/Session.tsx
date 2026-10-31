import { Alert, Badge, Code, Group, List, Paper, SimpleGrid, Stack, Table, Text, Title } from '@mantine/core';
import { IconArrowRight } from '@tabler/icons-react';

import { api, type Checkpoint, type Session as SessionRow, type Snapshot, type Step } from '../api';
import { useI18n } from '../i18n';
import { href } from '../router';
import { absolute, DataTable, Device, Empty, formatBytes, Link, Loaded, Mono, Section, short, StatusBadge, useLoad } from '../ui';

function Steps({ items }: { items?: Step[] }) {
  if (!items?.length) return <Empty text="—" />;
  return <List size="sm" spacing={4}>{items.map((step) => <List.Item key={step.id}>{step.text}</List.Item>)}</List>;
}

export function Session({ id }: { id: string }) {
  const { t, lang } = useI18n();
  const state = useLoad(async () => {
    const { session, checkpoints } = await api<{ session: SessionRow; checkpoints: Checkpoint[] }>(`/v1/sessions/${encodeURIComponent(id)}`);
    const snapshots = await api<{ snapshots: Snapshot[] }>(`/v1/projects/${session.projectId}/snapshots?session_id=${encodeURIComponent(session.id)}`)
      .then((data) => data.snapshots).catch(() => []);
    return { session, checkpoints, snapshots };
  }, [id]);

  return (
    <Loaded state={state}>
      {({ session, checkpoints, snapshots }) => {
        const s = session.state ?? {};
        const meta: Array<[string, React.ReactNode] | null> = [
          [t('status'), <StatusBadge value={session.status} />],
          [t('user'), session.userEmail],
          [t('device'), <Device id={session.deviceId} />],
          [t('agent'), session.agent ?? '—'],
          [t('model'), [session.modelProvider, session.model].filter(Boolean).join(' / ') || '—'],
          [t('branch'), <Mono>{session.gitBranch ?? '—'} @ {short(session.gitHead)}</Mono>],
          [t('lease'), session.leaseLive ? t('leaseLive', absolute(session.leaseExpiresAt, lang)) : '—'],
          session.handoffReservedUntil ? [t('reservedUntil'), absolute(session.handoffReservedUntil, lang)] : null,
          session.parentSessionId ? [t('parent'), <Link to={href.session(session.parentSessionId)}>{session.parentSessionId}</Link>] : null,
          session.continuedBy ? [t('continuedBy'), <Link to={href.session(session.continuedBy)}>{session.continuedBy}</Link>] : null,
          [t('created'), absolute(session.createdAt, lang)],
          [t('updated'), absolute(session.updatedAt, lang)],
        ];
        return (
          <Stack gap="lg">
            <div>
              <Title order={2}>{session.task || session.id}</Title>
              <Text size="xs" c="dimmed" ff="monospace">{session.id}</Text>
              {session.objective && <Text size="sm" mt="xs"><Text span fw={600}>{t('objective')}:</Text> {session.objective}</Text>}
            </div>
            {s.nextAction && (
              <Alert color="blue" variant="light" icon={<IconArrowRight size={18} />} title={t('nextAction')}>
                <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{s.nextAction}</Text>
              </Alert>
            )}
            <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
              <Stack gap="lg">
                {s.progress?.summary && (
                  <Section title={t('progress')}>
                    <Text size="sm">{s.progress.percent != null ? `${s.progress.percent}% · ` : ''}{s.progress.summary}</Text>
                  </Section>
                )}
                <Section title={t('completedSteps')}><Steps items={s.completedSteps} /></Section>
                <Section title={t('pendingSteps')}><Steps items={s.pendingSteps} /></Section>
                <Section title={t('decisions')}>
                  {s.decisions?.length ? <List size="sm" spacing={4}>{s.decisions.map((ref) => <List.Item key={ref.id}>{ref.title}</List.Item>)}</List> : <Empty text="—" />}
                </Section>
                {Boolean(s.problems?.length) && (
                  <Section title={t('problems')}>
                    <List size="sm" spacing={4}>{s.problems!.map((problem, i) => <List.Item key={i}><Group gap="xs">{problem.text}<StatusBadge value={problem.status} /></Group></List.Item>)}</List>
                  </Section>
                )}
              </Stack>
              <Stack gap="lg">
                <Section title={t('session')}>
                  <Paper withBorder radius="md">
                    <Table verticalSpacing={6} horizontalSpacing="md">
                      <Table.Tbody>
                        {meta.filter((row): row is [string, React.ReactNode] => row !== null).map(([key, value]) => (
                          <Table.Tr key={key}><Table.Td w={130}><Text size="sm" c="dimmed">{key}</Text></Table.Td><Table.Td><Text size="sm" component="div">{value}</Text></Table.Td></Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  </Paper>
                </Section>
                {s.git && (
                  <Section title={t('modifiedFiles')}>
                    {s.git.modifiedFiles.length ? <List size="sm" spacing={4}>{s.git.modifiedFiles.map((file) => <List.Item key={file.path}><Mono>{file.status} {file.path}</Mono></List.Item>)}</List> : <Empty text="—" />}
                  </Section>
                )}
                {Boolean(s.git?.unpushedCommits.length) && (
                  <Section title={t('unpushed')}>
                    <Group gap="xs">{s.git!.unpushedCommits.map((sha) => <Badge key={sha} variant="outline" color="gray" radius="sm" ff="monospace" tt="none">{short(sha)}</Badge>)}</Group>
                  </Section>
                )}
              </Stack>
            </SimpleGrid>
            {session.summary && <Section title={t('summary')}><Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{session.summary}</Text></Section>}
            {session.handoffBrief && <Section title={t('handoffBrief')}><Code block>{session.handoffBrief}</Code></Section>}
            <Section title={t('checkpoints')}>
              <DataTable
                rows={[...checkpoints].reverse()}
                empty="—"
                minWidth={420}
                columns={[
                  { title: '#', numeric: true, cell: (row) => row.seq },
                  { title: t('trigger'), cell: (row) => <Group gap="xs"><Text size="sm">{row.trigger}</Text>{row.orphan && <Badge color="orange" variant="light" radius="sm">{t('orphan')}</Badge>}</Group> },
                  { title: t('created'), cell: (row) => <Text size="sm">{absolute(row.createdAt, lang)}</Text> },
                ]}
              />
            </Section>
            <Section title={t('snapshots')}>
              <DataTable
                rows={snapshots}
                empty="—"
                minWidth={680}
                columns={[
                  { title: 'ID', cell: (row) => <Mono>{row.id}</Mono> },
                  { title: t('created'), cell: (row) => <Text size="sm" style={{ whiteSpace: 'nowrap' }}>{absolute(row.createdAt, lang)}</Text> },
                  { title: t('branch'), cell: (row) => <Mono>{row.branch ?? '—'} @ {short(row.baseCommit)}</Mono> },
                  { title: t('files'), numeric: true, cell: (row) => row.fileCount },
                  { title: t('size'), numeric: true, cell: (row) => formatBytes(row.totalBytes) },
                  { title: '', cell: (row) => (row.pinned ? <Badge variant="light" radius="sm">{t('pinned')}</Badge> : null) },
                ]}
              />
            </Section>
          </Stack>
        );
      }}
    </Loaded>
  );
}

// Shared building blocks of the PMI UI on top of Mantine.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Alert, Anchor, Badge, Center, Group, Loader, Paper, Progress, Stack, Table, Text, Title, Tooltip } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';

import { ApiError } from './api';
import { useI18n, type I18n } from './i18n';
import { navigate } from './router';

export const LIVE = ['created', 'in_progress', 'checkpointed'];
export const WAITING = ['waiting_handoff', 'resumable', 'interrupted'];
export const FINAL = ['completed', 'failed'];
export const CATEGORIES = ['project_overview', 'architecture', 'component', 'dependency', 'architecture_decision', 'business_logic', 'coding_convention', 'issue', 'solution', 'known_limitation', 'development_history', 'current_state', 'active_task', 'completed_task', 'session_history', 'git_history'];
export const CONFIDENCE = ['observed', 'inferred', 'proposed', 'confirmed', 'deprecated'];
export const MEMORY_STATUSES = ['active', 'needs_review', 'resolved', 'archived'];

const COLORS: Record<string, string> = {
  confirmed: 'green', deprecated: 'red', proposed: 'blue',
  needs_review: 'yellow', resolved: 'green',
  created: 'blue', in_progress: 'blue', checkpointed: 'blue',
  waiting_handoff: 'orange', resumable: 'orange', interrupted: 'orange',
  completed: 'green', failed: 'red',
  admin: 'grape', maintainer: 'violet', developer: 'blue',
};

export function StatusBadge({ value }: { value: string }) {
  const { label } = useI18n();
  // max-content: inside a table cell an overflow-hidden badge would otherwise shrink to its first letter.
  return <Badge variant="light" color={COLORS[value] ?? 'gray'} radius="sm" tt="none" miw="max-content">{label(value)}</Badge>;
}

/** Load data for a view; `reload` refetches. Stale responses after a route change are dropped. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]): { data?: T; error?: unknown; loading: boolean; reload: () => void } {
  const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setState((current) => ({ ...current, loading: true }));
    load().then(
      (data) => { if (live) setState({ data, loading: false }); },
      (error: unknown) => { if (live) setState({ error, loading: false }); },
    );
    return () => { live = false; };
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { ...state, reload };
}

export function explain(error: unknown, t: I18n['t']): string {
  if (error instanceof ApiError) {
    if (error.code === 'offline') return t('offline');
    if (error.status === 404) return t('notFound');
    if (error.status === 403) return `${t('forbidden')} (${error.message})`;
    return error.message;
  }
  return String((error as Error)?.message ?? error);
}

export function ErrorAlert({ error }: { error: unknown }) {
  const { t } = useI18n();
  return <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />}>{explain(error, t)}</Alert>;
}

/** Spinner, error or the content once data is there. */
export function Loaded<T>({ state, children }: { state: { data?: T; error?: unknown; loading: boolean }; children: (data: T) => ReactNode }) {
  if (state.error) return <ErrorAlert error={state.error} />;
  if (state.data === undefined) return <Center py="xl"><Loader size="sm" /></Center>;
  return <>{children(state.data)}</>;
}

export function absolute(iso: string | null | undefined, lang: string): string {
  return iso ? new Date(iso).toLocaleString(lang) : '—';
}

export function When({ iso }: { iso: string | null | undefined }) {
  const { lang, t } = useI18n();
  if (!iso) return <Text span c="dimmed" size="sm">{t('never')}</Text>;
  const date = new Date(iso);
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  const [value, unit]: [number, Intl.RelativeTimeFormatUnit] = abs < 60 ? [seconds, 'second'] : abs < 3600 ? [seconds / 60, 'minute'] : abs < 86400 ? [seconds / 3600, 'hour'] : abs < 2592000 ? [seconds / 86400, 'day'] : [seconds / 2592000, 'month'];
  return (
    <Tooltip label={date.toLocaleString(lang)} withArrow>
      <Text span size="sm" style={{ whiteSpace: 'nowrap' }}>{new Intl.RelativeTimeFormat(lang, { numeric: 'auto' }).format(Math.round(value), unit)}</Text>
    </Tooltip>
  );
}

/** Device ids are long random strings: the prefix tells devices apart, the tooltip has the rest. */
export function Device({ id }: { id: string | null | undefined }) {
  if (!id) return <Text span c="dimmed">—</Text>;
  return (
    <Tooltip label={id} withArrow>
      <Text span ff="monospace" size="xs">{id.length > 16 ? `${id.slice(0, 14)}…` : id}</Text>
    </Tooltip>
  );
}

export const short = (sha: string | null | undefined): string => (sha ? sha.slice(0, 10) : '—');

export function Mono({ children }: { children: ReactNode }) {
  return <Text span ff="monospace" size="xs">{children}</Text>;
}

export function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <Stack gap="xs">
      <Group justify="space-between" align="center"><Title order={4}>{title}</Title>{right}</Group>
      {children}
    </Stack>
  );
}

export function Empty({ text }: { text: string }) {
  return <Text c="dimmed" size="sm" py="sm">{text}</Text>;
}

export interface Column<T> {
  title: string;
  cell: (row: T) => ReactNode;
  numeric?: boolean;
}

/** A Mantine table that scrolls inside itself on narrow screens; rows open `link` when given. */
export function DataTable<T>({ columns, rows, link, empty, minWidth = 720 }: { columns: Column<T>[]; rows: T[]; link?: (row: T) => string; empty: string; minWidth?: number }) {
  if (rows.length === 0) return <Empty text={empty} />;
  return (
    <Paper withBorder radius="md">
      <Table.ScrollContainer minWidth={minWidth}>
        <Table highlightOnHover={Boolean(link)} verticalSpacing="sm" horizontalSpacing="md">
          <Table.Thead>
            <Table.Tr>{columns.map((column, i) => <Table.Th key={i} ta={column.numeric ? 'right' : undefined} style={{ whiteSpace: 'nowrap' }}>{column.title}</Table.Th>)}</Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((row, r) => {
              const target = link?.(row);
              return (
                <Table.Tr
                  key={r}
                  style={target ? { cursor: 'pointer' } : undefined}
                  onClick={target ? (event) => { if (!(event.target as HTMLElement).closest('a')) navigate(target); } : undefined}
                >
                  {columns.map((column, c) => <Table.Td key={c} ta={column.numeric ? 'right' : undefined}>{column.cell(row)}</Table.Td>)}
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Paper>
  );
}

/** Horizontal bars of counts; `order` fixes the order, otherwise largest first. */
export function CountBars({ counts, order }: { counts: Record<string, number>; order?: string[] }) {
  const { label, t } = useI18n();
  const entries = (order ?? Object.keys(counts)).map((key) => [key, counts[key] ?? 0] as const).filter(([, n]) => n > 0);
  if (!order) entries.sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return <Empty text={t('none')} />;
  const max = Math.max(...entries.map(([, n]) => n));
  return (
    <Stack gap={8}>
      {entries.map(([key, n]) => (
        <Group key={key} gap="sm" wrap="nowrap">
          <Text size="sm" w={170} truncate>{label(key)}</Text>
          <Progress value={(n / max) * 100} color={COLORS[key] ?? 'blue'} style={{ flex: 1 }} size="md" radius="xl" />
          <Text size="sm" c="dimmed" w={32} ta="right">{n}</Text>
        </Group>
      ))}
    </Stack>
  );
}

export function StatCard({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <Paper withBorder radius="md" p="md">
      <Text fz={26} fw={700} c={value > 0 ? color : undefined} lh={1.2}>{value}</Text>
      <Text size="sm" c="dimmed">{label}</Text>
    </Paper>
  );
}

export function Link({ to, children }: { to: string; children: ReactNode }) {
  return <Anchor href={to} size="sm">{children}</Anchor>;
}

export function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

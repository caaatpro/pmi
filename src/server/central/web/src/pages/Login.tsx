import { useState } from 'react';
import { Alert, Button, Center, Checkbox, Paper, PasswordInput, Stack, Text, Title } from '@mantine/core';

import { api, ApiError, saveToken, type Me } from '../api';
import { useI18n } from '../i18n';
import { explain } from '../ui';

export function Login({ onSignedIn }: { onSignedIn: (me: Me) => void }) {
  const { t } = useI18n();
  const [token, setToken] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const value = token.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      const me = await api<Me>('/v1/me', { token: value });
      saveToken(value, remember);
      onSignedIn(me);
    } catch (failure) {
      setError(failure instanceof ApiError && failure.status === 401 ? t('badToken') : explain(failure, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Center mih="70vh" px="md">
      <Paper withBorder shadow="sm" radius="md" p="xl" w="100%" maw={440}>
        <form onSubmit={submit}>
          <Stack>
            <Title order={2}>PMI</Title>
            <Text size="sm" c="dimmed">{t('loginHelp')}</Text>
            <PasswordInput
              label={t('token')}
              placeholder="pmi_pat_…"
              value={token}
              onChange={(event) => setToken(event.currentTarget.value)}
              autoComplete="off"
              autoFocus
              required
            />
            <Checkbox label={t('remember')} checked={remember} onChange={(event) => setRemember(event.currentTarget.checked)} />
            <Button type="submit" loading={busy}>{t('signIn')}</Button>
            {error && <Alert color="red" variant="light">{error}</Alert>}
          </Stack>
        </form>
      </Paper>
    </Center>
  );
}

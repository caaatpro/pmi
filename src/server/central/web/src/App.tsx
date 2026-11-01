import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActionIcon, Anchor, AppShell, Burger, Center, Container, Group, Loader, Menu, Text, TextInput, Tooltip, UnstyledButton, useComputedColorScheme, useMantineColorScheme } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconLanguage, IconLogout, IconMoon, IconSearch, IconSun, IconUserCircle } from '@tabler/icons-react';

import { api, clearToken, getToken, setUnauthorizedHandler, type Me } from './api';
import { AppContext, appState } from './context';
import { I18nContext, makeI18n, type Lang } from './i18n';
import { href, navigate, useRoute } from './router';
import { ErrorAlert } from './ui';
import { Login } from './pages/Login';
import { Memory } from './pages/Memory';
import { Project } from './pages/Project';
import { Projects } from './pages/Projects';
import { Search } from './pages/Search';
import { Session } from './pages/Session';

const LANG_KEY = 'baton.lang';

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'en' || saved === 'ru') return saved;
  } catch { /* storage unavailable */ }
  return (navigator.language || 'en').toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

export function App() {
  const route = useRoute();
  const [lang, setLang] = useState<Lang>(initialLang);
  const i18n = useMemo(() => makeI18n(lang), [lang]);
  const [me, setMe] = useState<Me | null>(null);
  const [meError, setMeError] = useState<unknown>(null);
  const [query, setQuery] = useState('');
  const [opened, { toggle, close }] = useDisclosure(false);
  const { setColorScheme } = useMantineColorScheme();
  const scheme = useComputedColorScheme('light');

  const signOut = useCallback(() => {
    clearToken();
    setMe(null);
    navigate('#/login');
  }, []);
  useEffect(() => setUnauthorizedHandler(signOut), [signOut]);

  const refreshMe = useCallback(async () => {
    const fresh = await api<Me>('/v1/me');
    setMe(fresh);
    return fresh;
  }, []);

  const routeKey = route.parts.join('/');
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  useEffect(() => {
    window.scrollTo(0, 0);
    close();
    if (route.parts[0] !== 'search') setQuery('');
    else setQuery(route.query.get('q') ?? '');
  }, [routeKey]);

  const signedIn = Boolean(getToken());
  useEffect(() => {
    if (!signedIn && route.parts[0] !== 'login') navigate('#/login');
    if (signedIn && !me) refreshMe().catch(setMeError);
  }, [signedIn, me, route.parts, refreshMe]);

  const switchLang = () => {
    const next: Lang = lang === 'ru' ? 'en' : 'ru';
    setLang(next);
    try { localStorage.setItem(LANG_KEY, next); } catch { /* storage unavailable */ }
  };

  if (route.parts[0] === 'login' || !signedIn) {
    return (
      <I18nContext.Provider value={i18n}>
        <Group justify="flex-end" p="md">
          <Tooltip label={i18n.t('language')}><ActionIcon variant="subtle" onClick={switchLang} aria-label={i18n.t('language')}><IconLanguage size={18} /></ActionIcon></Tooltip>
        </Group>
        <Login onSignedIn={(fresh) => { setMe(fresh); navigate(href.projects()); }} />
      </I18nContext.Provider>
    );
  }
  if (!me) {
    return (
      <I18nContext.Provider value={i18n}>
        <Container py="xl">{meError ? <ErrorAlert error={meError} /> : <Center><Loader size="sm" /></Center>}</Container>
      </I18nContext.Provider>
    );
  }

  const [section, id, tab] = route.parts;
  const page = section === 'p' && id ? <Project id={id} tab={tab ?? 'overview'} query={route.query} />
    : section === 'm' && id ? <Memory id={id} />
      : section === 's' && id ? <Session id={id} />
        : section === 'search' ? <Search q={route.query.get('q') ?? ''} />
          : <Projects />;

  const searchBox = (
    <form onSubmit={(event) => { event.preventDefault(); if (query.trim()) navigate(href.search(query.trim())); }}>
      <TextInput
        leftSection={<IconSearch size={16} />}
        placeholder={i18n.t('search')}
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        aria-label={i18n.t('search')}
        w={{ base: '100%', sm: 280 }}
      />
    </form>
  );

  return (
    <I18nContext.Provider value={i18n}>
      <AppContext.Provider value={appState(me, refreshMe)}>
        <AppShell header={{ height: 60 }} navbar={{ width: 280, breakpoint: 'sm', collapsed: { desktop: true, mobile: !opened } }} padding="md">
          <AppShell.Header>
            <Group h="100%" px="md" justify="space-between" wrap="nowrap">
              <Group gap="md" wrap="nowrap">
                <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" aria-label="Menu" />
                <Anchor href={href.projects()} underline="never" c="inherit"><Text fw={800} size="lg">Baton Hub</Text></Anchor>
                <Anchor href={href.projects()} size="sm" c="dimmed" visibleFrom="sm">{i18n.t('projects')}</Anchor>
              </Group>
              <Group gap="xs" wrap="nowrap">
                <div className="baton-header-search">{searchBox}</div>
                <Tooltip label={i18n.t('theme')}>
                  <ActionIcon variant="subtle" onClick={() => setColorScheme(scheme === 'dark' ? 'light' : 'dark')} aria-label={i18n.t('theme')}>
                    {scheme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
                  </ActionIcon>
                </Tooltip>
                <Menu position="bottom-end" withArrow>
                  <Menu.Target>
                    <UnstyledButton aria-label={me.user.email}>
                      <Group gap={6} wrap="nowrap"><IconUserCircle size={22} /><Text size="sm" visibleFrom="md">{me.user.email}</Text></Group>
                    </UnstyledButton>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Label>{me.user.email}</Menu.Label>
                    <Menu.Item leftSection={<IconLanguage size={16} />} onClick={switchLang}>{i18n.t('language')}</Menu.Item>
                    <Menu.Divider />
                    <Menu.Item color="red" leftSection={<IconLogout size={16} />} onClick={signOut}>{i18n.t('signOut')}</Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              </Group>
            </Group>
          </AppShell.Header>
          <AppShell.Navbar p="md" hiddenFrom="sm">
            {searchBox}
            <Anchor href={href.projects()} mt="md">{i18n.t('projects')}</Anchor>
          </AppShell.Navbar>
          <AppShell.Main>
            <Container size="xl" px={0}>{page}</Container>
          </AppShell.Main>
        </AppShell>
      </AppContext.Provider>
    </I18nContext.Provider>
  );
}

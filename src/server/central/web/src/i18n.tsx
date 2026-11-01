import { createContext, useContext } from 'react';

export type Lang = 'en' | 'ru';

const en = {
  signIn: 'Sign in', token: 'Personal access token', remember: 'Remember on this device',
  loginHelp: 'Paste a personal access token (baton_pat_…). An administrator issues one with: baton-server issue-token <email>',
  signOut: 'Sign out', badToken: 'The server did not accept this token.', search: 'Search all knowledge',
  language: 'Русский', theme: 'Toggle light and dark theme',
  projects: 'Projects', noProjects: 'You have no access to any project yet. Ask an administrator for a grant.',
  project: 'Project', role: 'Role', knowledge: 'Knowledge', needsReview: 'Needs review',
  unconfirmed: 'Unconfirmed', activeSessions: 'Active sessions', waitingSessions: 'Waiting to continue',
  conflicts: 'Conflicts', updated: 'Updated', gitAnalyzed: 'Git analyzed', never: 'never',
  overview: 'Overview', sessions: 'Sessions', audit: 'Audit log',
  confirmed: 'Confirmed', deprecated: 'Deprecated', openConflicts: 'Open conflicts',
  byCategory: 'Knowledge by category', byConfidence: 'By confidence', byStatus: 'By status', sessionsByStatus: 'Sessions by status',
  git: 'Git analysis', branch: 'Branch', commit: 'Commit', fullReconcile: 'Full reconcile', notAnalyzed: 'No commits analyzed yet.',
  projectOverview: 'Project overview (L1 context)', noOverview: 'No overview yet.',
  allCategories: 'All categories', allConfidence: 'Any confidence', allStatuses: 'Any status',
  component: 'Component', file: 'File', searchHere: 'Search this project', apply: 'Apply', reset: 'Reset',
  title: 'Title', category: 'Category', confidence: 'Confidence', status: 'Status', author: 'Author',
  noMemories: 'No knowledge matches.', showMore: 'Show more',
  content: 'Content', facts: 'Facts', relatedFiles: 'Related files', versions: 'History', version: 'Version',
  changedAt: 'Changed', changedBy: 'By', reason: 'Reason', deleted: 'deleted', source: 'Source', agent: 'Agent',
  topicKey: 'Topic key', created: 'Created', review: 'Review', details: 'Details',
  reviewHelp: 'Only people confirm knowledge. Confirmed knowledge is not changed by sync; deprecated knowledge drops out of context.',
  reasonPlaceholder: 'Reason (required to deprecate)', confirm: 'Confirm', deprecate: 'Mark deprecated',
  reasonRequired: 'Give a reason to deprecate.', confirmedDone: 'Confirmed.', deprecatedDone: 'Marked deprecated.',
  viewerReadOnly: 'You have the viewer role: knowledge is read-only for you.',
  all: 'All', live: 'Active', waiting: 'Waiting', finished: 'Finished', task: 'Task', user: 'User', device: 'Device',
  checkpoint: 'Checkpoint', lease: 'Lease', leaseLive: 'held until {0}', noSessions: 'No sessions.', session: 'Session',
  viewerSessions: 'You have the viewer role: session details are hidden.',
  objective: 'Objective', model: 'Model', progress: 'Progress', nextAction: 'Next action', completedSteps: 'Done',
  pendingSteps: 'Pending', decisions: 'Decisions', problems: 'Problems', modifiedFiles: 'Changed files',
  unpushed: 'Unpushed commits', handoffBrief: 'Handoff brief', summary: 'Summary', parent: 'Continues', continuedBy: 'Continued in',
  reservedUntil: 'Reserved until', checkpoints: 'Checkpoints', trigger: 'Trigger', orphan: 'orphan',
  snapshots: 'Workspace snapshots', files: 'Files', size: 'Size', pinned: 'pinned', none: '—',
  noConflicts: 'No open conflicts.', memory: 'Memory', kind: 'Kind', detectedBy: 'Detected by', winner: 'Kept', loser: 'Lost',
  at: 'Time', actor: 'Actor', action: 'Action', target: 'Target', detail: 'Detail', noAudit: 'No entries.',
  results: 'Results for “{0}”', noResults: 'Nothing found.', notFound: 'Not found or no access.',
  forbidden: 'Your role does not allow this.', offline: 'The server is unreachable.', loading: 'Loading…',
};

type Key = keyof typeof en;

const ru: Record<Key, string> = {
  signIn: 'Войти', token: 'Личный токен доступа', remember: 'Запомнить на этом устройстве',
  loginHelp: 'Вставьте личный токен (baton_pat_…). Его выдаёт администратор: baton-server issue-token <email>',
  signOut: 'Выйти', badToken: 'Сервер не принял этот токен.', search: 'Поиск по всем знаниям',
  language: 'English', theme: 'Светлая или тёмная тема',
  projects: 'Проекты', noProjects: 'У вас пока нет доступа ни к одному проекту. Попросите администратора выдать права.',
  project: 'Проект', role: 'Роль', knowledge: 'Знания', needsReview: 'На проверку',
  unconfirmed: 'Не подтверждено', activeSessions: 'Активные сессии', waitingSessions: 'Ждут продолжения',
  conflicts: 'Конфликты', updated: 'Обновлено', gitAnalyzed: 'Анализ git', never: 'не было',
  overview: 'Обзор', sessions: 'Сессии', audit: 'Журнал аудита',
  confirmed: 'Подтверждено', deprecated: 'Устарело', openConflicts: 'Открытые конфликты',
  byCategory: 'Знания по категориям', byConfidence: 'По доверию', byStatus: 'По статусу', sessionsByStatus: 'Сессии по статусу',
  git: 'Анализ git', branch: 'Ветка', commit: 'Коммит', fullReconcile: 'Полная сверка', notAnalyzed: 'Коммиты ещё не анализировались.',
  projectOverview: 'Обзор проекта (контекст L1)', noOverview: 'Обзора пока нет.',
  allCategories: 'Все категории', allConfidence: 'Любое доверие', allStatuses: 'Любой статус',
  component: 'Компонент', file: 'Файл', searchHere: 'Поиск в проекте', apply: 'Применить', reset: 'Сбросить',
  title: 'Заголовок', category: 'Категория', confidence: 'Доверие', status: 'Статус', author: 'Автор',
  noMemories: 'Ничего не найдено.', showMore: 'Показать ещё',
  content: 'Содержание', facts: 'Факты', relatedFiles: 'Связанные файлы', versions: 'История', version: 'Версия',
  changedAt: 'Когда', changedBy: 'Кто', reason: 'Причина', deleted: 'удалено', source: 'Источник', agent: 'Агент',
  topicKey: 'Ключ темы', created: 'Создано', review: 'Проверка', details: 'Сведения',
  reviewHelp: 'Подтверждают знания только люди. Подтверждённое знание не меняется синхронизацией; устаревшее не попадает в контекст.',
  reasonPlaceholder: 'Причина (обязательна для «устарело»)', confirm: 'Подтвердить', deprecate: 'Пометить устаревшим',
  reasonRequired: 'Укажите причину.', confirmedDone: 'Подтверждено.', deprecatedDone: 'Помечено устаревшим.',
  viewerReadOnly: 'У вас роль viewer: знания доступны только для чтения.',
  all: 'Все', live: 'Активные', waiting: 'Ждут', finished: 'Завершённые', task: 'Задача', user: 'Пользователь', device: 'Устройство',
  checkpoint: 'Checkpoint', lease: 'Lease', leaseLive: 'до {0}', noSessions: 'Сессий нет.', session: 'Сессия',
  viewerSessions: 'У вас роль viewer: подробности сессий скрыты.',
  objective: 'Цель', model: 'Модель', progress: 'Прогресс', nextAction: 'Следующее действие', completedSteps: 'Сделано',
  pendingSteps: 'Осталось', decisions: 'Решения', problems: 'Проблемы', modifiedFiles: 'Изменённые файлы',
  unpushed: 'Неотправленные коммиты', handoffBrief: 'Handoff brief', summary: 'Итог', parent: 'Продолжает', continuedBy: 'Продолжена в',
  reservedUntil: 'Зарезервирована до', checkpoints: 'Checkpoints', trigger: 'Триггер', orphan: 'orphan',
  snapshots: 'Снимки рабочей копии', files: 'Файлов', size: 'Размер', pinned: 'закреплён', none: '—',
  noConflicts: 'Открытых конфликтов нет.', memory: 'Запись', kind: 'Тип', detectedBy: 'Кем найден', winner: 'Осталось', loser: 'Отброшено',
  at: 'Время', actor: 'Кто', action: 'Действие', target: 'Объект', detail: 'Подробности', noAudit: 'Записей нет.',
  results: 'Результаты по «{0}»', noResults: 'Ничего не найдено.', notFound: 'Не найдено или нет доступа.',
  forbidden: 'Ваша роль этого не позволяет.', offline: 'Сервер недоступен.', loading: 'Загрузка…',
};

/** Enum values from the server (categories, statuses), in Russian; English shows them as they are. */
const values: Record<string, string> = {
  project_overview: 'обзор проекта', architecture: 'архитектура', component: 'компонент', dependency: 'зависимость',
  architecture_decision: 'архитектурное решение', business_logic: 'бизнес-логика', coding_convention: 'соглашение о коде',
  issue: 'проблема', solution: 'решение', known_limitation: 'известное ограничение', development_history: 'история разработки',
  current_state: 'текущее состояние', active_task: 'активная задача', completed_task: 'завершённая задача',
  session_history: 'история сессий', git_history: 'история git',
  observed: 'наблюдение', inferred: 'вывод', proposed: 'предложено', confirmed: 'подтверждено', deprecated: 'устарело',
  active: 'активно', needs_review: 'на проверку', resolved: 'решено', archived: 'в архиве',
  created: 'создана', in_progress: 'в работе', checkpointed: 'checkpoint', interrupted: 'прервана',
  waiting_handoff: 'ждёт передачи', resumable: 'можно продолжить', completed: 'завершена', failed: 'неудача',
};

export interface I18n {
  lang: Lang;
  t: (key: Key, ...args: Array<string | number>) => string;
  label: (value: string) => string;
}

export function makeI18n(lang: Lang): I18n {
  const dict = lang === 'ru' ? ru : en;
  return {
    lang,
    t: (key, ...args) => dict[key].replace(/\{(\d)\}/g, (_, i: string) => String(args[Number(i)] ?? '')),
    label: (value) => (lang === 'ru' ? values[value] : undefined) ?? value.replaceAll('_', ' '),
  };
}

export const I18nContext = createContext<I18n>(makeI18n('en'));
export const useI18n = (): I18n => useContext(I18nContext);

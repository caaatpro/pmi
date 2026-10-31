import { createContext, useContext } from 'react';

import type { Me, Project, Role } from './api';

const RANK: Record<Role, number> = { viewer: 1, developer: 2, maintainer: 3, admin: 4 };

export interface AppState {
  me: Me;
  projectOf: (id: string) => Project | undefined;
  orgName: (orgId: string) => string;
  /** Whether the caller holds at least `role` on the project (the server checks again). */
  can: (project: Project | undefined, role: Role) => boolean;
  refreshMe: () => Promise<Me>;
}

export function appState(me: Me, refreshMe: () => Promise<Me>): AppState {
  return {
    me,
    projectOf: (id) => me.projects.find((project) => project.id === id),
    orgName: (orgId) => me.organizations.find((org) => org.orgId === orgId)?.name ?? '',
    can: (project, role) => Boolean(project) && RANK[project!.role] >= RANK[role],
    refreshMe,
  };
}

export const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const state = useContext(AppContext);
  if (!state) throw new Error('AppContext missing');
  return state;
}

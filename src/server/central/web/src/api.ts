// Client for the baton-server /v1 API. The personal access token travels only
// in the Authorization header (no cookies, so no CSRF).

const TOKEN_KEY = 'baton.token';

let memoryToken: string | null = null;

function read(key: string): string | null {
  try {
    return sessionStorage.getItem(key) ?? localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function getToken(): string | null {
  return memoryToken ?? read(TOKEN_KEY);
}

/** Session storage by default; local storage only when the user asks to be remembered. */
export function saveToken(token: string, remember: boolean): void {
  memoryToken = token;
  try {
    (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
  } catch { /* storage unavailable: the token lives for this page only */ }
}

export function clearToken(): void {
  memoryToken = null;
  try {
    sessionStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_KEY);
  } catch { /* ignore */ }
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

let onUnauthorized: () => void = () => undefined;
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

export async function api<T>(path: string, options: { body?: unknown; token?: string } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${options.token ?? getToken() ?? ''}`,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiError(0, 'offline', 'offline');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !options.token) onUnauthorized();
    throw new ApiError(response.status, data?.error?.code ?? 'error', data?.error?.message ?? response.statusText);
  }
  return data as T;
}

// ── Types of the API responses the UI reads ──────────────────────────────

export type Role = 'viewer' | 'developer' | 'maintainer' | 'admin';

export interface Project {
  id: string;
  orgId: string;
  slug: string;
  name: string;
  role: Role;
}

export interface Me {
  user: { id: string; email: string; displayName: string | null };
  organizations: Array<{ orgId: string; slug: string; name: string; role: string }>;
  projects: Project[];
}

export interface Stats {
  memories: {
    total: number;
    byCategory: Record<string, number>;
    byConfidence: Record<string, number>;
    byStatus: Record<string, number>;
    needsReview: number;
    unconfirmed: number;
    lastUpdatedAt: string | null;
  };
  sessions: { total: number; byStatus: Record<string, number> };
  openConflicts: number;
  git: Array<{ branch: string; lastAnalyzedCommit: string; lastFullReconcileAt: string | null; updatedAt: string }>;
}

export interface Memory {
  id: string;
  projectId?: string;
  category: string;
  confidence: string;
  status: string;
  title: string;
  content: string;
  facts: string[];
  component: string | null;
  topicKey: string | null;
  source: string;
  authorEmail: string | null;
  authorAgent: string | null;
  relatedFiles: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryVersion {
  version: number;
  deleted: boolean;
  changedAt: string;
  changedByEmail: string | null;
  changedByDevice: string | null;
  reason: string;
}

export interface Step { id: string; text: string }

export interface Session {
  id: string;
  projectId: string;
  userEmail: string;
  deviceId: string;
  agent: string | null;
  modelProvider: string | null;
  model: string | null;
  status: string;
  task: string;
  objective: string;
  state?: {
    progress?: { percent?: number; summary: string };
    completedSteps?: Step[];
    pendingSteps?: Step[];
    decisions?: Array<{ id: string; title: string }>;
    problems?: Array<{ text: string; status: string }>;
    nextAction?: string | null;
    git?: { modifiedFiles: Array<{ path: string; status: string }>; unpushedCommits: string[] } | null;
  };
  parentSessionId: string | null;
  continuedBy: string | null;
  leaseExpiresAt: string | null;
  leaseLive: boolean;
  handoffReservedUntil: string | null;
  handoffBrief?: string | null;
  lastCheckpointSeq: number;
  gitBranch: string | null;
  gitHead: string | null;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Checkpoint { id: string; seq: number; trigger: string; orphan: boolean; createdAt: string }

export interface Snapshot {
  id: string;
  branch: string | null;
  baseCommit: string;
  totalBytes: number;
  fileCount: number;
  pinned: boolean;
  createdAt: string;
}

export interface Conflict {
  id: string;
  memoryId: string;
  kind: string;
  detectedBy: string;
  winner: ConflictSide;
  loser: ConflictSide;
  createdAt: string;
}
export interface ConflictSide { kind?: string; version?: { writer?: string }; row?: { title?: string } | null }

export interface AuditEntry {
  id: number;
  at: string;
  action: string;
  actorEmail: string | null;
  actorDeviceId: string | null;
  targetType: string | null;
  targetId: string | null;
  detail: Record<string, unknown>;
}

/**
 * Minimal HTTP client for the central server. Distinguishes "server
 * unreachable" (`offline`) from API errors so callers can keep local data
 * buffered instead of failing loudly when the network is down.
 */

export class PmiApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }

  get offline(): boolean {
    return this.code === 'offline';
  }
}

export interface PmiApiClient {
  readonly server: string;
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

export function createApiClient(server: string, token: string | undefined, options: { timeoutMs?: number } = {}): PmiApiClient {
  const timeoutMs = options.timeoutMs ?? 30_000;

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${server}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new PmiApiError(0, 'offline', `PMI server ${server} is unreachable: ${(error as Error).message}`);
    }
    const text = await res.text();
    let payload: any;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new PmiApiError(res.status, 'bad_response', `PMI server returned non-JSON (HTTP ${res.status})`);
    }
    if (!res.ok) {
      const error = payload?.error ?? {};
      throw new PmiApiError(res.status, error.code ?? 'http_error', error.message ?? `HTTP ${res.status}`, error.details);
    }
    return payload as T;
  }

  return {
    server,
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
  };
}

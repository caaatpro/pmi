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
  /** Upload raw bytes (blobs). */
  putBinary<T>(path: string, body: Buffer): Promise<T>;
  /** Download raw bytes (blobs). */
  getBinary(path: string): Promise<Buffer>;
}

export function createApiClient(server: string, token: string | undefined, options: { timeoutMs?: number } = {}): PmiApiClient {
  const timeoutMs = options.timeoutMs ?? 30_000;

  async function send(method: string, path: string, body: string | Buffer | undefined, contentType: string | undefined): Promise<Response> {
    try {
      return await fetch(`${server}${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(contentType ? { 'content-type': contentType } : {}),
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new PmiApiError(0, 'offline', `PMI server ${server} is unreachable: ${(error as Error).message}`);
    }
  }

  async function failure(res: Response): Promise<PmiApiError> {
    const text = await res.text();
    try {
      const error = JSON.parse(text)?.error ?? {};
      return new PmiApiError(res.status, error.code ?? 'http_error', error.message ?? `HTTP ${res.status}`, error.details);
    } catch {
      return new PmiApiError(res.status, 'http_error', `HTTP ${res.status}`);
    }
  }

  async function request<T>(method: string, path: string, body?: unknown, raw?: Buffer): Promise<T> {
    const res = raw
      ? await send(method, path, raw, 'application/octet-stream')
      : await send(method, path, body !== undefined ? JSON.stringify(body) : undefined, body !== undefined ? 'application/json' : undefined);
    if (!res.ok) throw await failure(res);
    const text = await res.text();
    let payload: any;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new PmiApiError(res.status, 'bad_response', `PMI server returned non-JSON (HTTP ${res.status})`);
    }
    return payload as T;
  }

  return {
    server,
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    putBinary: (path, body) => request('PUT', path, undefined, body),
    async getBinary(path: string): Promise<Buffer> {
      const res = await send('GET', path, undefined, undefined);
      if (!res.ok) throw await failure(res);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

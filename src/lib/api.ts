import { t as tr } from '../i18n/index.ts';
export class ApiFailure extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RestClient {
  get<T = any>(path: string): Promise<T>;
  post<T = any>(path: string, body?: unknown): Promise<T>;
  patch<T = any>(path: string, body?: unknown): Promise<T>;
}


export function createRestClient(opts: { fetchImpl?: FetchLike; actor?: 'webmcp'; onUnauthorized?: () => void; base?: string }): RestClient {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  const base = opts.base ?? '/api/v1';
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { 'X-Requested-With': 'kanban', Accept: 'application/json' };
    if (opts.actor === 'webmcp') headers['X-Kanban-Actor'] = 'webmcp';
    let payload: string | undefined;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await fetchImpl(base + path, { method, headers, body: payload, credentials: 'same-origin' });
    } catch (e) {
      throw new ApiFailure(0, 'network', tr('ui184'));
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* ignore */
    }
    if (!res.ok) {
      if (res.status === 401 && !path.startsWith('/auth/login')) opts.onUnauthorized?.();
      const err = json?.error;
      throw new ApiFailure(res.status, err?.code ?? 'http_error', err?.message ?? `HTTP ${res.status}`);
    }
    return json as T;
  }
  return {
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
    patch: (p, b) => call('PATCH', p, b),
  };
}

export const qs = (params: Record<string, string | number | boolean | undefined | null>): string => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
};

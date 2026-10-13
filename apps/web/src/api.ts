import { QueryClient } from '@tanstack/react-query';
import type { Account, ApiTokenInfo, OwnedGame, PersonaMode } from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
      refetchOnWindowFocus: false,
    },
  },
});

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Oturum düştüyse giriş ekranına dön
    if (res.status === 401 && path !== '/auth/login' && path !== '/auth/me') {
      queryClient.setQueryData(keys.me, null);
    }
    throw new ApiError(res.status, data.error ?? `İstek başarısız (${res.status})`);
  }
  return data as T;
}

export const keys = {
  me: ['me'] as const,
  accounts: ['accounts'] as const,
  logs: ['logs'] as const,
  games: (id: string) => ['games', id] as const,
  tokens: ['tokens'] as const,
};

export const api = {
  /** Giriş yapılmamışsa null döner */
  me: async () => {
    try {
      return await request<{ authKind: 'session' | 'token' }>('GET', '/auth/me');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return null;
      throw err;
    }
  },
  login: (password: string) => request<{ ok: true }>('POST', '/auth/login', { password }),
  logout: () => request<{ ok: true }>('POST', '/auth/logout'),
  changePassword: (current: string, next: string) => request<{ ok: true }>('POST', '/auth/password', { current, next }),

  addAccount: (accountName: string, password: string) => request<Account>('POST', '/accounts', { accountName, password }),
  relogin: (id: string, password: string) => request<Account>('POST', `/accounts/${id}/login`, { password }),
  submitGuard: (id: string, code: string) => request<Account>('POST', `/accounts/${id}/guard`, { code }),
  waitGuard: (id: string) => request<Account>('POST', `/accounts/${id}/guard/wait`),
  updateAccount: (id: string, patch: Partial<{ games: number[]; persona: PersonaMode; enabled: boolean }>) =>
    request<Account>('PATCH', `/accounts/${id}`, patch),
  removeAccount: (id: string) => request<{ ok: true }>('DELETE', `/accounts/${id}`),
  ownedGames: (id: string, refresh = false) => request<OwnedGame[]>('GET', `/accounts/${id}/games${refresh ? '?refresh=true' : ''}`),

  tokens: () => request<ApiTokenInfo[]>('GET', '/tokens'),
  createToken: (name: string) => request<{ token: string; info: ApiTokenInfo }>('POST', '/tokens', { name }),
  revokeToken: (id: string) => request<{ ok: true }>('DELETE', `/tokens/${id}`),
};

/** API'den dönen güncel hesabı önbelleğe yazar (WebSocket mesajını beklemeden). */
export function upsertAccount(account: Account) {
  queryClient.setQueryData<Account[]>(keys.accounts, (list = []) => {
    const index = list.findIndex((a) => a.id === account.id);
    if (index === -1) return [...list, account];
    const next = list.slice();
    next[index] = account;
    return next;
  });
}

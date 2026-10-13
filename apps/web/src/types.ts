/** Sunucudaki API tipleri (docs/API.md) */

export type SessionState =
  | 'stopped'
  | 'connecting'
  | 'awaiting_guard'
  | 'running'
  | 'blocked'
  | 'waiting_retry'
  | 'needs_login';

export type PersonaMode = 'online' | 'invisible';

export interface GuardRequest {
  type: 'email' | 'mobile';
  domain: string | null;
  lastCodeWrong: boolean;
}

export interface Account {
  id: string;
  accountName: string;
  steamId: string | null;
  personaName: string | null;
  avatarUrl: string | null;
  games: number[];
  persona: PersonaMode;
  mode: 'games' | 'cards';
  enabled: boolean;
  hasToken: boolean;
  /** Seçili oyunların sunucunun bildiği adları (AppID → ad) */
  gameNames: Record<string, string>;
  createdAt: string;
  session: {
    state: SessionState;
    guard: GuardRequest | null;
    lastError: string | null;
    retryAt: string | null;
    blockedByApp: number | null;
    runningSince: string | null;
  };
}

export interface OwnedGame {
  appId: number;
  name: string;
  playtimeMinutes: number;
  iconUrl: string | null;
}

export interface LogEntry {
  time: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  scope: string;
  message: string;
}

export interface ApiTokenInfo {
  id: string;
  name: string;
  preview: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export type ServerMessage =
  | { type: 'snapshot'; accounts: Account[]; logs: LogEntry[] }
  | { type: 'account'; account: Account }
  | { type: 'removed'; id: string }
  | { type: 'log'; entry: LogEntry };

export const MAX_GAMES = 32;

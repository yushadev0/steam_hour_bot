import { join } from 'node:path';
import { z } from 'zod';
import { MAX_GAMES } from '../config.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { readJson, writeJsonAtomic } from './json-file.js';
import type { Vault } from './vault.js';

export const personaModes = ['online', 'invisible'] as const;
export type PersonaMode = (typeof personaModes)[number];

/** 'games': seçili oyunları kas. 'cards': kart düşürme modu (Faz 4). */
export const idleModes = ['games', 'cards'] as const;
export type IdleMode = (typeof idleModes)[number];

const accountSchema = z.object({
  /** Küçük harfli Steam kullanıcı adı */
  id: z.string(),
  accountName: z.string(),
  steamId: z.string().nullable().default(null),
  personaName: z.string().nullable().default(null),
  games: z.array(z.number().int().positive()).default([]),
  persona: z.enum(personaModes).default('online'),
  mode: z.enum(idleModes).default('games'),
  enabled: z.boolean().default(true),
  /** Vault ile şifrelenmiş refresh token */
  refreshToken: z.string().nullable().default(null),
  createdAt: z.string(),
});

export type AccountRecord = z.infer<typeof accountSchema>;

const fileSchema = z.object({
  version: z.literal(1),
  accounts: z.array(accountSchema),
});

export type AccountPatch = Partial<Pick<AccountRecord, 'games' | 'persona' | 'mode' | 'enabled'>>;

export function accountIdOf(accountName: string) {
  return accountName.trim().toLowerCase();
}

/** AppID listesini doğrular: pozitif tam sayı, tekrarsız, en fazla MAX_GAMES. */
export function normalizeGames(games: unknown[]): number[] {
  const ids = games.map((g) => Number(g));
  const invalid = ids.filter((id) => !Number.isInteger(id) || id <= 0);
  if (invalid.length) throw badRequest(`Geçersiz AppID: ${invalid.join(', ')}`);
  const unique = [...new Set(ids)];
  if (unique.length > MAX_GAMES) throw badRequest(`Steam aynı anda en fazla ${MAX_GAMES} oyun gösterebilir`);
  return unique;
}

/** Hesapları data/accounts.json'da tutar. Token'lar Vault ile şifreli saklanır. */
export class AccountStore {
  private readonly file: string;
  private accounts = new Map<string, AccountRecord>();

  constructor(
    dataDir: string,
    private readonly vault: Vault,
  ) {
    this.file = join(dataDir, 'accounts.json');
    this.load();
  }

  private load() {
    const raw = readJson(this.file);
    if (raw === undefined) return;
    const parsed = fileSchema.parse(raw);
    this.accounts = new Map(parsed.accounts.map((a) => [a.id, a]));
  }

  private save() {
    writeJsonAtomic(this.file, { version: 1, accounts: [...this.accounts.values()] });
  }

  list(): AccountRecord[] {
    return [...this.accounts.values()];
  }

  get(id: string): AccountRecord | undefined {
    return this.accounts.get(accountIdOf(id));
  }

  require(id: string): AccountRecord {
    const account = this.get(id);
    if (!account) throw notFound(`Hesap bulunamadı: ${id}`);
    return account;
  }

  create(accountName: string): AccountRecord {
    const id = accountIdOf(accountName);
    if (this.accounts.has(id)) throw conflict(`Hesap zaten var: ${accountName}`);
    const account = accountSchema.parse({ id, accountName: accountName.trim(), createdAt: new Date().toISOString() });
    this.accounts.set(id, account);
    this.save();
    return account;
  }

  update(id: string, patch: AccountPatch & Partial<Pick<AccountRecord, 'steamId' | 'personaName'>>): AccountRecord {
    const account = this.require(id);
    const next = { ...account, ...patch };
    if (patch.games) next.games = normalizeGames(patch.games);
    this.accounts.set(account.id, next);
    this.save();
    return next;
  }

  remove(id: string) {
    if (this.accounts.delete(accountIdOf(id))) this.save();
  }

  getToken(id: string): string | null {
    const blob = this.require(id).refreshToken;
    if (!blob) return null;
    try {
      return this.vault.decrypt(blob);
    } catch {
      // Anahtar değişmiş olabilir; token kullanılamaz, yeniden giriş gerekir.
      return null;
    }
  }

  setToken(id: string, token: string | null) {
    const account = this.require(id);
    this.accounts.set(account.id, { ...account, refreshToken: token ? this.vault.encrypt(token) : null });
    this.save();
  }
}

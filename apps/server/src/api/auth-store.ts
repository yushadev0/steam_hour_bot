import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { badRequest, notFound, unauthorized } from '../errors.js';
import { readJson, writeJsonAtomic } from '../store/json-file.js';

export const SESSION_COOKIE = 'shb_session';

const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const MIN_PASSWORD_LENGTH = 8;
const API_TOKEN_PREFIX = 'shb_';

const sessionSchema = z.object({ hash: z.string(), expiresAt: z.string() });
const apiTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  hash: z.string(),
  /** Listelemede gösterilen ilk birkaç karakter */
  preview: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
const fileSchema = z.object({
  version: z.literal(1),
  /** scrypt: salt:hash (hex) */
  passwordHash: z.string(),
  sessions: z.array(sessionSchema),
  apiTokens: z.array(apiTokenSchema),
});

type AuthFile = z.infer<typeof fileSchema>;
export type ApiTokenInfo = Omit<z.infer<typeof apiTokenSchema>, 'hash'>;
export type AuthKind = 'session' | 'token';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(password, salt, 64).toString('hex')}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, Buffer.from(salt, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

/**
 * Panel şifresi, oturumlar ve API token'ları (data/auth.json). Oturum ve token'ların yalnızca
 * SHA-256 özetleri saklanır; şifre scrypt ile özetlenir.
 */
export class AuthStore {
  private readonly file: string;
  private data: AuthFile;
  /** İlk açılışta otomatik üretilen panel şifresi (yalnızca o açılışta dolu, bir kez gösterilir). */
  readonly generatedPassword: string | undefined;

  /** @param envPassword SHB_ADMIN_PASSWORD verilmişse her açılışta panel şifresi olarak ayarlanır. */
  constructor(dataDir: string, envPassword?: string) {
    this.file = join(dataDir, 'auth.json');
    const raw = readJson(this.file);
    if (raw !== undefined) {
      this.data = fileSchema.parse(raw);
      if (envPassword && !verifyPassword(envPassword, this.data.passwordHash)) {
        this.data.passwordHash = hashPassword(envPassword);
        this.save();
      }
      return;
    }
    const password = envPassword ?? randomBytes(9).toString('base64url');
    if (!envPassword) this.generatedPassword = password;
    this.data = { version: 1, passwordHash: hashPassword(password), sessions: [], apiTokens: [] };
    this.save();
  }

  private save() {
    writeJsonAtomic(this.file, this.data);
  }

  /** Şifre doğruysa yeni oturum token'ı döner. */
  login(password: string): { token: string; expiresAt: Date } {
    if (!verifyPassword(password, this.data.passwordHash)) throw unauthorized('Şifre hatalı');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    this.pruneSessions();
    this.data.sessions.push({ hash: sha256(token), expiresAt: expiresAt.toISOString() });
    this.save();
    return { token, expiresAt };
  }

  logout(sessionToken: string) {
    const hash = sha256(sessionToken);
    this.data.sessions = this.data.sessions.filter((s) => s.hash !== hash);
    this.save();
  }

  changePassword(current: string, next: string) {
    if (!verifyPassword(current, this.data.passwordHash)) throw unauthorized('Mevcut şifre hatalı');
    if (next.length < MIN_PASSWORD_LENGTH) throw badRequest(`Şifre en az ${MIN_PASSWORD_LENGTH} karakter olmalı`);
    this.data.passwordHash = hashPassword(next);
    // Diğer cihazlardaki oturumlar kapanır
    this.data.sessions = [];
    this.save();
  }

  /** Oturum çerezi ya da API token'ı doğrular; geçerliyse türünü döner. */
  verify(token: string): AuthKind | null {
    const hash = sha256(token);
    if (token.startsWith(API_TOKEN_PREFIX)) {
      const apiToken = this.data.apiTokens.find((t) => t.hash === hash);
      if (!apiToken) return null;
      const now = Date.now();
      if (!apiToken.lastUsedAt || now - Date.parse(apiToken.lastUsedAt) > 60_000) {
        apiToken.lastUsedAt = new Date(now).toISOString();
        this.save();
      }
      return 'token';
    }
    const session = this.data.sessions.find((s) => s.hash === hash);
    if (!session || new Date(session.expiresAt) < new Date()) return null;
    return 'session';
  }

  listApiTokens(): ApiTokenInfo[] {
    return this.data.apiTokens.map(({ hash, ...info }) => info);
  }

  /** Yeni API token'ı üretir. Düz hali yalnızca burada döner. */
  createApiToken(name: string): { token: string; info: ApiTokenInfo } {
    const trimmed = name.trim();
    if (!trimmed) throw badRequest('Token adı gerekli');
    const token = API_TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const record = {
      id: randomBytes(6).toString('hex'),
      name: trimmed,
      hash: sha256(token),
      preview: token.slice(0, API_TOKEN_PREFIX.length + 4),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    this.data.apiTokens.push(record);
    this.save();
    const { hash, ...info } = record;
    return { token, info };
  }

  revokeApiToken(id: string) {
    const before = this.data.apiTokens.length;
    this.data.apiTokens = this.data.apiTokens.filter((t) => t.id !== id);
    if (this.data.apiTokens.length === before) throw notFound('Token bulunamadı');
    this.save();
  }

  private pruneSessions() {
    const now = new Date();
    this.data.sessions = this.data.sessions.filter((s) => new Date(s.expiresAt) > now);
  }
}

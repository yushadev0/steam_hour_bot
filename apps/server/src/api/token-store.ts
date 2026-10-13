import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { badRequest, notFound } from '../errors.js';
import { readJson, writeJsonAtomic } from '../store/json-file.js';

const API_TOKEN_PREFIX = 'shb_';

const apiTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  hash: z.string(),
  /** Listelemede gösterilen ilk birkaç karakter */
  preview: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
// v1 dosyalarında panel şifresi ve oturumlar da vardı; artık yalnızca token'lar okunuyor.
const fileSchema = z.object({ apiTokens: z.array(apiTokenSchema) });

type ApiToken = z.infer<typeof apiTokenSchema>;
export type ApiTokenInfo = Omit<ApiToken, 'hash'>;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * Dış istemciler (yassistant modülü) için API token'ları (data/auth.json).
 * Yalnızca SHA-256 özetleri saklanır. Yerel panel token gerektirmez.
 */
export class TokenStore {
  private readonly file: string;
  private tokens: ApiToken[] = [];

  constructor(dataDir: string) {
    this.file = join(dataDir, 'auth.json');
    const raw = readJson(this.file);
    if (raw === undefined) return;
    const parsed = fileSchema.safeParse(raw);
    this.tokens = parsed.success ? parsed.data.apiTokens : [];
    // Eski biçimi (panel şifreli) yeni biçime çevir
    if ((raw as { version?: number }).version !== 2) this.save();
  }

  private save() {
    writeJsonAtomic(this.file, { version: 2, apiTokens: this.tokens });
  }

  /** Token geçerliyse true döner ve son kullanım zamanını günceller (dakikada bir diske yazılır). */
  verify(token: string): boolean {
    if (!token.startsWith(API_TOKEN_PREFIX)) return false;
    const hash = sha256(token);
    const apiToken = this.tokens.find((t) => t.hash === hash);
    if (!apiToken) return false;
    const now = Date.now();
    if (!apiToken.lastUsedAt || now - Date.parse(apiToken.lastUsedAt) > 60_000) {
      apiToken.lastUsedAt = new Date(now).toISOString();
      this.save();
    }
    return true;
  }

  list(): ApiTokenInfo[] {
    return this.tokens.map(({ hash, ...info }) => info);
  }

  /** Yeni token üretir. Düz hali yalnızca burada döner. */
  create(name: string): { token: string; info: ApiTokenInfo } {
    const trimmed = name.trim();
    if (!trimmed) throw badRequest('Token adı gerekli');
    const token = API_TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const record: ApiToken = {
      id: randomBytes(6).toString('hex'),
      name: trimmed,
      hash: sha256(token),
      preview: token.slice(0, API_TOKEN_PREFIX.length + 4),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    this.tokens.push(record);
    this.save();
    const { hash, ...info } = record;
    return { token, info };
  }

  revoke(id: string) {
    const before = this.tokens.length;
    this.tokens = this.tokens.filter((t) => t.id !== id);
    if (this.tokens.length === before) throw notFound('Token bulunamadı');
    this.save();
  }
}

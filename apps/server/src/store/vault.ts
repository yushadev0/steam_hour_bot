import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const VERSION = 'v1';

/** Refresh token'ları diskte AES-256-GCM ile şifreler. */
export class Vault {
  private readonly key: Buffer;

  constructor(secret: string) {
    if (!secret) throw new Error('Vault secret boş olamaz');
    this.key = scryptSync(secret, 'yusha-steam-hour-bot', 32);
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join(':');
  }

  decrypt(blob: string): string {
    const [version, iv, tag, data] = blob.split(':');
    if (version !== VERSION || !iv || !tag || !data) throw new Error('Geçersiz şifreli veri');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  }
}

/**
 * Şifreleme anahtarını döndürür: SHB_SECRET verilmişse onu, yoksa dataDir/secret.key
 * dosyasını kullanır (yoksa rastgele üretir).
 */
export function resolveSecret(dataDir: string, envSecret: string | undefined): { secret: string; generated: boolean } {
  if (envSecret) return { secret: envSecret, generated: false };

  const file = join(dataDir, 'secret.key');
  if (existsSync(file)) return { secret: readFileSync(file, 'utf8').trim(), generated: false };

  mkdirSync(dataDir, { recursive: true });
  const secret = randomBytes(32).toString('base64url');
  writeFileSync(file, secret, { mode: 0o600 });
  return { secret, generated: true };
}

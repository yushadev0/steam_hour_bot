import { join, resolve } from 'node:path';

export const APP_NAME = "yusha's Steam Hour Bot";

/** Steam aynı anda en fazla bu kadar oyunu "oynuyor" gösterebilir. */
export const MAX_GAMES = 32;

export interface Config {
  /** Hesaplar, şifreli token'lar ve steam-user önbelleği burada tutulur. */
  dataDir: string;
  /** Token şifreleme anahtarı. Verilmezse dataDir/secret.key otomatik üretilir. */
  secret: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    // INIT_CWD: npm script'i workspace klasöründe çalıştırsa da komutun verildiği klasör
    dataDir: resolve(env.SHB_DATA_DIR ?? join(env.INIT_CWD ?? process.cwd(), 'data')),
    secret: env.SHB_SECRET || undefined,
  };
}

import { join } from 'node:path';
import { loadConfig, type Config } from './config.js';
import { logger } from './logger.js';
import { t } from './i18n.js';
import { AccountManager } from './steam/account-manager.js';
import { AccountStore } from './store/account-store.js';
import { resolveSecret, Vault } from './store/vault.js';

export interface Core {
  config: Config;
  store: AccountStore;
  manager: AccountManager;
}

export function createCore(config: Config = loadConfig()): Core {
  const { secret, generated } = resolveSecret(config.dataDir, config.secret);
  if (generated) {
    const file = join(config.dataDir, 'secret.key');
    logger.log(
      'warn',
      'core',
      t(
        `Şifreleme anahtarı oluşturuldu: ${file} — bu dosyayı kaybedersen hesaplara yeniden giriş yapman gerekir.`,
        `Encryption key created: ${file} — if you lose this file you will need to sign in to your accounts again.`,
      ),
    );
  }
  const store = new AccountStore(config.dataDir, new Vault(secret));
  const manager = new AccountManager(store, config.dataDir);
  return { config, store, manager };
}

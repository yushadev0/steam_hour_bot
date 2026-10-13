import { join } from 'node:path';
import { loadConfig, type Config } from './config.js';
import { logger } from './logger.js';
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
    logger.log('warn', 'core', `Şifreleme anahtarı oluşturuldu: ${join(config.dataDir, 'secret.key')} — bu dosyayı kaybedersen hesaplara yeniden giriş yapman gerekir.`);
  }
  const store = new AccountStore(config.dataDir, new Vault(secret));
  const manager = new AccountManager(store, config.dataDir);
  return { config, store, manager };
}

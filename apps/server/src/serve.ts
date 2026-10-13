import { AuthStore } from './api/auth-store.js';
import { buildServer } from './api/server.js';
import { APP_NAME, VERSION } from './config.js';
import type { Core } from './core.js';
import { acquireServerLock } from './lock.js';
import { logger } from './logger.js';

const log = logger.scoped('core');

/** Botu ve panel/API sunucusunu başlatır; SIGINT/SIGTERM ile düzgün kapanır. */
export async function serve(core: Core) {
  const { config, manager } = core;
  const releaseLock = acquireServerLock(config.dataDir);

  const auth = new AuthStore(config.dataDir, config.adminPassword);
  const app = await buildServer(core, auth, { serveWeb: true });
  await app.listen({ host: config.host, port: config.port });

  const shownHost = config.host === '0.0.0.0' ? 'localhost' : config.host;
  log.info(`${APP_NAME} v${VERSION} çalışıyor → http://${shownHost}:${config.port}`);
  if (auth.generatedPassword) {
    log.warn(`Panel şifresi oluşturuldu: ${auth.generatedPassword}  (girişten sonra panelden değiştirebilirsin; bir daha gösterilmeyecek)`);
  }

  manager.startAll();

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    log.info('Kapatılıyor...');
    manager.stopAll();
    await app.close();
    releaseLock();
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

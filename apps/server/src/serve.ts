import { spawn } from 'node:child_process';
import { buildServer } from './api/server.js';
import { TokenStore } from './api/token-store.js';
import { APP_NAME, VERSION } from './config.js';
import type { Core } from './core.js';
import { acquireServerLock } from './lock.js';
import { logger } from './logger.js';
import { t } from './i18n.js';

const log = logger.scoped('core');

/** Windows'ta exe çalıştırılınca paneli varsayılan tarayıcıda açar (SHB_NO_BROWSER=1 ile kapatılır). */
function openBrowser(url: string) {
  const compiled = !!process.versions.bun;
  if (process.platform !== 'win32' || !compiled || process.env.SHB_NO_BROWSER) return;
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

/** Botu ve yerel paneli başlatır; SIGINT/SIGTERM ile düzgün kapanır. */
export async function serve(core: Core) {
  const { config, manager } = core;
  const releaseLock = acquireServerLock(config.dataDir);

  const app = await buildServer(core, new TokenStore(config.dataDir), { serveWeb: true });
  await app.listen({ host: config.host, port: config.port });

  const url = `http://127.0.0.1:${config.port}`;
  log.info(t(`${APP_NAME} v${VERSION} çalışıyor → panel: ${url}`, `${APP_NAME} v${VERSION} is running → panel: ${url}`));
  if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
    log.warn(
      t(
        `Sunucu ${config.host} adresini dinliyor. Panel yine yalnızca bu bilgisayardan açılır; dışarıdan yalnızca API token ile erişilebilir.`,
        `Listening on ${config.host}. The panel still only opens on this computer; remote access needs an API token.`,
      ),
    );
  }
  openBrowser(url);

  manager.startAll();

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    log.info(t('Kapatılıyor...', 'Shutting down...'));
    manager.stopAll();
    await app.close();
    releaseLock();
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Arayüz geliştirme için demo sunucu: gerçek Steam yerine sahte istemcilerle çalışır.
 * Geçici bir data klasöründe örnek hesaplar oluşturur.
 *
 *   npm run demo   (ardından apps/web'de npm run dev, ya da derlenmiş panel için http://127.0.0.1:8090)
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import SteamUser from 'steam-user';
import { TokenStore } from '../src/api/token-store.js';
import { buildServer } from '../src/api/server.js';
import { loadConfig } from '../src/config.js';
import { AccountManager } from '../src/steam/account-manager.js';
import { AccountStore } from '../src/store/account-store.js';
import { Vault } from '../src/store/vault.js';

const LIBRARY = [
  { appid: 730, name: 'Counter-Strike 2', playtime_forever: 24_750 },
  { appid: 570, name: 'Dota 2', playtime_forever: 8_130 },
  { appid: 440, name: 'Team Fortress 2', playtime_forever: 3_390 },
  { appid: 1172470, name: 'Apex Legends', playtime_forever: 1_220 },
  { appid: 578080, name: 'PUBG: BATTLEGROUNDS', playtime_forever: 610 },
  { appid: 252490, name: 'Rust', playtime_forever: 95 },
  { appid: 1086940, name: "Baldur's Gate 3", playtime_forever: 0 },
].map((app) => ({ ...app, img_icon_url: '' }));

/** Hesap adına göre davranan sahte Steam istemcisi */
class DemoClient extends EventEmitter {
  steamID = { getSteamID64: () => '76561198000000000' };
  private account = '';

  logOn(details: { refreshToken?: string; accountName?: string; password?: string }) {
    this.account = details.accountName ?? details.refreshToken ?? '';
    setTimeout(() => {
      if (details.password) {
        // Yeni eklenen hesaplar Guard ister; kod 12345
        const onCode = (code: string) =>
          setTimeout(() => {
            if (code !== '12345') return this.emit('steamGuard', null, onCode, true);
            this.emit('refreshToken', `token-${this.account}`);
            this.loggedOn();
          }, 600);
        return this.emit('steamGuard', null, onCode, false);
      }
      if (this.account.includes('expired')) {
        return this.emit('error', Object.assign(new Error('AccessDenied'), { eresult: SteamUser.EResult.AccessDenied }));
      }
      this.loggedOn();
    }, 700);
  }

  private loggedOn() {
    this.emit('loggedOn');
    this.emit('accountInfo', this.account.replace(/^token-/, '').replace('_main', ''));
    if (this.account.includes('alt')) setTimeout(() => this.emit('playingState', true, 570), 200);
  }

  gamesPlayed() {}
  setPersona() {}
  logOff() {}
  async getUserOwnedApps() {
    return { app_count: LIBRARY.length, apps: LIBRARY };
  }
  async getPersonas() {
    return { personas: {} };
  }
}

const dataDir = mkdtempSync(join(tmpdir(), 'shb-demo-'));
const store = new AccountStore(dataDir, new Vault('demo'));
const seed = [
  { name: 'yusha_main', games: [730, 570, 440], persona: 'online' as const },
  { name: 'yusha_alt', games: [578080], persona: 'invisible' as const },
  { name: 'old_expired', games: [252490], persona: 'online' as const },
];
for (const { name, games, persona } of seed) {
  store.create(name);
  store.update(name, { games, persona });
  store.setToken(name, `token-${name}`);
}

const manager = new AccountManager(store, dataDir, () => new DemoClient() as unknown as SteamUser);
const config = loadConfig({ ...process.env, SHB_DATA_DIR: dataDir });
const app = await buildServer({ config, store, manager }, new TokenStore(dataDir), { serveWeb: true });
await app.listen({ host: config.host, port: config.port });
manager.startAll();
console.log(`Demo sunucu: http://127.0.0.1:${config.port}  (yeni hesap eklerken Guard kodu: 12345)`);

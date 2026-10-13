import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { buildServer } from '../src/api/server.js';
import { TokenStore } from '../src/api/token-store.js';
import type { ServerMessage } from '../src/api/ws.js';
import { loadConfig } from '../src/config.js';
import type { Core } from '../src/core.js';
import { AccountManager } from '../src/steam/account-manager.js';
import { AccountStore } from '../src/store/account-store.js';
import { Vault } from '../src/store/vault.js';
import { FakeClient, fakeClientFactory } from './helpers.js';

let app: FastifyInstance;
let core: Core;
let clients: FakeClient[];
let dataDir: string;

/**
 * Sahte Steam senaryosu: şifreli girişte mobil Guard ister, '12345' kodu doğruysa girişi
 * tamamlar; token ile girişte doğrudan giriş yapar.
 */
function scenario(client: FakeClient) {
  client.onLogOn = (c, details) => {
    setImmediate(() => {
      if ('refreshToken' in (details as object)) return c.emit('loggedOn');
      const onCode = (code: string) =>
        setImmediate(() => {
          if (code !== '12345') return c.emit('steamGuard', null, onCode, true);
          c.emit('refreshToken', 'steam-refresh-token');
          c.emit('loggedOn');
        });
      c.emit('steamGuard', null, onCode, false);
    });
  };
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** Yerel panelden istek (inject varsayılanı: 127.0.0.1, Host: localhost) */
function api(method: Method, url: string, payload?: object) {
  return app.inject({ method, url, payload });
}

/** Başka bir makineden istek; token verilirse Bearer ile */
function remote(method: Method, url: string, token?: string) {
  return app.inject({
    method,
    url,
    remoteAddress: '192.168.1.50',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

async function addAccount() {
  const added = await api('POST', '/api/accounts', { accountName: 'User', password: 'steam-pw' });
  assert.equal(added.statusCode, 201);
  const guarded = await api('POST', '/api/accounts/user/guard', { code: '12345' });
  assert.equal(guarded.json().session.state, 'running');
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'shb-api-'));
  clients = [];
  const store = new AccountStore(dataDir, new Vault('k'));
  const manager = new AccountManager(store, dataDir, fakeClientFactory(clients, scenario));
  core = { config: loadConfig({ SHB_DATA_DIR: dataDir }), store, manager };
  app = await buildServer(core, new TokenStore(dataDir));
});

afterEach(async () => {
  core.manager.stopAll();
  await app.close();
});

describe('Erişim', () => {
  it('yerel panel şifresiz erişir', async () => {
    assert.deepEqual((await api('GET', '/api/auth/me')).json(), { authKind: 'local' });
    assert.equal((await api('GET', '/api/accounts')).statusCode, 200);
  });

  it('başka makineden token olmadan erişilemez, health açıktır', async () => {
    assert.equal((await remote('GET', '/api/accounts')).statusCode, 401);
    assert.equal((await remote('GET', '/api/health')).statusCode, 200);
  });

  it('yerel olmayan Host başlığını reddeder (DNS rebinding)', async () => {
    const res = await app.inject({ url: '/api/accounts', headers: { host: 'evil.example:8090' } });
    assert.equal(res.statusCode, 401);
  });

  it('başka bir sitenin tarayıcı üzerinden isteğini reddeder (Origin)', async () => {
    const res = await app.inject({ url: '/api/accounts', headers: { host: '127.0.0.1:8090', origin: 'https://evil.example' } });
    assert.equal(res.statusCode, 403);
    const same = await app.inject({ url: '/api/accounts', headers: { host: '127.0.0.1:8090', origin: 'http://127.0.0.1:8090' } });
    assert.equal(same.statusCode, 200);
  });

  it('eski (panel şifreli) auth.json dosyasındaki token korunur', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shb-auth-'));
    const token = 'shb_legacy-token';
    const apiToken = {
      id: 'abc',
      name: 'eski',
      hash: createHash('sha256').update(token).digest('hex'),
      preview: 'shb_lega',
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ version: 1, passwordHash: 'x:y', sessions: [], apiTokens: [apiToken] }));

    const store = new TokenStore(dir);
    assert.equal(store.verify(token), true);
    const migrated = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'));
    assert.equal(migrated.version, 2);
    assert.equal(migrated.passwordHash, undefined, 'eski panel şifresi silinmeli');
  });
});

describe('API token', () => {
  it('token ile dışarıdan hesaplara erişilir ama token yönetilemez; iptal edilince geçersiz olur', async () => {
    const created = await api('POST', '/api/tokens', { name: 'yassistant' });
    assert.equal(created.statusCode, 201);
    const { token, info } = created.json();
    assert.ok(token.startsWith('shb_'));

    assert.equal((await remote('GET', '/api/accounts', token)).statusCode, 200);
    assert.equal((await remote('GET', '/api/tokens', token)).statusCode, 403);
    assert.equal((await remote('GET', '/api/accounts', 'shb_bogus')).statusCode, 401);

    const list = (await api('GET', '/api/tokens')).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].hash, undefined, 'hash dışarı sızmamalı');

    await api('DELETE', `/api/tokens/${info.id}`);
    assert.equal((await remote('GET', '/api/accounts', token)).statusCode, 401);
  });
});

describe('Hesaplar', () => {
  it('hesap ekleme: Guard istenir, hatalı kod tekrar sorulur, doğru kodla giriş tamamlanır', async () => {
    const added = await api('POST', '/api/accounts', { accountName: 'User', password: 'steam-pw' });
    assert.equal(added.statusCode, 201);
    assert.equal(added.json().session.state, 'awaiting_guard');
    assert.equal(added.json().refreshToken, undefined, 'token dışarı sızmamalı');

    const wrong = await api('POST', '/api/accounts/user/guard', { code: '00000' });
    assert.equal(wrong.json().session.guard.lastCodeWrong, true);

    const ok = await api('POST', '/api/accounts/user/guard', { code: '12345' });
    assert.equal(ok.json().session.state, 'running');
    assert.equal(ok.json().hasToken, true);
    assert.equal(ok.json().steamId, '76561190000000000');
    assert.ok(ok.json().session.runningSince, 'runningSince dolu olmalı');

    await new Promise((r) => setImmediate(r));
    const account = (await api('GET', '/api/accounts/user')).json();
    assert.equal(account.avatarUrl, 'https://avatars.example/a_medium.jpg');
  });

  it('aynı hesabı iki kez ekleyince 409 döner', async () => {
    await addAccount();
    const again = await api('POST', '/api/accounts', { accountName: 'user', password: 'x' });
    assert.equal(again.statusCode, 409);
  });

  it('oyun, görünürlük ve etkinlik güncellenir; geçersiz istekler 400 döner', async () => {
    await addAccount();
    const patched = await api('PATCH', '/api/accounts/user', { games: [730, 440], persona: 'invisible' });
    assert.equal(patched.statusCode, 200);
    assert.deepEqual(patched.json().games, [730, 440]);
    assert.equal(patched.json().persona, 'invisible');
    assert.deepEqual(clients.at(-1)!.played.at(-1), [730, 440]);
    // Girişte kütüphane okunur, oyun adları hesap çevrimdışıyken de bilinir
    assert.deepEqual(patched.json().gameNames, { 730: 'Counter-Strike 2', 440: 'Team Fortress 2' });

    const tooMany = Array.from({ length: 33 }, (_, i) => i + 1);
    assert.equal((await api('PATCH', '/api/accounts/user', { games: tooMany })).statusCode, 400);
    assert.equal((await api('PATCH', '/api/accounts/user', { persona: 'away' })).statusCode, 400);
    assert.equal((await api('PATCH', '/api/accounts/user', { refreshToken: 'x' })).statusCode, 400);
  });

  it('sahip olunan oyunları oynama süresine göre sıralı döner', async () => {
    await addAccount();
    const games = (await api('GET', '/api/accounts/user/games')).json();
    assert.deepEqual(
      games.map((g: { appId: number }) => g.appId),
      [730, 440],
    );
    assert.equal(
      games[1].iconUrl,
      'https://cdn.akamai.steamstatic.com/steamcommunity/public/images/apps/440/e3f595a92552da3d664ad00277fad2107345f743.jpg',
    );
    assert.equal(games[0].iconUrl, null, 'ikonu olmayan oyun null');
  });

  it('olmayan hesap için 404, silinen hesap listeden kalkar', async () => {
    assert.equal((await api('GET', '/api/accounts/ghost')).statusCode, 404);
    await addAccount();
    assert.equal((await api('DELETE', '/api/accounts/user')).statusCode, 200);
    assert.deepEqual((await api('GET', '/api/accounts')).json(), []);
  });
});

describe('WebSocket', () => {
  /** Gerçek bir bağlantı: yerel adres ve Host/Origin kontrolleri ancak böyle test edilebilir */
  async function connect(headers: Record<string, string> = {}) {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const messages: ServerMessage[] = [];
    let notify = () => {};
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, { headers });
    // Reddedilen bağlantıyı kapatırken istemci hata olayı yayar; test bunu ayrıca kontrol ediyor
    ws.on('error', () => {});
    ws.on('message', (raw) => {
      messages.push(JSON.parse(raw.toString()));
      notify();
    });
    /** İlgili türdeki ilk okunmamış mesajı bekler */
    const next = (type: ServerMessage['type']) =>
      new Promise<ServerMessage>((resolve) => {
        const check = () => {
          const index = messages.findIndex((m) => m.type === type);
          if (index >= 0) resolve(messages.splice(index, 1)[0]!);
        };
        notify = check;
        check();
      });
    return { ws, next, port };
  }

  it('bağlanınca anlık durumu, sonra değişiklikleri gönderir', async () => {
    await addAccount();
    const { ws, next } = await connect();

    const snapshot = await next('snapshot');
    assert.equal(snapshot.type === 'snapshot' && snapshot.accounts.length, 1);

    const update = next('account');
    await api('PATCH', '/api/accounts/user', { games: [570] });
    const message = await update;
    assert.deepEqual(message.type === 'account' && message.account.games, [570]);
    ws.terminate();
  });

  it('başka bir sitenin WebSocket bağlantısını reddeder', async () => {
    const { ws } = await connect({ origin: 'https://evil.example' });
    const status = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => resolve(101));
    });
    assert.equal(status, 403);
    ws.terminate();
  });
});

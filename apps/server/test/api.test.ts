import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { AuthStore } from '../src/api/auth-store.js';
import { buildServer } from '../src/api/server.js';
import type { ServerMessage } from '../src/api/ws.js';
import { loadConfig } from '../src/config.js';
import type { Core } from '../src/core.js';
import { AccountManager } from '../src/steam/account-manager.js';
import { AccountStore } from '../src/store/account-store.js';
import { Vault } from '../src/store/vault.js';
import { FakeClient, fakeClientFactory } from './helpers.js';

const PASSWORD = 'correct-horse';

let app: FastifyInstance;
let core: Core;
let clients: FakeClient[];
let cookie: string;

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

async function login(password = PASSWORD) {
  return app.inject({ method: 'POST', url: '/api/auth/login', payload: { password } });
}

function api(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object, auth = cookie) {
  const headers = auth.startsWith('shb_session=') ? { cookie: auth } : { authorization: `Bearer ${auth}` };
  return app.inject({ method, url, payload, headers });
}

async function addAccount() {
  const added = await api('POST', '/api/accounts', { accountName: 'User', password: 'steam-pw' });
  assert.equal(added.statusCode, 201);
  const guarded = await api('POST', '/api/accounts/user/guard', { code: '12345' });
  assert.equal(guarded.json().session.state, 'running');
}

beforeEach(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'shb-api-'));
  clients = [];
  const store = new AccountStore(dataDir, new Vault('k'));
  const manager = new AccountManager(store, dataDir, fakeClientFactory(clients, scenario));
  core = { config: loadConfig({ SHB_DATA_DIR: dataDir }), store, manager };
  app = await buildServer(core, new AuthStore(dataDir, PASSWORD));
  const res = await login();
  cookie = `shb_session=${res.cookies.find((c) => c.name === 'shb_session')!.value}`;
});

afterEach(async () => {
  core.manager.stopAll();
  await app.close();
});

describe('Kimlik doğrulama', () => {
  it('health herkese açık, diğer uç noktalar giriş ister', async () => {
    assert.equal((await app.inject({ url: '/api/health' })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/accounts' })).statusCode, 401);
    assert.equal((await api('GET', '/api/accounts', undefined, 'shb_session=bogus')).statusCode, 401);
  });

  it('oturum çereziyle erişim verir', async () => {
    const res = await api('GET', '/api/auth/me');
    assert.deepEqual(res.json(), { authKind: 'session' });
  });

  it('hatalı şifreyi reddeder ve 5 denemeden sonra kilitler', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await login('wrong')).statusCode, 401);
    const locked = await login(PASSWORD);
    assert.equal(locked.statusCode, 429);
  });

  it('şifre değişince eski oturumlar kapanır', async () => {
    const changed = await api('POST', '/api/auth/password', { current: PASSWORD, next: 'new-password-1' });
    assert.equal(changed.statusCode, 200);
    assert.equal((await api('GET', '/api/accounts')).statusCode, 401);
    assert.equal((await login('new-password-1')).statusCode, 200);
  });

  it('çıkış yapınca oturum geçersizleşir', async () => {
    await api('POST', '/api/auth/logout');
    assert.equal((await api('GET', '/api/accounts')).statusCode, 401);
  });

  it('ilk açılışta şifre verilmezse rastgele üretir', () => {
    const auth = new AuthStore(mkdtempSync(join(tmpdir(), 'shb-auth-')));
    assert.ok(auth.generatedPassword && auth.generatedPassword.length >= 12);
  });
});

describe('API token', () => {
  it('token ile hesaplara erişilir ama token yönetilemez; iptal edilince geçersiz olur', async () => {
    const created = await api('POST', '/api/tokens', { name: 'yassistant' });
    assert.equal(created.statusCode, 201);
    const { token, info } = created.json();
    assert.ok(token.startsWith('shb_'));

    assert.equal((await api('GET', '/api/accounts', undefined, token)).statusCode, 200);
    assert.equal((await api('GET', '/api/tokens', undefined, token)).statusCode, 403);

    const list = (await api('GET', '/api/tokens')).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].hash, undefined, 'hash dışarı sızmamalı');

    await api('DELETE', `/api/tokens/${info.id}`);
    assert.equal((await api('GET', '/api/accounts', undefined, token)).statusCode, 401);
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
    assert.match(games[1].iconUrl, /\/440\/abc\.jpg$/);
  });

  it('olmayan hesap için 404, silinen hesap listeden kalkar', async () => {
    assert.equal((await api('GET', '/api/accounts/ghost')).statusCode, 404);
    await addAccount();
    assert.equal((await api('DELETE', '/api/accounts/user')).statusCode, 200);
    assert.deepEqual((await api('GET', '/api/accounts')).json(), []);
  });
});

describe('WebSocket', () => {
  it('bağlanınca anlık durumu, sonra değişiklikleri gönderir', async () => {
    await addAccount();
    // Sunucu snapshot'ı bağlantı açılır açılmaz gönderir; dinleyici onInit'te bağlanmalı.
    const messages: ServerMessage[] = [];
    let notify = () => {};
    const ws = await app.injectWS('/api/ws', { headers: { cookie } }, {
      onInit: (socket) =>
        socket.on('message', (raw) => {
          messages.push(JSON.parse(raw.toString()));
          notify();
        }),
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

    const snapshot = await next('snapshot');
    assert.equal(snapshot.type === 'snapshot' && snapshot.accounts.length, 1);

    const update = next('account');
    await api('PATCH', '/api/accounts/user', { games: [570] });
    const message = await update;
    assert.deepEqual(message.type === 'account' && message.account.games, [570]);
    ws.terminate();
  });

  it('kimliksiz bağlantıyı reddeder', async () => {
    await assert.rejects(app.injectWS('/api/ws'));
  });
});

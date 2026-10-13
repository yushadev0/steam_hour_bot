import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import SteamUser from 'steam-user';
import { AccountManager } from '../src/steam/account-manager.js';
import { AccountStore } from '../src/store/account-store.js';
import { Vault } from '../src/store/vault.js';
import { FakeClient, fakeClientFactory } from './helpers.js';

let clients: FakeClient[];
let store: AccountStore;
let manager: AccountManager;
const lastClient = () => clients.at(-1)!;
const stateOf = (id: string) => manager.status(id)!.session.state;

let dataDir: string;

function createManager() {
  return new AccountManager(store, dataDir, fakeClientFactory(clients));
}

function setup() {
  dataDir = mkdtempSync(join(tmpdir(), 'shb-session-'));
  clients = [];
  store = new AccountStore(dataDir, new Vault('k'));
  manager = createManager();
}

/** Token'ı kayıtlı bir hesapla uygulamayı yeniden başlatmayı taklit eder. */
function startWithToken(games = [730]) {
  store.create('user');
  store.update('user', { games });
  store.setToken('user', 'tok');
  manager = createManager();
  manager.startAll();
}

describe('AccountSession', () => {
  beforeEach(() => {
    setup();
    mock.timers.enable({ apis: ['setTimeout'] });
  });
  afterEach(() => {
    manager.stopAll();
    mock.timers.reset();
  });

  it('hesap eklerken Steam Guard istenince döner, kodla giriş tamamlanır ve token kaydedilir', async () => {
    const adding = manager.addAccount('User', 'pw');
    const client = lastClient();
    assert.deepEqual(client.logOnCalls[0], { accountName: 'User', password: 'pw' });

    let submitted: string | undefined;
    client.emit('steamGuard', null, (code: string) => (submitted = code), false);
    const pending = await adding;
    assert.equal(pending.session.state, 'awaiting_guard');
    assert.equal(pending.session.guard?.type, 'mobile');

    const guarded = manager.submitGuardCode('user', ' ABC12 ');
    assert.equal(submitted, 'ABC12');

    client.emit('refreshToken', 'new-token');
    client.emit('loggedOn');
    const status = await guarded;
    assert.equal(status.session.state, 'running');
    assert.equal(status.hasToken, true);
    assert.equal(store.getToken('user'), 'new-token');
    assert.equal(status.steamId, '76561190000000000');
  });

  it('hatalı Guard kodunda tekrar kod ister', async () => {
    const adding = manager.addAccount('User', 'pw');
    const client = lastClient();
    client.emit('steamGuard', 'gmail.com', () => {}, false);
    assert.equal((await adding).session.guard?.type, 'email');

    const retry = manager.submitGuardCode('user', 'WRONG');
    client.emit('steamGuard', 'gmail.com', () => {}, true);
    const status = await retry;
    assert.equal(status.session.state, 'awaiting_guard');
    assert.equal(status.session.guard?.lastCodeWrong, true);
  });

  it('Guard beklenmiyorken kod gönderilirse 409 döner', () => {
    startWithToken();
    lastClient().emit('loggedOn');
    assert.throws(() => manager.submitGuardCode('user', '12345'), { status: 409 });
  });

  it('başarısız eklemede hesabı siler', async () => {
    const adding = manager.addAccount('User', 'wrong');
    lastClient().fail(SteamUser.EResult.InvalidPassword);
    await assert.rejects(adding);
    assert.equal(store.get('user'), undefined);
    assert.equal(manager.list().length, 0);
  });

  it('girişten sonra playingState için bekler, sonra oyunları gösterir', () => {
    startWithToken([730, 440]);
    const client = lastClient();
    assert.deepEqual(client.logOnCalls[0], { refreshToken: 'tok' });
    client.emit('loggedOn');
    assert.equal(client.played.length, 0);
    mock.timers.tick(3000);
    assert.deepEqual(client.played, [[730, 440]]);
    assert.deepEqual(client.personas, [SteamUser.EPersonaState.Online]);
  });

  it('hesap başka yerde oyundayken oyun göndermez, serbest kalınca gösterir', () => {
    startWithToken();
    const client = lastClient();
    client.emit('loggedOn');
    client.emit('playingState', true, 570);
    mock.timers.tick(3000);
    assert.equal(client.played.length, 0);
    assert.equal(stateOf('user'), 'blocked');
    assert.equal(manager.status('user')!.session.blockedByApp, 570);

    client.emit('playingState', false, 0);
    assert.equal(stateOf('user'), 'running');
    assert.deepEqual(client.played, [[730]]);
  });

  it('LoggedInElsewhere sonrası 60 sn bekleyip token ile tekrar bağlanır', () => {
    startWithToken();
    lastClient().emit('loggedOn');
    lastClient().fail(SteamUser.EResult.LoggedInElsewhere);
    assert.equal(stateOf('user'), 'waiting_retry');
    assert.equal(clients.length, 1);

    mock.timers.tick(59_000);
    assert.equal(clients.length, 1);
    mock.timers.tick(1_000);
    assert.equal(clients.length, 2);
    assert.deepEqual(lastClient().logOnCalls[0], { refreshToken: 'tok' });
  });

  it('genel hatalarda artan aralıklarla tekrar dener', () => {
    startWithToken();
    lastClient().fail(SteamUser.EResult.ServiceUnavailable);
    mock.timers.tick(30_000);
    assert.equal(clients.length, 2);
    lastClient().fail(SteamUser.EResult.ServiceUnavailable);
    mock.timers.tick(30_000);
    assert.equal(clients.length, 2, 'ikinci deneme 60 sn sonra olmalı');
    mock.timers.tick(30_000);
    assert.equal(clients.length, 3);
  });

  it('token reddedilirse token silinir ve şifre ile giriş beklenir', () => {
    startWithToken();
    lastClient().fail(SteamUser.EResult.AccessDenied);
    assert.equal(stateOf('user'), 'needs_login');
    assert.equal(store.getToken('user'), null);
    mock.timers.tick(60 * 60_000);
    assert.equal(clients.length, 1, 'tekrar denememeli');
  });

  it('ayar değişikliklerini canlı uygular, devre dışı bırakınca durur', () => {
    startWithToken();
    const client = lastClient();
    client.emit('loggedOn');
    mock.timers.tick(3000);

    manager.updateAccount('user', { games: [570], persona: 'invisible' });
    assert.deepEqual(client.played.at(-1), [570]);
    assert.equal(client.personas.at(-1), SteamUser.EPersonaState.Invisible);

    manager.updateAccount('user', { enabled: false });
    assert.deepEqual(client.played.at(-1), []);
    assert.equal(stateOf('user'), 'stopped');
  });
});

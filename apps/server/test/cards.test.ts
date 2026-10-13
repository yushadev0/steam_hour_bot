import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { logger } from '../src/logger.js';
import { AccountManager } from '../src/steam/account-manager.js';
import { BadgeSessionError, fetchCardDrops, parseBadgesPage, type BadgeGame } from '../src/steam/badges.js';
import { CardFarmer, CHECK_INTERVAL_MS, ERROR_RETRY_MS, NEW_ITEMS_DELAY_MS } from '../src/steam/card-farmer.js';
import type { BotEvent } from '../src/steam/events.js';
import { AccountStore } from '../src/store/account-store.js';
import { Vault } from '../src/store/vault.js';
import { FakeClient, fakeClientFactory } from './helpers.js';

const fixture = readFileSync(new URL('./fixtures/badges-page.html', import.meta.url), 'utf8');

/** Bekleyen promise'lerin (fetch, then zincirleri) tamamlanmasını sağlar */
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

const game = (appId: number, dropsRemaining: number, playtimeHours = 0): BadgeGame => ({
  appId,
  name: `Game ${appId}`,
  dropsRemaining,
  playtimeHours,
});

describe('Rozet sayfası', () => {
  it('oyun rozetlerini, kalan kartları ve oynama süresini okur', () => {
    const { games, pageCount } = parseBadgesPage(fixture);
    assert.equal(pageCount, 2);
    assert.deepEqual(games, [
      { appId: 730, name: 'Counter-Strike 2', dropsRemaining: 3, playtimeHours: 1234.5 },
      { appId: 570, name: 'Dota 2', dropsRemaining: 0, playtimeHours: 135.5 },
      { appId: 1086940, name: "Baldur's Gate 3", dropsRemaining: 1, playtimeHours: 0 },
    ]);
  });

  it('rozet listesi yoksa oturum geçersiz sayar', () => {
    assert.throws(() => parseBadgesPage('<html><body>Sign In</body></html>'), BadgeSessionError);
  });

  it('tüm sayfaları gezer, yalnızca kartı kalanları döner ve çerez gönderir', async () => {
    const requested: { url: string; cookie: string }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      requested.push({ url, cookie: (init.headers as Record<string, string>).cookie });
      const page2 = fixture.replace('gamecards/730/', 'gamecards/440/').replace('Counter-Strike 2', 'Team Fortress 2');
      return new Response(url.endsWith('p=1') ? fixture : page2, { status: 200 });
    }) as unknown as typeof fetch;

    const drops = await fetchCardDrops('7656', ['steamLoginSecure=x'], fakeFetch);
    assert.deepEqual(
      drops.map((g) => g.appId),
      [730, 1086940, 440, 1086940],
    );
    assert.equal(requested.length, 2);
    assert.match(requested[0]!.url, /profiles\/7656\/badges\/\?l=english&p=1$/);
    assert.equal(requested[0]!.cookie, 'steamLoginSecure=x; Steam_Language=english');
  });

  it("giriş sayfasına yönlendirilirse oturum hatası verir", async () => {
    const fakeFetch = (async () => {
      const res = new Response('<html></html>', { status: 200 });
      Object.defineProperty(res, 'url', { value: 'https://steamcommunity.com/login/home/' });
      return res;
    }) as unknown as typeof fetch;
    await assert.rejects(fetchCardDrops('7656', [], fakeFetch), BadgeSessionError);
  });
});

describe('CardFarmer', () => {
  let drops: BadgeGame[] | Error;
  let fetches: number;
  let farmer: CardFarmer;
  let played: number[][];
  let finished: boolean;

  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout'] });
    fetches = 0;
    played = [];
    finished = false;
    farmer = new CardFarmer(async () => {
      fetches++;
      if (drops instanceof Error) throw drops;
      return drops;
    }, logger.scoped('test'));
    farmer.on('games', (games) => played.push(games));
    farmer.on('finished', () => (finished = true));
  });

  afterEach(() => {
    farmer.stop();
    mock.timers.reset();
  });

  it('en az kartı kalan oyunu tek başına kasar, sonra 15 dk aralıkla kontrol eder', async () => {
    drops = [game(730, 3), game(440, 1), game(570, 2)];
    farmer.start();
    await flush();

    const snap = farmer.snapshot();
    assert.equal(snap.status, 'farming');
    assert.equal(snap.current?.appId, 440);
    assert.deepEqual(snap.queue.map((g) => g.appId), [570, 730]);
    assert.equal(snap.totalDrops, 6);
    assert.deepEqual(played, [[440]]);

    mock.timers.tick(CHECK_INTERVAL_MS - 1);
    assert.equal(fetches, 1);
    mock.timers.tick(1);
    await flush();
    assert.equal(fetches, 2);
  });

  it('kasılan oyunun kartı varken oyun değiştirmez, bitince sıradakine geçer', async () => {
    drops = [game(440, 2), game(730, 2)];
    farmer.start();
    await flush();
    assert.equal(farmer.snapshot().current?.appId, 440);

    // 730 artık daha az kartlı olsa da 440'ın kartı bitmeden değişmez
    drops = [game(440, 1), game(730, 1)];
    farmer.checkNow();
    await flush();
    assert.equal(farmer.snapshot().current?.appId, 440);
    assert.deepEqual(played, [[440]]);

    drops = [game(730, 1)];
    farmer.checkNow();
    await flush();
    assert.equal(farmer.snapshot().current?.appId, 730);
    assert.deepEqual(played, [[440], [730]]);
  });

  it('kart kalmayınca bitirir ve oyunu bırakır', async () => {
    drops = [game(440, 1)];
    farmer.start();
    await flush();
    drops = [];
    farmer.checkNow();
    await flush();
    assert.equal(farmer.snapshot().status, 'done');
    assert.deepEqual(played.at(-1), []);
    assert.equal(finished, true);
  });

  it('kontrol başarısız olursa 5 dk sonra tekrar dener, kasılan oyuna devam eder', async () => {
    drops = [game(440, 2)];
    farmer.start();
    await flush();

    drops = new Error('ağ hatası');
    farmer.checkNow();
    await flush();
    const snap = farmer.snapshot();
    assert.equal(snap.status, 'farming');
    assert.match(snap.error!, /ağ hatası/);

    drops = [game(440, 1)];
    mock.timers.tick(ERROR_RETRY_MS);
    await flush();
    assert.equal(farmer.snapshot().error, null);
  });

  it('Steam yeni eşya bildirince kısa süre sonra kontrol eder', async () => {
    drops = [game(440, 2)];
    farmer.start();
    await flush();
    farmer.onNewItems();
    mock.timers.tick(NEW_ITEMS_DELAY_MS);
    await flush();
    assert.equal(fetches, 2);
  });
});

describe('Kart modu (oturumla)', () => {
  let clients: FakeClient[];
  let store: AccountStore;
  let manager: AccountManager;
  let drops: BadgeGame[];
  let cookiesSeen: string[][];

  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const dataDir = mkdtempSync(join(tmpdir(), 'shb-cards-'));
    clients = [];
    cookiesSeen = [];
    drops = [game(440, 2), game(730, 1)];
    store = new AccountStore(dataDir, new Vault('k'));
    store.create('user');
    store.update('user', { games: [570], mode: 'cards' });
    store.setToken('user', 'tok');
    manager = new AccountManager(store, dataDir, fakeClientFactory(clients), async (_id, cookies) => {
      cookiesSeen.push(cookies);
      return drops;
    });
    manager.startAll();
  });

  afterEach(() => {
    manager.stopAll();
    mock.timers.reset();
  });

  it('web oturumu açar, kart kalan oyunu kasar; bitince oyun listesine döner', async () => {
    const client = clients[0]!;
    client.emit('loggedOn');
    await flush();
    assert.deepEqual(cookiesSeen, [['steamLoginSecure=fake']]);

    // Giriş sonrası 3 sn beklemeden oyun gönderilmez
    assert.equal(client.played.length, 0);
    mock.timers.tick(3000);
    assert.deepEqual(client.played.at(-1), [730]);

    const status = manager.status('user')!;
    assert.equal(status.session.cards?.current?.appId, 730);
    assert.equal(status.session.cards?.totalDrops, 3);

    drops = [];
    manager.checkCards('user');
    await flush();
    assert.equal(store.require('user').mode, 'games');
    assert.deepEqual(client.played.at(-1), [570]);
    assert.equal(manager.status('user')!.session.cards, null);
  });

  it('oyun moduna geçince kart kasmayı bırakır', async () => {
    const client = clients[0]!;
    client.emit('loggedOn');
    await flush();
    mock.timers.tick(3000);
    manager.updateAccount('user', { mode: 'games' });
    assert.deepEqual(client.played.at(-1), [570]);
    assert.equal(manager.status('user')!.session.cards, null);
    assert.throws(() => manager.checkCards('user'), { status: 409 });
  });

  it('hesap başka yerde oyundayken kart oyunu da gönderilmez', async () => {
    const client = clients[0]!;
    client.emit('loggedOn');
    client.emit('playingState', true, 570);
    await flush();
    mock.timers.tick(3000);
    assert.equal(client.played.length, 0);
    client.emit('playingState', false, 0);
    assert.deepEqual(client.played.at(-1), [730]);
  });
});


describe('Kart olayları', () => {
  it('kart düşünce card_dropped, kartlar bitince cards_finished yayınlar', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const dataDir = mkdtempSync(join(tmpdir(), 'shb-card-events-'));
    const clients: FakeClient[] = [];
    let drops: BadgeGame[] = [game(440, 2), game(730, 3)];
    const store = new AccountStore(dataDir, new Vault('k'));
    store.create('user');
    store.update('user', { mode: 'cards' });
    store.setToken('user', 'tok');
    const manager = new AccountManager(store, dataDir, fakeClientFactory(clients), async () => drops);
    const events: BotEvent[] = [];
    manager.on('event', (e) => events.push(e));
    manager.startAll();
    try {
      clients[0]!.emit('loggedOn');
      await flush();

      drops = [game(440, 1), game(730, 3)];
      manager.checkCards('user');
      await flush();
      const dropped = events.find((e) => e.type === 'card_dropped');
      assert.ok(dropped && dropped.type === 'card_dropped');
      assert.equal(dropped.appId, 440);
      assert.equal(dropped.dropped, 1);
      assert.equal(dropped.remaining, 1);
      assert.equal(dropped.totalRemaining, 4);

      drops = [];
      manager.checkCards('user');
      await flush();
      assert.deepEqual(
        events.map((e) => e.type),
        ['card_dropped', 'card_dropped', 'cards_finished'],
      );
    } finally {
      manager.stopAll();
      mock.timers.reset();
    }
  });
});

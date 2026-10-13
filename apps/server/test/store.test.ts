import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AccountStore, normalizeGames } from '../src/store/account-store.js';
import { resolveSecret, Vault } from '../src/store/vault.js';
import { iconUrlOf } from '../src/steam/account-session.js';

const tempDir = () => mkdtempSync(join(tmpdir(), 'shb-test-'));

describe('Vault', () => {
  it('şifreler ve geri çözer', () => {
    const vault = new Vault('secret');
    const blob = vault.encrypt('my-refresh-token');
    assert.notEqual(blob, 'my-refresh-token');
    assert.equal(vault.decrypt(blob), 'my-refresh-token');
  });

  it('yanlış anahtarla çözemez', () => {
    const blob = new Vault('a').encrypt('token');
    assert.throws(() => new Vault('b').decrypt(blob));
  });

  it('anahtar dosyasını bir kez üretip sonra tekrar kullanır', () => {
    const dir = tempDir();
    const first = resolveSecret(dir, undefined);
    const second = resolveSecret(dir, undefined);
    assert.equal(first.generated, true);
    assert.equal(second.generated, false);
    assert.equal(first.secret, second.secret);
    assert.equal(resolveSecret(dir, 'from-env').secret, 'from-env');
  });
});

describe('normalizeGames', () => {
  it('tekrarları kaldırır ve sayıya çevirir', () => {
    assert.deepEqual(normalizeGames([730, '440', 730]), [730, 440]);
  });

  it('geçersiz AppID reddeder', () => {
    assert.throws(() => normalizeGames([730, -1]), /Geçersiz AppID/);
    assert.throws(() => normalizeGames(['abc']), /Geçersiz AppID/);
  });

  it('32 oyundan fazlasını reddeder', () => {
    const games = Array.from({ length: 33 }, (_, i) => i + 1);
    assert.throws(() => normalizeGames(games), /en fazla 32/);
    assert.equal(normalizeGames(games.slice(0, 32)).length, 32);
  });
});

describe('AccountStore', () => {
  it('hesapları kalıcı saklar, token diske şifreli yazılır', () => {
    const dir = tempDir();
    const store = new AccountStore(dir, new Vault('k'));
    store.create('MyUser');
    store.update('myuser', { games: [730], persona: 'invisible' });
    store.setToken('myuser', 'super-secret-token');

    const onDisk = readFileSync(join(dir, 'accounts.json'), 'utf8');
    assert.ok(!onDisk.includes('super-secret-token'));

    const reloaded = new AccountStore(dir, new Vault('k'));
    const account = reloaded.require('MYUSER');
    assert.equal(account.accountName, 'MyUser');
    assert.deepEqual(account.games, [730]);
    assert.equal(account.persona, 'invisible');
    assert.equal(reloaded.getToken('myuser'), 'super-secret-token');
  });

  it('anahtar değişirse token null döner', () => {
    const dir = tempDir();
    const store = new AccountStore(dir, new Vault('k1'));
    store.create('u');
    store.setToken('u', 'tok');
    assert.equal(new AccountStore(dir, new Vault('k2')).getToken('u'), null);
  });

  it('aynı hesabı iki kez eklemez', () => {
    const store = new AccountStore(tempDir(), new Vault('k'));
    store.create('u');
    assert.throws(() => store.create('U'), /zaten var/);
  });
});

describe('iconUrlOf', () => {
  const hash = '8dbc71957312bbd3baea65848b545be9eae2a355';
  const expected = `https://cdn.akamai.steamstatic.com/steamcommunity/public/images/apps/730/${hash}.jpg`;

  it("steam-user'ın eski alan adlı adresini güncel CDN'e taşır", () => {
    assert.equal(iconUrlOf(730, `https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/730/${hash}.jpg`), expected);
  });

  it('yalnızca hash gelirse adresi kurar', () => {
    assert.equal(iconUrlOf(730, hash), expected);
  });

  it('boş ya da tanınmayan değerde null döner', () => {
    assert.equal(iconUrlOf(730, ''), null);
    assert.equal(iconUrlOf(730, null), null);
    assert.equal(iconUrlOf(730, 'garbage'), null);
  });
});

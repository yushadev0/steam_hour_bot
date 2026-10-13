import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import SteamUser from 'steam-user';
import { badRequest, conflict } from '../errors.js';
import { logger, type ScopedLogger } from '../logger.js';
import type { AppNameCache } from '../store/app-names.js';
import type { AccountRecord, AccountStore } from '../store/account-store.js';

const { EResult, EPersonaState } = SteamUser;

export type SessionState =
  /** Çalışmıyor (kapalı ya da devre dışı) */
  | 'stopped'
  /** Steam'e bağlanıyor / yeniden bağlanıyor */
  | 'connecting'
  /** Steam Guard kodu bekleniyor */
  | 'awaiting_guard'
  /** Oyunlar oynanıyor gösteriliyor */
  | 'running'
  /** Hesapta başka bir yerde oyun açık; bot bekliyor */
  | 'blocked'
  /** Hata sonrası tekrar deneme bekleniyor */
  | 'waiting_retry'
  /** Token yok / geçersiz; şifre ile yeniden giriş gerekli */
  | 'needs_login';

export interface GuardRequest {
  /** 'email': e-postaya kod gönderildi. 'mobile': mobil uygulamadan kod veya onay. */
  type: 'email' | 'mobile';
  domain: string | null;
  lastCodeWrong: boolean;
}

export interface SessionSnapshot {
  state: SessionState;
  guard: GuardRequest | null;
  lastError: string | null;
  /** waiting_retry durumunda bir sonraki denemenin zamanı */
  retryAt: string | null;
  /** blocked durumunda başka yerde açık olan oyun */
  blockedByApp: number | null;
  /** running durumundaysa ne zamandan beri kesintisiz kasılıyor */
  runningSince: string | null;
}

export interface OwnedGame {
  appId: number;
  name: string;
  /** Dakika cinsinden toplam oynama süresi */
  playtimeMinutes: number;
  iconUrl: string | null;
}

export type ClientFactory = (options: ConstructorParameters<typeof SteamUser>[0]) => SteamUser;

export interface SessionDeps {
  /** steam-user'ın kendi önbellek klasörü */
  steamDataDir: string;
  appNames: AppNameCache;
  /** Testlerde sahte istemci vermek için */
  createClient?: ClientFactory;
}

type SessionEvents = {
  change: [SessionSnapshot];
  /** Şifreyle giriş denemesinin sonucu (addAccount / relogin bekler) */
  loginResult: [error: Error | null];
};

/** Bu hatalar token/şifrenin geçersiz olduğunu gösterir; tekrar denemek anlamsız. */
const AUTH_ERRORS = new Set<number>([
  EResult.InvalidPassword,
  EResult.AccessDenied,
  EResult.Expired,
  EResult.Revoked,
  EResult.InvalidSignature,
  EResult.InvalidLoginAuthCode,
  EResult.TwoFactorCodeMismatch,
  EResult.AccountLoginDeniedNeedTwoFactor,
]);

const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 15 * 60_000;
/** Başka yerden oyuna girilince Steam bot'u atar; bu süre sonra tekrar bağlanılır. */
const ELSEWHERE_RETRY_MS = 60_000;
const RATE_LIMIT_RETRY_MS = 30 * 60_000;
/** Girişten sonra playingState bilgisinin gelmesi için beklenen süre. */
const PLAYING_STATE_GRACE_MS = 3_000;
const OWNED_GAMES_CACHE_MS = 10 * 60_000;

/**
 * Tek bir Steam hesabının oturumu. steam-user istemcisini sarar; giriş, Steam Guard,
 * oyun gösterme, görünürlük ve hata sonrası yeniden bağlanmayı yönetir.
 */
export class AccountSession extends EventEmitter<SessionEvents> {
  private client: SteamUser | null = null;
  private log: ScopedLogger;

  private state: SessionState = 'stopped';
  private guard: GuardRequest | null = null;
  private guardCallback: ((code: string) => void) | null = null;
  private lastError: string | null = null;
  private retryAt: Date | null = null;
  private blockedByApp: number | null = null;
  private runningSince: Date | null = null;

  private loggedOn = false;
  private blocked = false;
  private passwordLogin = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private applyTimer: NodeJS.Timeout | null = null;
  private retryDelay = RETRY_BASE_MS;
  private ownedGamesCache: { at: number; games: OwnedGame[] } | null = null;

  constructor(
    readonly accountId: string,
    private readonly store: AccountStore,
    private readonly deps: SessionDeps,
  ) {
    super();
    this.log = logger.scoped(accountId);
  }

  private get account(): AccountRecord {
    return this.store.require(this.accountId);
  }

  snapshot(): SessionSnapshot {
    return {
      state: this.state,
      guard: this.guard,
      lastError: this.lastError,
      retryAt: this.retryAt?.toISOString() ?? null,
      blockedByApp: this.blockedByApp,
      runningSince: this.runningSince?.toISOString() ?? null,
    };
  }

  private setState(state: SessionState, patch: Partial<Pick<SessionSnapshot, 'lastError' | 'guard'>> = {}) {
    if (state !== 'running') this.runningSince = null;
    else if (this.state !== 'running') this.runningSince = new Date();
    this.state = state;
    if (state !== 'awaiting_guard') {
      this.guard = null;
      this.guardCallback = null;
    }
    if (state !== 'waiting_retry') this.retryAt = null;
    if (state !== 'blocked') this.blockedByApp = null;
    if ('lastError' in patch) this.lastError = patch.lastError ?? null;
    if ('guard' in patch) this.guard = patch.guard ?? null;
    this.emit('change', this.snapshot());
  }

  /** Kayıtlı token ile oturumu başlatır. Token yoksa 'needs_login' durumuna geçer. */
  start() {
    if (this.client) return;
    const token = this.store.getToken(this.accountId);
    if (!token) {
      this.log.warn('Kayıtlı token yok, şifre ile giriş gerekli.');
      this.setState('needs_login');
      return;
    }
    this.connect({ refreshToken: token });
  }

  /** Şifre ile giriş (yeni hesap ya da token geçersizleştiğinde). Steam Guard gerekebilir. */
  loginWithPassword(password: string): Promise<void> {
    this.teardown();
    this.passwordLogin = true;
    const result = new Promise<void>((resolve, reject) => {
      this.once('loginResult', (err) => (err ? reject(err) : resolve()));
    });
    this.connect({ accountName: this.account.accountName, password });
    return result;
  }

  submitGuardCode(code: string) {
    if (!this.guardCallback) throw conflict('Şu an Steam Guard kodu beklenmiyor');
    const callback = this.guardCallback;
    this.guardCallback = null;
    this.log.info('Steam Guard kodu gönderildi.');
    this.setState('connecting');
    callback(code.trim());
  }

  /** Hesap ayarları (oyunlar, görünürlük) değiştiğinde çağrılır. */
  refresh() {
    if (!this.loggedOn) return;
    this.applyPersona();
    this.applyGames();
  }

  /** Hesabın sahip olduğu oyunlar (oynama süresiyle). Oturum açık olmalı; 10 dk önbelleklenir. */
  async getOwnedGames(force = false): Promise<OwnedGame[]> {
    if (!force && this.ownedGamesCache && Date.now() - this.ownedGamesCache.at < OWNED_GAMES_CACHE_MS) {
      return this.ownedGamesCache.games;
    }
    if (!this.client || !this.loggedOn || !this.client.steamID) throw conflict("Hesap şu an Steam'e bağlı değil");
    const { apps } = await this.client.getUserOwnedApps(this.client.steamID, { includePlayedFreeGames: true });
    const games = apps
      .map((app) => ({
        appId: app.appid,
        name: app.name,
        playtimeMinutes: app.playtime_forever,
        iconUrl: app.img_icon_url
          ? `https://media.steampowered.com/steamcommunity/public/images/apps/${app.appid}/${app.img_icon_url}.jpg`
          : null,
      }))
      .sort((a, b) => b.playtimeMinutes - a.playtimeMinutes);
    this.ownedGamesCache = { at: Date.now(), games };
    this.deps.appNames.merge(games);
    return games;
  }

  stop() {
    if (this.client && this.loggedOn) {
      this.client.gamesPlayed([]);
      this.log.info('Oturum kapatılıyor.');
    }
    this.teardown();
    this.setState('stopped');
  }

  private connect(details: { refreshToken: string } | { accountName: string; password: string }) {
    this.teardown();
    this.setState('connecting');
    this.log.info('refreshToken' in details ? 'Token ile giriş yapılıyor...' : 'Şifre ile giriş yapılıyor...');

    const options = { autoRelogin: true, renewRefreshTokens: true, dataDirectory: this.deps.steamDataDir };
    const client = this.deps.createClient ? this.deps.createClient(options) : new SteamUser(options);
    this.client = client;
    this.bindEvents(client);
    client.logOn(details);
  }

  private bindEvents(client: SteamUser) {
    client.on('loggedOn', () => {
      this.loggedOn = true;
      this.retryDelay = RETRY_BASE_MS;
      const steamId = client.steamID?.getSteamID64() ?? null;
      this.log.info(`Giriş başarılı (SteamID ${steamId}).`);
      this.store.update(this.accountId, { steamId });
      this.setState('running', { lastError: null });
      this.finishPasswordLogin(null);

      this.applyPersona();
      this.fetchAvatar(client);
      // Steam, hesabın başka yerde oyunda olup olmadığını girişten hemen sonra bildirir.
      // O bilgi gelmeden oyun gösterirsek kullanıcının gerçek oturumunu etkileyebiliriz.
      this.applyTimer = setTimeout(() => this.applyGames(), PLAYING_STATE_GRACE_MS);
      // Oyun adlarını önceden öğren (panel ve loglar için)
      this.getOwnedGames()
        .then(() => this.emit('change', this.snapshot()))
        .catch((err: Error) => this.log.debug(`Kütüphane alınamadı: ${err.message}`));
    });

    client.on('accountInfo', (name) => {
      if (name !== this.account.personaName) this.store.update(this.accountId, { personaName: name });
    });

    client.on('steamGuard', (domain, callback, lastCodeWrong) => {
      const guard: GuardRequest = { type: domain ? 'email' : 'mobile', domain, lastCodeWrong };
      this.guardCallback = callback;
      this.log.warn(
        lastCodeWrong
          ? 'Steam Guard kodu hatalı, yeni kod bekleniyor.'
          : guard.type === 'email'
            ? `Steam Guard kodu ${domain} adresine gönderildi.`
            : 'Steam Guard: mobil uygulamadaki kodu gir ya da girişi uygulamadan onayla.',
      );
      this.setState('awaiting_guard', { guard });
    });

    client.on('refreshToken', (token) => {
      this.store.setToken(this.accountId, token);
      this.log.info('Refresh token kaydedildi.');
    });

    client.on('playingState', (blocked, playingApp) => {
      if (blocked === this.blocked) return;
      this.blocked = blocked;
      if (blocked) {
        this.log.info(`Hesapla başka bir yerde oynanıyor (${this.deps.appNames.label(playingApp)}), bekleniyor.`);
        this.setState('blocked');
        this.blockedByApp = playingApp || null;
        this.emit('change', this.snapshot());
      } else {
        this.log.info('Hesap serbest kaldı, oyunlar tekrar gösteriliyor.');
        this.setState('running');
        this.applyGames();
      }
    });

    client.on('disconnected', (eresult, msg) => {
      this.loggedOn = false;
      // Yeniden girişte Steam güncel playingState'i tekrar bildirir.
      this.blocked = false;
      if (this.state === 'stopped') return;
      // autoRelogin açık: steam-user kendisi yeniden bağlanır.
      this.log.warn(`Bağlantı koptu (${msg ?? EResult[eresult]}), yeniden bağlanılıyor.`);
      this.setState('connecting');
    });

    client.on('error', (err) => this.handleError(err as Error & { eresult?: number }));
  }

  private handleError(err: Error & { eresult?: number }) {
    const eresult = err.eresult ?? EResult.Fail;
    // steam-user çoğu hatada mesaj olarak EResult adını verir; tekrar etmesin
    const code = EResult[eresult] ?? String(eresult);
    const reason = err.message === code ? code : `${err.message} (${code})`;
    this.teardown();

    if (AUTH_ERRORS.has(eresult)) {
      this.log.error(`Giriş reddedildi: ${reason}`);
      // Şifre ile yapılan denemede kayıtlı token'a dokunma; token girişi reddedildiyse token geçersizdir.
      if (!this.passwordLogin) this.store.setToken(this.accountId, null);
      this.setState('needs_login', { lastError: reason });
      this.finishPasswordLogin(badRequest(`Steam girişi reddedildi: ${reason}`));
      return;
    }

    // Şifre ile girişte (ör. hesap eklerken) tekrar deneme yapılmaz, sonuç çağırana döner.
    if (this.passwordLogin) {
      this.log.error(`Giriş başarısız: ${reason}`);
      this.setState('needs_login', { lastError: reason });
      this.finishPasswordLogin(badRequest(`Steam girişi başarısız: ${reason}`));
      return;
    }

    let delay: number;
    if (eresult === EResult.LoggedInElsewhere || eresult === EResult.LogonSessionReplaced) {
      this.log.info('Hesaba başka bir yerden oyunla girildi; bot geri çekildi.');
      delay = ELSEWHERE_RETRY_MS;
    } else if (eresult === EResult.RateLimitExceeded) {
      this.log.warn('Steam istek sınırına takıldı.');
      delay = RATE_LIMIT_RETRY_MS;
    } else {
      this.log.error(`Hata: ${reason}`);
      delay = this.retryDelay;
      this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS);
    }
    this.scheduleRetry(delay, reason);
  }

  private scheduleRetry(delay: number, reason: string) {
    this.retryAt = new Date(Date.now() + delay);
    this.runningSince = null;
    this.lastError = reason;
    this.state = 'waiting_retry';
    this.emit('change', this.snapshot());
    this.log.info(`${Math.round(delay / 1000)} sn sonra tekrar denenecek.`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.start();
    }, delay);
  }

  private finishPasswordLogin(err: Error | null) {
    if (!this.passwordLogin) return;
    this.passwordLogin = false;
    this.emit('loginResult', err);
  }

  private fetchAvatar(client: SteamUser) {
    if (!client.steamID) return;
    const steamId = client.steamID.getSteamID64();
    client
      .getPersonas([client.steamID])
      .then(({ personas }) => {
        const avatarUrl: string | undefined = personas[steamId]?.avatar_url_medium;
        if (avatarUrl && avatarUrl !== this.account.avatarUrl) {
          this.store.update(this.accountId, { avatarUrl });
          this.emit('change', this.snapshot());
        }
      })
      .catch((err: Error) => this.log.debug(`Avatar alınamadı: ${err.message}`));
  }

  private applyPersona() {
    if (!this.client || !this.loggedOn) return;
    const invisible = this.account.persona === 'invisible';
    this.client.setPersona(invisible ? EPersonaState.Invisible : EPersonaState.Online);
  }

  private applyGames() {
    if (this.applyTimer) clearTimeout(this.applyTimer);
    this.applyTimer = null;
    // Hesap başka yerde oyundayken gamesPlayed göndermek o oturumu etkileyebilir.
    if (!this.client || !this.loggedOn || this.blocked) return;

    const { games, enabled } = this.account;
    const toPlay = enabled ? games : [];
    this.client.gamesPlayed(toPlay);
    this.log.info(
      toPlay.length
        ? `Oynuyor gösteriliyor: ${toPlay.map((id) => this.deps.appNames.label(id)).join(', ')}`
        : 'Oyun listesi boş, hiçbir oyun gösterilmiyor.',
    );
  }

  /** İstemciyi ve zamanlayıcıları temizler (durum değiştirmez). */
  private teardown() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.applyTimer) clearTimeout(this.applyTimer);
    this.retryTimer = this.applyTimer = null;
    if (this.client) {
      const client = this.client;
      this.client = null;
      client.removeAllListeners();
      // Kopmuş istemcinin geç gelen hatası süreci çökertmesin.
      client.on('error', () => {});
      if (this.loggedOn) client.logOff();
    }
    this.loggedOn = false;
    this.blocked = false;
  }
}

export function steamDataDirOf(dataDir: string) {
  return join(dataDir, 'steam-user');
}

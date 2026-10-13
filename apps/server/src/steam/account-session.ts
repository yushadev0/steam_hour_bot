import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import SteamUser from 'steam-user';
import { badRequest, conflict } from '../errors.js';
import { t } from '../i18n.js';
import { logger, type ScopedLogger } from '../logger.js';
import type { AppNameCache } from '../store/app-names.js';
import type { AccountRecord, AccountStore } from '../store/account-store.js';
import { BadgeSessionError, fetchCardDrops, type BadgeGame } from './badges.js';
import { CardFarmer, type CardFarmSnapshot } from './card-farmer.js';
import { CONNECTION_PROBLEM_AFTER_MS, type AccountEvent } from './events.js';

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
  /** Kart düşürme modu çalışıyorsa durumu */
  cards: CardFarmSnapshot | null;
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
  /** Testlerde rozet sayfası yerine sahte veri vermek için */
  fetchCardDrops?: (steamId: string, cookies: string[]) => Promise<BadgeGame[]>;
}

type SessionEvents = {
  change: [SessionSnapshot];
  /** Şifreyle giriş denemesinin sonucu (addAccount / relogin bekler) */
  loginResult: [error: Error | null];
  /** Bildirilmeye değer olay (push bildirimleri) */
  event: [AccountEvent];
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
const WEB_SESSION_TIMEOUT_MS = 30_000;

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

  private farmer: CardFarmer | null = null;
  /** steamcommunity.com çerezleri (rozet sayfasını okumak için) */
  private webCookies: string[] | null = null;
  /** Bağlantı sorunu ne zamandan beri sürüyor; uzarsa connection_problem yayınlanır */
  private troubleSince: Date | null = null;
  private troubleTimer: NodeJS.Timeout | null = null;
  private troubleReported = false;
  private webSessionWaiters: { resolve: (cookies: string[]) => void; reject: (err: Error) => void }[] = [];

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
      cards: this.farmer?.snapshot() ?? null,
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
    this.trackConnection(state);
    this.emit('change', this.snapshot());
  }

  /**
   * Hesap uzun süre bağlanamazsa (Steam bakımı, ağ sorunu) bir kez connection_problem,
   * sonra bağlantı kurulunca connection_restored yayınlar.
   */
  private trackConnection(state: SessionState) {
    if (state === 'connecting' || state === 'waiting_retry') {
      if (this.troubleSince) return;
      this.troubleSince = new Date();
      this.troubleTimer = setTimeout(() => {
        this.troubleTimer = null;
        this.troubleReported = true;
        this.log.warn(t("Uzun süredir Steam'e bağlanılamıyor.", 'Unable to reach Steam for a long time.'));
        this.emit('event', { type: 'connection_problem', reason: this.lastError, since: this.troubleSince!.toISOString() });
      }, CONNECTION_PROBLEM_AFTER_MS);
      return;
    }
    if (state === 'running' && this.troubleReported) this.emit('event', { type: 'connection_restored' });
    this.clearTrouble();
  }

  private clearTrouble() {
    if (this.troubleTimer) clearTimeout(this.troubleTimer);
    this.troubleTimer = null;
    this.troubleSince = null;
    this.troubleReported = false;
  }

  /** Kayıtlı token ile oturumu başlatır. Token yoksa 'needs_login' durumuna geçer. */
  start() {
    if (this.client) return;
    const token = this.store.getToken(this.accountId);
    if (!token) {
      this.log.warn(t('Kayıtlı token yok, şifre ile giriş gerekli.', 'No stored login; sign in with the password.'));
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
    if (!this.guardCallback) throw conflict(t('Şu an Steam Guard kodu beklenmiyor', 'No Steam Guard code is expected right now'));
    const callback = this.guardCallback;
    this.guardCallback = null;
    this.log.info(t('Steam Guard kodu gönderildi.', 'Steam Guard code sent.'));
    this.setState('connecting');
    callback(code.trim());
  }

  /** Hesap ayarları (oyunlar, görünürlük, mod) değiştiğinde çağrılır. */
  refresh() {
    if (!this.loggedOn) return;
    this.applyPersona();
    this.syncFarmer();
    this.applyGames();
  }

  /** Kart durumunu hemen kontrol et (panelden) */
  checkCards() {
    if (!this.farmer) throw conflict(t('Kart düşürme modu şu an çalışmıyor', 'Card farming is not running'));
    this.farmer.checkNow();
  }

  /** Hesabın sahip olduğu oyunlar (oynama süresiyle). Oturum açık olmalı; 10 dk önbelleklenir. */
  async getOwnedGames(force = false): Promise<OwnedGame[]> {
    if (!force && this.ownedGamesCache && Date.now() - this.ownedGamesCache.at < OWNED_GAMES_CACHE_MS) {
      return this.ownedGamesCache.games;
    }
    if (!this.client || !this.loggedOn || !this.client.steamID) throw conflict(t("Hesap şu an Steam'e bağlı değil", 'The account is not connected to Steam'));
    const { apps } = await this.client.getUserOwnedApps(this.client.steamID, { includePlayedFreeGames: true });
    const games = apps
      .map((app) => ({
        appId: app.appid,
        name: app.name,
        playtimeMinutes: app.playtime_forever,
        iconUrl: iconUrlOf(app.appid, app.img_icon_url),
      }))
      .sort((a, b) => b.playtimeMinutes - a.playtimeMinutes);
    this.ownedGamesCache = { at: Date.now(), games };
    this.deps.appNames.merge(games);
    return games;
  }

  stop() {
    if (this.client && this.loggedOn) {
      this.client.gamesPlayed([]);
      this.log.info(t('Oturum kapatılıyor.', 'Signing out.'));
    }
    this.teardown();
    this.setState('stopped');
  }

  private connect(details: { refreshToken: string } | { accountName: string; password: string }) {
    this.teardown();
    this.setState('connecting');
    this.log.info(
      'refreshToken' in details
        ? t('Token ile giriş yapılıyor...', 'Signing in with the stored login...')
        : t('Şifre ile giriş yapılıyor...', 'Signing in with the password...'),
    );

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
      this.log.info(t(`Giriş başarılı (SteamID ${steamId}).`, `Signed in (SteamID ${steamId}).`));
      this.store.update(this.accountId, { steamId });
      this.setState('running', { lastError: null });
      this.finishPasswordLogin(null);

      this.applyPersona();
      this.fetchAvatar(client);
      this.syncFarmer();
      // Steam, hesabın başka yerde oyunda olup olmadığını girişten hemen sonra bildirir.
      // O bilgi gelmeden oyun gösterirsek kullanıcının gerçek oturumunu etkileyebiliriz.
      this.applyTimer = setTimeout(() => this.applyGames(), PLAYING_STATE_GRACE_MS);
      // Oyun adlarını önceden öğren (panel ve loglar için)
      this.getOwnedGames()
        .then(() => this.emit('change', this.snapshot()))
        .catch((err: Error) => this.log.debug(t(`Kütüphane alınamadı: ${err.message}`, `Could not load the library: ${err.message}`)));
    });

    client.on('accountInfo', (name) => {
      if (name !== this.account.personaName) this.store.update(this.accountId, { personaName: name });
    });

    client.on('steamGuard', (domain, callback, lastCodeWrong) => {
      const guard: GuardRequest = { type: domain ? 'email' : 'mobile', domain, lastCodeWrong };
      this.guardCallback = callback;
      this.log.warn(
        lastCodeWrong
          ? t('Steam Guard kodu hatalı, yeni kod bekleniyor.', 'Wrong Steam Guard code; waiting for a new one.')
          : guard.type === 'email'
            ? t(`Steam Guard kodu ${domain} adresine gönderildi.`, `Steam Guard code sent to ${domain}.`)
            : t(
                'Steam Guard: mobil uygulamadaki kodu gir ya da girişi uygulamadan onayla.',
                'Steam Guard: enter the code from the mobile app or approve the sign-in there.',
              ),
      );
      this.setState('awaiting_guard', { guard });
    });

    client.on('refreshToken', (token) => {
      this.store.setToken(this.accountId, token);
      this.log.info(t('Refresh token kaydedildi.', 'Login token saved.'));
    });

    client.on('playingState', (blocked, playingApp) => {
      if (blocked === this.blocked) return;
      this.blocked = blocked;
      if (blocked) {
        this.log.info(
          t(
            `Hesapla başka bir yerde oynanıyor (${this.deps.appNames.label(playingApp)}), bekleniyor.`,
            `The account is playing elsewhere (${this.deps.appNames.label(playingApp)}); waiting.`,
          ),
        );
        this.setState('blocked');
        this.emit('event', {
          type: 'playing_elsewhere',
          appId: playingApp || null,
          game: playingApp ? (this.deps.appNames.get(playingApp) ?? null) : null,
        });
        this.blockedByApp = playingApp || null;
        this.emit('change', this.snapshot());
      } else {
        this.log.info(t('Hesap serbest kaldı, oyunlar tekrar gösteriliyor.', 'The account is free again; idling resumes.'));
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
      const why = msg ?? EResult[eresult];
      this.log.warn(t(`Bağlantı koptu (${why}), yeniden bağlanılıyor.`, `Disconnected (${why}); reconnecting.`));
      this.setState('connecting');
    });

    client.on('webSession', (_sessionId, cookies) => {
      this.webCookies = cookies;
      for (const waiter of this.webSessionWaiters.splice(0)) waiter.resolve(cookies);
    });

    // Steam yeni eşya bildirdi: kart düşmüş olabilir
    client.on('newItems', () => this.farmer?.onNewItems());

    client.on('error', (err) => this.handleError(err as Error & { eresult?: number }));
  }

  /** Kart modu açık, hesap etkin ve oturum açıksa kart kasıcıyı çalıştırır; değilse durdurur. */
  private syncFarmer() {
    const account = this.account;
    const want = this.loggedOn && account.enabled && account.mode === 'cards';
    if (want && !this.farmer) {
      const farmer = new CardFarmer(() => this.loadCardDrops(), this.log);
      farmer.on('change', () => this.emit('change', this.snapshot()));
      farmer.on('dropped', ({ game, dropped, remaining, totalRemaining }) =>
        this.emit('event', { type: 'card_dropped', appId: game.appId, game: game.name, dropped, remaining, totalRemaining }),
      );
      // Giriş sonrası bekleme sürüyorsa oyunlar o bitince uygulanır
      farmer.on('games', () => {
        if (!this.applyTimer) this.applyGames();
      });
      farmer.on('finished', () => {
        this.log.info(t('Tüm kartlar düştü; normal oyun listesine dönülüyor.', 'All cards dropped; back to the game list.'));
        this.emit('event', { type: 'cards_finished' });
        this.store.update(this.accountId, { mode: 'games' });
        this.syncFarmer();
        this.applyGames();
        this.emit('change', this.snapshot());
      });
      this.farmer = farmer;
      farmer.start();
    } else if (!want && this.farmer) {
      this.farmer.stop();
      this.farmer.removeAllListeners();
      this.farmer = null;
      this.emit('change', this.snapshot());
    }
  }

  private async loadCardDrops(): Promise<BadgeGame[]> {
    const steamId = this.client?.steamID?.getSteamID64();
    if (!steamId) throw new Error("Hesap Steam'e bağlı değil");
    const fetchDrops = this.deps.fetchCardDrops ?? ((id: string, cookies: string[]) => fetchCardDrops(id, cookies));
    try {
      return await fetchDrops(steamId, await this.getWebCookies());
    } catch (err) {
      if (!(err instanceof BadgeSessionError)) throw err;
      // Çerezlerin süresi dolmuş olabilir; yenileyip bir kez daha dene
      this.webCookies = null;
      return fetchDrops(steamId, await this.getWebCookies());
    }
  }

  private getWebCookies(): Promise<string[]> {
    if (this.webCookies) return Promise.resolve(this.webCookies);
    const client = this.client;
    if (!client || !this.loggedOn) return Promise.reject(new Error("Hesap Steam'e bağlı değil"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.webSessionWaiters = this.webSessionWaiters.filter((w) => w !== waiter);
        reject(new Error('Steam web oturumu açılamadı'));
      }, WEB_SESSION_TIMEOUT_MS);
      const waiter = {
        resolve: (cookies: string[]) => {
          clearTimeout(timer);
          resolve(cookies);
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      this.webSessionWaiters.push(waiter);
      if (this.webSessionWaiters.length === 1) client.webLogOn();
    });
  }

  private handleError(err: Error & { eresult?: number }) {
    const eresult = err.eresult ?? EResult.Fail;
    // steam-user çoğu hatada mesaj olarak EResult adını verir; tekrar etmesin
    const code = EResult[eresult] ?? String(eresult);
    const reason = err.message === code ? code : `${err.message} (${code})`;
    this.teardown();

    if (AUTH_ERRORS.has(eresult)) {
      this.log.error(t(`Giriş reddedildi: ${reason}`, `Sign-in rejected: ${reason}`));
      // Şifre ile yapılan denemede kayıtlı token'a dokunma; token girişi reddedildiyse token geçersizdir.
      if (!this.passwordLogin) this.store.setToken(this.accountId, null);
      this.setState('needs_login', { lastError: reason });
      // Şifreyle giriş kullanıcının kendi işlemi; yalnızca kendiliğinden düşen oturum bildirilir
      if (!this.passwordLogin) this.emit('event', { type: 'login_required', reason });
      this.finishPasswordLogin(badRequest(t(`Steam girişi reddedildi: ${reason}`, `Steam rejected the sign-in: ${reason}`)));
      return;
    }

    // Şifre ile girişte (ör. hesap eklerken) tekrar deneme yapılmaz, sonuç çağırana döner.
    if (this.passwordLogin) {
      this.log.error(t(`Giriş başarısız: ${reason}`, `Sign-in failed: ${reason}`));
      this.setState('needs_login', { lastError: reason });
      this.finishPasswordLogin(badRequest(t(`Steam girişi başarısız: ${reason}`, `Steam sign-in failed: ${reason}`)));
      return;
    }

    let delay: number;
    if (eresult === EResult.LoggedInElsewhere || eresult === EResult.LogonSessionReplaced) {
      this.log.info(t('Hesaba başka bir yerden oyunla girildi; bot geri çekildi.', 'A game was started on this account elsewhere; the bot stepped back.'));
      delay = ELSEWHERE_RETRY_MS;
    } else if (eresult === EResult.RateLimitExceeded) {
      this.log.warn(t('Steam istek sınırına takıldı.', 'Hit the Steam rate limit.'));
      delay = RATE_LIMIT_RETRY_MS;
    } else {
      this.log.error(t(`Hata: ${reason}`, `Error: ${reason}`));
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
    this.trackConnection('waiting_retry');
    this.emit('change', this.snapshot());
    const seconds = Math.round(delay / 1000);
    this.log.info(t(`${seconds} sn sonra tekrar denenecek.`, `Retrying in ${seconds} s.`));
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
      .catch((err: Error) => this.log.debug(t(`Avatar alınamadı: ${err.message}`, `Could not load the avatar: ${err.message}`)));
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

    const { games, enabled, mode } = this.account;
    const toPlay = !enabled ? [] : mode === 'cards' ? (this.farmer?.games ?? []) : games;
    if (mode === 'cards' && enabled && !toPlay.length) {
      // Kart modunda kasılacak oyun henüz belli değil (kontrol sürüyor ya da kart kalmadı)
      this.client.gamesPlayed([]);
      return;
    }
    this.client.gamesPlayed(toPlay);
    const names = toPlay.map((id) => this.deps.appNames.label(id)).join(', ');
    this.log.info(
      toPlay.length
        ? t(`Oynuyor gösteriliyor: ${names}`, `Now playing: ${names}`)
        : t('Oyun listesi boş, hiçbir oyun gösterilmiyor.', 'The game list is empty; nothing is being played.'),
    );
  }

  /** İstemciyi ve zamanlayıcıları temizler (durum değiştirmez). */
  private teardown() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.applyTimer) clearTimeout(this.applyTimer);
    this.retryTimer = this.applyTimer = null;
    if (this.farmer) {
      this.farmer.stop();
      this.farmer.removeAllListeners();
      this.farmer = null;
    }
    this.webCookies = null;
    for (const waiter of this.webSessionWaiters.splice(0)) waiter.reject(new Error('Oturum kapandı'));
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

/**
 * Oyun ikonunun adresi. steam-user img_icon_url'i zaten tam adrese çeviriyor ama eski
 * steamcdn-a.akamaihd.net alan adını kullanıyor; güncel CDN'e taşıyoruz. Yalnızca hash
 * gelirse adresi biz kuruyoruz.
 */
export function iconUrlOf(appId: number, icon: string | null | undefined): string | null {
  if (!icon) return null;
  const hash = icon.match(/([0-9a-f]{40})\.jpg$/i)?.[1] ?? (/^[0-9a-f]{40}$/i.test(icon) ? icon : null);
  if (!hash) return icon.startsWith('https://') ? icon : null;
  return `https://cdn.akamai.steamstatic.com/steamcommunity/public/images/apps/${appId}/${hash}.jpg`;
}

export function steamDataDirOf(dataDir: string) {
  return join(dataDir, 'steam-user');
}

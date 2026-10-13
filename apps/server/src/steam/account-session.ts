import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import SteamUser from 'steam-user';
import { logger, type ScopedLogger } from '../logger.js';
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
}

export type ClientFactory = (options: ConstructorParameters<typeof SteamUser>[0]) => SteamUser;

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

  private loggedOn = false;
  private blocked = false;
  private passwordLogin = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private applyTimer: NodeJS.Timeout | null = null;
  private retryDelay = RETRY_BASE_MS;

  constructor(
    readonly accountId: string,
    private readonly store: AccountStore,
    private readonly steamDataDir: string,
    /** Testlerde sahte istemci vermek için */
    private readonly createClient: ClientFactory = (options) => new SteamUser(options),
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
    };
  }

  private setState(state: SessionState, patch: Partial<Pick<SessionSnapshot, 'lastError' | 'guard'>> = {}) {
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
    if (!this.guardCallback) throw new Error('Şu an Steam Guard kodu beklenmiyor');
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

    const client = this.createClient({
      autoRelogin: true,
      renewRefreshTokens: true,
      dataDirectory: this.steamDataDir,
    });
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
      // Steam, hesabın başka yerde oyunda olup olmadığını girişten hemen sonra bildirir.
      // O bilgi gelmeden oyun gösterirsek kullanıcının gerçek oturumunu etkileyebiliriz.
      this.applyTimer = setTimeout(() => this.applyGames(), PLAYING_STATE_GRACE_MS);
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
        this.log.info(`Hesapta başka bir yerde oyun açık (AppID ${playingApp}), bekleniyor.`);
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
    const reason = `${err.message} (${EResult[eresult] ?? eresult})`;
    this.teardown();

    if (AUTH_ERRORS.has(eresult)) {
      this.log.error(`Giriş reddedildi: ${reason}`);
      // Şifre ile yapılan denemede kayıtlı token'a dokunma; token girişi reddedildiyse token geçersizdir.
      if (!this.passwordLogin) this.store.setToken(this.accountId, null);
      this.setState('needs_login', { lastError: reason });
      this.finishPasswordLogin(err);
      return;
    }

    // Şifre ile girişte (ör. hesap eklerken) tekrar deneme yapılmaz, sonuç çağırana döner.
    if (this.passwordLogin) {
      this.log.error(`Giriş başarısız: ${reason}`);
      this.setState('needs_login', { lastError: reason });
      this.finishPasswordLogin(err);
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
    this.log.info(toPlay.length ? `Oynuyor gösteriliyor: ${toPlay.join(', ')}` : 'Oyun listesi boş, hiçbir oyun gösterilmiyor.');
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

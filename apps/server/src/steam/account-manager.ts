import { EventEmitter } from 'node:events';
import { notFound } from '../errors.js';
import { logger } from '../logger.js';
import { accountIdOf, type AccountPatch, type AccountRecord, type AccountStore } from '../store/account-store.js';
import { AppNameCache } from '../store/app-names.js';
import type { BotEvent } from './events.js';
import { AccountSession, steamDataDirOf, type ClientFactory, type OwnedGame, type SessionDeps, type SessionSnapshot } from './account-session.js';

/** Hesap kaydı + canlı oturum durumu (token hariç). */
export type AccountStatus = Omit<AccountRecord, 'refreshToken'> & {
  hasToken: boolean;
  /** Seçili oyunların bilinen adları (AppID → ad) */
  gameNames: Record<string, string>;
  session: SessionSnapshot;
};

type ManagerEvents = {
  /** Bir hesabın kaydı ya da oturum durumu değişti */
  account: [AccountStatus];
  removed: [accountId: string];
  /** Bildirilmeye değer olay (WebSocket ile yayınlanır) */
  event: [BotEvent];
};

const log = logger.scoped('core');

/** Şifreli giriş isteğinin en fazla bekleyeceği süre */
const LOGIN_WAIT_MS = 30_000;

/** Tüm hesap oturumlarını yönetir. API ve CLI bu sınıf üzerinden çalışır. */
export class AccountManager extends EventEmitter<ManagerEvents> {
  private sessions = new Map<string, AccountSession>();
  /** startAll çağrıldıysa true; etkinleştirilen hesaplar yalnızca bu durumda hemen başlar. */
  private running = false;
  private pendingLogins = new Map<string, Promise<void>>();
  private readonly steamDataDir: string;
  private readonly appNames: AppNameCache;

  constructor(
    private readonly store: AccountStore,
    dataDir: string,
    private readonly clientFactory?: ClientFactory,
    private readonly cardDropsFetcher?: SessionDeps['fetchCardDrops'],
  ) {
    super();
    this.steamDataDir = steamDataDirOf(dataDir);
    this.appNames = new AppNameCache(dataDir);
    for (const account of store.list()) this.createSession(account.id);
  }

  private createSession(id: string): AccountSession {
    const session = new AccountSession(id, this.store, {
      steamDataDir: this.steamDataDir,
      appNames: this.appNames,
      createClient: this.clientFactory,
      fetchCardDrops: this.cardDropsFetcher,
    });
    session.on('change', () => this.emitAccount(id));
    session.on('event', (event) => {
      const account = this.store.get(id);
      if (!account) return;
      this.emit('event', {
        ...event,
        accountId: id,
        accountName: account.personaName ?? account.accountName,
        time: new Date().toISOString(),
      });
    });
    this.sessions.set(id, session);
    return session;
  }

  private session(id: string): AccountSession {
    const session = this.sessions.get(accountIdOf(id));
    if (!session) throw notFound(`Hesap bulunamadı: ${id}`);
    return session;
  }

  private emitAccount(id: string) {
    const status = this.status(id);
    if (status) this.emit('account', status);
  }

  status(id: string): AccountStatus | undefined {
    const account = this.store.get(id);
    const session = this.sessions.get(accountIdOf(id));
    if (!account || !session) return undefined;
    const { refreshToken, ...rest } = account;
    return {
      ...rest,
      hasToken: refreshToken !== null,
      gameNames: this.appNames.pick(account.games),
      session: session.snapshot(),
    };
  }

  require(id: string): AccountStatus {
    const status = this.status(id);
    if (!status) throw notFound(`Hesap bulunamadı: ${id}`);
    return status;
  }

  list(): AccountStatus[] {
    return this.store.list().map((a) => this.status(a.id)!);
  }

  /** Etkin ve token'ı olan tüm hesapları başlatır. */
  startAll() {
    this.running = true;
    const accounts = this.store.list().filter((a) => a.enabled);
    log.info(`${accounts.length} etkin hesap başlatılıyor.`);
    for (const account of accounts) this.session(account.id).start();
  }

  stopAll() {
    this.running = false;
    for (const session of this.sessions.values()) session.stop();
  }

  /*
   * Şifreli giriş akışı (addAccount / relogin / submitGuardCode) aynı şekilde döner:
   * giriş tamamlanınca, Steam Guard kodu istenince ya da zaman aşımında güncel durumla
   * çözülür; giriş başarısız olursa hata fırlatır. Böylece API isteği Guard beklerken asılı kalmaz.
   * Durum 'awaiting_guard' ise submitGuardCode ile devam edilir (mobil onayda waitForLogin).
   */

  /** Yeni hesap ekler ve şifre ile giriş yapar. Giriş başarısız olursa hesap silinir. */
  addAccount(accountName: string, password: string): Promise<AccountStatus> {
    const account = this.store.create(accountName);
    const session = this.createSession(account.id);
    this.emitAccount(account.id);
    log.info(`Hesap ekleniyor: ${account.accountName}`);
    return this.beginLogin(account.id, () =>
      session.loginWithPassword(password).catch((err) => {
        this.removeAccount(account.id);
        throw err;
      }),
    );
  }

  /** Token'ı geçersizleşmiş hesap için şifre ile tekrar giriş. */
  relogin(id: string, password: string): Promise<AccountStatus> {
    const session = this.session(id);
    return this.beginLogin(session.accountId, () => session.loginWithPassword(password));
  }

  submitGuardCode(id: string, code: string): Promise<AccountStatus> {
    this.session(id).submitGuardCode(code);
    return this.waitForLogin(id);
  }

  /** Devam eden şifreli girişi bekler (ör. mobil uygulamadan onay verildiyse). */
  waitForLogin(id: string, timeoutMs = LOGIN_WAIT_MS): Promise<AccountStatus> {
    const accountId = accountIdOf(id);
    const pending = this.pendingLogins.get(accountId);
    if (!pending) return Promise.resolve(this.status(accountId)!);
    const session = this.session(accountId);

    return new Promise<AccountStatus>((resolve, reject) => {
      const finish = (err?: unknown) => {
        clearTimeout(timer);
        session.off('change', onChange);
        if (err) reject(err);
        else resolve(this.status(accountId)!);
      };
      const onChange = (snapshot: SessionSnapshot) => {
        if (snapshot.state === 'awaiting_guard') finish();
      };
      const timer = setTimeout(() => finish(), timeoutMs);
      session.on('change', onChange);
      pending.then(() => finish(), finish);
    });
  }

  private beginLogin(id: string, run: () => Promise<void>): Promise<AccountStatus> {
    const pending = run();
    this.pendingLogins.set(id, pending);
    const cleanup = () => {
      if (this.pendingLogins.get(id) === pending) this.pendingLogins.delete(id);
    };
    pending.then(cleanup, cleanup);
    return this.waitForLogin(id);
  }

  updateAccount(id: string, patch: AccountPatch): AccountStatus {
    const before = this.store.require(id);
    const after = this.store.update(id, patch);
    const session = this.session(id);

    if (before.enabled !== after.enabled) {
      log.info(`${after.accountName} ${after.enabled ? 'etkinleştirildi' : 'devre dışı bırakıldı'}.`);
      if (after.enabled && this.running) session.start();
      else session.stop();
    } else {
      session.refresh();
    }
    this.emitAccount(id);
    return this.status(id)!;
  }

  checkCards(id: string): AccountStatus {
    this.session(id).checkCards();
    return this.status(id)!;
  }

  getOwnedGames(id: string, force = false): Promise<OwnedGame[]> {
    return this.session(id).getOwnedGames(force);
  }

  removeAccount(id: string) {
    const accountId = accountIdOf(id);
    const session = this.sessions.get(accountId);
    session?.stop();
    session?.removeAllListeners();
    this.sessions.delete(accountId);
    this.store.remove(accountId);
    log.info(`Hesap silindi: ${accountId}`);
    this.emit('removed', accountId);
  }
}

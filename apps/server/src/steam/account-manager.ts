import { EventEmitter } from 'node:events';
import { logger } from '../logger.js';
import { accountIdOf, type AccountPatch, type AccountRecord, type AccountStore } from '../store/account-store.js';
import { AccountSession, steamDataDirOf, type ClientFactory, type SessionSnapshot } from './account-session.js';

/** Hesap kaydı + canlı oturum durumu (token hariç). */
export type AccountStatus = Omit<AccountRecord, 'refreshToken'> & {
  hasToken: boolean;
  session: SessionSnapshot;
};

type ManagerEvents = {
  /** Bir hesabın kaydı ya da oturum durumu değişti */
  account: [AccountStatus];
  removed: [accountId: string];
};

const log = logger.scoped('core');

/** Tüm hesap oturumlarını yönetir. API ve CLI bu sınıf üzerinden çalışır. */
export class AccountManager extends EventEmitter<ManagerEvents> {
  private sessions = new Map<string, AccountSession>();
  /** startAll çağrıldıysa true; etkinleştirilen hesaplar yalnızca bu durumda hemen başlar. */
  private running = false;
  private readonly steamDataDir: string;

  constructor(
    private readonly store: AccountStore,
    dataDir: string,
    private readonly clientFactory?: ClientFactory,
  ) {
    super();
    this.steamDataDir = steamDataDirOf(dataDir);
    for (const account of store.list()) this.createSession(account.id);
  }

  private createSession(id: string): AccountSession {
    const session = new AccountSession(id, this.store, this.steamDataDir, this.clientFactory);
    session.on('change', () => this.emitAccount(id));
    this.sessions.set(id, session);
    return session;
  }

  private session(id: string): AccountSession {
    const session = this.sessions.get(accountIdOf(id));
    if (!session) throw new Error(`Hesap bulunamadı: ${id}`);
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
    return { ...rest, hasToken: refreshToken !== null, session: session.snapshot() };
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

  /**
   * Yeni hesap ekler ve şifre ile giriş yapar. Steam Guard gerekirse oturum 'awaiting_guard'
   * durumuna geçer; kod submitGuardCode ile verilir. Giriş başarısız olursa hesap silinir.
   */
  async addAccount(accountName: string, password: string): Promise<AccountStatus> {
    const account = this.store.create(accountName);
    const session = this.createSession(account.id);
    this.emitAccount(account.id);
    log.info(`Hesap ekleniyor: ${account.accountName}`);
    try {
      await session.loginWithPassword(password);
    } catch (err) {
      this.removeAccount(account.id);
      throw err;
    }
    return this.status(account.id)!;
  }

  /** Token'ı geçersizleşmiş hesap için şifre ile tekrar giriş. */
  async relogin(id: string, password: string): Promise<AccountStatus> {
    await this.session(id).loginWithPassword(password);
    return this.status(id)!;
  }

  submitGuardCode(id: string, code: string) {
    this.session(id).submitGuardCode(code);
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

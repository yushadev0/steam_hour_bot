/**
 * Kullanıcıya bildirilmeye değer olaylar. WebSocket üzerinden `{ type: 'event', event }` olarak
 * yayınlanır; yassistant agent'ı bunları push bildirimine çevirir.
 */
export type AccountEvent =
  /** Kayıtlı oturum reddedildi; bot bu hesapta durdu, şifreyle yeniden giriş gerekli. */
  | { type: 'login_required'; reason: string }
  /** Hesaba başka bir yerden oyunla girildi; bot geri çekildi. */
  | { type: 'playing_elsewhere'; appId: number | null; game: string | null }
  /** Uzun süredir Steam'e bağlanılamıyor. */
  | { type: 'connection_problem'; reason: string | null; since: string }
  /** connection_problem'den sonra bağlantı yeniden kuruldu. */
  | { type: 'connection_restored' }
  /** Kart modunda kasılan oyundan kart düştü. */
  | { type: 'card_dropped'; appId: number; game: string; dropped: number; remaining: number; totalRemaining: number }
  /** Kartı kalan oyun kalmadı; hesap oyun listesine döndü. */
  | { type: 'cards_finished' };

export type BotEvent = AccountEvent & {
  accountId: string;
  /** Steam'deki görünen ad (yoksa kullanıcı adı) */
  accountName: string;
  time: string;
};

/** Bu kadar süre bağlanamazsa connection_problem yayınlanır. */
export const CONNECTION_PROBLEM_AFTER_MS = 30 * 60_000;

import { EventEmitter } from 'node:events';
import { t, type Text } from '../i18n.js';
import type { ScopedLogger } from '../logger.js';
import { BadgeSessionError, type BadgeGame } from './badges.js';

export type CardFarmStatus =
  /** Rozet sayfası okunuyor */
  | 'checking'
  /** Bir oyun kasılıyor */
  | 'farming'
  /** Kartı kalan oyun yok */
  | 'done'
  /** Kontrol başarısız; tekrar denenecek */
  | 'error';

export interface CardFarmSnapshot {
  status: CardFarmStatus;
  /** Şu an kasılan oyun */
  current: BadgeGame | null;
  /** Kartı kalan diğer oyunlar (sırayla kasılacak) */
  queue: BadgeGame[];
  totalDrops: number;
  lastCheckAt: string | null;
  nextCheckAt: string | null;
  /** Türkçe hata metni */
  error: string | null;
  errorEn: string | null;
}

export interface CardDrop {
  game: BadgeGame;
  dropped: number;
  remaining: number;
  /** Tüm oyunlarda kalan kart sayısı */
  totalRemaining: number;
}

type FarmerEvents = {
  change: [CardFarmSnapshot];
  /** Kasılan oyundan kart düştü */
  dropped: [CardDrop];
  /** Kasılacak oyun değişti */
  games: [number[]];
  /** Tüm kartlar düştü */
  finished: [];
};

/** Kartlar oyun oynandıkça ~20-30 dakikada bir düşer; bu aralıkla kontrol edilir. */
export const CHECK_INTERVAL_MS = 15 * 60_000;
/** Steam yeni eşya bildirdiğinde kontrol (art arda bildirimleri birleştirmek için kısa bekleme) */
export const NEW_ITEMS_DELAY_MS = 10_000;
export const ERROR_RETRY_MS = 5 * 60_000;

/**
 * Kart düşürme modu. Kartı kalan oyunları rozet sayfasından okur ve tek tek kasar
 * (Steam aynı anda birden fazla oyunda kart düşürmüyor, yalnızca süre işliyor).
 * Az kartı kalan oyun önce kasılır; böylece oyunlar hızlıca tamamlanır.
 */
export class CardFarmer extends EventEmitter<FarmerEvents> {
  private status: CardFarmStatus = 'checking';
  private current: BadgeGame | null = null;
  private queue: BadgeGame[] = [];
  private lastCheckAt: Date | null = null;
  private nextCheckAt: Date | null = null;
  private error: Text | null = null;
  private timer: NodeJS.Timeout | null = null;
  private checking = false;
  private stopped = true;

  constructor(
    private readonly fetchDrops: () => Promise<BadgeGame[]>,
    private readonly log: ScopedLogger,
  ) {
    super();
  }

  snapshot(): CardFarmSnapshot {
    const all = [...(this.current ? [this.current] : []), ...this.queue];
    return {
      status: this.status,
      current: this.current,
      queue: this.queue,
      totalDrops: all.reduce((sum, g) => sum + g.dropsRemaining, 0),
      lastCheckAt: this.lastCheckAt?.toISOString() ?? null,
      nextCheckAt: this.nextCheckAt?.toISOString() ?? null,
      error: this.error?.tr ?? null,
      errorEn: this.error?.en ?? null,
    };
  }

  /** Kasılacak oyunlar (en fazla bir tane) */
  get games(): number[] {
    return this.current ? [this.current.appId] : [];
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.log.info(t('Kart düşürme modu başladı.', 'Card farming started.'));
    void this.check();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextCheckAt = null;
  }

  /** Hemen kontrol et (panelden "Şimdi kontrol et") */
  checkNow() {
    if (!this.stopped) void this.check();
  }

  /** Steam yeni eşya bildirdi; kart düşmüş olabilir */
  onNewItems() {
    if (this.stopped || this.status !== 'farming') return;
    this.schedule(NEW_ITEMS_DELAY_MS);
  }

  private schedule(delay: number) {
    if (this.timer) clearTimeout(this.timer);
    this.nextCheckAt = new Date(Date.now() + delay);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.check();
    }, delay);
    this.emit('change', this.snapshot());
  }

  private async check() {
    if (this.checking || this.stopped) return;
    this.checking = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const previous = this.current;
    if (!previous) this.status = 'checking';
    this.emit('change', this.snapshot());

    try {
      const drops = await this.fetchDrops();
      if (this.stopped) return;
      this.lastCheckAt = new Date();
      this.error = null;
      this.update(drops, previous);
    } catch (err) {
      if (this.stopped) return;
      this.error =
        err instanceof BadgeSessionError
          ? err.text
          : t(`Kart bilgisi alınamadı: ${(err as Error).message}`, `Could not read card drops: ${(err as Error).message}`);
      this.log.warn(this.error);
      // Kasılan oyun varsa ona devam et; yoksa hata durumunda bekle
      if (!this.current) this.status = 'error';
      this.schedule(ERROR_RETRY_MS);
    } finally {
      this.checking = false;
    }
  }

  private update(drops: BadgeGame[], previous: BadgeGame | null) {
    const sorted = [...drops].sort((a, b) => a.dropsRemaining - b.dropsRemaining || b.playtimeHours - a.playtimeHours);

    let drop: Omit<CardDrop, 'totalRemaining'> | null = null;
    if (previous) {
      const before = previous.dropsRemaining;
      const now = drops.find((g) => g.appId === previous.appId)?.dropsRemaining ?? 0;
      if (now < before) {
        this.log.info(t(`${previous.name}: ${before - now} kart düştü, ${now} kaldı.`, `${previous.name}: ${before - now} card(s) dropped, ${now} left.`));
        drop = { game: previous, dropped: before - now, remaining: now };
      }
    }

    // Kasılan oyunun hâlâ kartı varsa ona devam et; gereksiz oyun değiştirme
    const keep = previous && sorted.find((g) => g.appId === previous.appId);
    const current = keep ?? sorted[0] ?? null;
    this.queue = sorted.filter((g) => g.appId !== current?.appId);
    this.current = current;
    if (drop) this.emit('dropped', { ...drop, totalRemaining: this.snapshot().totalDrops });

    if (!current) {
      this.status = 'done';
      this.nextCheckAt = null;
      this.log.info(t('Kartı kalan oyun yok, kart düşürme tamamlandı.', 'No card drops left; card farming finished.'));
      this.emit('change', this.snapshot());
      this.emit('games', []);
      this.emit('finished');
      return;
    }

    this.status = 'farming';
    if (current.appId !== previous?.appId) {
      const n = this.queue.length;
      this.log.info(
        t(
          `Kart kasılıyor: ${current.name} (${current.dropsRemaining} kart kaldı${n ? `, sırada ${n} oyun daha var` : ''}).`,
          `Farming cards: ${current.name} (${current.dropsRemaining} left${n ? `, ${n} more game(s) queued` : ''}).`,
        ),
      );
      this.emit('games', this.games);
    }
    this.schedule(CHECK_INTERVAL_MS);
  }
}

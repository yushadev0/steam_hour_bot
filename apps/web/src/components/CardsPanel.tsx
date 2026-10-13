import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, Layers, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { api, upsertAccount } from '../api';
import { isConnected, useNow } from '../status';
import type { Account, BadgeGame } from '../types';
import { GameCapsule } from './GameArt';
import { Spinner, useToast } from './ui';

const hours = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 });

function relative(iso: string | null, now: number) {
  if (!iso) return null;
  const minutes = Math.round((Date.parse(iso) - now) / 60_000);
  if (minutes === 0) return 'şimdi';
  return minutes > 0 ? `${minutes} dk sonra` : `${-minutes} dk önce`;
}

const dropsLabel = (n: number) => `${n} kart kaldı`;

/** Kart düşürme modunda hesabın kart durumu: kasılan oyun, sıra ve kontrol zamanları. */
export function CardsPanel({ account }: { account: Account }) {
  const cards = account.session.cards;
  const now = useNow(15_000);
  const toast = useToast();
  const check = useMutation({
    mutationFn: () => api.checkCards(account.id),
    onSuccess: upsertAccount,
    onError: (err) => toast(err.message, 'error'),
  });

  const queueCount = cards ? cards.queue.length + (cards.current ? 1 : 0) : 0;

  return (
    <section className="rounded-md bg-surface">
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
        <h2 className="font-semibold text-bright">
          Kart düşürme
          {cards && cards.totalDrops > 0 && (
            <span className="font-normal text-muted tabular-nums">
              {' '}
              {cards.totalDrops} kart, {queueCount} oyun
            </span>
          )}
        </h2>
        <button className="btn" onClick={() => check.mutate()} disabled={!cards || cards.status === 'checking' || check.isPending}>
          <RefreshCw size={15} className={cards?.status === 'checking' ? 'animate-spin' : ''} />
          Şimdi kontrol et
        </button>
      </header>

      <div className="px-4 py-4 sm:px-5">
        {!cards ? (
          <Empty>
            {!account.enabled
              ? 'Bot bu hesap için kapalı. Açınca kartı kalan oyunlar kontrol edilecek.'
              : isConnected(account)
                ? 'Kart düşürme başlatılıyor…'
                : "Hesap Steam'e bağlanınca kartı kalan oyunlar kontrol edilecek."}
          </Empty>
        ) : cards.status === 'checking' && !cards.current ? (
          <Empty>
            <Spinner /> Rozet sayfası okunuyor…
          </Empty>
        ) : cards.status === 'done' ? (
          <Empty>Kartı kalan oyun yok. Bot birazdan normal oyun listene döner.</Empty>
        ) : (
          <>
            {cards.error && (
              <p className="mb-4 flex items-start gap-2 rounded-sm bg-warn/10 px-3 py-2 text-sm text-warn">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                {cards.error}
              </p>
            )}
            {cards.current && <CurrentGame game={cards.current} />}
            {cards.queue.length > 0 && (
              <>
                <h3 className="mt-5 mb-1 text-sm font-medium text-muted">Sırada</h3>
                <ul className="divide-y divide-line/60">
                  {cards.queue.map((game) => (
                    <li key={game.appId} className="flex items-center gap-3 py-2">
                      <GameCapsule appId={game.appId} iconUrl={null} width={92} />
                      <span className="min-w-0 flex-1 truncate">{game.name}</span>
                      <span className="shrink-0 text-sm text-muted tabular-nums">{dropsLabel(game.dropsRemaining)}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}

        {cards && (cards.lastCheckAt || cards.nextCheckAt) && (
          <p className="mt-4 text-sm text-muted">
            {cards.lastCheckAt && <>Son kontrol {relative(cards.lastCheckAt, now)}. </>}
            {cards.nextCheckAt && <>Sonraki kontrol {relative(cards.nextCheckAt, now)}.</>}
          </p>
        )}
        <p className="mt-2 text-sm text-muted">
          Steam kartları oyun oynandıkça yaklaşık 20-30 dakikada bir düşürür ve yalnızca tek oyunda sayar. Bot kartı biten oyundan
          sıradakine kendiliğinden geçer; hepsi bitince oyun listene döner.
        </p>
      </div>
    </section>
  );
}

function CurrentGame({ game }: { game: BadgeGame }) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      <GameCapsule appId={game.appId} iconUrl={null} width={184} />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-ingame">Şu an kasılıyor</p>
        <p className="truncate text-lg font-semibold text-bright">{game.name}</p>
        <p className="text-sm text-muted">
          <span className="text-text tabular-nums">{dropsLabel(game.dropsRemaining)}</span>
          {game.playtimeHours > 0 && <>, toplam {hours.format(game.playtimeHours)} saat</>}
        </p>
      </div>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-center py-6 text-center text-muted">
      <Layers size={28} className="mb-3" />
      <p className="flex items-center gap-2">{children}</p>
    </div>
  );
}

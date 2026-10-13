import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, keys } from './api';
import type { Account, OwnedGame } from './types';

/** Steam arkadaş listesindeki renklerle eşleşen durum tonları */
export type Tone = 'ingame' | 'online' | 'offline' | 'warn' | 'error';

export const toneText: Record<Tone, string> = {
  ingame: 'text-ingame',
  online: 'text-online',
  offline: 'text-offline',
  warn: 'text-warn',
  error: 'text-danger',
};

export const toneRing: Record<Tone, string> = {
  ingame: 'border-ingame',
  online: 'border-online',
  offline: 'border-offline/60',
  warn: 'border-warn',
  error: 'border-danger',
};

const CONNECTED = new Set(['running', 'blocked']);
export const isConnected = (account: Account) => CONNECTED.has(account.session.state);

/** Hesabın sahip olduğu oyunlar; yalnızca hesap Steam'e bağlıyken istenebilir. */
export function useOwnedGames(account: Account | undefined) {
  return useQuery({
    queryKey: keys.games(account?.id ?? ''),
    queryFn: () => api.ownedGames(account!.id),
    enabled: !!account && isConnected(account),
    staleTime: 10 * 60_000,
  });
}

export function gameName(appId: number, account: Account, games?: OwnedGame[]) {
  return games?.find((g) => g.appId === appId)?.name ?? account.gameNames[appId] ?? `AppID ${appId}`;
}

/** Hesabın arkadaşlarına nasıl göründüğünü ve botun ne yaptığını tek satırda anlatır. */
export function describeStatus(account: Account, games: OwnedGame[] | undefined, now: number): { tone: Tone; text: string } {
  const { session } = account;
  switch (session.state) {
    case 'running': {
      if (account.mode === 'cards') {
        const current = session.cards?.current;
        if (current) return { tone: 'ingame', text: `Kart düşürüyor: ${current.name} (${current.dropsRemaining})` };
        if (session.cards?.status === 'done') return { tone: 'online', text: 'Kartı kalan oyun yok' };
        return { tone: 'online', text: 'Kartlar kontrol ediliyor' };
      }
      if (!account.games.length) return { tone: 'online', text: 'Çevrimiçi, oyun seçilmedi' };
      const first = gameName(account.games[0]!, account, games);
      const more = account.games.length > 1 ? ` +${account.games.length - 1}` : '';
      return { tone: 'ingame', text: `Oyunda: ${first}${more}` };
    }
    case 'blocked': {
      if (!session.blockedByApp) return { tone: 'warn', text: 'Başka yerde oyunda, bekliyor' };
      return { tone: 'warn', text: `Başka yerde oyunda: ${gameName(session.blockedByApp, account, games)}` };
    }
    case 'connecting':
      return { tone: 'offline', text: 'Bağlanıyor…' };
    case 'awaiting_guard':
      return { tone: 'warn', text: 'Steam Guard kodu bekleniyor' };
    case 'waiting_retry': {
      const left = session.retryAt ? Math.max(0, Date.parse(session.retryAt) - now) : 0;
      return { tone: 'warn', text: `Bağlantı hatası, ${formatCountdown(left)} sonra tekrar denenecek` };
    }
    case 'needs_login':
      return { tone: 'error', text: 'Yeniden giriş gerekli' };
    case 'stopped':
      return { tone: 'offline', text: account.enabled ? 'Durdu' : 'Kapalı' };
  }
}

export function displayName(account: Account) {
  return account.personaName ?? account.accountName;
}

/** 135 dk → "2 sa 15 dk" */
export function formatDuration(ms: number) {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '1 dakikadan az';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} dk`;
  return m ? `${h} sa ${m} dk` : `${h} sa`;
}

function formatCountdown(ms: number) {
  const s = Math.ceil(ms / 1000);
  return s >= 60 ? `${Math.ceil(s / 60)} dk` : `${s} sn`;
}

const hoursFormat = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 });

/** Steam kütüphanesindeki gibi toplam oynama süresi: "412,5 saat" */
export function formatPlaytime(minutes: number) {
  if (minutes === 0) return 'Hiç oynanmadı';
  if (minutes < 60) return `${minutes} dakika`;
  return `${hoursFormat.format(minutes / 60)} saat`;
}

/** Belirli aralıklarla yeniden çizim için şimdiki zaman */
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

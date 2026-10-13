import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, keys } from './api';
import type { Lang, Translate } from './i18n';
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
export function describeStatus(
  account: Account,
  games: OwnedGame[] | undefined,
  now: number,
  t: Translate,
): { tone: Tone; text: string } {
  const { session } = account;
  switch (session.state) {
    case 'running': {
      if (account.mode === 'cards') {
        const current = session.cards?.current;
        if (current) {
          const label = `${current.name} (${current.dropsRemaining})`;
          return { tone: 'ingame', text: t(`Kart düşürüyor: ${label}`, `Farming cards: ${label}`) };
        }
        if (session.cards?.status === 'done') return { tone: 'online', text: t('Kartı kalan oyun yok', 'No card drops left') };
        return { tone: 'online', text: t('Kartlar kontrol ediliyor', 'Checking card drops') };
      }
      if (!account.games.length) return { tone: 'online', text: t('Çevrimiçi, oyun seçilmedi', 'Online, no games selected') };
      const first = gameName(account.games[0]!, account, games);
      const more = account.games.length > 1 ? ` +${account.games.length - 1}` : '';
      return { tone: 'ingame', text: t(`Oyunda: ${first}${more}`, `In game: ${first}${more}`) };
    }
    case 'blocked': {
      if (!session.blockedByApp) return { tone: 'warn', text: t('Başka yerde oyunda, bekliyor', 'Playing elsewhere, waiting') };
      const name = gameName(session.blockedByApp, account, games);
      return { tone: 'warn', text: t(`Başka yerde oyunda: ${name}`, `Playing elsewhere: ${name}`) };
    }
    case 'connecting':
      return { tone: 'offline', text: t('Bağlanıyor…', 'Connecting…') };
    case 'awaiting_guard':
      return { tone: 'warn', text: t('Steam Guard kodu bekleniyor', 'Waiting for a Steam Guard code') };
    case 'waiting_retry': {
      const left = session.retryAt ? Math.max(0, Date.parse(session.retryAt) - now) : 0;
      const when = formatCountdown(left, t);
      return { tone: 'warn', text: t(`Bağlantı hatası, ${when} sonra tekrar denenecek`, `Connection error, retrying in ${when}`) };
    }
    case 'needs_login':
      return { tone: 'error', text: t('Yeniden giriş gerekli', 'Sign-in required') };
    case 'stopped':
      return { tone: 'offline', text: account.enabled ? t('Durdu', 'Stopped') : t('Kapalı', 'Off') };
  }
}

/** Bot şu an gerçekten bir şey kasıyor mu (kart modunda kasılan oyun varsa) */
export function isIdling(account: Account) {
  if (account.session.state !== 'running') return false;
  return account.mode === 'cards' ? !!account.session.cards?.current : account.games.length > 0;
}

export function displayName(account: Account) {
  return account.personaName ?? account.accountName;
}

/** 135 dk → "2 sa 15 dk" / "2 h 15 min" */
export function formatDuration(ms: number, t: Translate) {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return t('1 dakikadan az', 'less than a minute');
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return t(`${m} dk`, `${m} min`);
  return m ? t(`${h} sa ${m} dk`, `${h} h ${m} min`) : t(`${h} sa`, `${h} h`);
}

function formatCountdown(ms: number, t: Translate) {
  const s = Math.ceil(ms / 1000);
  return s >= 60 ? t(`${Math.ceil(s / 60)} dk`, `${Math.ceil(s / 60)} min`) : t(`${s} sn`, `${s} s`);
}

const hoursFormat = {
  tr: new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 }),
  en: new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }),
};

export function formatHours(hours: number, lang: Lang) {
  const value = hoursFormat[lang].format(hours);
  return lang === 'en' ? `${value} ${hours === 1 ? 'hour' : 'hours'}` : `${value} saat`;
}

/** Steam kütüphanesindeki gibi toplam oynama süresi: "412,5 saat" / "412.5 hours" */
export function formatPlaytime(minutes: number, lang: Lang) {
  if (minutes === 0) return lang === 'en' ? 'Never played' : 'Hiç oynanmadı';
  if (minutes < 60) return lang === 'en' ? `${minutes} minutes` : `${minutes} dakika`;
  return formatHours(minutes / 60, lang);
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

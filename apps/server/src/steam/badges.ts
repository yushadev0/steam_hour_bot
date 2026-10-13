import { parse } from 'node-html-parser';
import { t } from '../i18n.js';

/** Rozet sayfasındaki, kart düşmesi kalan bir oyun */
export interface BadgeGame {
  appId: number;
  name: string;
  dropsRemaining: number;
  playtimeHours: number;
}

export class BadgeSessionError extends Error {
  readonly text = t('Steam web oturumu geçersiz; rozet sayfası okunamadı', 'Steam web session is invalid; could not read the badges page');

  constructor() {
    super('Steam web oturumu geçersiz; rozet sayfası okunamadı');
  }
}

const DROPS_RE = /(\d+)\s+card drops? remaining/i;
const PLAYTIME_RE = /([\d.,]+)\s+hrs? on record/i;
const APP_RE = /\/gamecards\/(\d+)\//;

const clean = (text: string) => text.replace(/ |&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * steamcommunity.com/profiles/<id>/badges/?l=english sayfasını okur. Kalan kart sayısı yalnızca
 * hesabın kendi oturumuyla görünür; sayfa rozet listesi içermiyorsa oturum geçersiz sayılır.
 */
export function parseBadgesPage(html: string): { games: BadgeGame[]; pageCount: number } {
  const root = parse(html);
  if (!root.querySelector('.badges_sheet')) throw new BadgeSessionError();

  const games: BadgeGame[] = [];
  for (const row of root.querySelectorAll('.badge_row')) {
    const href = row.querySelector('.badge_row_overlay')?.getAttribute('href') ?? '';
    const appMatch = href.match(APP_RE);
    if (!appMatch) continue; // oyun rozeti değil (topluluk, etkinlik...)

    const dropsText = clean(row.querySelector('.badge_title_stats_drops')?.text ?? '');
    const drops = Number(dropsText.match(DROPS_RE)?.[1] ?? 0);
    const playtimeText = clean(row.querySelector('.badge_title_stats_playtime')?.text ?? '');
    const playtime = Number((playtimeText.match(PLAYTIME_RE)?.[1] ?? '0').replace(/,/g, ''));
    const title = row.querySelector('.badge_title');
    title?.querySelector('.badge_view_details')?.remove();

    games.push({
      appId: Number(appMatch[1]),
      name: clean(title?.text ?? '') || `AppID ${appMatch[1]}`,
      dropsRemaining: drops,
      playtimeHours: Number.isFinite(playtime) ? playtime : 0,
    });
  }

  const pages = root.querySelectorAll('.pagelink').map((a) => Number(clean(a.text)));
  const pageCount = Math.max(1, ...pages.filter(Number.isFinite));
  return { games, pageCount };
}

const MAX_PAGES = 50;

/** Tüm rozet sayfalarını okuyup kartı kalan oyunları döner. */
export async function fetchCardDrops(steamId: string, cookies: string[], fetchImpl: typeof fetch = fetch): Promise<BadgeGame[]> {
  const cookie = [...cookies, 'Steam_Language=english'].join('; ');
  const fetchPage = async (page: number) => {
    const res = await fetchImpl(`https://steamcommunity.com/profiles/${steamId}/badges/?l=english&p=${page}`, {
      headers: { cookie, 'user-agent': 'Mozilla/5.0' },
    });
    if (res.url.includes('/login')) throw new BadgeSessionError();
    if (!res.ok) throw new Error(`Rozet sayfası alınamadı (HTTP ${res.status})`);
    return parseBadgesPage(await res.text());
  };

  const first = await fetchPage(1);
  const games = [...first.games];
  for (let page = 2; page <= Math.min(first.pageCount, MAX_PAGES); page++) {
    games.push(...(await fetchPage(page)).games);
  }
  return games.filter((g) => g.dropsRemaining > 0);
}

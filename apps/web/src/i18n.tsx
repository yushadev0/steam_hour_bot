import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Lang = 'tr' | 'en';

const STORAGE_KEY = 'shb:lang';

function detect(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'tr' || saved === 'en') return saved;
  } catch {
    // Tarayıcı depolaması kapalıysa tarayıcı diline bakılır
  }
  return navigator.language.toLowerCase().startsWith('tr') ? 'tr' : 'en';
}

/** React dışındaki kod (API hata mesajları) için geçerli dil */
let current: Lang = detect();
export const currentLang = () => current;

/** Metni seçili dile göre seçer: t('Türkçe', 'English') */
export type Translate = (tr: string, en: string) => string;

interface I18n {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: Translate;
  /** Intl biçimleri için */
  locale: string;
}

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(current);

  useEffect(() => {
    current = lang;
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    current = next;
    setLangState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Seçim yalnızca bu oturumda geçerli olur
    }
  }, []);

  const value = useMemo<I18n>(
    () => ({
      lang,
      setLang,
      t: (tr, en) => (lang === 'en' ? en : tr),
      locale: lang === 'en' ? 'en-US' : 'tr-TR',
    }),
    [lang, setLang],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error('I18nProvider eksik');
  return value;
}

/** Sunucudan gelen iki dilli metin (log, kart hatası) */
export function pick(lang: Lang, tr: string, en: string | null | undefined) {
  return lang === 'en' && en ? en : tr;
}

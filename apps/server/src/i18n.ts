/**
 * Kullanıcıya gösterilen sunucu metinleri iki dilli üretilir. API mevcut Türkçe alanların
 * (message, error) yanında İngilizcelerini de (messageEn, errorEn) döner; panel seçili dile
 * göre gösterir. Konsol çıktısının dili SHB_LANG ile seçilir (varsayılan tr).
 */
export interface Text {
  tr: string;
  en: string;
}

export const t = (tr: string, en: string): Text => ({ tr, en });

/** Dile bağlı olmayan metinler (ör. hata kodu, yığın izi) iki dilde aynıdır. */
export const textOf = (message: string | Text): Text => (typeof message === 'string' ? { tr: message, en: message } : message);

export const consoleLang: keyof Text = process.env.SHB_LANG === 'en' ? 'en' : 'tr';

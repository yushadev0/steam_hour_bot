import { textOf, type Text } from './i18n.js';

/** Kullanıcıya gösterilebilecek hata; API bunu ilgili HTTP durum koduyla (error + errorEn) döner. */
export class AppError extends Error {
  readonly messageEn: string;

  constructor(
    readonly status: number,
    message: string | Text,
  ) {
    const text = textOf(message);
    super(text.tr);
    this.messageEn = text.en;
    this.name = 'AppError';
  }
}

export const badRequest = (message: string | Text) => new AppError(400, message);
export const unauthorized = (message: string | Text) => new AppError(401, message);
export const forbidden = (message: string | Text) => new AppError(403, message);
export const notFound = (message: string | Text) => new AppError(404, message);
export const conflict = (message: string | Text) => new AppError(409, message);
export const tooManyRequests = (message: string | Text) => new AppError(429, message);

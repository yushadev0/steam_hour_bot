import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import type { Core } from '../core.js';
import { AppError, unauthorized } from '../errors.js';
import { logger } from '../logger.js';
import { SESSION_COOKIE, type AuthKind, type AuthStore } from './auth-store.js';
import { registerRoutes } from './routes.js';
import { loadWebAssets, registerStatic } from './static.js';
import { registerWebSocket } from './ws.js';

declare module 'fastify' {
  interface FastifyRequest {
    authKind: AuthKind | null;
  }
}

/** Kimlik doğrulama gerektirmeyen uç noktalar */
const PUBLIC_ROUTES = new Set(['/api/health', '/api/auth/login']);

/** İstekten oturum çerezi ya da Bearer token'ı okur (WebSocket için ?token= de kabul edilir). */
export function credentialOf(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  const fromCookie = request.cookies[SESSION_COOKIE];
  if (fromCookie) return fromCookie;
  const query = request.query as { token?: string } | undefined;
  if (request.url.startsWith('/api/ws') && query?.token) return query.token;
  return null;
}

// Doğrulama hataları panelde Türkçe görünsün
z.config(z.locales.tr());

export async function buildServer(core: Core, auth: AuthStore, options: { serveWeb?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: process.env.SHB_TRUST_PROXY === 'true' });
  await app.register(cookie);
  await app.register(websocket);

  app.decorateRequest('authKind', null);

  app.addHook('onRequest', async (request) => {
    const path = request.url.split('?')[0]!;
    if (!path.startsWith('/api/') || PUBLIC_ROUTES.has(path)) return;
    const credential = credentialOf(request);
    request.authKind = credential ? auth.verify(credential) : null;
    if (!request.authKind) throw unauthorized();
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) return reply.status(error.status).send({ error: error.message });
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      const field = issue?.path.join('.');
      return reply.status(400).send({ error: field ? `${field}: ${issue?.message}` : (issue?.message ?? 'Geçersiz istek') });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (error as Error).message });
    logger.log('error', 'api', `${request.method} ${request.url}: ${(error as Error).stack ?? error}`);
    return reply.status(500).send({ error: 'Sunucu hatası' });
  });

  app.setNotFoundHandler((request, reply) => reply.status(404).send({ error: `Bulunamadı: ${request.method} ${request.url.split('?')[0]}` }));

  registerRoutes(app, core, auth);
  registerWebSocket(app, core);

  if (options.serveWeb) {
    const web = loadWebAssets();
    logger.log('info', 'core', web ? `Panel dosyaları: ${web.source}` : 'Panel dosyaları bulunamadı; yalnızca API çalışıyor.');
    registerStatic(app, web?.assets ?? null);
  }
  return app;
}

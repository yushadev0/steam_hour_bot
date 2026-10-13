import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import type { Core } from '../core.js';
import { AppError, forbidden, unauthorized } from '../errors.js';
import { logger } from '../logger.js';
import { registerRoutes } from './routes.js';
import { loadWebAssets, registerStatic } from './static.js';
import type { TokenStore } from './token-store.js';
import { registerWebSocket } from './ws.js';

/** 'local': botun çalıştığı bilgisayardan (panel). 'token': API token'lı dış istemci (yassistant). */
export type AuthKind = 'local' | 'token';

declare module 'fastify' {
  interface FastifyRequest {
    authKind: AuthKind | null;
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Bearer token (WebSocket için ?token= de kabul edilir). */
function tokenOf(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  const query = request.query as { token?: string } | undefined;
  if (request.url.startsWith('/api/ws') && query?.token) return query.token;
  return null;
}

const hostnameOf = (host: string) => host.replace(/:\d+$/, '').toLowerCase();

/**
 * Panel şifresizdir; yalnızca bu bilgisayardan gelen istekler kabul edilir. Ek olarak:
 * - Host başlığı yerel olmalı: kötü niyetli bir sitenin alan adını 127.0.0.1'e çözdürerek
 *   (DNS rebinding) panele erişmesini engeller.
 * - Origin varsa Host ile aynı olmalı: başka bir sitenin tarayıcı üzerinden istek/WebSocket
 *   açmasını engeller.
 */
function isTrustedLocal(request: FastifyRequest): boolean {
  if (!LOOPBACK.has(request.socket.remoteAddress ?? '')) return false;
  const host = request.headers.host ?? '';
  if (!LOCAL_HOSTNAMES.has(hostnameOf(host))) return false;
  const origin = request.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

// Doğrulama hataları panelde Türkçe görünsün
z.config(z.locales.tr());

export async function buildServer(core: Core, tokens: TokenStore, options: { serveWeb?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(websocket);

  app.decorateRequest('authKind', null);

  app.addHook('onRequest', async (request) => {
    const path = request.url.split('?')[0]!;
    if (!path.startsWith('/api/') || path === '/api/health') return;
    const token = tokenOf(request);
    if (token) {
      if (!tokens.verify(token)) throw unauthorized('API token geçersiz');
      request.authKind = 'token';
      return;
    }
    if (isTrustedLocal(request)) {
      request.authKind = 'local';
      return;
    }
    throw request.headers.origin ? forbidden('Bu istek kabul edilmedi') : unauthorized('Panel yalnızca botun çalıştığı bilgisayardan kullanılabilir');
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

  registerRoutes(app, core, tokens);
  registerWebSocket(app, core);

  if (options.serveWeb) {
    const web = loadWebAssets();
    logger.log('info', 'core', web ? `Panel dosyaları: ${web.source}` : 'Panel dosyaları bulunamadı; yalnızca API çalışıyor.');
    registerStatic(app, web?.assets ?? null);
  }
  return app;
}

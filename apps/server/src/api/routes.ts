import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { APP_NAME, VERSION } from '../config.js';
import type { Core } from '../core.js';
import { forbidden, tooManyRequests } from '../errors.js';
import { logger } from '../logger.js';
import { idleModes, personaModes } from '../store/account-store.js';
import { SESSION_COOKIE, type AuthStore } from './auth-store.js';

const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60_000;

/** Panel girişinde kaba kuvvet denemelerine karşı IP başına basit sınırlama. */
class LoginLimiter {
  private failures = new Map<string, { count: number; resetAt: number }>();

  check(ip: string) {
    const entry = this.failures.get(ip);
    if (entry && entry.resetAt > Date.now() && entry.count >= LOGIN_MAX_FAILURES) {
      const minutes = Math.ceil((entry.resetAt - Date.now()) / 60_000);
      throw tooManyRequests(`Çok fazla hatalı deneme. ${minutes} dk sonra tekrar dene.`);
    }
  }

  fail(ip: string) {
    const entry = this.failures.get(ip);
    if (!entry || entry.resetAt <= Date.now()) {
      this.failures.set(ip, { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
    } else {
      entry.count++;
    }
  }

  reset(ip: string) {
    this.failures.delete(ip);
  }
}

const loginBody = z.object({ password: z.string().min(1) });
const changePasswordBody = z.object({ current: z.string(), next: z.string() });
const createTokenBody = z.object({ name: z.string().min(1).max(64) });
const addAccountBody = z.object({ accountName: z.string().trim().min(1), password: z.string().min(1) });
const reloginBody = z.object({ password: z.string().min(1) });
const guardBody = z.object({ code: z.string().trim().min(1).max(10) });
const patchAccountBody = z
  .object({
    games: z.array(z.number().int().positive()),
    persona: z.enum(personaModes),
    mode: z.enum(idleModes),
    enabled: z.boolean(),
  })
  .partial()
  .strict();
const idParams = z.object({ id: z.string().min(1) });
const gamesQuery = z.object({ refresh: z.enum(['true', 'false']).optional() });
const logsQuery = z.object({ scope: z.string().optional(), limit: z.coerce.number().int().min(1).max(1000).optional() });

/** Panel şifresini değiştirmek ve API token yönetmek yalnızca panel oturumuyla yapılabilir. */
function requireSession(request: FastifyRequest) {
  if (request.authKind !== 'session') throw forbidden('Bu işlem için panel girişi gerekli');
}

export function registerRoutes(app: FastifyInstance, core: Core, auth: AuthStore) {
  const { manager } = core;
  const limiter = new LoginLimiter();

  app.get('/api/health', async () => ({ ok: true, name: APP_NAME, version: VERSION }));

  // --- Panel girişi ---

  app.post('/api/auth/login', async (request, reply: FastifyReply) => {
    limiter.check(request.ip);
    const { password } = loginBody.parse(request.body);
    let session;
    try {
      session = auth.login(password);
    } catch (err) {
      limiter.fail(request.ip);
      logger.log('warn', 'api', `Hatalı panel girişi denemesi (${request.ip})`);
      throw err;
    }
    limiter.reset(request.ip);
    reply.setCookie(SESSION_COOKIE, session.token, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: request.protocol === 'https',
      expires: session.expiresAt,
    });
    return { ok: true };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) auth.logout(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (request) => ({ authKind: request.authKind }));

  app.post('/api/auth/password', async (request) => {
    requireSession(request);
    const { current, next } = changePasswordBody.parse(request.body);
    auth.changePassword(current, next);
    logger.log('info', 'api', 'Panel şifresi değiştirildi; tüm oturumlar kapatıldı.');
    return { ok: true };
  });

  // --- API token'ları (yassistant gibi dış istemciler için) ---

  app.get('/api/tokens', async (request) => {
    requireSession(request);
    return auth.listApiTokens();
  });

  app.post('/api/tokens', async (request, reply) => {
    requireSession(request);
    const { name } = createTokenBody.parse(request.body);
    const created = auth.createApiToken(name);
    logger.log('info', 'api', `API token oluşturuldu: ${created.info.name}`);
    return reply.status(201).send(created);
  });

  app.delete('/api/tokens/:id', async (request) => {
    requireSession(request);
    const { id } = idParams.parse(request.params);
    auth.revokeApiToken(id);
    return { ok: true };
  });

  // --- Hesaplar ---

  app.get('/api/accounts', async () => manager.list());

  /**
   * Hesap ekler. Yanıt giriş tamamlanınca ya da Steam Guard kodu istenince döner
   * (session.state === 'awaiting_guard' ise /guard ile devam edilir).
   */
  app.post('/api/accounts', async (request, reply) => {
    const { accountName, password } = addAccountBody.parse(request.body);
    return reply.status(201).send(await manager.addAccount(accountName, password));
  });

  app.get('/api/accounts/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    return manager.require(id);
  });

  app.patch('/api/accounts/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    return manager.updateAccount(id, patchAccountBody.parse(request.body));
  });

  app.delete('/api/accounts/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    manager.require(id);
    manager.removeAccount(id);
    return { ok: true };
  });

  app.post('/api/accounts/:id/login', async (request) => {
    const { id } = idParams.parse(request.params);
    const { password } = reloginBody.parse(request.body);
    return manager.relogin(id, password);
  });

  app.post('/api/accounts/:id/guard', async (request) => {
    const { id } = idParams.parse(request.params);
    const { code } = guardBody.parse(request.body);
    return manager.submitGuardCode(id, code);
  });

  /** Mobil uygulamadan onay bekleniyorsa girişin tamamlanmasını bekler. */
  app.post('/api/accounts/:id/guard/wait', async (request) => {
    const { id } = idParams.parse(request.params);
    return manager.waitForLogin(id);
  });

  app.get('/api/accounts/:id/games', async (request) => {
    const { id } = idParams.parse(request.params);
    const { refresh } = gamesQuery.parse(request.query);
    return manager.getOwnedGames(id, refresh === 'true');
  });

  // --- Loglar ---

  app.get('/api/logs', async (request) => {
    const { scope, limit } = logsQuery.parse(request.query);
    return logger.recent(scope, limit);
  });
}

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { APP_NAME, VERSION } from '../config.js';
import type { Core } from '../core.js';
import { forbidden } from '../errors.js';
import { logger } from '../logger.js';
import { idleModes, personaModes } from '../store/account-store.js';
import type { TokenStore } from './token-store.js';

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

/** API token'ları yalnızca yerel panelden yönetilebilir (token'la yeni token üretilemez). */
function requireLocal(request: FastifyRequest) {
  if (request.authKind !== 'local') throw forbidden('Token yönetimi yalnızca yerel panelden yapılabilir');
}

export function registerRoutes(app: FastifyInstance, core: Core, tokens: TokenStore) {
  const { manager } = core;

  app.get('/api/health', async () => ({ ok: true, name: APP_NAME, version: VERSION }));

  app.get('/api/auth/me', async (request) => ({ authKind: request.authKind }));

  // --- API token'ları (yassistant modülü için) ---

  app.get('/api/tokens', async (request) => {
    requireLocal(request);
    return tokens.list();
  });

  app.post('/api/tokens', async (request, reply) => {
    requireLocal(request);
    const { name } = createTokenBody.parse(request.body);
    const created = tokens.create(name);
    logger.log('info', 'api', `API token oluşturuldu: ${created.info.name}`);
    return reply.status(201).send(created);
  });

  app.delete('/api/tokens/:id', async (request) => {
    requireLocal(request);
    const { id } = idParams.parse(request.params);
    tokens.revoke(id);
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

  /** Kart modunda rozet sayfasını hemen yeniden kontrol eder */
  app.post('/api/accounts/:id/cards/check', async (request) => {
    const { id } = idParams.parse(request.params);
    return manager.checkCards(id);
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

import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { Core } from '../core.js';
import { logger, type LogEntry } from '../logger.js';
import type { AccountStatus } from '../steam/account-manager.js';

/** Sunucudan istemciye giden WebSocket mesajları */
export type ServerMessage =
  | { type: 'snapshot'; accounts: AccountStatus[]; logs: LogEntry[] }
  | { type: 'account'; account: AccountStatus }
  | { type: 'removed'; id: string }
  | { type: 'log'; entry: LogEntry };

const PING_INTERVAL_MS = 30_000;
const SNAPSHOT_LOG_LIMIT = 200;

/**
 * /api/ws: bağlanınca tüm hesapların durumu ve son loglar gönderilir; sonrasında her
 * değişiklik ve log satırı anlık iletilir. Kimlik doğrulama HTTP yükseltme isteğinde yapılır.
 */
export function registerWebSocket(app: FastifyInstance, { manager }: Core) {
  app.get('/api/ws', { websocket: true }, (socket: WebSocket) => {
    const send = (message: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    };

    const onAccount = (account: AccountStatus) => send({ type: 'account', account });
    const onRemoved = (id: string) => send({ type: 'removed', id });
    const onLog = (entry: LogEntry) => send({ type: 'log', entry });

    manager.on('account', onAccount);
    manager.on('removed', onRemoved);
    logger.on('entry', onLog);

    let alive = true;
    socket.on('pong', () => (alive = true));
    const ping = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      socket.ping();
    }, PING_INTERVAL_MS);

    socket.on('close', () => {
      clearInterval(ping);
      manager.off('account', onAccount);
      manager.off('removed', onRemoved);
      logger.off('entry', onLog);
    });

    send({ type: 'snapshot', accounts: manager.list(), logs: logger.recent(undefined, SNAPSHOT_LOG_LIMIT) });
  });
}

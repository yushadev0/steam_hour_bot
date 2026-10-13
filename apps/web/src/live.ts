import { useEffect, useState } from 'react';
import { keys, queryClient, upsertAccount } from './api';
import type { Account, LogEntry, ServerMessage } from './types';

const MAX_LOGS = 1000;

export type LiveState = 'connecting' | 'open' | 'closed';

/**
 * /api/ws'e bağlanır ve gelen mesajlarla hesap/log önbelleğini günceller. Bağlantı koparsa
 * artan aralıklarla yeniden bağlanır. Bağlantı durumunu döner.
 */
export function useLiveUpdates(enabled: boolean): LiveState {
  const [state, setState] = useState<LiveState>('connecting');

  useEffect(() => {
    if (!enabled) return;
    let socket: WebSocket | null = null;
    let retryTimer: number | undefined;
    let delay = 1000;
    let disposed = false;

    const connect = () => {
      setState('connecting');
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${protocol}://${location.host}/api/ws`);

      socket.onopen = () => {
        delay = 1000;
        setState('open');
      };
      socket.onmessage = (event) => handle(JSON.parse(event.data) as ServerMessage);
      socket.onclose = () => {
        if (disposed) return;
        setState('closed');
        // Oturum düşmüş olabilir; /me sonucu giriş ekranına yönlendirir
        void queryClient.invalidateQueries({ queryKey: keys.me });
        retryTimer = window.setTimeout(connect, delay);
        delay = Math.min(delay * 2, 15_000);
      };
    };

    connect();
    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, [enabled]);

  return state;
}

function handle(message: ServerMessage) {
  switch (message.type) {
    case 'snapshot':
      queryClient.setQueryData<Account[]>(keys.accounts, message.accounts);
      queryClient.setQueryData<LogEntry[]>(keys.logs, message.logs);
      break;
    case 'account':
      upsertAccount(message.account);
      break;
    case 'removed':
      queryClient.setQueryData<Account[]>(keys.accounts, (list = []) => list.filter((a) => a.id !== message.id));
      break;
    case 'log':
      queryClient.setQueryData<LogEntry[]>(keys.logs, (list = []) => [...list.slice(-(MAX_LOGS - 1)), message.entry]);
      break;
  }
}

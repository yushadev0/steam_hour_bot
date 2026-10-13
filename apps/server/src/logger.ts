import { EventEmitter } from 'node:events';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  time: string;
  level: LogLevel;
  /** Kaynak: 'core' ya da hesap id'si */
  scope: string;
  message: string;
}

const BUFFER_SIZE = 1000;
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Konsola yazar, son kayıtları bellekte tutar ve her kaydı 'entry' olarak yayınlar
 * (Faz 2'de WebSocket üzerinden panele akıtılacak).
 */
class Logger extends EventEmitter<{ entry: [LogEntry] }> {
  private buffer: LogEntry[] = [];
  minLevel: LogLevel = (process.env.SHB_LOG_LEVEL as LogLevel) || 'info';

  log(level: LogLevel, scope: string, message: string) {
    const entry: LogEntry = { time: new Date().toISOString(), level, scope, message };
    this.buffer.push(entry);
    if (this.buffer.length > BUFFER_SIZE) this.buffer.shift();

    if (LEVEL_ORDER[level] >= LEVEL_ORDER[this.minLevel]) {
      const line = `[${new Date(entry.time).toLocaleTimeString()}] ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
      (level === 'error' ? console.error : console.log)(line);
    }
    this.emit('entry', entry);
  }

  /** Son kayıtlar; scope verilirse yalnızca o kaynağınkiler. */
  recent(scope?: string, limit = 200): LogEntry[] {
    const list = scope ? this.buffer.filter((e) => e.scope === scope) : this.buffer;
    return list.slice(-limit);
  }

  scoped(scope: string) {
    return {
      debug: (msg: string) => this.log('debug', scope, msg),
      info: (msg: string) => this.log('info', scope, msg),
      warn: (msg: string) => this.log('warn', scope, msg),
      error: (msg: string) => this.log('error', scope, msg),
    };
  }
}

export type ScopedLogger = ReturnType<Logger['scoped']>;

export const logger = new Logger();

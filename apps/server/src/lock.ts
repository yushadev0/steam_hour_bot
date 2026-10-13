import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Sunucu çalışırken data/server.pid yazılır. CLI, sunucu açıkken hesap dosyalarını
 * değiştirmesin diye bunu kontrol eder (aynı anda iki süreç yazarsa değişiklikler kaybolur).
 */
const pidFile = (dataDir: string) => join(dataDir, 'server.pid');

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: süreç var ama sinyal gönderme yetkimiz yok
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Çalışan bir sunucu varsa pid'ini döner. */
export function runningServerPid(dataDir: string): number | null {
  const file = pidFile(dataDir);
  if (!existsSync(file)) return null;
  const pid = Number(readFileSync(file, 'utf8').trim());
  if (!Number.isInteger(pid) || pid === process.pid || !isAlive(pid)) return null;
  return pid;
}

export function acquireServerLock(dataDir: string) {
  const other = runningServerPid(dataDir);
  if (other) throw new Error(`Sunucu zaten çalışıyor (pid ${other}). Aynı data klasörüyle iki sunucu açılamaz.`);
  writeFileSync(pidFile(dataDir), String(process.pid));
  return () => rmSync(pidFile(dataDir), { force: true });
}

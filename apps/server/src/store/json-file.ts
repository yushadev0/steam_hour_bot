import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function readJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Önce geçici dosyaya yazıp sonra yerine taşır; yazma yarıda kalırsa dosya bozulmaz. */
export function writeJsonAtomic(path: string, data: unknown, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode });
  renameSync(tmp, path);
}

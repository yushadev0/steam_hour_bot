import { join } from 'node:path';
import { z } from 'zod';
import { readJson, writeJsonAtomic } from './json-file.js';

const fileSchema = z.record(z.string(), z.string());

/**
 * AppID → oyun adı (data/app-names.json). Hesapların kütüphanesinden öğrenilir; hesap
 * çevrimdışıyken de panelde ve loglarda oyun adlarını gösterebilmek için saklanır.
 */
export class AppNameCache {
  private readonly file: string;
  private names = new Map<number, string>();

  constructor(dataDir: string) {
    this.file = join(dataDir, 'app-names.json');
    const raw = readJson(this.file);
    if (raw !== undefined) {
      for (const [id, name] of Object.entries(fileSchema.parse(raw))) this.names.set(Number(id), name);
    }
  }

  get(appId: number): string | undefined {
    return this.names.get(appId);
  }

  /** "Counter-Strike 2" ya da bilinmiyorsa "AppID 730" */
  label(appId: number): string {
    return this.names.get(appId) ?? `AppID ${appId}`;
  }

  merge(entries: { appId: number; name: string }[]) {
    let changed = false;
    for (const { appId, name } of entries) {
      if (name && this.names.get(appId) !== name) {
        this.names.set(appId, name);
        changed = true;
      }
    }
    if (changed) writeJsonAtomic(this.file, Object.fromEntries(this.names), 0o644);
  }

  pick(appIds: number[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const id of appIds) {
      const name = this.names.get(id);
      if (name) out[id] = name;
    }
    return out;
  }
}

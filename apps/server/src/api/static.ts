import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { embeddedWebAssets } from '../web-assets.js';

interface Asset {
  type: string;
  body: Buffer;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const typeOf = (path: string) => CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';

function readDir(root: string, dir = root, out = new Map<string, Asset>()) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) readDir(root, full, out);
    else out.set('/' + relative(root, full).split('\\').join('/'), { type: typeOf(full), body: readFileSync(full) });
  }
  return out;
}

/**
 * Panel dosyalarını bulur: SHB_WEB_DIR → binary'ye gömülü dosyalar → apps/web/dist (kaynaktan).
 * Hiçbiri yoksa null döner.
 */
export function loadWebAssets(): { assets: Map<string, Asset>; source: string } | null {
  const envDir = process.env.SHB_WEB_DIR;
  if (envDir && existsSync(join(envDir, 'index.html'))) return { assets: readDir(resolve(envDir)), source: envDir };

  const embedded = Object.entries(embeddedWebAssets);
  if (embedded.length) {
    return {
      assets: new Map(embedded.map(([path, base64]) => [path, { type: typeOf(path), body: Buffer.from(base64, 'base64') }])),
      source: 'gömülü',
    };
  }

  const devDir = fileURLToPath(new URL('../../../web/dist', import.meta.url));
  if (existsSync(join(devDir, 'index.html'))) return { assets: readDir(devDir), source: devDir };
  return null;
}

/** /api dışındaki istekleri panel dosyalarıyla karşılar; bilinmeyen yollar index.html'e düşer (SPA). */
export function registerStatic(app: FastifyInstance, assets: Map<string, Asset> | null) {
  app.get('/*', async (request, reply) => {
    const path = request.url.split('?')[0]!;
    if (path.startsWith('/api/')) return reply.callNotFound();

    if (!assets) {
      return reply
        .type('text/html; charset=utf-8')
        .send('<p>Panel derlenmemiş. Proje kökünde <code>npm run build:web</code> çalıştır ya da API\'yi doğrudan kullan.</p>');
    }

    const asset = assets.get(path) ?? (extname(path) ? undefined : assets.get('/index.html'));
    if (!asset) return reply.callNotFound();

    // Vite dosya adlarına içerik özeti ekler; bu dosyalar değişmez.
    const immutable = path.startsWith('/assets/');
    reply.header('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    return reply.type(asset.type).send(asset.body);
  });
}

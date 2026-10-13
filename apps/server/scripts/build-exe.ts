/**
 * Tek dosyalık çalıştırılabilir üretir (Bun ile çalıştırılır).
 *
 *   bun scripts/build-exe.ts                 → bu platform için
 *   bun scripts/build-exe.ts bun-linux-x64   → çapraz derleme
 */
import type { BunPlugin } from 'bun';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * steam-user lzma'yı `requireWithFallback('lzma-native', 'lzma')` ile dinamik yüklüyor;
 * bundler bunu göremediği için paket binary'ye girmiyor ve açılışta çöküyor.
 * Satırı statik require'a çeviriyoruz (lzma-native native modül, binary'de zaten kullanılamaz).
 */
const staticLzma: BunPlugin = {
  name: 'steam-user-static-lzma',
  setup(build) {
    build.onLoad({ filter: /steam-user[\\/]components[\\/]cdn_compression\.js$/ }, async (args) => {
      const source = await Bun.file(args.path).text();
      const patched = source.replace(
        "requireWithFallback('lzma-native', 'lzma')",
        "require('lzma')",
      );
      if (patched === source) throw new Error('cdn_compression.js beklenen satırı içermiyor; steam-user güncellenmiş olabilir');
      return { contents: patched, loader: 'js' };
    });
  },
};

/**
 * src/web-assets.ts boş bir yer tutucudur; derlemede içeriğini apps/web/dist dosyalarıyla
 * (base64) değiştirerek paneli binary'ye gömüyoruz. Böylece exe tek başına yeterli olur.
 */
function collectWebAssets(): Record<string, string> {
  const root = join(import.meta.dir, '../../web/dist');
  if (!existsSync(join(root, 'index.html'))) {
    throw new Error('Panel derlenmemiş (apps/web/dist yok). Önce proje kökünde: npm run build:web');
  }
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out['/' + relative(root, full).split('\\').join('/')] = readFileSync(full).toString('base64');
    }
  };
  walk(root);
  return out;
}

const webAssets = collectWebAssets();
const embedWeb: BunPlugin = {
  name: 'embed-web-panel',
  setup(build) {
    build.onLoad({ filter: /src[\\/]web-assets\.ts$/ }, () => ({
      contents: `export const embeddedWebAssets = ${JSON.stringify(webAssets)};`,
      loader: 'ts',
    }));
  },
};

const platform = process.platform === 'win32' ? 'windows' : process.platform;
const target = (process.argv[2] ?? `bun-${platform}-${process.arch}`) as Bun.Build.Target;
const outfile = `dist/steam-hour-bot${target.includes('windows') ? '.exe' : target.includes('linux') ? '-linux' : ''}`;

const result = await Bun.build({
  entrypoints: ['src/cli.ts'],
  compile: { target, outfile },
  plugins: [staticLzma, embedWeb],
  minify: true,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`✓ ${outfile} (${target}, panel: ${Object.keys(webAssets).length} dosya)`);

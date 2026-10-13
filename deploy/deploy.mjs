// Sunucuya kurar ya da günceller: repoyu çeker, imajı sunucuda derler, konteyneri yeniden başlatır.
//
//   npm run deploy
//
// Ayarlar proje kökündeki .env dosyasından (git'e girmez) ya da ortam değişkenlerinden okunur:
//   DEPLOY_TARGET=kullanici@sunucu     (zorunlu)
//   DEPLOY_KEY=~/.ssh/anahtar          (isteğe bağlı)
//   DEPLOY_DIR=steam_hour_bot          (sunucudaki klasör, ev dizinine göre)
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

const target = process.env.DEPLOY_TARGET;
if (!target) {
  console.error('DEPLOY_TARGET ayarlanmamış. .env dosyasına DEPLOY_TARGET=kullanici@sunucu ekle.');
  process.exit(1);
}
const key = process.env.DEPLOY_KEY?.replace(/^~/, homedir());
const dir = process.env.DEPLOY_DIR ?? 'steam_hour_bot';
const repo = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();

const status = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
const unpushed = execFileSync('git', ['log', '@{u}..', '--oneline'], { encoding: 'utf8' }).trim();
if (status || unpushed) {
  console.warn('! Yerelde commit edilmemiş ya da pushlanmamış değişiklik var; sunucu GitHub\'daki son hali kullanır.');
}

const script = `set -eo pipefail
if [ ! -d ~/${dir}/.git ]; then
  echo "› ilk kurulum: ${repo}"
  git clone --quiet ${repo} ~/${dir}
fi
cd ~/${dir}
git pull --quiet --ff-only
echo "› sürüm: $(git log -1 --format='%h %s')"
mkdir -p data
[ -f .env ] || printf "SHB_UID=%s\nSHB_GID=%s\n" "$(id -u)" "$(id -g)" > .env
echo "› imaj derleniyor ve konteyner başlatılıyor"
docker compose up -d --build --quiet-pull 2>&1 | grep -vE '^\\s*$' | tail -n 5
for i in $(seq 1 30); do
  if docker exec steam-hour-bot steam-hour-bot health >/dev/null 2>&1; then
    echo "✓ çalışıyor"
    exit 0
  fi
  sleep 2
done
echo "✗ bot ayağa kalkmadı; loglar: docker compose -f ~/${dir}/docker-compose.yml logs" >&2
docker compose logs --tail 30 >&2
exit 1
`;

const sshArgs = [...(key ? ['-i', key] : []), '-o', 'BatchMode=yes', target, script];
console.log(`› ${target}:~/${dir}`);
execFileSync('ssh', sshArgs, { stdio: 'inherit' });

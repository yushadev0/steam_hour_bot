/**
 * Faz 0 deneme betiği: steam-user ile giriş yapıp verilen AppID'leri "oynuyor" gösterir.
 *
 * Kullanım:
 *   npm run spike -- 730 440            → CS2 + TF2 oynuyor görün (Çevrimiçi)
 *   npm run spike -- 730 --invisible    → Görünmez modda
 *
 * İlk girişte kullanıcı adı/şifre sorulur (veya STEAM_ACCOUNT / STEAM_PASSWORD env).
 * Başarılı girişten sonra refresh token data/spike-token-<hesap>.txt dosyasına yazılır;
 * sonraki çalıştırmalarda şifre gerekmez.
 */
import SteamUser from 'steam-user';
import { createInterface } from 'node:readline';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = join(process.cwd(), 'data');
const MAX_GAMES = 32;

function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Yazılan karakterleri ekrana basma
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
        if (s.startsWith(question)) process.stdout.write(question);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

function log(...args: unknown[]) {
  console.log(`[${new Date().toLocaleTimeString()}]`, ...args);
}

async function main() {
  const args = process.argv.slice(2);
  const invisible = args.includes('--invisible');
  const appIds = args.filter((a) => /^\d+$/.test(a)).map(Number);

  if (appIds.length === 0) {
    console.error('En az bir AppID ver. Örn: npm run spike -- 730');
    process.exit(1);
  }
  if (appIds.length > MAX_GAMES) {
    console.error(`Steam aynı anda en fazla ${MAX_GAMES} oyun gösterebilir.`);
    process.exit(1);
  }

  const accountName = process.env.STEAM_ACCOUNT || (await ask('Steam kullanıcı adı: '));
  const tokenFile = join(DATA_DIR, `spike-token-${accountName.toLowerCase()}.txt`);
  mkdirSync(DATA_DIR, { recursive: true });

  const client = new SteamUser({ autoRelogin: true });

  client.on('steamGuard', async (domain, callback, lastCodeWrong) => {
    if (lastCodeWrong) log('Kod hatalı, tekrar dene.');
    const where = domain ? `e-posta (${domain})` : 'mobil Steam Guard';
    log(`Steam Guard kodu gerekli: ${where}. Mobil uygulamadan onaylayabilirsin.`);
    callback(await ask('Kod: '));
  });

  client.on('refreshToken', (token) => {
    writeFileSync(tokenFile, token, { mode: 0o600 });
    log(`Refresh token kaydedildi → ${tokenFile}`);
  });

  client.on('loggedOn', () => {
    log(`Giriş başarılı. SteamID: ${client.steamID?.getSteamID64()}`);
    client.setPersona(invisible ? SteamUser.EPersonaState.Invisible : SteamUser.EPersonaState.Online);
    client.gamesPlayed(appIds);
    log(`Oynuyor gösteriliyor: ${appIds.join(', ')} (${invisible ? 'Görünmez' : 'Çevrimiçi'})`);
    log('Durdurmak için Ctrl+C.');
  });

  client.on('playingState', (blocked, playingApp) => {
    if (blocked) {
      log(`Hesapta başka bir yerde oyun açık (AppID ${playingApp}). Bekleniyor...`);
    } else {
      log('Hesap serbest, oyunlar tekrar gösteriliyor.');
      client.gamesPlayed(appIds);
    }
  });

  client.on('disconnected', (eresult, msg) => {
    log(`Bağlantı koptu (${msg ?? eresult}). Otomatik yeniden bağlanılacak.`);
  });

  client.on('error', (err) => {
    const eresult = (err as Error & { eresult?: number }).eresult;
    log(`Hata: ${err.message} (EResult ${eresult})`);
    if (eresult === SteamUser.EResult.LoggedInElsewhere) {
      log('Hesaba başka bir yerden oyunla giriş yapıldı.');
    }
    if (existsSync(tokenFile) && eresult === SteamUser.EResult.InvalidPassword) {
      log('Kayıtlı token geçersiz olabilir; dosyayı silip tekrar dene.');
    }
    process.exit(1);
  });

  if (existsSync(tokenFile)) {
    log('Kayıtlı refresh token ile giriş yapılıyor...');
    client.logOn({ refreshToken: readFileSync(tokenFile, 'utf8').trim() });
  } else {
    const password = process.env.STEAM_PASSWORD || (await ask('Şifre: ', true));
    log('Şifre ile giriş yapılıyor...');
    client.logOn({ accountName, password });
  }

  const shutdown = () => {
    log('Kapatılıyor...');
    client.gamesPlayed([]);
    client.logOff();
    setTimeout(() => process.exit(0), 1000);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Giriş noktası. Komut verilmezse bot + panel/API sunucusu başlar (exe'ye çift tıklama dahil);
 * diğer komutlar sunucuya gerek kalmadan hesapları yönetir.
 */
import { createInterface } from 'node:readline';
import { APP_NAME, VERSION } from './config.js';
import { createCore } from './core.js';
import { runningServerPid } from './lock.js';
import { logger } from './logger.js';
import { serve } from './serve.js';
import { runSmokeTest } from './smoke.js';
import { personaModes, type PersonaMode } from './store/account-store.js';
import type { AccountManager, AccountStatus } from './steam/account-manager.js';

const USAGE = `${APP_NAME} v${VERSION}

Kullanım: steam-hour-bot [komut] [argümanlar]
(kaynaktan: npm start / npm run cli -- <komut>)

  (komutsuz) / serve               Botu ve web panelini başlatır
  list                             Hesapları listeler
  add <kullanıcı>                  Hesap ekler (şifre ve Steam Guard sorulur)
  login <kullanıcı>                Token'ı geçersiz hesaba yeniden giriş yapar
  games <kullanıcı> [appid...]     Oyun listesini ayarlar (boş bırakılırsa temizler)
  persona <kullanıcı> online|invisible
  enable <kullanıcı> / disable <kullanıcı>
  remove <kullanıcı>               Hesabı ve kayıtlı token'ı siler
  smoke                            Steam bağlantı testi (anonim giriş, hesap gerekmez)

Ortam değişkenleri: SHB_DATA_DIR, SHB_HOST (varsayılan 127.0.0.1), SHB_PORT (8090),
SHB_ADMIN_PASSWORD, SHB_SECRET
`;

/** Hesap verisini değiştiren komutlar; sunucu açıkken çalıştırılamaz. */
const MUTATING = new Set(['add', 'login', 'games', 'persona', 'enable', 'disable', 'remove']);

function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
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

function printAccounts(accounts: AccountStatus[]) {
  if (!accounts.length) {
    console.log('Henüz hesap yok. Eklemek için: add <kullanıcı>');
    return;
  }
  console.table(
    accounts.map((a) => ({
      hesap: a.accountName,
      isim: a.personaName ?? '-',
      etkin: a.enabled ? 'evet' : 'hayır',
      görünürlük: a.persona,
      oyunlar: a.games.join(', ') || '-',
      token: a.hasToken ? 'var' : 'YOK',
    })),
  );
}

/** Şifre ile giriş yapar; Steam Guard istenirse terminalden kod sorar. */
async function interactiveLogin(
  manager: AccountManager,
  accountName: string,
  start: (password: string) => Promise<AccountStatus>,
): Promise<AccountStatus> {
  let status = await start(await ask('Şifre: ', true));
  while (status.session.state === 'awaiting_guard' || status.session.state === 'connecting') {
    if (status.session.state === 'connecting') {
      status = await manager.waitForLogin(accountName);
      continue;
    }
    const code = await ask(
      status.session.guard?.lastCodeWrong
        ? 'Kod hatalı, tekrar gir: '
        : 'Steam Guard kodu (mobil uygulamadan onayladıysan boş bırakıp Enter): ',
    );
    status = code ? await manager.submitGuardCode(accountName, code) : await manager.waitForLogin(accountName);
  }
  return status;
}

// steam-user'ın bağımlılıklarındaki url.parse kullanımı her açılışta uyarı basıyor.
process.noDeprecation = true;

async function main() {
  const [command = 'serve', ...args] = process.argv.slice(2);
  const name = args[0];
  const needName = () => {
    if (!name) throw new Error('Kullanıcı adı gerekli.\n\n' + USAGE);
    return name;
  };

  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE);
    return;
  }
  if (command === 'smoke') {
    console.log(`✓ ${await runSmokeTest()}`);
    setTimeout(() => process.exit(0), 500);
    return;
  }

  // Yalnızca sunucu ve giriş yapan komutlarda log'ları göster
  if (!['serve', 'add', 'login'].includes(command)) logger.minLevel = 'warn';
  const core = createCore();
  const { manager } = core;

  if (MUTATING.has(command)) {
    const pid = runningServerPid(core.config.dataDir);
    if (pid) throw new Error(`Sunucu çalışıyor (pid ${pid}). Değişiklikleri web panelinden yap ya da önce sunucuyu durdur.`);
  }

  switch (command) {
    case 'serve':
      await serve(core);
      return; // süreç açık kalır
    case 'list':
      printAccounts(manager.list());
      break;
    case 'add': {
      const accountName = needName();
      const status = await interactiveLogin(manager, accountName, (pw) => manager.addAccount(accountName, pw));
      console.log(`\n✓ ${status.personaName ?? status.accountName} eklendi. Oyun eklemek için: games ${status.accountName} 730`);
      manager.stopAll();
      break;
    }
    case 'login': {
      const accountName = needName();
      await interactiveLogin(manager, accountName, (pw) => manager.relogin(accountName, pw));
      console.log('\n✓ Giriş başarılı, token yenilendi.');
      manager.stopAll();
      break;
    }
    case 'games':
      printAccounts([manager.updateAccount(needName(), { games: args.slice(1).map(Number) })]);
      break;
    case 'persona': {
      const persona = args[1] as PersonaMode;
      if (!personaModes.includes(persona)) throw new Error('Görünürlük online ya da invisible olmalı.');
      printAccounts([manager.updateAccount(needName(), { persona })]);
      break;
    }
    case 'enable':
    case 'disable':
      printAccounts([manager.updateAccount(needName(), { enabled: command === 'enable' })]);
      break;
    case 'remove':
      manager.removeAccount(manager.require(needName()).id);
      console.log('✓ Hesap silindi.');
      break;
    default:
      throw new Error(`Bilinmeyen komut: ${command}\n\n${USAGE}`);
  }
  setTimeout(() => process.exit(0), 500);
}

main().catch((err: Error) => {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
});

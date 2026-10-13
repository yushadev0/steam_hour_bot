/**
 * Komut satırı arayüzü. Web paneli (Faz 3) gelene kadar hesapları buradan yönetiyoruz;
 * panel geldikten sonra da sunucuda hızlı işler için kalacak.
 *
 * Not: 'run' çalışırken yapılan değişiklikler (games, persona...) ancak yeniden başlatınca
 * etkili olur. Canlı değişiklik Faz 2'deki API ile gelecek.
 */
import { createInterface } from 'node:readline';
import { APP_NAME } from './config.js';
import { createCore } from './core.js';
import { logger } from './logger.js';
import { runSmokeTest } from './smoke.js';
import { personaModes, type PersonaMode } from './store/account-store.js';
import type { AccountManager, AccountStatus } from './steam/account-manager.js';

const USAGE = `${APP_NAME}

Kullanım: npm run cli -- <komut> [argümanlar]

  run                              Etkin tüm hesapları başlatır (Ctrl+C ile durur)
  list                             Hesapları listeler
  add <kullanıcı>                  Hesap ekler (şifre ve Steam Guard sorulur)
  login <kullanıcı>                Token'ı geçersiz hesaba yeniden giriş yapar
  games <kullanıcı> [appid...]     Oyun listesini ayarlar (boş bırakılırsa temizler)
  persona <kullanıcı> online|invisible
  enable <kullanıcı> / disable <kullanıcı>
  remove <kullanıcı>               Hesabı ve kayıtlı token'ı siler
  smoke                            Steam bağlantı testi (anonim giriş, hesap gerekmez)
`;

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
async function interactiveLogin(manager: AccountManager, accountName: string, login: (password: string) => Promise<AccountStatus>) {
  const password = await ask('Şifre: ', true);
  let prompting = false;
  const onAccount = async (status: AccountStatus) => {
    if (status.accountName.toLowerCase() !== accountName.toLowerCase()) return;
    if (status.session.state !== 'awaiting_guard' || prompting) return;
    prompting = true;
    const code = await ask('Steam Guard kodu (mobil onay verdiysen boş bırakıp bekle): ');
    prompting = false;
    if (code) manager.submitGuardCode(accountName, code);
  };
  manager.on('account', onAccount);
  try {
    return await login(password);
  } finally {
    manager.off('account', onAccount);
  }
}

// steam-user'ın bağımlılıklarındaki url.parse kullanımı her açılışta uyarı basıyor.
process.noDeprecation = true;

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const name = args[0];
  const needName = () => {
    if (!name) throw new Error('Kullanıcı adı gerekli.\n\n' + USAGE);
    return name;
  };

  if (!command || command === 'help' || command === '--help') {
    console.log(USAGE);
    return;
  }

  if (command === 'smoke') {
    console.log(`✓ ${await runSmokeTest()}`);
    setTimeout(() => process.exit(0), 500);
    return;
  }

  // Yalnızca 'run' ve giriş yapan komutlarda log'ları göster
  if (!['run', 'add', 'login'].includes(command)) logger.minLevel = 'warn';
  const { manager } = createCore();

  switch (command) {
    case 'run': {
      manager.startAll();
      if (!manager.list().some((a) => a.enabled)) logger.log('warn', 'core', 'Etkin hesap yok.');
      const shutdown = () => {
        manager.stopAll();
        setTimeout(() => process.exit(0), 1000);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      return; // süreç açık kalır
    }
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
      manager.removeAccount(needName());
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

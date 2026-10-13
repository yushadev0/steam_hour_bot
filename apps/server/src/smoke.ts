/**
 * Smoke test: Steam'e anonim giriş yapıp çıkar. Hesap bilgisi gerektirmez.
 * Bağlantı, protobuf ve kripto katmanlarının çalıştığını (Node ve Bun binary'de) doğrular.
 */
import SteamUser from 'steam-user';

const client = new SteamUser({ autoRelogin: false });
const timeout = setTimeout(() => {
  console.error('FAIL: 30 sn içinde giriş yapılamadı');
  process.exit(1);
}, 30_000);

client.on('loggedOn', () => {
  clearTimeout(timeout);
  console.log(`OK: anonim giriş başarılı (${client.steamID?.getSteamID64()}), runtime: ${process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}`}`);
  client.logOff();
  setTimeout(() => process.exit(0), 500);
});

client.on('error', (err) => {
  clearTimeout(timeout);
  console.error(`FAIL: ${err.message}`);
  process.exit(1);
});

client.logOn({ anonymous: true });

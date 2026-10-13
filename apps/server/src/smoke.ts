import SteamUser from 'steam-user';

/**
 * Steam'e anonim giriş yapıp çıkar. Hesap bilgisi gerektirmez; bağlantı, protobuf ve
 * kripto katmanlarının (Node'da ve derlenmiş binary'de) çalıştığını doğrular.
 */
export function runSmokeTest(timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = new SteamUser({ autoRelogin: false });
    const timer = setTimeout(() => {
      client.removeAllListeners();
      reject(new Error(`${timeoutMs / 1000} sn içinde giriş yapılamadı`));
    }, timeoutMs);

    client.on('loggedOn', () => {
      clearTimeout(timer);
      const runtime = process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}`;
      resolve(`anonim giriş başarılı (${client.steamID?.getSteamID64()}), runtime: ${runtime}`);
      client.logOff();
    });

    client.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    client.logOn({ anonymous: true });
  });
}

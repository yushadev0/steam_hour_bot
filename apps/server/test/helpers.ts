import { EventEmitter } from 'node:events';
import SteamUser from 'steam-user';
import { logger } from '../src/logger.js';

// Testlerde log çıktısı istemiyoruz
logger.log = () => {};

/** steam-user'ın kullandığımız kısmını taklit eden sahte istemci. */
export class FakeClient extends EventEmitter {
  logOnCalls: unknown[] = [];
  played: number[][] = [];
  personas: number[] = [];
  steamID = { getSteamID64: () => '76561190000000000' };
  /** logOn çağrıldığında çalışır (senaryoyu test belirler) */
  onLogOn: ((client: FakeClient, details: unknown) => void) | null = null;

  logOn(details: unknown) {
    this.logOnCalls.push(details);
    this.onLogOn?.(this, details);
  }
  gamesPlayed(apps: number[]) {
    this.played.push(apps);
  }
  setPersona(state: number) {
    this.personas.push(state);
  }
  async getUserOwnedApps() {
    return {
      app_count: 2,
      apps: [
        {
          appid: 440,
          name: 'Team Fortress 2',
          playtime_forever: 60,
          img_icon_url: 'https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/440/e3f595a92552da3d664ad00277fad2107345f743.jpg',
        },
        { appid: 730, name: 'Counter-Strike 2', playtime_forever: 1200, img_icon_url: '' },
      ],
    };
  }
  async getPersonas() {
    return { personas: { '76561190000000000': { avatar_url_medium: 'https://avatars.example/a_medium.jpg' } } };
  }
  webLogOn() {
    setImmediate(() => this.emit('webSession', 'session-id', ['steamLoginSecure=fake']));
  }
  logOff() {}
  fail(eresult: number) {
    this.emit('error', Object.assign(new Error(SteamUser.EResult[eresult]), { eresult }));
  }
}

export function fakeClientFactory(clients: FakeClient[], setup?: (client: FakeClient) => void) {
  return () => {
    const client = new FakeClient();
    setup?.(client);
    clients.push(client);
    return client as unknown as SteamUser;
  };
}

# yusha's Steam Hour Bot — Plan

Headless Steam saat botu. Seçilen oyunları (AppID) oynuyormuş gibi gösterir.
Windows ve Linux'ta çalışır. Steam girişi zorunludur.

## Kararlar

- **Çoklu hesap**: her hesabın kendi oyun listesi ve modu var.
- **Web arayüzü**: React + Vite. İlk öncelik.
- **Dağıtım**: Docker (Linux/VPS) + Windows için standalone `.exe`.
- **Ekstralar**: Çevrimiçi/Görünmez modu, kart düşürme modu.
- **İleri aşama**: yassistant için kullanıcının kendi Steam hesabına özel modül. API dışarıdan
  tüketilebilir (token ile) olacak şekilde tasarlanır.

## Teknik yığın

| Katman | Seçim |
|---|---|
| Steam bağlantısı | `steam-user` |
| Backend | Node.js + TypeScript + Fastify |
| Canlı durum | WebSocket |
| Veri | JSON dosyaları (`data/`), native modül yok |
| Frontend | React + Vite + TypeScript, TanStack Query, Tailwind v4 (shadcn yerine elle yazılmış hafif bileşenler) |
| Paketleme | Docker multi-stage; `.exe` için `bun build --compile` (panel gömülü) |

## Proje yapısı

```
steam_hour_bot/
├── apps/
│   ├── server/          → Fastify + bot çekirdeği
│   │   ├── steam/       → hesap oturumu, idler, kart modu, yeniden bağlanma
│   │   ├── api/         → REST + WebSocket
│   │   └── store/       → JSON kalıcılık, token şifreleme
│   └── web/             → React + Vite paneli
├── Dockerfile
├── docker-compose.yml
└── data/                → (volume) hesaplar, şifreli token'lar, ayarlar
```

## Tasarım ilkeleri

1. **Şifre saklanmaz.** Şifre yalnızca ilk girişte kullanılır, sonra refresh token saklanır
   (`.env`'deki anahtarla şifrelenmiş).
2. **Steam Guard panelden.** Kod istenirse panelde kod kutusu açılır; mobil onay da desteklenir.
3. **Panel girişi zorunlu** (admin şifresi). yassistant için ayrıca API token.
4. **Başka yerden oyuna girilirse** bot geri çekilir, oyun kapanınca devam eder.
5. **Kart modu:** resmi API yok; `/badges` sayfası okunur. Kartı kalan oyunlar sırayla kasılır,
   ~15 dk'da bir kontrol, bitince sıradakine geçilir.
6. **Sınır:** aynı anda en fazla 32 oyun.
7. Oyunlar **AppID** ile seçilir (ör. CS2 = 730); panelde hesaptaki oyunlar isim/ikonla listelenir.

## Fazlar

| Faz | İçerik | Durum |
|---|---|---|
| 0. Deneme | `steam-user` ile giriş + oyun gösterme; Bun `.exe` derlemesinin doğrulanması | ✅ |
| 1. Çekirdek | Hesap yöneticisi, giriş/Guard akışı, idler, yeniden bağlanma, kalıcılık, CLI | ✅ |
| 2. API | REST + WebSocket, panel girişi, API token ([docs/API.md](docs/API.md)) | ✅ |
| 3. Web paneli | Giriş, hesap listesi/durum, hesap ekleme, oyun seçici, mod ayarları, canlı log; panel exe'ye gömülü | ✅ |
| 4. Kart modu | Rozet sayfası okuma, sıralı kasma, otomatik geçiş | |
| 5. Dağıtım | Dockerfile, compose, Windows `.exe`, README | |
| 6. yassistant | İleri aşama | |

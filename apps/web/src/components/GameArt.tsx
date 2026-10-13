import { Gamepad2 } from 'lucide-react';
import { useEffect, useState } from 'react';

/** CDN hiç yanıt vermezse onError gelmez; bu sürede yüklenmeyen görselde sıradakine geçilir. */
const LOAD_TIMEOUT_MS = 6000;

/**
 * Steam mağazasının yatay kapak görselleri; yalnızca AppID ile alınabilir (kütüphanede olmasa da).
 * shared.akamai bazı dosyalarda yanıt vermeyebiliyor, o yüzden önce cdn.akamai denenir.
 */
const capsuleUrls = (appId: number) => [
  `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/capsule_184x69.jpg`,
  `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/capsule_184x69.jpg`,
  `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/header.jpg`,
];

/**
 * Sırayla kaynakları dener; yüklenemeyen görselde bir sonrakine geçer, hiçbiri yoksa
 * boş bir kutu gösterir (tarayıcının bozuk resim simgesi görünmez).
 */
function SteamImage({
  sources,
  width,
  height,
  lazy,
}: {
  sources: (string | null)[];
  width: number;
  height: number;
  /** Uzun listelerde ekrana gelince yükle; bu durumda zaman aşımı uygulanmaz (yükleme başlamamış olabilir) */
  lazy?: boolean;
}) {
  const list = sources.filter((s): s is string => !!s);
  const [index, setIndex] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const src = list[index];

  useEffect(() => {
    if (!src || loaded || lazy) return;
    const timer = window.setTimeout(() => setIndex((i) => i + 1), LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [src, loaded, lazy]);

  if (!src) {
    return (
      <span className="flex shrink-0 items-center justify-center rounded-[2px] bg-raised text-muted/60" style={{ width, height }}>
        <Gamepad2 size={Math.min(width, height) * 0.5} />
      </span>
    );
  }
  return (
    <img
      key={src}
      src={src}
      alt=""
      loading={lazy ? 'lazy' : 'eager'}
      width={width}
      height={height}
      onLoad={() => setLoaded(true)}
      onError={() => setIndex((i) => i + 1)}
      className="shrink-0 rounded-[2px] bg-raised object-cover"
      style={{ width, height }}
    />
  );
}

/** Kare oyun ikonu (kütüphane listeleri); ikon yoksa kapak görselinden kırpılır. */
export function GameIcon({ appId, iconUrl, size = 32 }: { appId: number; iconUrl: string | null; size?: number }) {
  return <SteamImage sources={[iconUrl, ...capsuleUrls(appId)]} width={size} height={size} lazy />;
}

/** Steam kütüphanesindeki gibi yatay kapak; yoksa ikon. */
export function GameCapsule({ appId, iconUrl, width = 120 }: { appId: number; iconUrl: string | null; width?: number }) {
  return <SteamImage sources={[...capsuleUrls(appId), iconUrl]} width={width} height={Math.round((width * 69) / 184)} />;
}

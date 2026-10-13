import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Plus, Settings } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, ApiError, keys } from './api';
import { AccountDetail } from './components/AccountDetail';
import { AccountList } from './components/AccountList';
import { AddAccountDialog } from './components/AddAccountDialog';
import { Logo } from './components/Logo';
import { SettingsDialog } from './components/SettingsDialog';
import { Spinner } from './components/ui';
import { useI18n, type Lang } from './i18n';
import { useLiveUpdates, type LiveState } from './live';
import type { Account } from './types';

export function App() {
  const { t } = useI18n();
  const me = useQuery({ queryKey: keys.me, queryFn: api.me });
  if (me.isPending) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bar text-muted">
        <Spinner size={28} />
      </div>
    );
  }
  if (me.error) {
    const denied = me.error instanceof ApiError && (me.error.status === 401 || me.error.status === 403);
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-bar p-4 text-center">
        <Logo size="lg" />
        <p className="max-w-md">
          {denied
            ? t(
                'Panel yalnızca botun çalıştığı bilgisayardan açılabilir. Adres çubuğunda 127.0.0.1 ya da localhost kullan.',
                'The panel only opens on the computer the bot runs on. Use 127.0.0.1 or localhost in the address bar.',
              )
            : t('Sunucuya ulaşılamadı. Bot çalışıyor mu?', 'Could not reach the server. Is the bot running?')}
        </p>
        {!denied && (
          <button className="btn" onClick={() => me.refetch()}>
            {t('Tekrar dene', 'Try again')}
          </button>
        )}
      </div>
    );
  }
  return <Panel />;
}

const SELECTED_KEY = 'shb:selected';

function readSelected() {
  try {
    return localStorage.getItem(SELECTED_KEY);
  } catch {
    return null;
  }
}

function Panel() {
  const { t } = useI18n();
  const live = useLiveUpdates(true);
  // Hesaplar WebSocket snapshot'ıyla gelir
  const { data: accounts } = useQuery<Account[]>({ queryKey: keys.accounts, enabled: false });
  const [selectedId, setSelectedId] = useState<string | null>(readSelected);
  // Dar ekranda liste ve detay ayrı görünümlerdir
  const [mobileDetail, setMobileDetail] = useState(false);
  const [adding, setAdding] = useState(false);
  const [settings, setSettings] = useState(false);

  const selected = accounts?.find((a) => a.id === selectedId) ?? accounts?.[0];

  useEffect(() => {
    try {
      if (selected) localStorage.setItem(SELECTED_KEY, selected.id);
    } catch {
      // Tarayıcı depolaması kapalıysa seçim hatırlanmaz
    }
  }, [selected?.id]);

  const select = (id: string) => {
    setSelectedId(id);
    setMobileDetail(true);
  };

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 bg-bar px-4">
        <Logo />
        <div className="flex-1" />
        <ConnectionBadge state={live} />
        <LanguageSwitch />
        <button className="btn-ghost" onClick={() => setSettings(true)} aria-label={t('Ayarlar', 'Settings')} title={t('Ayarlar', 'Settings')}>
          <Settings size={18} />
        </button>
      </header>

      {!accounts ? (
        <div className="flex flex-1 items-center justify-center text-muted">
          <Spinner size={24} />
        </div>
      ) : accounts.length === 0 ? (
        <Welcome onAdd={() => setAdding(true)} />
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className={`w-full shrink-0 bg-[#1a212c] md:block md:w-72 ${mobileDetail ? 'hidden' : ''}`}>
            <AccountList accounts={accounts} selectedId={selected?.id ?? null} onSelect={select} onAdd={() => setAdding(true)} />
          </aside>
          <main className={`min-w-0 flex-1 overflow-y-auto md:block ${mobileDetail ? '' : 'hidden'}`}>
            <button className="btn-ghost m-3 mb-0 md:hidden" onClick={() => setMobileDetail(false)}>
              <ArrowLeft size={16} />
              {t('Hesaplar', 'Accounts')}
            </button>
            {selected && (
              <AccountDetail
                key={selected.id}
                account={selected}
                onRemoved={() => {
                  setSelectedId(null);
                  setMobileDetail(false);
                }}
              />
            )}
          </main>
        </div>
      )}

      <AddAccountDialog open={adding} onClose={() => setAdding(false)} onAdded={select} />
      <SettingsDialog open={settings} onClose={() => setSettings(false)} />
    </div>
  );
}

const LANGS: { value: Lang; label: string; name: string }[] = [
  { value: 'tr', label: 'TR', name: 'Türkçe' },
  { value: 'en', label: 'EN', name: 'English' },
];

function LanguageSwitch() {
  const { lang, setLang, t } = useI18n();
  return (
    <div role="radiogroup" aria-label={t('Dil', 'Language')} className="flex rounded-sm bg-surface p-0.5 text-xs font-semibold">
      {LANGS.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={lang === option.value}
          aria-label={option.name}
          title={option.name}
          onClick={() => setLang(option.value)}
          className={`rounded-[2px] px-2 py-1 transition-colors ${
            lang === option.value ? 'bg-raised text-bright' : 'text-muted hover:text-text'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function ConnectionBadge({ state }: { state: LiveState }) {
  const { t } = useI18n();
  if (state === 'open') {
    return (
      <span className="flex items-center gap-1.5 text-sm text-muted" title={t('Canlı güncellemeler açık', 'Live updates on')}>
        <span className="h-2 w-2 rounded-full bg-ingame" />
        <span className="hidden sm:inline">{t('Bağlı', 'Connected')}</span>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-sm text-warn" role="status">
      <Spinner size={14} />
      <span className="hidden sm:inline">
        {state === 'connecting'
          ? t('Bağlanıyor', 'Connecting')
          : t('Sunucuyla bağlantı koptu, yeniden deneniyor', 'Lost connection to the server, retrying')}
      </span>
    </span>
  );
}

function Welcome({ onAdd }: { onAdd: () => void }) {
  const { t } = useI18n();
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-semibold text-bright">{t('İlk Steam hesabını ekle', 'Add your first Steam account')}</h1>
        <p className="mt-3 text-muted">
          {t(
            'Hesabına bir kez giriş yap, kasmak istediğin oyunları seç. Bot bu bilgisayar kapanana kadar o oyunları oynuyor gösterir; sen başka yerde oyun açarsan kenara çekilir.',
            'Sign in once and pick the games to idle. The bot shows them as played for as long as this computer is on, and steps aside whenever you start a game elsewhere.',
          )}
        </p>
        <button className="btn-primary mt-6 px-6 py-2.5" onClick={onAdd}>
          <Plus size={18} />
          {t('Hesap ekle', 'Add account')}
        </button>
      </div>
    </main>
  );
}

import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, Clock, Eye, EyeOff, Gamepad2, Info, KeyRound, Pencil, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, keys, upsertAccount } from '../api';
import { describeStatus, displayName, formatDuration, formatPlaytime, gameName, toneText, useNow, useOwnedGames } from '../status';
import { MAX_GAMES, type Account, type LogEntry, type OwnedGame, type PersonaMode } from '../types';
import { GameCapsule } from './GameArt';
import { GamePickerDialog } from './GamePickerDialog';
import { GuardForm } from './GuardForm';
import { Avatar, Dialog, ErrorText, Segmented, Spinner, Switch, useToast } from './ui';

export function AccountDetail({ account, onRemoved }: { account: Account; onRemoved: () => void }) {
  const owned = useOwnedGames(account);
  const now = useNow();
  const status = describeStatus(account, owned.data, now);
  const toast = useToast();
  const [picking, setPicking] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const update = useMutation({
    mutationFn: (patch: Parameters<typeof api.updateAccount>[1]) => api.updateAccount(account.id, patch),
    onSuccess: upsertAccount,
    onError: (err) => toast(err.message, 'error'),
  });

  const removeGame = (appId: number) => update.mutate({ games: account.games.filter((id) => id !== appId) });
  const idling = account.session.state === 'running' && account.games.length > 0;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 p-4 sm:p-6">
      {/* Profil başlığı: arkadaşlarının seni gördüğü hal */}
      <section className="flex flex-wrap items-center gap-4 rounded-md bg-surface p-4 sm:p-5">
        <Avatar src={account.avatarUrl} name={displayName(account)} tone={status.tone} size={72} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-semibold text-bright">{displayName(account)}</h1>
          {account.personaName && <p className="text-sm text-muted">{account.accountName}</p>}
          <p className={`mt-1 font-medium ${toneText[status.tone]}`}>
            {status.text}
            {account.persona === 'invisible' && idling && <span className="font-normal text-muted"> (görünmez)</span>}
          </p>
          {idling && account.session.runningSince && (
            <p className="mt-0.5 flex items-center gap-1.5 text-sm text-muted tabular-nums">
              <Clock size={14} />
              Bu oturumda {formatDuration(now - Date.parse(account.session.runningSince))}
            </p>
          )}
        </div>
        <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto sm:flex-col sm:items-end">
          <label className="flex items-center gap-2.5 text-sm">
            <span className={account.enabled ? 'text-bright' : 'text-muted'}>{account.enabled ? 'Bot açık' : 'Bot kapalı'}</span>
            <Switch
              label="Bu hesap için botu aç/kapat"
              checked={account.enabled}
              disabled={update.isPending}
              onChange={(enabled) => update.mutate({ enabled })}
            />
          </label>
          <Segmented<PersonaMode>
            label="Steam'de görünürlük"
            value={account.persona}
            disabled={update.isPending}
            onChange={(persona) => update.mutate({ persona })}
            options={[
              { value: 'online', label: 'Çevrimiçi', icon: <Eye size={15} /> },
              { value: 'invisible', label: 'Görünmez', icon: <EyeOff size={15} /> },
            ]}
          />
        </div>
      </section>

      <Attention account={account} now={now} />

      {/* Kasılan oyunlar */}
      <section className="rounded-md bg-surface">
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
          <h2 className="font-semibold text-bright">
            Kasılan oyunlar <span className="font-normal text-muted tabular-nums">{account.games.length}/{MAX_GAMES}</span>
          </h2>
          <button className="btn" onClick={() => setPicking(true)}>
            <Pencil size={15} />
            Oyunları düzenle
          </button>
        </header>
        {account.games.length ? (
          <ul className="divide-y divide-line/60">
            {account.games.map((appId) => (
              <GameItem
                key={appId}
                appId={appId}
                name={gameName(appId, account, owned.data)}
                game={owned.data?.find((g) => g.appId === appId)}
                active={idling}
                onRemove={() => removeGame(appId)}
                disabled={update.isPending}
              />
            ))}
          </ul>
        ) : (
          <div className="flex flex-col items-center px-4 py-10 text-center">
            <Gamepad2 size={32} className="text-muted" />
            <p className="mt-3 text-bright">Henüz oyun seçmedin</p>
            <p className="mt-1 max-w-sm text-sm text-muted">Kütüphanenden en fazla {MAX_GAMES} oyun seç; bot hepsini aynı anda oynuyor gösterir.</p>
            <button className="btn-primary mt-4" onClick={() => setPicking(true)}>
              Oyun seç
            </button>
          </div>
        )}
      </section>

      <ActivityLog accountId={account.id} />

      <div className="flex justify-end">
        <button className="btn-ghost text-sm hover:text-danger" onClick={() => setConfirmDelete(true)}>
          <Trash2 size={15} />
          Hesabı kaldır
        </button>
      </div>

      <GamePickerDialog account={account} open={picking} onClose={() => setPicking(false)} />
      <DeleteDialog account={account} open={confirmDelete} onClose={() => setConfirmDelete(false)} onRemoved={onRemoved} />
    </div>
  );
}

function GameItem({
  appId,
  name,
  game,
  active,
  onRemove,
  disabled,
}: {
  appId: number;
  name: string;
  game: OwnedGame | undefined;
  active: boolean;
  onRemove: () => void;
  disabled: boolean;
}) {
  return (
    <li className="group flex items-center gap-3 px-4 py-2.5 sm:px-5">
      <GameCapsule appId={appId} iconUrl={game?.iconUrl ?? null} />
      <div className="min-w-0 flex-1">
        <p className={`truncate ${active ? 'text-ingame' : 'text-bright'}`}>{name}</p>
        <p className="text-xs text-muted">
          {game ? `Toplam ${formatPlaytime(game.playtimeMinutes)}` : name === `AppID ${appId}` ? 'Hesap bağlanınca oyun bilgisi gelir' : `AppID ${appId}`}
        </p>
      </div>
      <button
        className="btn-ghost opacity-60 group-hover:opacity-100 focus-visible:opacity-100"
        onClick={onRemove}
        disabled={disabled}
        aria-label={`${name} oyununu listeden çıkar`}
        title="Listeden çıkar"
      >
        <X size={16} />
      </button>
    </li>
  );
}

/** Hesabın dikkat gerektiren durumu: giriş, Guard, hata ya da bekleme. */
function Attention({ account, now }: { account: Account; now: number }) {
  const { session } = account;

  if (session.state === 'awaiting_guard') {
    return (
      <Banner tone="warn" icon={<KeyRound size={18} />} title="Steam Guard kodu gerekli">
        <GuardForm account={account} />
      </Banner>
    );
  }
  if (session.state === 'needs_login') {
    return (
      <Banner tone="error" icon={<KeyRound size={18} />} title="Steam oturumu sona erdi">
        <p className="mb-3 text-sm">
          Kayıtlı oturum anahtarı artık geçerli değil{session.lastError ? ` (${session.lastError})` : ''}. Devam etmek için şifrenle tekrar giriş yap.
        </p>
        <ReloginForm account={account} />
      </Banner>
    );
  }
  if (session.state === 'waiting_retry') {
    const left = session.retryAt ? Math.max(0, Date.parse(session.retryAt) - now) : 0;
    return (
      <Banner tone="warn" icon={<AlertTriangle size={18} />} title={`Steam'e bağlanılamadı, ${Math.ceil(left / 1000)} sn sonra tekrar denenecek`}>
        {session.lastError && <p className="text-sm text-muted">{session.lastError}</p>}
      </Banner>
    );
  }
  if (session.state === 'blocked') {
    return (
      <Banner tone="info" icon={<Info size={18} />} title="Bu hesapla şu an başka bir yerde oynanıyor">
        <p className="text-sm text-muted">Steam aynı anda tek oyun oturumuna izin verir. Oyunu kapattığında bot kaldığı yerden devam eder.</p>
      </Banner>
    );
  }
  return null;
}

function Banner({
  tone,
  icon,
  title,
  children,
}: {
  tone: 'warn' | 'error' | 'info';
  icon: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  const color = { warn: 'border-warn text-warn', error: 'border-danger text-danger', info: 'border-online text-online' }[tone];
  return (
    <section className={`rounded-md border-l-4 bg-surface p-4 sm:p-5 ${color}`}>
      <h2 className="flex items-center gap-2 font-semibold">
        {icon}
        {title}
      </h2>
      {children && <div className="mt-3 text-text">{children}</div>}
    </section>
  );
}

function ReloginForm({ account }: { account: Account }) {
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: () => api.relogin(account.id, password),
    onSuccess: (result) => {
      upsertAccount(result);
      setPassword('');
    },
  });
  return (
    <form
      className="flex flex-wrap gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        login.mutate();
      }}
    >
      <input
        className="input min-w-48 flex-1"
        type="password"
        placeholder={`${account.accountName} şifresi`}
        aria-label="Steam şifresi"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <button className="btn-primary" disabled={!password || login.isPending}>
        {login.isPending && <Spinner />}
        Giriş yap
      </button>
      {login.error && (
        <div className="w-full">
          <ErrorText>{login.error.message}</ErrorText>
        </div>
      )}
    </form>
  );
}

const levelColor: Record<LogEntry['level'], string> = {
  debug: 'text-muted',
  info: 'text-text',
  warn: 'text-warn',
  error: 'text-danger',
};

const timeFormat = new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function ActivityLog({ accountId }: { accountId: string }) {
  const { data: logs = [] } = useQuery<LogEntry[]>({ queryKey: keys.logs, enabled: false });
  const entries = logs.filter((e) => e.scope === accountId).slice(-100);
  const ref = useRef<HTMLDivElement>(null);
  const last = entries.at(-1)?.time;

  // Kullanıcı yukarı kaydırmadıysa en yeni satırı göster
  useEffect(() => {
    const el = ref.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [last]);

  return (
    <section className="rounded-md bg-surface">
      <h2 className="border-b border-line px-4 py-3 font-semibold text-bright sm:px-5">Etkinlik</h2>
      <div ref={ref} className="max-h-64 overflow-y-auto px-4 py-2 text-sm sm:px-5">
        {entries.length ? (
          entries.map((entry, i) => (
            <p key={`${entry.time}-${i}`} className="flex gap-3 py-0.5">
              <time className="shrink-0 text-muted tabular-nums">{timeFormat.format(new Date(entry.time))}</time>
              <span className={levelColor[entry.level]}>{entry.message}</span>
            </p>
          ))
        ) : (
          <p className="py-4 text-muted">Bu hesap için henüz kayıt yok.</p>
        )}
      </div>
    </section>
  );
}

function DeleteDialog({ account, open, onClose, onRemoved }: { account: Account; open: boolean; onClose: () => void; onRemoved: () => void }) {
  const toast = useToast();
  const remove = useMutation({
    mutationFn: () => api.removeAccount(account.id),
    onSuccess: () => {
      toast(`${displayName(account)} kaldırıldı`);
      onClose();
      onRemoved();
    },
  });
  return (
    <Dialog open={open} onClose={onClose} title="Hesabı kaldır">
      <p>
        <span className="text-bright">{displayName(account)}</span> için bot durdurulacak ve kayıtlı Steam oturumu silinecek. Tekrar eklemek
        için şifren ve Steam Guard kodu gerekecek.
      </p>
      <ErrorText>{remove.error?.message}</ErrorText>
      <div className="mt-5 flex justify-end gap-2">
        <button className="btn" onClick={onClose}>
          Vazgeç
        </button>
        <button className="btn-danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
          {remove.isPending && <Spinner />}
          Hesabı kaldır
        </button>
      </div>
    </Dialog>
  );
}

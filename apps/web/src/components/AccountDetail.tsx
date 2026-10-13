import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, Clock, Eye, EyeOff, Gamepad2, Info, KeyRound, Layers, Pencil, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, keys, upsertAccount } from '../api';
import { pick, useI18n } from '../i18n';
import {
  describeStatus,
  displayName,
  formatDuration,
  formatPlaytime,
  gameName,
  isIdling,
  toneText,
  useNow,
  useOwnedGames,
} from '../status';
import { MAX_GAMES, type Account, type IdleMode, type LogEntry, type OwnedGame, type PersonaMode } from '../types';
import { CardsPanel } from './CardsPanel';
import { GameCapsule } from './GameArt';
import { GamePickerDialog } from './GamePickerDialog';
import { GuardForm } from './GuardForm';
import { Avatar, Dialog, ErrorText, Segmented, Spinner, Switch, useToast } from './ui';

export function AccountDetail({ account, onRemoved }: { account: Account; onRemoved: () => void }) {
  const { t } = useI18n();
  const owned = useOwnedGames(account);
  const now = useNow();
  const status = describeStatus(account, owned.data, now, t);
  const toast = useToast();
  const [picking, setPicking] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const update = useMutation({
    mutationFn: (patch: Parameters<typeof api.updateAccount>[1]) => api.updateAccount(account.id, patch),
    onSuccess: upsertAccount,
    onError: (err) => toast(err.message, 'error'),
  });

  const removeGame = (appId: number) => update.mutate({ games: account.games.filter((id) => id !== appId) });
  const cardsMode = account.mode === 'cards';
  const idling = isIdling(account);

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
            {account.persona === 'invisible' && idling && <span className="font-normal text-muted"> {t('(görünmez)', '(invisible)')}</span>}
          </p>
          {idling && account.session.runningSince && (
            <p className="mt-0.5 flex items-center gap-1.5 text-sm text-muted tabular-nums">
              <Clock size={14} />
              {t('Bu oturumda', 'This session:')} {formatDuration(now - Date.parse(account.session.runningSince), t)}
            </p>
          )}
        </div>
        <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto sm:flex-col sm:items-end">
          <label className="flex items-center gap-2.5 text-sm">
            <span className={account.enabled ? 'text-bright' : 'text-muted'}>
              {account.enabled ? t('Bot açık', 'Bot on') : t('Bot kapalı', 'Bot off')}
            </span>
            <Switch
              label={t('Bu hesap için botu aç/kapat', 'Turn the bot on or off for this account')}
              checked={account.enabled}
              disabled={update.isPending}
              onChange={(enabled) => update.mutate({ enabled })}
            />
          </label>
          <Segmented<PersonaMode>
            label={t("Steam'de görünürlük", 'Visibility on Steam')}
            value={account.persona}
            disabled={update.isPending}
            onChange={(persona) => update.mutate({ persona })}
            options={[
              { value: 'online', label: t('Çevrimiçi', 'Online'), icon: <Eye size={15} /> },
              { value: 'invisible', label: t('Görünmez', 'Invisible'), icon: <EyeOff size={15} /> },
            ]}
          />
        </div>
      </section>

      <Attention account={account} now={now} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          {cardsMode
            ? t('Kartı kalan oyunlar sırayla, tek tek kasılıyor.', 'Games with card drops left are farmed one at a time.')
            : t('Seçtiğin oyunların hepsi aynı anda oynuyor görünüyor.', 'All selected games show as played at the same time.')}
        </p>
        <Segmented<IdleMode>
          label={t('Kasma modu', 'Idle mode')}
          value={account.mode}
          disabled={update.isPending}
          onChange={(mode) => update.mutate({ mode })}
          options={[
            { value: 'games', label: t('Saat kas', 'Idle hours'), icon: <Gamepad2 size={15} /> },
            { value: 'cards', label: t('Kart düşür', 'Farm cards'), icon: <Layers size={15} /> },
          ]}
        />
      </div>

      {cardsMode ? (
        <CardsPanel account={account} />
      ) : (
        <section className="rounded-md bg-surface">
          <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
            <h2 className="font-semibold text-bright">
              {t('Kasılan oyunlar', 'Idled games')}{' '}
              <span className="font-normal text-muted tabular-nums">
                {account.games.length}/{MAX_GAMES}
              </span>
            </h2>
            <button className="btn" onClick={() => setPicking(true)}>
              <Pencil size={15} />
              {t('Oyunları düzenle', 'Edit games')}
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
              <p className="mt-3 text-bright">{t('Henüz oyun seçmedin', 'No games selected yet')}</p>
              <p className="mt-1 max-w-sm text-sm text-muted">
                {t(
                  `Kütüphanenden en fazla ${MAX_GAMES} oyun seç; bot hepsini aynı anda oynuyor gösterir.`,
                  `Pick up to ${MAX_GAMES} games from your library; the bot shows them all as played at once.`,
                )}
              </p>
              <button className="btn-primary mt-4" onClick={() => setPicking(true)}>
                {t('Oyun seç', 'Choose games')}
              </button>
            </div>
          )}
        </section>
      )}

      <ActivityLog accountId={account.id} />

      <div className="flex justify-end">
        <button className="btn-ghost text-sm hover:text-danger" onClick={() => setConfirmDelete(true)}>
          <Trash2 size={15} />
          {t('Hesabı kaldır', 'Remove account')}
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
  const { t, lang } = useI18n();
  return (
    <li className="group flex items-center gap-3 px-4 py-2.5 sm:px-5">
      <GameCapsule appId={appId} iconUrl={game?.iconUrl ?? null} />
      <div className="min-w-0 flex-1">
        <p className={`truncate ${active ? 'text-ingame' : 'text-bright'}`}>{name}</p>
        <p className="text-xs text-muted">
          {game
            ? t(`Toplam ${formatPlaytime(game.playtimeMinutes, lang)}`, `${formatPlaytime(game.playtimeMinutes, lang)} total`)
            : name === `AppID ${appId}`
              ? t('Hesap bağlanınca oyun bilgisi gelir', 'Game details load once the account is connected')
              : `AppID ${appId}`}
        </p>
      </div>
      <button
        className="btn-ghost opacity-60 group-hover:opacity-100 focus-visible:opacity-100"
        onClick={onRemove}
        disabled={disabled}
        aria-label={t(`${name} oyununu listeden çıkar`, `Remove ${name} from the list`)}
        title={t('Listeden çıkar', 'Remove from list')}
      >
        <X size={16} />
      </button>
    </li>
  );
}

/** Hesabın dikkat gerektiren durumu: giriş, Guard, hata ya da bekleme. */
function Attention({ account, now }: { account: Account; now: number }) {
  const { t } = useI18n();
  const { session } = account;

  if (session.state === 'awaiting_guard') {
    return (
      <Banner tone="warn" icon={<KeyRound size={18} />} title={t('Steam Guard kodu gerekli', 'Steam Guard code required')}>
        <GuardForm account={account} />
      </Banner>
    );
  }
  if (session.state === 'needs_login') {
    const reason = session.lastError ? ` (${session.lastError})` : '';
    return (
      <Banner tone="error" icon={<KeyRound size={18} />} title={t('Steam oturumu sona erdi', 'Steam sign-in expired')}>
        <p className="mb-3 text-sm">
          {t(
            `Kayıtlı oturum anahtarı artık geçerli değil${reason}. Devam etmek için şifrenle tekrar giriş yap.`,
            `The stored login is no longer valid${reason}. Sign in with your password to continue.`,
          )}
        </p>
        <ReloginForm account={account} />
      </Banner>
    );
  }
  if (session.state === 'waiting_retry') {
    const left = Math.ceil((session.retryAt ? Math.max(0, Date.parse(session.retryAt) - now) : 0) / 1000);
    return (
      <Banner
        tone="warn"
        icon={<AlertTriangle size={18} />}
        title={t(`Steam'e bağlanılamadı, ${left} sn sonra tekrar denenecek`, `Couldn't reach Steam, retrying in ${left} s`)}
      >
        {session.lastError && <p className="text-sm text-muted">{session.lastError}</p>}
      </Banner>
    );
  }
  if (session.state === 'blocked') {
    return (
      <Banner tone="info" icon={<Info size={18} />} title={t('Bu hesapla şu an başka bir yerde oynanıyor', 'This account is playing somewhere else')}>
        <p className="text-sm text-muted">
          {t(
            'Steam aynı anda tek oyun oturumuna izin verir. Oyunu kapattığında bot kaldığı yerden devam eder.',
            'Steam allows one game session at a time. When you quit that game, the bot picks up where it left off.',
          )}
        </p>
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
  const { t } = useI18n();
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
        placeholder={t(`${account.accountName} şifresi`, `Password for ${account.accountName}`)}
        aria-label={t('Steam şifresi', 'Steam password')}
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <button className="btn-primary" disabled={!password || login.isPending}>
        {login.isPending && <Spinner />}
        {t('Giriş yap', 'Sign in')}
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

function ActivityLog({ accountId }: { accountId: string }) {
  const { t, lang, locale } = useI18n();
  const { data: logs = [] } = useQuery<LogEntry[]>({ queryKey: keys.logs, enabled: false });
  const entries = logs.filter((e) => e.scope === accountId).slice(-100);
  const ref = useRef<HTMLDivElement>(null);
  const last = entries.at(-1)?.time;
  const timeFormat = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

  // Kullanıcı yukarı kaydırmadıysa en yeni satırı göster
  useEffect(() => {
    const el = ref.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [last]);

  return (
    <section className="rounded-md bg-surface">
      <h2 className="border-b border-line px-4 py-3 font-semibold text-bright sm:px-5">{t('Etkinlik', 'Activity')}</h2>
      <div ref={ref} className="max-h-64 overflow-y-auto px-4 py-2 text-sm sm:px-5">
        {entries.length ? (
          entries.map((entry, i) => (
            <p key={`${entry.time}-${i}`} className="flex gap-3 py-0.5">
              <time className="shrink-0 text-muted tabular-nums">{timeFormat.format(new Date(entry.time))}</time>
              <span className={levelColor[entry.level]}>{pick(lang, entry.message, entry.messageEn)}</span>
            </p>
          ))
        ) : (
          <p className="py-4 text-muted">{t('Bu hesap için henüz kayıt yok.', 'Nothing logged for this account yet.')}</p>
        )}
      </div>
    </section>
  );
}

function DeleteDialog({ account, open, onClose, onRemoved }: { account: Account; open: boolean; onClose: () => void; onRemoved: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const name = displayName(account);
  const remove = useMutation({
    mutationFn: () => api.removeAccount(account.id),
    onSuccess: () => {
      toast(t(`${name} kaldırıldı`, `${name} removed`));
      onClose();
      onRemoved();
    },
  });
  return (
    <Dialog open={open} onClose={onClose} title={t('Hesabı kaldır', 'Remove account')}>
      <p>
        {t(
          `${name} için bot durdurulacak ve kayıtlı Steam oturumu silinecek. Tekrar eklemek için şifren ve Steam Guard kodu gerekecek.`,
          `The bot stops for ${name} and its stored Steam login is deleted. Adding it again needs your password and a Steam Guard code.`,
        )}
      </p>
      <ErrorText>{remove.error?.message}</ErrorText>
      <div className="mt-5 flex justify-end gap-2">
        <button className="btn" onClick={onClose}>
          {t('Vazgeç', 'Cancel')}
        </button>
        <button className="btn-danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
          {remove.isPending && <Spinner />}
          {t('Hesabı kaldır', 'Remove account')}
        </button>
      </div>
    </Dialog>
  );
}

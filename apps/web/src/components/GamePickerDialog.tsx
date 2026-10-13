import { useMutation } from '@tanstack/react-query';
import { Check, Plus, RefreshCw, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, keys, queryClient, upsertAccount } from '../api';
import { formatPlaytime, isConnected, useOwnedGames } from '../status';
import { MAX_GAMES, type Account, type OwnedGame } from '../types';
import { GameIcon } from './GameArt';
import { Dialog, ErrorText, Spinner, useToast } from './ui';

export function GamePickerDialog({ account, open, onClose }: { account: Account; open: boolean; onClose: () => void }) {
  const owned = useOwnedGames(account);
  const [selected, setSelected] = useState<number[]>([]);
  const [search, setSearch] = useState('');
  const [onlySelected, setOnlySelected] = useState(false);
  const [manualId, setManualId] = useState('');
  const toast = useToast();

  // Her açılışta hesabın güncel listesinden başla
  useEffect(() => {
    if (!open) return;
    setSelected(account.games);
    setSearch('');
    setOnlySelected(false);
    setManualId('');
    save.reset();
  }, [open]);

  const save = useMutation({
    mutationFn: () => api.updateAccount(account.id, { games: selected }),
    onSuccess: (updated) => {
      upsertAccount(updated);
      toast(updated.games.length ? `${updated.games.length} oyun kaydedildi` : 'Oyun listesi temizlendi');
      onClose();
    },
  });

  const refresh = useMutation({
    mutationFn: () => api.ownedGames(account.id, true),
    onSuccess: (games) => queryClient.setQueryData(keys.games(account.id), games),
  });

  const ownedIds = useMemo(() => new Set(owned.data?.map((g) => g.appId)), [owned.data]);
  const extra = selected.filter((id) => !ownedIds.has(id));
  const full = selected.length >= MAX_GAMES;

  const visible = useMemo(() => {
    const q = search.trim().toLocaleLowerCase('tr');
    return (owned.data ?? []).filter(
      (g) =>
        (!onlySelected || selected.includes(g.appId)) &&
        (!q || g.name.toLocaleLowerCase('tr').includes(q) || String(g.appId) === q),
    );
  }, [owned.data, search, onlySelected, selected]);

  const toggle = (appId: number) =>
    setSelected((list) => (list.includes(appId) ? list.filter((id) => id !== appId) : full ? list : [...list, appId]));

  const addManual = () => {
    const id = Number(manualId);
    if (!Number.isInteger(id) || id <= 0) return;
    if (!selected.includes(id) && !full) setSelected((list) => [...list, id]);
    setManualId('');
  };

  const changed = selected.length !== account.games.length || selected.some((id, i) => account.games[i] !== id);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Kasılacak oyunları seç"
      wide
      fixedBody
      footer={
        <>
          <ErrorText>{save.error?.message}</ErrorText>
          <div className="flex justify-end gap-2">
            <button className="btn" onClick={onClose}>
              Vazgeç
            </button>
            <button className="btn-primary" disabled={!changed || save.isPending} onClick={() => save.mutate()}>
              {save.isPending && <Spinner />}
              Kaydet
            </button>
          </div>
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
          <input
            className="input pl-9"
            placeholder="Kütüphanede ara"
            aria-label="Kütüphanede ara"
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <button
          className="btn-ghost"
          onClick={() => refresh.mutate()}
          disabled={!isConnected(account) || refresh.isPending}
          title="Kütüphaneyi Steam'den yeniden yükle"
          aria-label="Kütüphaneyi yenile"
        >
          <RefreshCw size={16} className={refresh.isPending ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="mt-3 flex items-center justify-between text-sm">
        <label className="flex cursor-pointer items-center gap-2 text-muted select-none">
          <input type="checkbox" className="accent-accent" checked={onlySelected} onChange={(e) => setOnlySelected(e.target.checked)} />
          Yalnızca seçilenler
        </label>
        <span className={`tabular-nums ${full ? 'text-warn' : 'text-muted'}`}>
          {selected.length}/{MAX_GAMES} seçili{full && ', Steam sınırı doldu'}
        </span>
      </div>

      <div className="-mx-1 mt-2 min-h-32 flex-1 overflow-y-auto">
        {!isConnected(account) && (
          <p className="px-1 py-6 text-center text-sm text-muted">
            Kütüphane yalnızca hesap Steam'e bağlıyken yüklenebilir. Bu arada AppID ile oyun ekleyebilirsin.
          </p>
        )}
        {owned.isLoading && (
          <div className="flex justify-center py-10 text-muted">
            <Spinner size={22} />
          </div>
        )}
        {owned.error && <ErrorText>{owned.error.message}</ErrorText>}

        {extra.map((appId) => (
          <GameRow key={appId} appId={appId} name={account.gameNames[appId]} checked onToggle={() => toggle(appId)} disabled={false} />
        ))}
        {visible.map((game) => (
          <GameRow
            key={game.appId}
            appId={game.appId}
            game={game}
            checked={selected.includes(game.appId)}
            disabled={full && !selected.includes(game.appId)}
            onToggle={() => toggle(game.appId)}
          />
        ))}
        {owned.data && !visible.length && !extra.length && (
          <p className="px-1 py-6 text-center text-sm text-muted">
            {search ? `"${search}" ile eşleşen oyun yok.` : 'Henüz oyun seçilmedi.'}
          </p>
        )}
      </div>

      <form
        className="mt-3 flex gap-2 border-t border-line pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          addManual();
        }}
      >
        <input
          className="input"
          inputMode="numeric"
          placeholder="Kütüphanende yok mu? AppID gir (ör. 730)"
          aria-label="AppID ile ekle"
          value={manualId}
          onChange={(e) => setManualId(e.target.value.replace(/\D/g, ''))}
        />
        <button className="btn shrink-0" disabled={!manualId || full}>
          <Plus size={16} />
          Ekle
        </button>
      </form>

    </Dialog>
  );
}

function GameRow({
  appId,
  name,
  game,
  checked,
  disabled,
  onToggle,
}: {
  appId: number;
  name?: string;
  game?: OwnedGame;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={onToggle}
      className={`flex w-full items-center gap-3 rounded-sm px-2 py-1.5 text-left transition-colors disabled:opacity-40 ${
        checked ? 'bg-accent/10' : 'hover:bg-raised'
      }`}
    >
      <span
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-[3px] border ${
          checked ? 'border-accent bg-accent text-bar' : 'border-[#4b5a6b]'
        }`}
      >
        {checked && <Check size={14} strokeWidth={3} />}
      </span>
      <GameIcon appId={appId} iconUrl={game?.iconUrl ?? null} />
      <span className="min-w-0 flex-1">
        <span className={`block truncate ${checked ? 'text-bright' : ''}`}>{game?.name ?? name ?? `AppID ${appId}`}</span>
        <span className="block text-xs text-muted">{game ? formatPlaytime(game.playtimeMinutes) : 'Kütüphanede değil'}</span>
      </span>
    </button>
  );
}

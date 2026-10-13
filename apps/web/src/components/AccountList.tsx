import { Plus } from 'lucide-react';
import { describeStatus, displayName, toneText, useNow, useOwnedGames } from '../status';
import type { Account } from '../types';
import { Avatar } from './ui';

/** Steam arkadaş listesi görünümünde hesaplar. */
export function AccountList({
  accounts,
  selectedId,
  onSelect,
  onAdd,
}: {
  accounts: Account[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  const idling = accounts.filter((a) => a.session.state === 'running' && a.games.length).length;
  return (
    <nav aria-label="Hesaplar" className="flex h-full flex-col">
      <div className="flex items-baseline justify-between px-4 pt-4 pb-2">
        <h2 className="font-semibold text-bright">Hesaplar</h2>
        {accounts.length > 0 && (
          <span className="text-sm text-muted tabular-nums">
            {idling}/{accounts.length} kasıyor
          </span>
        )}
      </div>
      <ul className="flex-1 overflow-y-auto px-2">
        {accounts.map((account) => (
          <AccountRow key={account.id} account={account} selected={account.id === selectedId} onSelect={() => onSelect(account.id)} />
        ))}
      </ul>
      <div className="border-t border-line p-2">
        <button className="btn-ghost w-full justify-start py-2.5" onClick={onAdd}>
          <Plus size={18} />
          Hesap ekle
        </button>
      </div>
    </nav>
  );
}

function AccountRow({ account, selected, onSelect }: { account: Account; selected: boolean; onSelect: () => void }) {
  const owned = useOwnedGames(account);
  const now = useNow(5000);
  const status = describeStatus(account, owned.data, now);
  return (
    <li>
      <button
        onClick={onSelect}
        aria-current={selected ? 'page' : undefined}
        className={`flex w-full items-center gap-3 rounded-sm px-2 py-2 text-left transition-colors ${
          selected ? 'bg-raised' : 'hover:bg-raised/50'
        }`}
      >
        <Avatar src={account.avatarUrl} name={displayName(account)} tone={status.tone} />
        <span className="min-w-0 flex-1">
          <span className={`block truncate font-medium ${status.tone === 'ingame' ? 'text-ingame' : 'text-bright'}`}>
            {displayName(account)}
          </span>
          <span className={`block truncate text-sm ${toneText[status.tone]}`}>{status.text}</span>
        </span>
      </button>
    </li>
  );
}

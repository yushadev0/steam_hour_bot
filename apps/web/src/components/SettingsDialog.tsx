import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, Copy, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, keys, queryClient } from '../api';
import { Dialog, ErrorText, Spinner } from './ui';

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Ayarlar" wide>
      <TokenSection open={open} />
    </Dialog>
  );
}

const dateFormat = new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short' });

function TokenSection({ open }: { open: boolean }) {
  const [name, setName] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const tokens = useQuery({ queryKey: keys.tokens, queryFn: api.tokens, enabled: open });

  const create = useMutation({
    mutationFn: () => api.createToken(name),
    onSuccess: ({ token }) => {
      setCreated(token);
      setCopied(false);
      setName('');
      void queryClient.invalidateQueries({ queryKey: keys.tokens });
    },
  });
  const revoke = useMutation({
    mutationFn: api.revokeToken,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.tokens }),
  });

  const copy = async () => {
    if (!created) return;
    await navigator.clipboard.writeText(created);
    setCopied(true);
  };

  return (
    <section>
      <h3 className="font-semibold text-bright">API token'ları</h3>
      <p className="mt-1 text-sm text-muted">
        yassistant gibi başka bir uygulamanın botu yönetmesi için. Panel bu bilgisayardan şifresiz açılır; token yalnızca dışarıdan gelen API istekleri için gerekir.
      </p>

      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <input className="input" placeholder="Token adı (ör. yassistant)" aria-label="Token adı" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn shrink-0" disabled={!name.trim() || create.isPending}>
          {create.isPending && <Spinner />}
          Token oluştur
        </button>
      </form>
      <ErrorText>{create.error?.message}</ErrorText>

      {created && (
        <div className="mt-3 rounded-sm border-l-4 border-ingame bg-bar p-3">
          <p className="text-sm text-bright">Token'ı şimdi kopyala; bir daha gösterilmeyecek.</p>
          <div className="mt-2 flex gap-2">
            <code className="min-w-0 flex-1 truncate rounded-sm bg-[#32353c] px-3 py-2 text-sm text-bright">{created}</code>
            <button className="btn shrink-0" onClick={copy}>
              {copied ? <Check size={16} /> : <Copy size={16} />}
              {copied ? 'Kopyalandı' : 'Kopyala'}
            </button>
          </div>
        </div>
      )}

      <ul className="mt-4 divide-y divide-line/60">
        {tokens.data?.map((token) => (
          <li key={token.id} className="flex items-center gap-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-bright">{token.name}</p>
              <p className="text-xs text-muted">
                {token.preview}…, oluşturuldu {dateFormat.format(new Date(token.createdAt))}
                {token.lastUsedAt ? `, son kullanım ${dateFormat.format(new Date(token.lastUsedAt))}` : ', hiç kullanılmadı'}
              </p>
            </div>
            <button
              className="btn-ghost hover:text-danger"
              onClick={() => revoke.mutate(token.id)}
              disabled={revoke.isPending}
              aria-label={`${token.name} token'ını iptal et`}
              title="İptal et"
            >
              <Trash2 size={16} />
            </button>
          </li>
        ))}
        {tokens.data?.length === 0 && <li className="py-2.5 text-sm text-muted">Henüz token yok.</li>}
      </ul>
    </section>
  );
}

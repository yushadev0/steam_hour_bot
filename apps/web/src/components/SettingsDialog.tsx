import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, Copy, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, keys, queryClient } from '../api';
import { useI18n } from '../i18n';
import { Dialog, ErrorText, Spinner } from './ui';

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onClose={onClose} title={t('Ayarlar', 'Settings')} wide>
      <TokenSection open={open} />
    </Dialog>
  );
}

function TokenSection({ open }: { open: boolean }) {
  const { t, locale } = useI18n();
  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
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
      <h3 className="font-semibold text-bright">{t("API token'ları", 'API tokens')}</h3>
      <p className="mt-1 text-sm text-muted">
        {t(
          'yassistant gibi başka bir uygulamanın botu yönetmesi için. Panel bu bilgisayardan şifresiz açılır; token yalnızca dışarıdan gelen API istekleri için gerekir.',
          'For another app (such as yassistant) to control the bot. The panel opens on this computer without a password; tokens are only needed for API requests from elsewhere.',
        )}
      </p>

      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <input
          className="input"
          placeholder={t('Token adı (ör. yassistant)', 'Token name (e.g. yassistant)')}
          aria-label={t('Token adı', 'Token name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button className="btn shrink-0" disabled={!name.trim() || create.isPending}>
          {create.isPending && <Spinner />}
          {t('Token oluştur', 'Create token')}
        </button>
      </form>
      <ErrorText>{create.error?.message}</ErrorText>

      {created && (
        <div className="mt-3 rounded-sm border-l-4 border-ingame bg-bar p-3">
          <p className="text-sm text-bright">{t("Token'ı şimdi kopyala; bir daha gösterilmeyecek.", "Copy the token now; it won't be shown again.")}</p>
          <div className="mt-2 flex gap-2">
            <code className="min-w-0 flex-1 truncate rounded-sm bg-[#32353c] px-3 py-2 text-sm text-bright">{created}</code>
            <button className="btn shrink-0" onClick={copy}>
              {copied ? <Check size={16} /> : <Copy size={16} />}
              {copied ? t('Kopyalandı', 'Copied') : t('Kopyala', 'Copy')}
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
                {token.preview}…, {t('oluşturuldu', 'created')} {dateFormat.format(new Date(token.createdAt))}
                {token.lastUsedAt
                  ? t(`, son kullanım ${dateFormat.format(new Date(token.lastUsedAt))}`, `, last used ${dateFormat.format(new Date(token.lastUsedAt))}`)
                  : t(', hiç kullanılmadı', ', never used')}
              </p>
            </div>
            <button
              className="btn-ghost hover:text-danger"
              onClick={() => revoke.mutate(token.id)}
              disabled={revoke.isPending}
              aria-label={t(`${token.name} token'ını iptal et`, `Revoke ${token.name}`)}
              title={t('İptal et', 'Revoke')}
            >
              <Trash2 size={16} />
            </button>
          </li>
        ))}
        {tokens.data?.length === 0 && <li className="py-2.5 text-sm text-muted">{t('Henüz token yok.', 'No tokens yet.')}</li>}
      </ul>
    </section>
  );
}

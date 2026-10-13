import { useMutation, useQuery } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, keys, upsertAccount } from '../api';
import { useI18n } from '../i18n';
import type { Account } from '../types';
import { GuardForm } from './GuardForm';
import { Dialog, ErrorText, Spinner, useToast } from './ui';

export function AddAccountDialog({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: (id: string) => void }) {
  const [accountName, setAccountName] = useState('');
  const [password, setPassword] = useState('');
  const [pendingId, setPendingId] = useState<string | null>(null);
  // Guard adımından sonra giriş başarısız olduysa (hesap sunucuda silindi)
  const [failure, setFailure] = useState(false);
  const toast = useToast();
  const { t } = useI18n();

  // Guard adımında hesabın canlı durumu (mobil onay WebSocket ile gelir)
  const { data: accounts } = useQuery<Account[]>({ queryKey: keys.accounts, enabled: false });
  const pending = accounts?.find((a) => a.id === pendingId);

  const reset = () => {
    setAccountName('');
    setPassword('');
    setPendingId(null);
    setFailure(false);
    add.reset();
  };
  const close = () => {
    reset();
    onClose();
  };
  const finish = (account: Account) => {
    const name = account.personaName ?? account.accountName;
    toast(t(`${name} eklendi`, `${name} added`));
    onAdded(account.id);
    close();
  };

  const add = useMutation({
    mutationFn: () => {
      setFailure(false);
      return api.addAccount(accountName.trim(), password);
    },
    onSuccess: (account) => {
      upsertAccount(account);
      setPassword('');
      if (account.session.state === 'awaiting_guard') setPendingId(account.id);
      else finish(account);
    },
  });

  const pendingState = pending?.session.state;
  useEffect(() => {
    if (!pendingId) return;
    // Giriş Guard adımından sonra başarısız olursa sunucu hesabı siler
    if (!pending) {
      setPendingId(null);
      setFailure(true);
      return;
    }
    // Mobil onay verildiyse giriş kendiliğinden tamamlanır
    if (pendingState !== 'awaiting_guard' && pendingState !== 'connecting') finish(pending);
  }, [pendingId, pendingState, !!pending]);

  return (
    <Dialog open={open} onClose={close} title={pending ? 'Steam Guard' : t('Steam hesabı ekle', 'Add a Steam account')}>
      {pending ? (
        <GuardForm account={pending} />
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <label className="label" htmlFor="add-username">
            {t('Steam kullanıcı adı', 'Steam username')}
          </label>
          <input
            id="add-username"
            className="input"
            autoFocus
            autoComplete="username"
            value={accountName}
            onChange={(e) => setAccountName(e.target.value)}
          />
          <label className="label mt-4" htmlFor="add-password">
            {t('Şifre', 'Password')}
          </label>
          <input
            id="add-password"
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <ErrorText>
            {add.error?.message ??
              (failure
                ? t('Steam girişi tamamlanamadı. Bilgileri kontrol edip tekrar dene.', 'Steam sign-in did not complete. Check your details and try again.')
                : null)}
          </ErrorText>
          <p className="mt-4 flex gap-2 text-sm text-muted">
            <ShieldCheck size={18} className="shrink-0 text-ingame" />
            {t(
              "Şifren kaydedilmez. Steam'in verdiği oturum anahtarı şifrelenerek saklanır, sonraki açılışlarda şifre sorulmaz.",
              "Your password is never stored. Steam's login token is kept encrypted, so you won't be asked again next time.",
            )}
          </p>
          <button className="btn-primary mt-5 w-full py-2.5" disabled={!accountName.trim() || !password || add.isPending}>
            {add.isPending && <Spinner />}
            {add.isPending ? t("Steam'e bağlanılıyor…", 'Connecting to Steam…') : t('Giriş yap ve ekle', 'Sign in and add')}
          </button>
        </form>
      )}
    </Dialog>
  );
}

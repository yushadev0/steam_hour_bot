import { useMutation } from '@tanstack/react-query';
import { Mail, Smartphone } from 'lucide-react';
import { useState } from 'react';
import { api, upsertAccount } from '../api';
import type { Account } from '../types';
import { ErrorText, Spinner } from './ui';

/**
 * Steam Guard adımı. E-posta kodunu ya da mobil uygulamadaki kodu alır; mobilde
 * uygulamadan onay da verilebilir (giriş kendiliğinden tamamlanır).
 */
export function GuardForm({ account, onDone }: { account: Account; onDone?: (account: Account) => void }) {
  const [code, setCode] = useState('');
  const guard = account.session.guard;
  const mobile = guard?.type !== 'email';

  const handle = (result: Account) => {
    upsertAccount(result);
    setCode('');
    if (result.session.state !== 'awaiting_guard') onDone?.(result);
  };
  const submit = useMutation({ mutationFn: () => api.submitGuard(account.id, code), onSuccess: handle });
  const wait = useMutation({ mutationFn: () => api.waitGuard(account.id), onSuccess: handle });
  const busy = submit.isPending || wait.isPending;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit.mutate();
      }}
    >
      <div className="mb-4 flex gap-3">
        <div className="mt-0.5 text-accent">{mobile ? <Smartphone size={22} /> : <Mail size={22} />}</div>
        <p className="text-sm">
          {mobile ? (
            <>Steam mobil uygulamasındaki 5 haneli kodu gir ya da girişi uygulamadan onayla.</>
          ) : (
            <>
              <span className="text-bright">{guard?.domain}</span> adresine gönderilen 5 haneli kodu gir.
            </>
          )}
        </p>
      </div>
      <label className="label" htmlFor={`guard-${account.id}`}>
        Steam Guard kodu
      </label>
      <input
        id={`guard-${account.id}`}
        className="input text-center text-xl font-semibold tracking-[0.4em] uppercase"
        autoFocus
        autoComplete="one-time-code"
        maxLength={5}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\s/g, '').toUpperCase())}
      />
      <ErrorText>
        {guard?.lastCodeWrong ? 'Kod hatalı ya da süresi geçmiş. Yeni kodu gir.' : (submit.error?.message ?? wait.error?.message)}
      </ErrorText>
      <div className="mt-4 flex flex-wrap gap-2">
        <button className="btn-primary flex-1" disabled={code.length < 5 || busy}>
          {submit.isPending && <Spinner />}
          Kodu gönder
        </button>
        {mobile && (
          <button type="button" className="btn flex-1" disabled={busy} onClick={() => wait.mutate()}>
            {wait.isPending && <Spinner />}
            Uygulamadan onayladım
          </button>
        )}
      </div>
    </form>
  );
}

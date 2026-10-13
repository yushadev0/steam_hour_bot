import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { api, keys, queryClient } from '../api';
import { ErrorText, Spinner } from './ui';
import { Logo } from './Logo';

export function LoginScreen() {
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: () => api.login(password),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.me }),
  });

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-bar px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <Logo size="lg" />
        </div>
        <form
          className="rounded-md bg-surface p-6 shadow-2xl shadow-black/50"
          onSubmit={(e) => {
            e.preventDefault();
            login.mutate();
          }}
        >
          <h1 className="mb-5 text-2xl font-semibold text-bright">Giriş yap</h1>
          <label className="label" htmlFor="panel-password">
            Panel şifresi
          </label>
          <input
            id="panel-password"
            className="input"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <ErrorText>{login.error?.message}</ErrorText>
          <button className="btn-primary mt-5 w-full py-2.5" disabled={!password || login.isPending}>
            {login.isPending && <Spinner />}
            Giriş yap
          </button>
          <p className="mt-4 text-sm text-muted">
            Şifreyi ilk kez mi soruyor? Sunucu ilk açıldığında log'a yazdı. Kaybettiysen <code className="text-text">data/auth.json</code>{' '}
            dosyasını silip sunucuyu yeniden başlat.
          </p>
        </form>
      </div>
    </main>
  );
}

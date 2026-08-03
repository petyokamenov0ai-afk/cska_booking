'use client';

import { useState } from 'react';

import Button from '@/components/ui/Button';
import { cn } from '@/lib/format';
import { t, type Locale } from '@/lib/i18n';

export default function LoginForm({ locale }: { locale: Locale }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!response.ok) {
        setFailed(true);
        return;
      }
      // Full navigation, not a router push: every server component in the app
      // renders differently once the cookie exists, so start from scratch.
      window.location.assign('/');
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const inputClass = cn(
    // text-base: anything smaller makes iOS Safari zoom the page on focus.
    'h-11 w-full rounded-lg border bg-input px-3 text-base text-foreground',
    'placeholder:text-muted-foreground',
    failed ? 'border-destructive' : 'border-border',
  );

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="login-username" className="text-sm font-medium">
          {t(locale, 'auth.username')}
        </label>
        <input
          id="login-username"
          data-testid="login-username"
          type="text"
          autoComplete="username"
          autoFocus
          required
          value={username}
          onChange={(event) => {
            setUsername(event.target.value);
            setFailed(false);
          }}
          className={inputClass}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="login-password" className="text-sm font-medium">
          {t(locale, 'auth.password')}
        </label>
        <input
          id="login-password"
          data-testid="login-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            setFailed(false);
          }}
          className={inputClass}
        />
      </div>

      {failed ? (
        <p role="alert" className="text-sm text-destructive">
          {t(locale, 'auth.failed')}
        </p>
      ) : null}

      <Button type="submit" fullWidth loading={busy} data-testid="login-submit">
        {t(locale, 'auth.submit')}
      </Button>
    </form>
  );
}

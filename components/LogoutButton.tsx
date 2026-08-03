'use client';

import { t, type Locale } from '@/lib/i18n';

export default function LogoutButton({ locale }: { locale: Locale }) {
  async function handleClick() {
    await fetch('/api/auth/logout', { method: 'POST' });
    // Full navigation: the middleware owns what an anonymous visitor may see.
    window.location.assign('/login');
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className="text-xs font-medium tracking-wide text-muted-foreground uppercase transition-colors hover:text-foreground motion-reduce:transition-none"
    >
      {t(locale, 'auth.logout')}
    </button>
  );
}

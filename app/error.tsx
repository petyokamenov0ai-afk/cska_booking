'use client';

import Link from 'next/link';
import { useEffect } from 'react';

import Button, { buttonClasses } from '@/components/ui/Button';
import { t } from '@/lib/i18n';

/**
 * Route-level error boundary. Anything a Server Component throws (a Postgres
 * outage, a bad availability read) lands here instead of a white screen.
 * `reset()` re-renders the segment, which retries the server render.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[error-boundary]', error);
  }, [error]);

  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-6 py-20 text-center">
      <p
        aria-hidden="true"
        className="font-mono text-6xl font-black tracking-tighter text-primary/25 select-none"
      >
        500
      </p>

      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold tracking-tight">{t('bg', 'common.error')}</h1>
        <p className="text-sm text-muted-foreground">{t('en', 'common.error')}</p>
      </div>

      <p className="text-sm text-muted-foreground">{t('bg', 'error.INTERNAL')}</p>

      {error.digest && (
        <p className="font-mono text-xs text-muted-foreground/70">ref: {error.digest}</p>
      )}

      <div className="flex flex-wrap items-center justify-center gap-3">
        <Button variant="primary" size="lg" onClick={reset}>
          {t('bg', 'common.retry')} · {t('en', 'common.retry')}
        </Button>
        <Link href="/" className={buttonClasses({ variant: 'outline', size: 'lg' })}>
          {t('bg', 'nav.home')}
        </Link>
      </div>
    </div>
  );
}

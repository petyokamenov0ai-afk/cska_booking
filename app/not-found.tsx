import Link from 'next/link';

import { buttonClasses } from '@/components/ui/Button';
import { t } from '@/lib/i18n';

/**
 * 404 for unknown events, subsector codes (remember: Cyrillic) and reservation
 * codes. Bilingual on purpose — a dead end is exactly where a visitor who does
 * not read Bulgarian needs the English line too.
 */
export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-6 py-20 text-center">
      <p
        aria-hidden="true"
        className="font-mono text-6xl font-black tracking-tighter text-primary/25 select-none"
      >
        404
      </p>

      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold tracking-tight">{t('bg', 'common.notFound')}</h1>
        <p className="text-sm text-muted-foreground">{t('en', 'common.notFound')}</p>
      </div>

      <p className="text-sm text-muted-foreground">{t('bg', 'error.NOT_FOUND')}</p>

      <Link href="/" className={buttonClasses({ variant: 'primary', size: 'lg' })}>
        {t('bg', 'nav.events')} · {t('en', 'nav.events')}
      </Link>
    </div>
  );
}

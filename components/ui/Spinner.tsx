/**
 * Spinner — a pure-SVG indeterminate loader.
 *
 * No client hooks, so it is usable from server components too. Motion is CSS
 * only and is switched off under `prefers-reduced-motion` (the ring then reads
 * as a static partial circle, which still communicates "busy" next to its
 * accessible label).
 */

import { cn } from '@/lib/format';
import { DEFAULT_LOCALE, t, type Locale } from '@/lib/i18n';

export type SpinnerSize = 'xs' | 'sm' | 'md' | 'lg';

const SIZE_CLASS: Record<SpinnerSize, string> = {
  xs: 'size-3',
  sm: 'size-4',
  md: 'size-6',
  lg: 'size-9',
};

export interface SpinnerProps {
  size?: SpinnerSize;
  className?: string;
  /**
   * Accessible label. Defaults to the translated "Loading…".
   * Pass `label={null}` for a purely decorative spinner (e.g. inside a button
   * that already announces its own busy state).
   */
  label?: string | null;
  locale?: Locale;
}

export default function Spinner({
  size = 'md',
  className,
  label,
  locale = DEFAULT_LOCALE,
}: SpinnerProps) {
  const decorative = label === null;
  const text = decorative ? undefined : (label ?? t(locale, 'common.loading'));

  return (
    <span
      className={cn('inline-flex items-center gap-2', className)}
      role={decorative ? undefined : 'status'}
      aria-live={decorative ? undefined : 'polite'}
    >
      <svg
        className={cn(SIZE_CLASS[size], 'animate-spin motion-reduce:animate-none')}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        focusable="false"
      >
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.2" />
        <path
          d="M21 12a9 9 0 0 0-9-9"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
      {text !== undefined ? <span className="sr-only">{text}</span> : null}
    </span>
  );
}

/**
 * Full-block loading state: a centred spinner with a visible caption.
 * Handy as a `Suspense` fallback for the map panels.
 */
export function LoadingBlock({
  className,
  label,
  locale = DEFAULT_LOCALE,
}: {
  className?: string;
  label?: string;
  locale?: Locale;
}) {
  return (
    <div
      className={cn(
        'flex min-h-40 flex-col items-center justify-center gap-3 text-muted-foreground',
        className,
      )}
    >
      <Spinner size="lg" label={null} className="text-primary" />
      <p className="text-sm">{label ?? t(locale, 'common.loading')}</p>
    </div>
  );
}

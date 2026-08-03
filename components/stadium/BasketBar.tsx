/**
 * BasketBar — the sticky bottom bar that carries the selection through the flow.
 *
 * Selected seats as removable chips and — once the server
 * has given us a hold — a live `m:ss` countdown that turns urgent under a
 * minute and calls `onExpire` exactly once when it reaches zero.
 *
 * Connected **or** presentational: every data prop is optional and falls back to
 * `lib/basketStore`, so a page can drop `<BasketBar onContinue={…} />` in and be
 * done, while a summary elsewhere can pass an explicit seat list instead.
 *
 * The countdown renders nothing until after mount. `Date.now()` on the server
 * and in the browser are never the same instant, and a hydration mismatch on a
 * ticking clock is the classic way to get React to blow up here.
 */

'use client';

import { useEffect, useRef, useState } from 'react';
import { Clock, Trash2, X } from 'lucide-react';

import Button from '@/components/ui/Button';
import { cn, formatCountdown, isoDuration, msUntil } from '@/lib/format';
import { DEFAULT_LOCALE, t, type Locale } from '@/lib/i18n';
import {
  MAX_SELECTED_SEATS,
  useBasketExpiresAt,
  useBasketSeats,
  useBasketStore,
  type BasketSeat,
} from '@/lib/basketStore';

/** Below this the countdown is styled as urgent. */
export const URGENT_THRESHOLD_MS = 60_000;

/**
 * Milliseconds left on the hold, ticking each second, `null` when there is no
 * hold (or before hydration). Calls `onExpire` once per `expiresAt` value.
 */
function useCountdown(
  expiresAt: string | null | undefined,
  onExpire?: () => void,
): number | null {
  const [remaining, setRemaining] = useState<number | null>(null);
  const firedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!expiresAt) {
      setRemaining(null);
      firedFor.current = null;
      return;
    }
    setRemaining(msUntil(expiresAt));
    const timer = setInterval(() => {
      const left = msUntil(expiresAt);
      setRemaining(left);
      if (left <= 0) clearInterval(timer);
    }, 1_000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  useEffect(() => {
    if (!expiresAt || remaining === null) return;
    if (remaining <= 0 && firedFor.current !== expiresAt) {
      firedFor.current = expiresAt;
      onExpire?.();
    }
  }, [remaining, expiresAt, onExpire]);

  return remaining;
}

export interface BasketBarProps {
  /** Omit to read the live selection from `lib/basketStore`. */
  seats?: readonly BasketSeat[];
  /**
   * ISO instant from the hold. Omit to read it from the store;
   * pass `null` to force "no hold".
   */
  expiresAt?: string | null;
  /** Omit to fall back to the store's `remove`. */
  onRemove?: (seatId: string) => void;
  /** Omit to fall back to the store's `clear`. */
  onClear?: () => void;
  onContinue?: () => void;
  /** Fired once when the countdown hits zero. */
  onExpire?: () => void;
  continueLabel?: string;
  /** Blocks Continue (e.g. sales closed). */
  disabled?: boolean;
  /**
   * The selection is locked: a reservation POST is in flight, or a hold already
   * exists. Chips stop being editable and Continue is blocked; while there is no
   * hold yet it also drives the Continue spinner.
   */
  busy?: boolean;
  /** Explicit override for the Continue spinner. */
  isSubmitting?: boolean;
  /**
   * Keep Continue clickable even while the selection is locked by an existing
   * hold. Set it when `onContinue` *navigates* (e.g. "go to my reservation")
   * rather than creating a new hold — otherwise a visitor who walks back to the
   * seat map mid-hold is left with a frozen map and no way forward.
   */
  allowContinueWhileLocked?: boolean;
  /** One-line notice under the chips — rejection reasons, dropped seats, … */
  message?: string | null;
  messageTone?: 'info' | 'warning' | 'error';
  maxSeats?: number;
  locale?: Locale;
  /** `fixed` (default) survives any page layout; `sticky` flows in a column. */
  position?: 'fixed' | 'sticky';
  className?: string;
}

const TONE_CLASS: Record<'info' | 'warning' | 'error', string> = {
  info: 'text-muted-foreground',
  warning: 'text-warning',
  error: 'text-destructive',
};

export default function BasketBar({
  seats: seatsProp,
  expiresAt: expiresAtProp,
  onRemove,
  onClear,
  onContinue,
  onExpire,
  continueLabel,
  disabled = false,
  busy = false,
  isSubmitting,
  allowContinueWhileLocked = false,
  message,
  messageTone = 'info',
  maxSeats = MAX_SELECTED_SEATS,
  locale = DEFAULT_LOCALE,
  position = 'fixed',
  className,
}: BasketBarProps) {
  // Always subscribed; props simply win when supplied. Doing it this way keeps
  // the hook order unconditional while still allowing a detached, prop-driven bar.
  const storeSeats = useBasketSeats();
  const storeExpiresAt = useBasketExpiresAt();
  const storeRemove = useBasketStore((state) => state.remove);
  const storeClear = useBasketStore((state) => state.clear);

  const seats = seatsProp ?? storeSeats;
  const expiresAt = expiresAtProp !== undefined ? expiresAtProp : storeExpiresAt;

  const remaining = useCountdown(expiresAt, onExpire);
  const hasHold = Boolean(expiresAt);

  if (seats.length === 0 && !hasHold) return null;

  const locked = busy || hasHold;
  const submitting = isSubmitting ?? (busy && !hasHold);
  const removeSeat = locked ? undefined : (onRemove ?? storeRemove);
  const clearSeats = locked ? undefined : (onClear ?? storeClear);

  const urgent = remaining !== null && remaining > 0 && remaining <= URGENT_THRESHOLD_MS;
  const expired = remaining !== null && remaining <= 0;
  const atLimit = seats.length >= maxSeats;

  return (
    <div
      data-testid="basket-bar"
      className={cn(
        'inset-x-0 bottom-0 z-30 border-t border-border bg-surface-raised/95 backdrop-blur',
        'pb-[env(safe-area-inset-bottom)] shadow-[0_-4px_16px_rgb(0_0_0/0.08)]',
        position === 'fixed' ? 'fixed' : 'sticky',
        className,
      )}
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-2 px-3 py-2.5 sm:px-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 sm:flex-nowrap">
          {/* Chips */}
          <div className="order-1 min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t(locale, 'basket.title')}
              </span>
              <span data-testid="basket-count" className="text-xs text-muted-foreground tabular">
                {seats.length === 1
                  ? t(locale, 'basket.countOne')
                  : t(locale, 'basket.count', { count: seats.length })}
              </span>
              {atLimit ? (
                <span className="text-xs text-warning">
                  {t(locale, 'basket.maxSeats', { max: maxSeats })}
                </span>
              ) : null}
            </div>

            {seats.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t(locale, 'basket.empty')}</p>
            ) : (
              <ul className="flex gap-1.5 overflow-x-auto pb-1">
                {seats.map((seat) => {
                  const label = t(locale, 'basket.seatLine', {
                    subsector: seat.subsectorCode,
                    row: seat.row,
                    number: seat.number,
                  });
                  return (
                    <li
                      key={seat.id}
                      data-testid="basket-chip"
                      data-seat-id={seat.id}
                      className="shrink-0"
                    >
                      <span
                        className={cn(
                          'inline-flex items-center gap-1 rounded-full border border-border bg-surface',
                          'py-1 pl-2.5 pr-1 text-xs font-medium text-foreground tabular',
                        )}
                        title={label}
                      >
                        <span aria-hidden="true">
                          {seat.subsectorCode} · {seat.row}-{seat.number}
                        </span>
                        <span className="sr-only">{label}</span>
                        {removeSeat ? (
                          <button
                            type="button"
                            onClick={() => removeSeat(seat.id)}
                            aria-label={`${t(locale, 'basket.remove')}: ${label}`}
                            className="rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive motion-reduce:transition-none"
                          >
                            <X className="size-3.5" aria-hidden="true" />
                          </button>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Countdown */}
          {hasHold && remaining !== null ? (
            <div
              data-testid="hold-countdown"
              className={cn(
                'order-3 flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 sm:order-2',
                expired
                  ? 'bg-destructive/10 text-destructive'
                  : urgent
                    ? 'bg-destructive/10 text-destructive'
                    : 'bg-muted text-foreground',
              )}
              role="timer"
              aria-live={urgent ? 'assertive' : 'off'}
            >
              <Clock
                className={cn('size-4', urgent && !expired && 'animate-pulse motion-reduce:animate-none')}
                aria-hidden="true"
              />
              {expired ? (
                <span className="text-sm font-medium">{t(locale, 'basket.expired')}</span>
              ) : (
                <>
                  <time dateTime={isoDuration(remaining)} className="text-sm font-semibold tabular">
                    {formatCountdown(remaining)}
                  </time>
                  <span className="sr-only">
                    {t(locale, 'basket.countdown', { time: formatCountdown(remaining) })}
                  </span>
                </>
              )}
            </div>
          ) : null}

          {/* Actions */}
          <div className="order-2 flex items-center gap-2 sm:order-3">
            {clearSeats && seats.length > 0 ? (
              <Button
                variant="ghost"
                size="icon"
                onClick={clearSeats}
                aria-label={t(locale, 'basket.clear')}
                title={t(locale, 'basket.clear')}
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </Button>
            ) : null}

            <Button
              data-testid="basket-continue"
              variant="primary"
              size="lg"
              onClick={onContinue}
              loading={submitting}
              disabled={
                disabled ||
                (locked && !allowContinueWhileLocked) ||
                seats.length === 0 ||
                (expired && !allowContinueWhileLocked) ||
                !onContinue
              }
            >
              {continueLabel ?? t(locale, 'basket.continue')}
            </Button>
          </div>
        </div>

        {message ? (
          <p
            data-testid="basket-message"
            className={cn('text-xs', TONE_CLASS[messageTone])}
            role="status"
          >
            {message}
          </p>
        ) : null}

        {hasHold && !expired ? (
          <p className="text-xs text-muted-foreground">
            {urgent ? t(locale, 'basket.expiresSoon') : t(locale, 'basket.holding')}
          </p>
        ) : null}
      </div>
    </div>
  );
}

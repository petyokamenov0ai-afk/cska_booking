/**
 * Display formatting — the only place durations and dates become strings.
 *
 * NOTE on the two `formatCountdown`s: `lib/i18n.ts` already exports one that
 * takes **seconds** (it is used by that module's own dictionary helpers). The
 * one exported here takes **milliseconds**, because that is what
 * `Date.parse(expiresAt) - Date.now()` gives you. This module re-uses the i18n
 * implementation internally, so both always agree on the `m:ss` shape.
 */

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

import {
  DEFAULT_LOCALE,
  formatCountdown as formatCountdownSeconds,
  type Locale,
} from '@/lib/i18n';

/**
 * Conditional class names with Tailwind conflict resolution, so a `className`
 * prop can override a component's own utilities.
 *
 * It lives in this module (rather than the customary `lib/utils.ts`) simply
 * because this is the shared leaf module the map components already own; it has
 * no client-only dependencies and is safe in server components.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Stadium-local time zone. Pinned (rather than "the viewer's zone") so the
 * server-rendered HTML and the client hydration produce byte-identical
 * strings, and so kick-off times always read as they do on the ticket.
 */
export const STADIUM_TIME_ZONE = 'Europe/Sofia';

function intlLocale(locale: Locale): string {
  return locale === 'bg' ? 'bg-BG' : 'en-GB';
}

/* ------------------------------------------------------------------ *
 * Durations
 * ------------------------------------------------------------------ */

/** Milliseconds remaining → `"6:59"`. Never negative. */
export function formatCountdown(ms: number): string {
  if (!Number.isFinite(ms)) return '0:00';
  return formatCountdownSeconds(Math.ceil(Math.max(0, ms) / 1000));
}

/**
 * Milliseconds left until an ISO instant, floored at 0.
 * Returns 0 for `null`/unparseable input, so callers can treat "no hold" and
 * "expired hold" the same way.
 */
export function msUntil(iso: string | null | undefined, now: number = Date.now()): number {
  if (!iso) return 0;
  const target = Date.parse(iso);
  if (Number.isNaN(target)) return 0;
  return Math.max(0, target - now);
}

/** `"PT6M59S"`-ish machine value for `<time dateTime>` on the countdown. */
export function isoDuration(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `PT${Math.floor(total / 60)}M${total % 60}S`;
}

/* ------------------------------------------------------------------ *
 * Dates
 * ------------------------------------------------------------------ */

/**
 * Kick-off instant → `"сб, 15 авг 2026 г., 20:00"` / `"Sat, 15 Aug 2026, 20:00"`.
 * The year is always included so the output does not depend on the current
 * date (which would break hydration).
 */
export function formatKickoff(iso: string, locale: Locale = DEFAULT_LOCALE): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(intlLocale(locale), {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: STADIUM_TIME_ZONE,
  }).format(date);
}

/** Date only, e.g. `"15 авг 2026 г."`. */
export function formatDate(iso: string, locale: Locale = DEFAULT_LOCALE): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(intlLocale(locale), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: STADIUM_TIME_ZONE,
  }).format(date);
}

/** Time only, e.g. `"20:00"`. */
export function formatTime(iso: string, locale: Locale = DEFAULT_LOCALE): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(intlLocale(locale), {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: STADIUM_TIME_ZONE,
  }).format(date);
}

/* ------------------------------------------------------------------ *
 * Misc
 * ------------------------------------------------------------------ */

/** `"А1 / A1"` — the dual Cyrillic/Latin label used all over the drawing. */
export function formatDualCode(code: string, latin: string): string {
  return code === latin ? code : `${code} / ${latin}`;
}

/** Integer percentage 0..100, safe for `total === 0`. */
export function percent(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}

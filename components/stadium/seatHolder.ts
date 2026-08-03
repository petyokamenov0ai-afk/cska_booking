/**
 * Holder-label helpers.
 *
 * They exist because `SeatDTO.holder` is nullable and, on the live database,
 * every pre-existing booking has no name — so the fallback is the common case,
 * not an edge. Funnelling every read through here is what makes a rendered
 * `"null"` (or a literal `{name}` left behind by `interpolate`) structurally
 * impossible, and it is the only part of this feature that is testable in the
 * node-only vitest setup.
 *
 * "Structurally impossible" now includes *rendering nothing at all*: `holder`
 * and `note` both pass through `visibleText`, so a value made only of zero-width
 * or combining characters — legal today in a hand-written row, and legal in the
 * schema before D4 — can no longer produce a bold "За: " with an empty tail.
 *
 * No `'use client'`: pure functions, no hooks, so the seat map and the server
 * render can both call them.
 */

import type { SeatVisualState } from '@/components/stadium/Seat';
import { t, type Locale } from '@/lib/i18n';
import type { SeatDTO } from '@/lib/types';
import { SEAT_NOTE_MAX, rendersSomething } from '@/lib/zodSchemas';

/**
 * Visual states that mean "a reservation exists", i.e. a holder line belongs.
 *
 * `SELECTED` is excluded on purpose: it is the seat being named right now, or a
 * booking still in flight — nothing is committed, so there is no holder to show.
 * `BLOCKED` is excluded because "Без име" on an administrator-killed seat reads
 * as "booked by someone anonymous", which is the opposite of the truth.
 */
export function seatHasHolder(state: SeatVisualState): boolean {
  return state === 'MINE' || state === 'RESERVED' || state === 'HELD';
}

/**
 * Trim, then refuse anything that would paint nothing.
 *
 * `trim()` on its own is not enough: it does not touch U+200B/200C/200D, U+00AD,
 * a bare combining mark or the Hangul fillers, and a value made only of those
 * used to come back `named: true` — a bold "За: " with an empty tail, and an
 * aria-label ending ", за ".
 *
 * EVERY read of a user-written string on the map goes through here, which is
 * what turns this file's header claim from an aspiration into a structure. The
 * predicate is imported rather than restated so we render by exactly the rule
 * the schema enforces and `lib/booking.ts` writes by; `lib/zodSchemas` is
 * dependency-free and client-safe by design, so it costs the browser nothing.
 */
export function visibleText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && rendersSomething(trimmed) ? trimmed : null;
}

/**
 * The holder line for a seat that carries a reservation.
 *
 * `interpolate` leaves an unreplaced `{name}` in the string when the variable is
 * undefined, so the fallback has to be resolved *before* `t()` is called — never
 * by passing a possibly-absent name in and hoping.
 *
 * Returns `named` so the caller can style a real person differently from the
 * placeholder: the name is the thing the user came to read, the placeholder is
 * not.
 */
export function holderLabel(
  locale: Locale,
  holder: string | null | undefined,
): { text: string; named: boolean } {
  const name = visibleText(holder);
  return name
    ? { text: t(locale, 'seat.holder', { name }), named: true }
    : { text: t(locale, 'seat.holderUnknown'), named: false };
}

/**
 * The note as rendered, or `null`.
 *
 * No "Без име"-style placeholder to pair with `holderLabel`'s: the absence of a
 * *name* on a booking is itself information — someone booked this and we do not
 * know who — whereas the absence of a note is simply nothing to say.
 */
export function noteLabel(note: string | null | undefined): string | null {
  return visibleText(note);
}

/**
 * The note as an accessible-name fragment, clipped at the bound the schema
 * enforces.
 *
 * The clip is not redundant with `seatNoteSchema`: the route is not the only way
 * into the column, and an accessible name is read *aloud* — an unbounded one is
 * a sentence the listener cannot interrupt. The bubble solves the same problem
 * with `line-clamp`, which a screen reader does not honour.
 */
export function noteAriaFragment(note: string | null | undefined): string | null {
  const text = noteLabel(note);
  if (text === null) return null;
  return text.length <= SEAT_NOTE_MAX
    ? text
    : `${text.slice(0, SEAT_NOTE_MAX - 1).trimEnd()}…`;
}

/**
 * "You cannot have this seat" — shared by the tap handler and by the effect that
 * closes the naming dialog when the seat is lost mid-typing, so both phrasings
 * can never drift apart.
 *
 * This is also the primary *touch* affordance for the holder name: a phone
 * cannot hover, but tapping an occupied seat is the gesture a phone user already
 * makes, and it now answers "whose is it?" instead of just "not yours".
 *
 * The **note is deliberately not here**, and a vitest case pins that: this
 * sentence answers *why you cannot have this seat*, and the note is information
 * about someone else's booking rather than about the refusal. It also fires on
 * the first tap now (D3), which is precisely the moment it has to stay one short
 * sentence. Nobody is deprived — the press-to-peek bubble carries the note on
 * that same first tap, and the accessible name carries it for a screen reader.
 */
export function seatUnavailableMessage(locale: Locale, seat: SeatDTO): string {
  const vars = { row: String(seat.row), seat: String(seat.number) };
  // A switched-off seat is not "taken" — it does not exist to be booked.
  if (seat.status === 'BLOCKED') return t(locale, 'book.blocked', vars);
  const name = visibleText(seat.holder);
  return name
    ? t(locale, 'book.unavailableNamed', { ...vars, name })
    : t(locale, 'book.unavailable', vars);
}

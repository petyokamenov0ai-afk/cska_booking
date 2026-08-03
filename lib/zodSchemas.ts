/**
 * Request validation — `docs/API_CONTRACT.md § Endpoints`.
 *
 * This module is deliberately dependency-free apart from `zod` (and type-only
 * imports), so **client components may import it** for form validation without
 * dragging Prisma or `next/server` into the browser bundle. Do not import
 * `lib/db.ts`, `lib/reservations.ts` or anything server-only from here.
 *
 * `MAX_SEATS_PER_RESERVATION` is defined here for that reason and re-exported
 * from `lib/reservations.ts`, where the API contract advertises it. There is one
 * definition, two import paths — the values can never drift.
 */

import { z } from 'zod';
import type {
  BookSeatBody,
  ConfirmReservationBody,
  CreateReservationBody,
} from '@/lib/types';

/* ------------------------------------------------------------------ *
 * Limits
 * ------------------------------------------------------------------ */

/** IMPLEMENTATION_PLAN §5 — anti seat-hoarding cap. */
export const MAX_SEATS_PER_RESERVATION = 10;

/** `generateReservationCode()` emits exactly this many characters. */
export const RESERVATION_CODE_LENGTH = 6;

/**
 * Crockford-ish alphabet: digits 2–9 plus A–Z without `I` and `O`.
 * 32 symbols, so `byte % 32` is an unbiased draw. Excludes the four
 * mutually-confusable glyphs `I O 0 1` — codes get read aloud and retyped.
 */
export const RESERVATION_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

/** cuid()s in practice, but never assume the id generator. */
export const idSchema = z.string().trim().min(1).max(64);

export const seatIdSchema = idSchema;
export const eventIdSchema = idSchema;

/**
 * Reservation code. Accepts any case / surrounding whitespace and normalises to
 * upper case, then checks it only contains alphabet characters.
 */
export const reservationCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .length(RESERVATION_CODE_LENGTH)
  .regex(
    new RegExp(`^[${RESERVATION_CODE_ALPHABET}]+$`),
    'Not a valid reservation code.',
  );

/**
 * Sector code — CYRILLIC `А Б В Г` (U+0410, U+0411, U+0412, U+0413).
 * The character class is written with explicit escapes so a future editor
 * cannot silently "fix" it into Latin lookalikes.
 */
export const sectorCodeSchema = z
  .string()
  .trim()
  .regex(/^[АБВГ]$/u, 'Not a Cyrillic sector code.');

/**
 * Subsector code — Cyrillic stand letter + 1–2 digits, e.g. `А1`, `Г22`.
 * Callers must `decodeURIComponent` the path segment first.
 */
export const subsectorCodeSchema = z
  .string()
  .trim()
  .regex(
    /^[АБВГ]\d{1,2}$/u,
    'Not a Cyrillic subsector code.',
  );

/** Longest seat-holder name the map is willing to carry. */
export const SEAT_HOLDER_NAME_MAX = 120;

/**
 * The note's bound. Deliberately the same number as the name: one figure to
 * remember, it is what the hover bubble can show in three clamped lines, and it
 * is the most an accessible name can absorb without more than doubling.
 * Exported so the textarea's `maxLength`, this schema and the aria clip cannot
 * drift apart.
 */
export const SEAT_NOTE_MAX = 120;

/**
 * Characters that have no business in either field and actively break the UI:
 * C0/C1 controls (an interior newline blows out the tooltip's one-line first row,
 * and in the note it spends a whole clamped line on a line break) and the bidi
 * overrides/isolates (U+202E can visually rewrite the text *around* the value on
 * the map — and the note renders directly beneath the name it could rewrite).
 * `\p{Cf}` as a whole is deliberately NOT stripped: it would take ZWJ with it and
 * shred family emoji.
 */
const UNSAFE_TEXT_CHARS = /[\p{Cc}\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/**
 * Replace-with-space, then collapse, so "Иван\nПетров" is not "ИванПетров".
 *
 * Named for text rather than for the name because the note travels the same
 * pipeline: one rule for both fields is what stops a character the map cannot
 * survive in a name from surviving in a note.
 *
 * Exported because the *storage* layer applies it too (`lib/booking.ts`): the
 * route's parse is the only path a browser can take, but it is not the only path
 * into the column, and a value written by a script is rendered into the seat map
 * exactly like any other. Idempotent, so running it twice costs nothing.
 * Length is **not** checked here — that is the schema's job, and this must never
 * be able to reject.
 */
export function normaliseSeatText(value: string): string {
  return value.replace(UNSAFE_TEXT_CHARS, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * A code point that paints nothing on its own.
 *
 * `\p{Mn}`/`\p{Me}` are listed as CARRIERS, not as banned characters: a value
 * that also has a base letter still passes, which keeps "Пападо́пулос" and every
 * VS16 emoji legal — only a value made ENTIRELY of marks is refused. The five
 * literals are the invisible code points Unicode files as letters or symbols,
 * where no property test can see them: the braille blank and the four Hangul
 * fillers.
 *
 * `\p{Zs}` is listed for completeness only: `normaliseSeatText`'s `\s+` and
 * `trim()` have already removed NBSP, U+3000, U+1680, the BOM and the rest.
 */
const INVISIBLE_CODEPOINT =
  /^[\p{Cc}\p{Cf}\p{Cs}\p{Zs}\p{Zl}\p{Zp}\p{Mn}\p{Me}\u2800\u115F\u1160\u3164\uFFA0]$/u;

/**
 * True when the string puts at least one glyph on screen.
 *
 * `for…of` iterates CODE POINTS, so an astral character is tested whole rather
 * than as two lone surrogates (which `\p{Cs}` would otherwise call invisible).
 */
export function rendersSomething(value: string): boolean {
  for (const ch of value) if (!INVISIBLE_CODEPOINT.test(ch)) return true;
  return false;
}

const tidyText = (value: unknown): unknown =>
  typeof value === 'string' ? normaliseSeatText(value) : value;

/**
 * Seat-holder / reservation-contact name.
 *
 * One definition, two callers — the click-to-book body and the confirm body — so
 * a name the booking modal accepts can never be one the server rejects. The
 * client imports this module directly (see the header), which is the whole
 * mechanism preventing that drift.
 */
export const seatHolderNameSchema = z.preprocess(
  tidyText,
  z
    .string()
    .trim()
    .min(2, 'Name is too short.')
    .max(SEAT_HOLDER_NAME_MAX)
    // `.min` counts code units; this counts INK. Without it a name of two
    // zero-width spaces is legal, and the map renders a bold "За: " with nothing
    // after it plus an aria-label ending ", за " — see components/stadium/seatHolder.ts.
    .refine(rendersSomething, 'Name renders as nothing.'),
);

/**
 * Optional free text beside the name — `Допълнителна информация`.
 *
 * `optionalTrimmed` below is deliberately not reused: it tests
 * `value.trim() === ''` on the RAW string, so it neither normalises first nor
 * sees a value made only of zero-width characters. An optional field that would
 * render nothing is simply absent — dropping it instead of rejecting it is why
 * the booking dialog still needs exactly one error state, the name's.
 */
export const seatNoteSchema = z.preprocess((value) => {
  // `null` counts as absent so a caller can echo `SeatDTO.note` — which is
  // nullable, never optional — straight back with no translation step.
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') return value; // let zod report the type
  const tidy = normaliseSeatText(value);
  return tidy === '' || !rendersSomething(tidy) ? undefined : tidy;
}, z.string().max(SEAT_NOTE_MAX, 'Note is too long.').optional());

/** Trimmed, empty string counts as absent. */
const optionalTrimmed = (inner: z.ZodType<string>) =>
  z.preprocess(
    (value) =>
      typeof value === 'string' && value.trim() === '' ? undefined : value,
    inner.optional(),
  );

/* ------------------------------------------------------------------ *
 * Bodies
 * ------------------------------------------------------------------ */

/** `POST /api/events/:eventId/reservations` */
export const createReservationSchema = z.object({
  seatIds: z
    .array(seatIdSchema)
    .min(1, 'Select at least one seat.')
    .max(
      MAX_SEATS_PER_RESERVATION,
      `At most ${MAX_SEATS_PER_RESERVATION} seats per reservation.`,
    ),
});

/**
 * `POST /api/seats/:seatId` — click-to-book carries the seat holder's name and,
 * optionally, a free-text note about that one seat.
 *
 * `note` is optional on the way in and nullable on the way out (`SeatDTO.note`),
 * the same split `ConfirmReservationBody.phone` already uses: a request omits
 * what it does not have, a response has to state the absence.
 */
export const bookSeatSchema = z.object({
  name: seatHolderNameSchema,
  note: seatNoteSchema,
});

/** `PATCH /api/reservations/:code` */
export const confirmReservationSchema = z.object({
  name: seatHolderNameSchema,
  email: z.string().trim().toLowerCase().email('Not a valid e-mail address.').max(160),
  phone: optionalTrimmed(
    z
      .string()
      .min(6, 'Phone number is too short.')
      .max(32)
      .regex(/^[+()\s\d-]+$/, 'Not a valid phone number.'),
  ),
});

/** Path params, for routes that want one parse call. */
export const subsectorSeatsParamsSchema = z.object({
  eventId: eventIdSchema,
  code: subsectorCodeSchema,
});

export const reservationParamsSchema = z.object({
  code: reservationCodeSchema,
});

export const eventParamsSchema = z.object({
  eventId: eventIdSchema,
});

/* ------------------------------------------------------------------ *
 * Inferred types
 * ------------------------------------------------------------------ */

export type CreateReservationInput = z.infer<typeof createReservationSchema>;
export type BookSeatInput = z.infer<typeof bookSeatSchema>;
export type ConfirmReservationInput = z.infer<typeof confirmReservationSchema>;
export type SubsectorSeatsParams = z.infer<typeof subsectorSeatsParamsSchema>;
export type ReservationParams = z.infer<typeof reservationParamsSchema>;
export type EventParams = z.infer<typeof eventParamsSchema>;

/**
 * Compile-time proof that the schemas still produce exactly the wire bodies in
 * `lib/types.ts`. If a schema drifts, one of these tuple slots narrows to
 * `false` and the `true` literal below stops assigning — a type error, here,
 * instead of a runtime surprise in a route handler.
 */
export type SchemaContractCheck = [
  CreateReservationInput extends CreateReservationBody ? true : false,
  CreateReservationBody extends CreateReservationInput ? true : false,
  ConfirmReservationInput extends ConfirmReservationBody ? true : false,
  ConfirmReservationBody extends ConfirmReservationInput ? true : false,
  BookSeatInput extends BookSeatBody ? true : false,
  BookSeatBody extends BookSeatInput ? true : false,
];

export const SCHEMAS_MATCH_CONTRACT: SchemaContractCheck = [
  true,
  true,
  true,
  true,
  true,
  true,
];

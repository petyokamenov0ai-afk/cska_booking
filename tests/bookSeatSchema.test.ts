/**
 * The seat-holder name and seat-note rules — `seatHolderNameSchema`,
 * `seatNoteSchema`, `bookSeatSchema`.
 *
 * Pure: no Postgres, no fixture, no clock. That matters because these are the
 * rules the browser and the route handler both apply, from the same objects —
 * the modal must never accept a value the server then rejects — so they have to
 * be verifiable on any machine, including one with no `docker compose up`.
 *
 * The normalisation cases are the interesting ones. A seat holder's name is
 * rendered inside a one-line tooltip on a map of ~1,200 seats, so a stray
 * newline or a bidi override is a layout bug (or a spoofing trick) rather than
 * a cosmetic detail — and stripping too eagerly would shred a family emoji.
 *
 * The "renders as nothing" block is the third rule and the subtlest: a value can
 * be two characters long, survive `trim()` whole, and still paint no pixels. The
 * map would then show a bold "За: " with an empty tail and an aria-label ending
 * ", за ". So length is checked in code units and *ink* is checked separately.
 */

import { describe, expect, it } from 'vitest';

import {
  SEAT_NOTE_MAX,
  bookSeatSchema,
  confirmReservationSchema,
  rendersSomething,
  seatHolderNameSchema,
  seatNoteSchema,
} from '@/lib/zodSchemas';

/** Built from code points so no editor or tool can render them back to invisible glyphs. */
const RLO = String.fromCodePoint(0x202e); // RIGHT-TO-LEFT OVERRIDE
const ZWJ = String.fromCodePoint(0x200d); // ZERO WIDTH JOINER — holds emoji together
const cp = (...codes: number[]): string => String.fromCodePoint(...codes);

function parse(value: unknown): { ok: boolean; data?: string } {
  const result = seatHolderNameSchema.safeParse(value);
  return result.success ? { ok: true, data: result.data as string } : { ok: false };
}

describe('seatHolderNameSchema', () => {
  it('rejects anything that is not at least two characters of actual name', () => {
    // Trimming happens before the length check, so whitespace-only is "too
    // short" rather than "present" — an all-spaces name must never book a seat.
    for (const value of ['', '   ', 'a', '  a  ', '\n\n', '\t']) {
      expect(parse(value).ok, JSON.stringify(value)).toBe(false);
    }
  });

  it('rejects a name longer than 120 characters, in either script', () => {
    expect(parse('x'.repeat(121)).ok).toBe(false);
    expect(parse('И'.repeat(121)).ok).toBe(false);
    // 121 is rejected, not truncated: the input caps typing at 120, so this can
    // only ever arrive from a hand-crafted request.
    expect(parse('x'.repeat(120)).ok).toBe(true);
    expect(parse('И'.repeat(120)).ok).toBe(true);
  });

  it('rejects non-strings rather than coercing them', () => {
    for (const value of [42, null, undefined, {}, ['Иван'], true]) {
      expect(parse(value).ok, JSON.stringify(value ?? null)).toBe(false);
    }
  });

  it('accepts ordinary names', () => {
    for (const value of ['Ив', 'Иван Петров', 'Ivan Petrov', "O'Brien", '🐍🐍']) {
      expect(parse(value).ok, value).toBe(true);
    }
  });

  it('trims and collapses whitespace instead of deleting it', () => {
    expect(parse('  Иван Петров  ').data).toBe('Иван Петров');
    expect(parse('Иван   Петров').data).toBe('Иван Петров');
    // The whole reason controls become a space rather than nothing: joining the
    // two halves into "ИванПетров" would silently rename the person.
    expect(parse('Иван\nПетров').data).toBe('Иван Петров');
    expect(parse('Иван\tПетров').data).toBe('Иван Петров');
  });

  it('strips bidi overrides, which can rewrite the text around them on the map', () => {
    const parsed = parse(`Ив${RLO}ан`);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).not.toContain(RLO);
    expect(parsed.data).toBe('Ив ан');
  });

  it('keeps the zero-width joiner, so emoji sequences survive intact', () => {
    const family = `👨${ZWJ}👩${ZWJ}👧 Петрови`;
    const parsed = parse(family);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toBe(family);
    expect(parsed.data).toContain(ZWJ);
  });
});

/* ------------------------------------------------------------------ *
 * D4 — values that occupy code units but paint nothing
 * ------------------------------------------------------------------ */

/**
 * Every one of these is at least two code units long and survives `trim()`, so
 * before the ink check each was a legal name. Named rather than listed inline,
 * because the *reason* a code point is here is the whole content of the test.
 */
const RENDERS_NOTHING: Array<[string, string]> = [
  ['zero-width space ×2', cp(0x200b, 0x200b)],
  ['zero-width non-joiner ×2', cp(0x200c, 0x200c)],
  ['zero-width joiner ×2', cp(0x200d, 0x200d)],
  ['word joiner ×2', cp(0x2060, 0x2060)],
  ['soft hyphen ×2', cp(0x00ad, 0x00ad)],
  ['Mongolian vowel separator ×2', cp(0x180e, 0x180e)],
  ['braille blank ×2', cp(0x2800, 0x2800)],
  ['Hangul choseong filler ×2', cp(0x115f, 0x115f)],
  ['Hangul jungseong filler ×2', cp(0x1160, 0x1160)],
  ['Hangul filler ×2', cp(0x3164, 0x3164)],
  ['halfwidth Hangul filler ×2', cp(0xffa0, 0xffa0)],
  ['combining acute ×2, no base letter', cp(0x0301, 0x0301)],
  ['Cyrillic titlo ×2, no base letter', cp(0x0483, 0x0483)],
  ['variation selector-16 ×2', cp(0xfe0f, 0xfe0f)],
  ['interlinear annotation anchor + terminator', cp(0xfff9, 0xfffa)],
  ['tag characters (astral)', cp(0xe0061, 0xe0062)],
  ['language tag ×2 (astral)', cp(0xe0001, 0xe0001)],
  // Mixed pairs: each half invisible for a different reason, so a rule that only
  // knew about one class would let these through.
  ['ZWSP + ZWJ', cp(0x200b, 0x200d)],
  ['VS16 + ZWJ', cp(0xfe0f, 0x200d)],
  ['combining acute + ZWSP', cp(0x0301, 0x200b)],
  ['LRM + RLM', cp(0x200e, 0x200f)],
  // Already rejected before this rule existed, because JS `\s` covers them and
  // the normaliser collapses them away. Kept as a regression on that path.
  ['no-break space ×2', cp(0x00a0, 0x00a0)],
  ['ideographic space ×2', cp(0x3000, 0x3000)],
  ['figure space ×2', cp(0x2007, 0x2007)],
  ['byte-order mark ×2', cp(0xfeff, 0xfeff)],
];

/**
 * The other side of the same rule. Two boundaries are written down here rather
 * than left to be rediscovered:
 *
 *   * U+FFFD REPLACEMENT CHARACTER is `\p{So}` and genuinely paints a glyph.
 *     Mojibake is a different problem needing a different rule, not this one.
 *   * an unassigned code point renders as tofu (`▯`), i.e. visibly, so it is
 *     accepted too.
 */
const RENDERS_SOMETHING: Array<[string, string]> = [
  ['ordinary Cyrillic', 'Иван Петров'],
  ['two-letter name', 'Ян'],
  ['hyphenated', 'Анна-Мария'],
  ['Latin', 'Jo Li'],
  ['flag emoji', '🇧🇬'],
  ['heart + VS16', cp(0x2764, 0xfe0f)],
  ['emoji + skin tone', cp(0x1f44d, 0x1f3fd)],
  ['base letter carrying a combining acute', `Пападо${cp(0x0301)}пулос`],
  ['Han', '李小龙'],
  ['Arabic with an interior ZWNJ', `عبد${cp(0x200c)}الله`],
  ['tag-sequence flag (England)', '🏴󠁧󠁢󠁥󠁮󠁧󠁿'],
  ['name with a trailing ZWSP', `Иван${cp(0x200b)}`],
  ['replacement character', `${cp(0xfffd)}${cp(0xfffd)}`],
  ['a letter from a block added after this rule was written', cp(0x0870, 0x0870)],
];

describe('rendersSomething', () => {
  it('is false for values made entirely of code points that paint nothing', () => {
    for (const [label, value] of RENDERS_NOTHING) {
      expect(rendersSomething(value), label).toBe(false);
    }
  });

  it('is true as soon as one code point puts ink on screen', () => {
    for (const [label, value] of RENDERS_SOMETHING) {
      expect(rendersSomething(value), label).toBe(true);
    }
  });
});

describe('seatHolderNameSchema — a name must render', () => {
  it('rejects a name that occupies code units but paints nothing', () => {
    for (const [label, value] of RENDERS_NOTHING) {
      expect(parse(value).ok, label).toBe(false);
    }
  });

  it('still accepts every name that does render, byte-identical', () => {
    for (const [label, value] of RENDERS_SOMETHING) {
      const parsed = parse(value);
      expect(parsed.ok, label).toBe(true);
      // Nothing in the ink check may rewrite the value: the acute in
      // "Пападо́пулос" and the ZWJ in a family emoji have to come back untouched.
      expect(parsed.data, label).toBe(value.replace(/\s+/g, ' ').trim());
    }
  });
});

/* ------------------------------------------------------------------ *
 * The note
 * ------------------------------------------------------------------ */

function parseNote(value: unknown): { ok: boolean; data?: string | undefined } {
  const result = seatNoteSchema.safeParse(value);
  return result.success
    ? { ok: true, data: result.data as string | undefined }
    : { ok: false };
}

describe('seatNoteSchema', () => {
  it('treats every flavour of "no note" as absent rather than as an error', () => {
    // The field is optional, so a note that would render nothing is not a
    // mistake to report — it is simply not a note. This is what keeps the
    // booking dialog down to one error state, the name's.
    for (const value of [undefined, null, '', '   ', '\n\t', ...RENDERS_NOTHING.map(([, v]) => v)]) {
      const parsed = parseNote(value);
      expect(parsed.ok, JSON.stringify(value ?? null)).toBe(true);
      expect(parsed.data, JSON.stringify(value ?? null)).toBeUndefined();
    }
  });

  it('accepts free text and hands it back normalised', () => {
    expect(parseNote('плаща в брой').data).toBe('плаща в брой');
    expect(parseNote('  x  y  ').data).toBe('x y');
  });

  it('turns a newline into a space rather than deleting it', () => {
    // Same reasoning as the name: joining the halves would invent a word that
    // nobody typed, and the bubble clamps the note to three lines anyway, so a
    // typist's line break would cost one of them.
    expect(parseNote('вход Б\nдо пътеката').data).toBe('вход Б до пътеката');
  });

  it('strips bidi overrides, which sit directly under the name on the map', () => {
    const parsed = parseNote(`a${RLO}b`);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).not.toContain(RLO);
    expect(parsed.data).toBe('a b');
  });

  it('bounds the note at exactly SEAT_NOTE_MAX characters', () => {
    expect(SEAT_NOTE_MAX).toBe(120);
    expect(parseNote('я'.repeat(SEAT_NOTE_MAX)).ok).toBe(true);
    // Rejected, not truncated: the textarea caps typing at the same number, so
    // a longer value can only arrive from a hand-crafted request.
    expect(parseNote('я'.repeat(SEAT_NOTE_MAX + 1)).ok).toBe(false);
  });

  it('rejects non-strings rather than coercing them', () => {
    for (const value of [42, {}, ['x'], true]) {
      expect(parseNote(value).ok, JSON.stringify(value)).toBe(false);
    }
  });
});

describe('bookSeatSchema', () => {
  it('requires the name field', () => {
    expect(bookSeatSchema.safeParse({}).success).toBe(false);
    expect(bookSeatSchema.safeParse({ name: 42 }).success).toBe(false);
    expect(bookSeatSchema.safeParse({ name: ' ' }).success).toBe(false);
    expect(bookSeatSchema.safeParse(null).success).toBe(false);
    expect(bookSeatSchema.safeParse('Иван').success).toBe(false);
  });

  it('hands the route a normalised name', () => {
    const parsed = bookSeatSchema.safeParse({ name: '  Иван   Петров  ' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.name).toBe('Иван Петров');
  });

  it('reports failures as messages only, never echoing the rejected name', () => {
    const parsed = bookSeatSchema.safeParse({ name: 'x'.repeat(200) });
    expect(parsed.success).toBe(false);
    // `validationError` puts exactly this into the 400 body.
    const flat = JSON.stringify(parsed.success ? {} : parsed.error.flatten());
    expect(flat).not.toContain('xxxxx');
  });

  it('books with no note at all', () => {
    // The overwhelmingly common request: a name and nothing else. `note` must be
    // absent from the parsed object, not present-and-empty, so the storage layer
    // has one "no note" state rather than two.
    const parsed = bookSeatSchema.safeParse({ name: 'Иван Петров' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.note).toBeUndefined();
    expect(parsed.success && 'note' in parsed.data).toBe(false);
  });

  it('carries a note through, normalised, alongside the name', () => {
    const parsed = bookSeatSchema.safeParse({
      name: '  Иван   Петров  ',
      note: '  плаща в брой,\nвход Б  ',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.name).toBe('Иван Петров');
    expect(parsed.success && parsed.data.note).toBe('плаща в брой, вход Б');
  });

  it('rejects the whole body when only the note is too long', () => {
    // An over-long note is a 400 VALIDATION, never a silent booking that drops
    // the field and never a 500 from the column.
    const parsed = bookSeatSchema.safeParse({
      name: 'Иван Петров',
      note: 'я'.repeat(SEAT_NOTE_MAX + 1),
    });
    expect(parsed.success).toBe(false);
    expect(parsed.success ? [] : Object.keys(parsed.error.flatten().fieldErrors)).toEqual([
      'note',
    ]);
  });

  it('never lets a bad note book the seat and never echoes it back', () => {
    const parsed = bookSeatSchema.safeParse({ name: 'Иван', note: 'ю'.repeat(200) });
    expect(parsed.success).toBe(false);
    const flat = JSON.stringify(parsed.success ? {} : parsed.error.flatten());
    expect(flat).not.toContain('юююю');
  });
});

describe('one rule, two callers', () => {
  it('is the same object the confirm-reservation body uses', () => {
    // Identity, not equivalence: two schemas that merely *look* alike are how a
    // modal ends up accepting what the server rejects.
    expect(confirmReservationSchema.shape.name).toBe(seatHolderNameSchema);
  });

  it('gives the booking body the same note object the dialog validates with', () => {
    // Same argument as above, one field over: the dialog previews the server's
    // normalisation by parsing with this exact object before it POSTs.
    expect(bookSeatSchema.shape.note).toBe(seatNoteSchema);
    expect(bookSeatSchema.shape.name).toBe(seatHolderNameSchema);
  });
});

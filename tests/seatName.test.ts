/**
 * Holder labels and the i18n keys behind them.
 *
 * Pure: no Postgres, no browser. The seat map itself can only be exercised in
 * Playwright (vitest runs `environment: 'node'` and there is no jsdom here on
 * purpose), so these helpers are deliberately the place where the whole
 * nullable-holder problem is decided — and therefore the one part of the feature
 * that is provable on any machine.
 *
 * The fallback is not an edge case: every booking that existed before this
 * feature has `name = null`, so "renders sensibly with no name" is the *common*
 * path and is tested first.
 */

import { describe, expect, it } from 'vitest';

import {
  holderLabel,
  noteAriaFragment,
  noteLabel,
  seatHasHolder,
  seatUnavailableMessage,
  visibleText,
} from '@/components/stadium/seatHolder';
import type { SeatVisualState } from '@/components/stadium/Seat';
import { LOCALES, t } from '@/lib/i18n';
import type { SeatDTO, SeatStatus } from '@/lib/types';
import { SEAT_NOTE_MAX } from '@/lib/zodSchemas';

function seat(overrides: Partial<SeatDTO> = {}): SeatDTO {
  return {
    id: 'seat-1',
    row: 4,
    number: 12,
    x: 0,
    y: 0,
    angle: 0,
    type: 'STANDARD',
    white: false,
    status: 'RESERVED' as SeatStatus,
    mine: false,
    holder: null,
    note: null,
    ...overrides,
  };
}

describe('seatHasHolder', () => {
  it('is true exactly for the states that carry a reservation', () => {
    for (const state of ['MINE', 'RESERVED', 'HELD'] as SeatVisualState[]) {
      expect(seatHasHolder(state), state).toBe(true);
    }
  });

  it('is false for FREE, SELECTED and BLOCKED', () => {
    // SELECTED is the seat being named right now (or a booking still in flight):
    // nothing is committed, so claiming a holder would be a lie. BLOCKED is an
    // administrator-killed seat — "Без име" there reads as "booked by someone
    // anonymous", which is the opposite of what it means.
    for (const state of ['FREE', 'SELECTED', 'BLOCKED'] as SeatVisualState[]) {
      expect(seatHasHolder(state), state).toBe(false);
    }
  });
});

describe('holderLabel', () => {
  it('falls back to a real placeholder for every shape of "no name"', () => {
    for (const holder of [null, undefined, '', '   ']) {
      const label = holderLabel('bg', holder);
      expect(label, JSON.stringify(holder)).toEqual({ text: 'Без име', named: false });
    }
  });

  it('never leaks null, undefined or an unreplaced placeholder into the UI', () => {
    // The three ways this feature could visibly break on the ~190 nameless rows
    // already in the database.
    for (const locale of LOCALES) {
      for (const holder of [null, undefined, '', '  ']) {
        const { text } = holderLabel(locale, holder);
        expect(text).not.toContain('null');
        expect(text).not.toContain('undefined');
        expect(text).not.toContain('{');
        expect(text.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('renders a real name, and trims it', () => {
    expect(holderLabel('bg', 'Иван')).toEqual({ text: 'За: Иван', named: true });
    expect(holderLabel('bg', '  Иван  ')).toEqual({ text: 'За: Иван', named: true });
    expect(holderLabel('en', 'Ivan')).toEqual({ text: 'For: Ivan', named: true });
  });
});

/**
 * D4's render half. The schema now refuses a name that paints nothing, but the
 * column is older than the schema and a script can still write straight into it,
 * so the map has to refuse it a second time at read.
 *
 * Vectors are built with `String.fromCodePoint` rather than pasted, so a future
 * editor cannot "clean up" an invisible character out of the test that exists to
 * catch it.
 */
const ZWSP = String.fromCodePoint(0x200b);
const ZWNJ = String.fromCodePoint(0x200c);
const ZWJ = String.fromCodePoint(0x200d);
const SOFT_HYPHEN = String.fromCodePoint(0x00ad);
const BRAILLE_BLANK = String.fromCodePoint(0x2800);
const HANGUL_FILLER = String.fromCodePoint(0x3164);
const COMBINING_ACUTE = String.fromCodePoint(0x0301);
const VS16 = String.fromCodePoint(0xfe0f);
const FAMILY = [0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f466].map((c) => String.fromCodePoint(c)).join('');

describe('visibleText', () => {
  it('returns null for every shape of "nothing to render"', () => {
    for (const value of [
      null,
      undefined,
      '',
      '   ',
      ZWSP + ZWSP,
      ZWNJ + ZWNJ,
      ZWJ + ZWJ,
      SOFT_HYPHEN + SOFT_HYPHEN,
      BRAILLE_BLANK + BRAILLE_BLANK,
      HANGUL_FILLER + HANGUL_FILLER,
      COMBINING_ACUTE + COMBINING_ACUTE,
      VS16 + VS16,
    ]) {
      expect(visibleText(value), JSON.stringify(value)).toBeNull();
    }
  });

  it('keeps anything that puts a glyph on screen, trimmed', () => {
    expect(visibleText('  Иван  ')).toBe('Иван');
    // The marks are CARRIERS, not banned characters: a base letter still passes.
    expect(visibleText('Пападо' + COMBINING_ACUTE + 'пулос')).toBe('Пападо' + COMBINING_ACUTE + 'пулос');
    // ZWJ survives intact — shredding it would break every family emoji.
    expect(visibleText(FAMILY)).toBe(FAMILY);
    expect(visibleText('Иван' + ZWSP)).toBe('Иван' + ZWSP);
  });
});

describe('holderLabel — D4', () => {
  it('reports the placeholder, not a bold empty tail, for an invisible name', () => {
    // Before the fix this returned `named: true` and rendered "За: " with
    // nothing after it, plus an aria-label ending ", за ".
    for (const holder of [ZWSP + ZWSP, COMBINING_ACUTE + COMBINING_ACUTE, BRAILLE_BLANK]) {
      expect(holderLabel('bg', holder), JSON.stringify(holder)).toEqual({
        text: 'Без име',
        named: false,
      });
    }
  });
});

describe('noteLabel', () => {
  it('is null whenever there is nothing to caption', () => {
    for (const note of [null, undefined, '', '  ', ZWSP + ZWNJ + ZWJ]) {
      expect(noteLabel(note), JSON.stringify(note)).toBeNull();
    }
  });

  it('renders a real note, trimmed, with no placeholder of its own', () => {
    // Unlike `holderLabel`, the absence of a note is not information: a booking
    // simply has nothing to say about itself.
    expect(noteLabel('  до пътеката  ')).toBe('до пътеката');
  });
});

describe('noteAriaFragment', () => {
  it('passes a note within the bound through unchanged', () => {
    const note = 'я'.repeat(SEAT_NOTE_MAX);
    expect(noteAriaFragment(note)).toBe(note);
  });

  it('clips a legacy over-long row instead of reading it out whole', () => {
    // Only reachable from a hand-written INSERT — the schema caps the route at
    // 120 — but an accessible name is read aloud and cannot be interrupted.
    const clipped = noteAriaFragment('я'.repeat(SEAT_NOTE_MAX + 1));
    expect(clipped).toBe('я'.repeat(SEAT_NOTE_MAX - 1) + '…');
    expect(clipped).toHaveLength(SEAT_NOTE_MAX);
  });

  it('is null for a note that renders nothing', () => {
    expect(noteAriaFragment(ZWSP + ZWSP)).toBeNull();
  });
});

describe('seatUnavailableMessage', () => {
  it('says "unavailable", not "taken", for a blocked seat', () => {
    // A seat an administrator switched off is not held by anyone, so the
    // holder — even a stale one — must not colour the message.
    const message = seatUnavailableMessage('bg', seat({ status: 'BLOCKED', holder: 'Иван' }));
    expect(message).toBe('Ред 4, място 12 е недостъпно.');
  });

  it('names the holder when there is one — the touch route to the name', () => {
    const message = seatUnavailableMessage('bg', seat({ holder: 'Иван Петров' }));
    expect(message).toBe('Ред 4, място 12 е заето от Иван Петров.');
  });

  it('uses the nameless copy for a booking with no name', () => {
    for (const holder of [null, '   ', ZWSP + ZWSP]) {
      const message = seatUnavailableMessage('bg', seat({ holder }));
      expect(message, JSON.stringify(holder)).toBe('Ред 4, място 12 е заето.');
    }
  });

  it('is byte-identical with and without a note — the note is deliberately absent', () => {
    // This sentence answers *why you cannot have this seat*; the note is
    // information about someone else's booking, not about the refusal. After the
    // D3 fix it also fires on the FIRST tap, which is exactly when it has to stay
    // one short sentence. The touch user still gets the note — the press-to-peek
    // bubble carries it on that same tap. Anyone tempted to append it here has to
    // delete this test first, which is the point.
    for (const locale of LOCALES) {
      for (const status of ['RESERVED', 'HELD', 'BLOCKED'] as SeatStatus[]) {
        const bare = seatUnavailableMessage(locale, seat({ status, holder: 'Иван' }));
        const noted = seatUnavailableMessage(
          locale,
          seat({ status, holder: 'Иван', note: 'плаща в брой' }),
        );
        expect(noted, `${locale}/${status}`).toBe(bare);
        expect(noted).not.toContain('плаща');
      }
    }
  });
});

describe('i18n keys for named bookings', () => {
  const KEYS = [
    'seat.holder',
    'seat.holderUnknown',
    'seat.ariaHolder',
    'seat.ariaNote',
    'form.note',
    'form.noteOptional',
    'form.notePlaceholder',
    'form.noteHint',
    'book.nameTitle',
    'book.nameSubmit',
    'book.nameTooShort',
    'book.bookedFor',
    'book.unavailableNamed',
    'book.blocked',
  ] as const;

  it('resolves in both locales', () => {
    // `t()` falls back to the other locale and then returns the key itself, so a
    // key added to bg and forgotten in en renders as the literal string
    // "book.nameTitle" — silent, and visible only to whoever switches language.
    for (const locale of LOCALES) {
      for (const key of KEYS) {
        const value = t(locale, key);
        expect(value, `${locale}/${key}`).not.toBe(key);
        expect(value.trim().length, `${locale}/${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('substitutes every variable it advertises', () => {
    const booked = t('bg', 'book.bookedFor', { name: 'Ив', row: '4', seat: '12' });
    expect(booked).not.toContain('{');
    expect(booked).toContain('Ив');

    const taken = t('en', 'book.unavailableNamed', { name: 'Ivan', row: '4', seat: '12' });
    expect(taken).not.toContain('{');
    expect(taken).toContain('Ivan');

    for (const locale of LOCALES) {
      // The hint is the only place the 120 is shown to a user, and the textarea's
      // `maxLength` reads the same constant — an unsubstituted `{max}` would be a
      // silently wrong promise about a limit the browser is already enforcing.
      const hint = t(locale, 'form.noteHint', { max: String(SEAT_NOTE_MAX) });
      expect(hint, locale).not.toContain('{');
      expect(hint, locale).toContain(String(SEAT_NOTE_MAX));

      const note = t(locale, 'seat.ariaNote', { note: 'до пътеката' });
      expect(note, locale).not.toContain('{');
      expect(note, locale).toContain('до пътеката');
    }
  });
});

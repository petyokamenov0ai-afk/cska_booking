/**
 * "Who is this seat for?" — the prompt between clicking a free seat and booking it.
 *
 * Built on the native `<dialog>` + `showModal()`, which is doing real work here
 * and is not a stylistic preference:
 *
 *   * a **browser-enforced focus trap** that also orders browser chrome, rather
 *     than a hand-rolled tabbable-node query — and this map has SVG `[tabindex]`
 *     seats, exactly what such queries miss;
 *   * the rest of the document goes **inert**, so `SeatMap`'s single delegated
 *     pointer listener cannot fire and "clicked a second seat behind the modal"
 *     stops being a case at all;
 *   * the **top layer**, so it paints above the whole z-index ladder and is
 *     immune to the map root's `overflow-hidden`;
 *   * Escape, from the UA.
 *
 * Background-scroll suppression is **not** in that list. `showModal()` makes the
 * document inert for hit-testing and focus, not for scrolling — the wheel still
 * reaches the root scroller. See the lock effect below and the note it carries.
 *
 * There is no generic `<Modal>` primitive behind it on purpose: `<dialog>`
 * already *is* that primitive, and a wrapper with one caller would be untested
 * surface between us and the platform.
 *
 * No portal and no `mounted` flag either — a `<dialog>` without the `open`
 * attribute is `display: none` per the UA stylesheet, so the server and hydrated
 * markup are identical. That is the same position `Toast.tsx` takes with its
 * frozen server snapshot.
 */

'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';

import Button from '@/components/ui/Button';
import { cn } from '@/lib/format';
import { DEFAULT_LOCALE, t, type Locale } from '@/lib/i18n';
import type { SeatDTO } from '@/lib/types';
import { SEAT_HOLDER_NAME_MAX, SEAT_NOTE_MAX, seatHolderNameSchema, seatNoteSchema } from '@/lib/zodSchemas';

export interface SeatNameDialogProps {
  /** The seat being named, or `null` when the dialog is closed. */
  seat: SeatDTO | null;
  /** Pre-filled and pre-selected on open. */
  defaultName: string;
  onCancel: () => void;
  /**
   * Receives already-normalised values; the caller books and has already closed.
   *
   * An object rather than two positionals: `(string, string | null)` is the
   * shape where a third field silently lands in the wrong slot, and the single
   * call site has to name both values before it can build the body anyway.
   */
  onConfirm: (values: { name: string; note: string | null }) => void;
  locale?: Locale;
}

export default function SeatNameDialog({
  seat,
  defaultName,
  onCancel,
  onConfirm,
  locale = DEFAULT_LOCALE,
}: SeatNameDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const restoreTo = useRef<Element | null>(null);
  const downOnBackdrop = useRef(false);

  const [value, setValue] = useState(defaultName);
  const [note, setNote] = useState('');
  const [error, setError] = useState(false);
  const [entered, setEntered] = useState(false);

  const titleId = useId();
  const descId = useId();
  const inputId = useId();
  const errorId = useId();
  const noteId = useId();
  const noteHintId = useId();

  const seatId = seat?.id ?? null;
  // Mirrored during render, in the same style as `SeatMapClient`'s pendingRef,
  // so the DOM `close` handler below can tell a close *we* asked for from one
  // that came from somewhere else.
  const openRef = useRef(false);
  openRef.current = seatId !== null;

  // Keep the last seat so the "Ред 4 · Място 12" line does not blank out in the
  // frame where the dialog is closing.
  const viewRef = useRef<SeatDTO | null>(null);
  if (seat !== null) viewRef.current = seat;
  const view = seat ?? viewRef.current;

  // `useEffect`, not `useLayoutEffect`: this is a client component that the App
  // Router still server-renders, where useLayoutEffect warns. The extra frame is
  // invisible — the dialog is display:none until showModal(), and the entrance
  // transition covers the seam.
  useEffect(() => {
    const node = dialogRef.current;
    if (node === null) return;

    if (seatId === null) {
      setEntered(false);
      if (node.open) node.close();
      // The UA restores focus on close, but the trigger is an SVG <g> that a
      // mouse click may never have focused. Restore explicitly while we can.
      const target = restoreTo.current;
      if ((target instanceof HTMLElement || target instanceof SVGElement) && target.isConnected) {
        target.focus();
      }
      restoreTo.current = null;
      return;
    }

    restoreTo.current = document.activeElement;
    setValue(defaultName);
    // Reset lives here rather than in a second effect keyed on `seatId`, which
    // would race the rAF below. There is deliberately no `defaultNote` to
    // restore: unlike a surname, which repeats down a row, "до пътеката" is a
    // fact about ONE seat, and a remembered note would silently relabel the next
    // nine — the note is not pre-selected-and-overtyped the way the name is.
    setNote('');
    setError(false);
    // showModal() throws InvalidStateError if the dialog is already open.
    if (!node.open) node.showModal();
    // showModal() honours the `autofocus` *attribute*; React's `autoFocus` prop
    // is an imperative focus() call that sets no attribute, so it is not enough.
    inputRef.current?.focus();
    // rAF so the select lands after the focus — selecting an already-focused
    // input is what keeps the selection instead of collapsing the caret.
    const frame = requestAnimationFrame(() => {
      inputRef.current?.select();
      setEntered(true);
    });
    return () => cancelAnimationFrame(frame);
    // Keyed on the seat ID, never on the SeatDTO: the 7 s poll hands back a
    // fresh object every time, which would wipe the field mid-typing.
  }, [seatId, defaultName]);

  /**
   * Background scroll lock. The top layer is not one: the wheel still reaches
   * the ROOT scroller — and because the document is inert, the map's own
   * non-passive `preventDefault` wheel guard is off too, so the worst offender
   * is the largest target on the page (measured: 0 px scrolled with the dialog
   * closed, 382 px with it open).
   *
   * `overflow: hidden` is not enough. It stops the wheel in Chromium but not a
   * programmatic scroll — `focus()` inside the dialog moves the nearest
   * scrollable ancestor, which is the root — and it does not stop WebKit at all
   * (measured on iPhone 14 emulation). Pinning the body is the only technique
   * that holds in both engines and the only one that restores the position
   * exactly.
   *
   * No scrollbar-gutter compensation: `html { scrollbar-gutter: stable }`
   * (app/globals.css) already reserves the gutter, so flipping to a fixed body
   * cannot reflow the page — and a `padding-right` hack here would INTRODUCE the
   * shift it claims to prevent. The width is captured in px rather than set to
   * 100%, because a fixed element resolves 100% against the viewport, which
   * includes that reserved gutter.
   *
   * Declared after the lifecycle effect on purpose: React runs all cleanups
   * before all effect bodies, so the scroll is restored before that effect's
   * `focus()` lands on the seat, and the map is back under the cursor when it
   * does. Keyboard scrolling needs no handling — the UA focus trap already eats
   * PageDown (measured).
   */
  useEffect(() => {
    if (seatId === null) return;
    const body = document.body;
    const y = window.scrollY;
    const width = body.offsetWidth;
    const saved = { position: body.style.position, top: body.style.top, width: body.style.width };
    body.style.position = 'fixed';
    body.style.top = `-${y}px`;
    body.style.width = `${width}px`;
    return () => {
      // Restore the exact prior inline values rather than clearing them, so a
      // style set by something else survives.
      body.style.position = saved.position;
      body.style.top = saved.top;
      body.style.width = saved.width;
      // `scrollTo`, not `scrollY = y`, and in the SAME task: restoring the
      // styles is what makes the document scrollable again, and deferring this
      // paints at 0 for a frame.
      window.scrollTo(0, y);
    };
  }, [seatId]);

  function handleCancel(event: React.SyntheticEvent<HTMLDialogElement>) {
    // ALWAYS preventDefault. Letting the UA close the dialog desyncs it from the
    // `seat` prop, and the next render would not re-open it for that same seat —
    // the seat would simply stop responding to clicks.
    event.preventDefault();
    onCancel();
  }

  /**
   * D1. `close` is delivered from a QUEUED TASK, not synchronously from
   * `close()` (measured: p50 2.4 ms, max 7 ms). An event that lands after the
   * dialog has been reopened is describing a close that is already history, and
   * cancelling on it destroys the dialog the user just asked for — 36/40 laps of
   * Enter→Escape→Enter with no delay. `dialogRef.current.open` is the only thing
   * that can tell the two apart AT DELIVERY TIME: on a stale event the dialog is
   * open again, on a real outside close it is not.
   *
   * The handler cannot simply be deleted. Chromium's CloseWatcher force-closes
   * on the third Escape *despite* preventDefault(), firing `close` with no
   * `cancel`. Without this line `promptSeatId` stays set, the seat stays
   * SELECTED, and `setPromptSeatId(sameId)` is a no-op so the effect above never
   * re-opens it: the seat is dead until reload (measured).
   *
   * The `node !== null` guard means an event delivered during unmount cannot
   * setState on a parent that is already gone.
   */
  function handleDomClose() {
    const node = dialogRef.current;
    if (openRef.current && node !== null && !node.open) onCancel();
  }

  // Backdrop dismissal needs pointerdown *and* click on the dialog element
  // itself. Requiring both is what stops a drag that starts inside the input
  // (selecting a typo) and ends over the backdrop from destroying what was
  // typed. The dialog is `p-0` and the panel is an inner div, so
  // `target === dialog` is an exact "outside" test with no padding gutter.
  function handleDialogPointerDown(event: React.PointerEvent<HTMLDialogElement>) {
    downOnBackdrop.current = event.target === dialogRef.current;
  }

  function handleDialogClick(event: React.MouseEvent<HTMLDialogElement>) {
    const wasBackdrop = downOnBackdrop.current && event.target === dialogRef.current;
    downOnBackdrop.current = false;
    if (wasBackdrop) onCancel();
  }

  /**
   * Enter submits, exactly as it does in the name input above.
   *
   * A newline cannot survive normalisation (`\p{Cc}` becomes a space), so a box
   * that inserted one would be showing text the server is about to rewrite.
   * Making Enter mean the same thing in both fields is also what keeps the
   * "Enter, Enter, Enter" flow down a row of six seats — the reason `lastName`
   * exists — untouched by a second field.
   */
  function handleNoteKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter') return;
    // Never during IME composition: Enter is how a Chinese or Japanese input
    // method commits a candidate, and stealing it would submit half a word.
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    // `requestSubmit()` and not `submit()`: `submit()` bypasses the submit event
    // entirely, so `handleSubmit` would never run.
    event.currentTarget.form?.requestSubmit();
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const parsedName = seatHolderNameSchema.safeParse(value);
    // Zod's job here is to be the *same rule the server applies*, not the copy:
    // its message is English and not in the dictionary, so it is never rendered.
    if (!parsedName.success) {
      setError(true);
      inputRef.current?.focus();
      return;
    }
    // The note has no error state and needs none: `maxLength` makes the browser
    // refuse the 121st character and truncate a paste (in UTF-16 code units, the
    // same unit `.max()` counts, on a string normalisation can only shorten), and
    // a note that would render nothing is dropped rather than rejected. So this
    // parse cannot fail from this form; `?? null` is what turns "absent" into the
    // DTO-shaped null the caller passes on. If a future rule ever makes the note
    // failable it gets its OWN boolean and its own errorId — never a shared one.
    const parsedNote = seatNoteSchema.safeParse(note);
    onConfirm({
      name: parsedName.data as string,
      note: parsedNote.success ? ((parsedNote.data as string | undefined) ?? null) : null,
    });
  }

  return (
    <dialog
      ref={dialogRef}
      data-testid="seat-name-dialog"
      aria-labelledby={titleId}
      aria-describedby={descId}
      onCancel={handleCancel}
      onPointerDown={handleDialogPointerDown}
      onClick={handleDialogClick}
      onClose={handleDomClose}
      className={cn(
        // Tailwind's preflight zeroes the UA's `dialog { margin: auto }`, which
        // would leave a showModal()'d dialog flush against the top-left corner.
        // Centring is therefore restated here, not inherited.
        'fixed inset-0 mx-auto mt-[7dvh] mb-auto sm:my-auto',
        'w-[calc(100%-1.5rem)] max-w-[25rem]',
        // Two fields no longer necessarily fit a short phone in landscape. The
        // cap is here and the SCROLLING is on the panel: the dialog itself must
        // stay `p-0` and non-scrolling so `target === dialogRef.current` remains
        // an exact "clicked outside" test, with no padding gutter and no
        // scrollbar to false-positive on.
        'max-h-[86dvh]',
        // p-0: the backdrop hit-test above must not have a padding gutter to
        // false-positive on. The panel below owns all the spacing.
        'rounded-xl border border-border bg-surface-raised p-0 text-foreground shadow-2xl',
        // The UA paints `background: canvas; color: canvastext`, which ignores
        // the theme tokens — hence the explicit pair above.
        'backdrop:bg-black/45 backdrop:backdrop-blur-[2px]',
      )}
    >
      {/* No role="dialog" and no aria-modal: both are implicit on a showModal()'d
          <dialog>, and an explicit aria-modal double-announces in some AT pairings. */}
      <div
        className={cn(
          'flex flex-col gap-4 p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]',
          // `max-h-[inherit]` takes the dialog's computed cap, so the 86dvh
          // above is written once and this box is the one that scrolls.
          'max-h-[inherit] overflow-y-auto',
          'origin-top transition-[opacity,scale,translate] duration-200 ease-out motion-reduce:transition-none',
          entered ? 'translate-y-0 scale-100 opacity-100' : '-translate-y-1 scale-[0.97] opacity-0',
        )}
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            {/* h2, not h1 — the subsector page owns the page heading. */}
            <h2 id={titleId} className="text-base font-semibold">
              {t(locale, 'book.nameTitle')}
            </h2>
            <p id={descId} className="mt-1 text-sm text-muted-foreground tabular">
              {view ? t(locale, 'map.seatTooltip', { row: view.row, number: view.number }) : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label={t(locale, 'common.close')}
            className="-m-1 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground motion-reduce:transition-none"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        {/* The action row lives inside the form, so Enter and the button share
            one submit path and no `form={id}` indirection is needed.

            `gap-4` and one wrapper per field group: with the label/input/error
            stack directly on the <form>, a second labelled field would sit 6 px
            under the first field's error paragraph. Tab order is plain DOM
            order — name, note, Отказ, Резервирай, ✕ — with no `tabindex`
            anywhere; the UA's showModal() trap owns the wrap. */}
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={inputId} className="text-sm font-medium">
              {t(locale, 'form.name')}
            </label>
            <input
              id={inputId}
              ref={inputRef}
              data-testid="seat-name-input"
              type="text"
              name="holder"
              required
              maxLength={SEAT_HOLDER_NAME_MAX}
              autoComplete="off"
              enterKeyHint="done"
              // A proper name is not a dictionary word; the note below is prose,
              // and keeps the browser default.
              spellCheck={false}
              placeholder={t(locale, 'form.namePlaceholder')}
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                if (error) setError(false);
              }}
              aria-invalid={error || undefined}
              aria-describedby={error ? errorId : undefined}
              className={cn(
                // text-base is 16px on purpose: anything smaller makes iOS Safari
                // zoom the page on focus, leaving the map off-screen afterwards.
                'h-11 w-full rounded-lg border bg-input px-3 text-base text-foreground',
                'placeholder:text-muted-foreground',
                error ? 'border-destructive' : 'border-border',
              )}
            />
            {error ? (
              <p id={errorId} role="alert" className="text-sm text-destructive">
                {t(locale, 'book.nameTooShort')}
              </p>
            ) : null}
          </div>

          {/* Optional, and never focused on open — `inputRef` keeps that job. */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor={noteId} className="text-sm font-medium">
              {t(locale, 'form.note')}{' '}
              {/* Inside the label, so the accessible name says "optional" too. */}
              <span className="font-normal text-muted-foreground">
                {t(locale, 'form.noteOptional')}
              </span>
            </label>
            <textarea
              id={noteId}
              data-testid="seat-note-input"
              name="note"
              // A textarea used as one logical line. Free text up to 120
              // characters has to be reviewable WHILE typing, and a one-line
              // <input> scrolls horizontally and hides what was typed — the
              // worse accessibility outcome.
              //
              // FOUR rows, not three: measured at this dialog's width, a full
              // 120-character note wraps to four lines and a three-row box
              // scrolls it by exactly 24 px — which is the same defect as the
              // one-line input, only vertical. Four rows fit the cap with
              // nothing hidden, for 24 px of dialog height that `max-h-[86dvh]`
              // already accounts for. The hover bubble still clamps at three;
              // that is a glance affordance, and the full text lives in the
              // accessible name.
              rows={4}
              maxLength={SEAT_NOTE_MAX}
              autoComplete="off"
              enterKeyHint="done"
              aria-describedby={noteHintId}
              placeholder={t(locale, 'form.notePlaceholder')}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              onKeyDown={handleNoteKeyDown}
              className={cn(
                // text-base for the same reason as the name input above.
                // `resize-none` because the cap already fits in three rows, and a
                // resizable box would make the dialog's height — and therefore
                // the backdrop's hit area — depend on a drag.
                'w-full resize-none rounded-lg border border-border bg-input px-3 py-2',
                'text-base leading-6 text-foreground placeholder:text-muted-foreground',
              )}
            />
            {/* A static description, not a live region: it states the one thing
                about this dialog a user cannot guess. */}
            <p id={noteHintId} className="text-xs text-muted-foreground">
              {t(locale, 'form.noteHint', { max: String(SEAT_NOTE_MAX) })}
            </p>
          </div>

          <div className="flex justify-end gap-2 border-t border-border pt-4">
            {/* `variant="ghost"` already defaults type="button", so Cancel can
                never submit the form. */}
            <Button variant="ghost" onClick={onCancel}>
              {t(locale, 'common.cancel')}
            </Button>
            {/* Never disabled on invalid input: a disabled submit is unfocusable
                and explains nothing. Validate on submit and show the error. */}
            <Button type="submit" data-testid="seat-name-submit">
              {t(locale, 'book.nameSubmit')}
            </Button>
          </div>
        </form>
        {/* Backdrop dismissal (see `handleDialogPointerDown`) is unchanged and
            now more load-bearing than it was: a drag-select that starts in a
            three-row textarea and ends over the backdrop is far likelier than
            one that started in a one-line input. Do not weaken it. */}
      </div>
    </dialog>
  );
}

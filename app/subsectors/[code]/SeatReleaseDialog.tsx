/**
 * The confirm step between tapping an occupied seat and cancelling its booking.
 *
 * Opens for ANY occupied seat, not just this session's — this is an admin
 * tool, and the server's DELETE is unauthenticated by design (lib/booking.ts).
 * Releasing used to be a bare click on the seat, which on a phone made "who is
 * sitting here?" and "cancel this reservation" the same gesture. This dialog
 * splits them: tapping a seat shows who it is booked for, and only the
 * explicit destructive button actually releases. Closing it changes nothing.
 *
 * Built on the same native `<dialog>` + `showModal()` machinery as
 * `SeatNameDialog`, for the same reasons (UA focus trap, inert document, top
 * layer, Escape from the UA) — see that file for the full argument, including
 * why the `close` DOM event needs its own guarded handler and why every
 * dismissal path is `onCancel()` and nothing else.
 */

'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';

import { visibleText } from '@/components/stadium/seatHolder';
import Button from '@/components/ui/Button';
import { cn } from '@/lib/format';
import { DEFAULT_LOCALE, t, type Locale } from '@/lib/i18n';
import type { SeatDTO } from '@/lib/types';

export interface SeatReleaseDialogProps {
  /** The occupied seat being viewed, or `null` when the dialog is closed. */
  seat: SeatDTO | null;
  onCancel: () => void;
  /** The caller releases and has already closed. */
  onConfirm: () => void;
  locale?: Locale;
}

export default function SeatReleaseDialog({
  seat,
  onCancel,
  onConfirm,
  locale = DEFAULT_LOCALE,
}: SeatReleaseDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const restoreTo = useRef<Element | null>(null);
  const downOnBackdrop = useRef(false);

  const [entered, setEntered] = useState(false);

  const titleId = useId();
  const descId = useId();

  const seatId = seat?.id ?? null;
  // Same render-mirrored ref as `SeatNameDialog`: lets the DOM `close` handler
  // tell a close we asked for from one the UA forced.
  const openRef = useRef(false);
  openRef.current = seatId !== null;

  // Keep the last seat so the text does not blank in the closing frame.
  const viewRef = useRef<SeatDTO | null>(null);
  if (seat !== null) viewRef.current = seat;
  const view = seat ?? viewRef.current;

  useEffect(() => {
    const node = dialogRef.current;
    if (node === null) return;

    if (seatId === null) {
      setEntered(false);
      if (node.open) node.close();
      const target = restoreTo.current;
      if ((target instanceof HTMLElement || target instanceof SVGElement) && target.isConnected) {
        target.focus();
      }
      restoreTo.current = null;
      return;
    }

    restoreTo.current = document.activeElement;
    if (!node.open) node.showModal();
    // Initial focus on Close, not on the destructive button: Enter straight
    // after opening must VIEW-and-dismiss, never release.
    closeRef.current?.focus();
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, [seatId]);

  /** Background scroll lock — same technique and reasoning as `SeatNameDialog`. */
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
      body.style.position = saved.position;
      body.style.top = saved.top;
      body.style.width = saved.width;
      window.scrollTo(0, y);
    };
  }, [seatId]);

  function handleCancel(event: React.SyntheticEvent<HTMLDialogElement>) {
    // Always preventDefault: a UA-driven close desyncs the dialog from the
    // `seat` prop and the seat stops responding — see `SeatNameDialog`.
    event.preventDefault();
    onCancel();
  }

  function handleDomClose() {
    const node = dialogRef.current;
    if (openRef.current && node !== null && !node.open) onCancel();
  }

  function handleDialogPointerDown(event: React.PointerEvent<HTMLDialogElement>) {
    downOnBackdrop.current = event.target === dialogRef.current;
  }

  function handleDialogClick(event: React.MouseEvent<HTMLDialogElement>) {
    const wasBackdrop = downOnBackdrop.current && event.target === dialogRef.current;
    downOnBackdrop.current = false;
    if (wasBackdrop) onCancel();
  }

  const holderName = visibleText(view?.holder);
  const noteText = visibleText(view?.note);

  return (
    <dialog
      ref={dialogRef}
      data-testid="seat-release-dialog"
      aria-labelledby={titleId}
      aria-describedby={descId}
      onCancel={handleCancel}
      onPointerDown={handleDialogPointerDown}
      onClick={handleDialogClick}
      onClose={handleDomClose}
      className={cn(
        'fixed inset-0 mx-auto mt-[7dvh] mb-auto sm:my-auto',
        'w-[calc(100%-1.5rem)] max-w-[25rem]',
        'max-h-[86dvh]',
        // p-0 keeps `target === dialog` an exact backdrop test — see sibling.
        'rounded-xl border border-border bg-surface-raised p-0 text-foreground shadow-2xl',
        'backdrop:bg-black/45 backdrop:backdrop-blur-[2px]',
      )}
    >
      <div
        className={cn(
          'flex flex-col gap-4 p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]',
          'max-h-[inherit] overflow-y-auto',
          'origin-top transition-[opacity,scale,translate] duration-200 ease-out motion-reduce:transition-none',
          entered ? 'translate-y-0 scale-100 opacity-100' : '-translate-y-1 scale-[0.97] opacity-0',
        )}
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-base font-semibold">
              {/* "Твоя резервация" only when it actually is; anyone can cancel
                  any booking, but the title must not claim someone else's. */}
              {t(locale, view?.mine ? 'book.releaseTitle' : 'book.releaseTitleOther')}
            </h2>
            <p id={descId} className="mt-1 text-sm text-muted-foreground tabular">
              {/* Same block prefix as `SeatNameDialog`: on merged corners the
                  row/seat pair alone is ambiguous. */}
              {view
                ? (view.block ? `${view.block} · ` : '') +
                  t(locale, 'map.seatTooltip', { row: view.row, number: view.number })
                : ''}
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

        <div className="flex flex-col gap-1 rounded-lg bg-surface px-3 py-2.5">
          <p className="text-sm font-medium">
            {holderName
              ? t(locale, 'seat.holder', { name: holderName })
              : t(locale, 'seat.holderUnknown')}
          </p>
          {noteText ? (
            // `break-words`: the note is free text and a long token must wrap
            // inside the panel rather than widen the dialog.
            <p className="text-sm break-words text-muted-foreground">{noteText}</p>
          ) : null}
        </div>

        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button ref={closeRef} variant="ghost" onClick={onCancel}>
            {t(locale, 'common.close')}
          </Button>
          <Button
            variant="destructive"
            data-testid="seat-release-confirm"
            onClick={onConfirm}
          >
            {t(locale, 'book.releaseConfirm')}
          </Button>
        </div>
      </div>
    </dialog>
  );
}

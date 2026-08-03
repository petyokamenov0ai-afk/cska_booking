'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import Legend from '@/components/stadium/Legend';
import SeatMap from '@/components/stadium/SeatMap';
import { seatUnavailableMessage } from '@/components/stadium/seatHolder';
import { pushToast } from '@/components/ui/Toast';
import { t, type Locale } from '@/lib/i18n';
import { ApiRequestError, apiFetch, seatsQueryKey, useSeats } from '@/lib/useSeats';
import type { SeatDTO, SubsectorMeta } from '@/lib/types';
import SeatNameDialog from './SeatNameDialog';

/**
 * Click-to-book. There is no basket, no hold countdown and no contact form:
 *
 *   * clicking a free seat asks who it is for, then books it under that name;
 *   * clicking a seat you can see as booked frees it again, with no prompt.
 *
 * The seat list is polled, so two people looking at the same subsector converge
 * within a poll. Optimism is deliberately limited: a click marks *that one seat*
 * as in-flight (so it cannot be double-submitted) and the authoritative status
 * comes from the refetch. That keeps the map honest when someone else got there
 * first — the seat simply comes back taken, with a toast.
 *
 * The naming step deliberately writes **nothing** until it is confirmed. See
 * `promptSeatId` below for why that rule is not negotiable.
 */
export interface SeatMapClientProps {
  eventId: string;
  subsector: SubsectorMeta;
  initialSeats: SeatDTO[];
  locale: Locale;
}

export default function SeatMapClient({
  eventId,
  subsector,
  initialSeats,
  locale,
}: SeatMapClientProps) {
  const queryClient = useQueryClient();
  const polled = useSeats({ eventId, subsectorCode: subsector.code });
  // The server already rendered a seat list; show it until the first poll lands
  // so the map never flashes empty.
  const seats: readonly SeatDTO[] = polled.seats.length > 0 ? polled.seats : initialSeats;
  const isFetching = polled.isFetching;

  /** Seats with a request in flight — used to block a second click. */
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  /**
   * The seat whose name is being asked for, held **by id**: the 7 s poll hands
   * back fresh `SeatDTO` objects, so binding the object itself would pin a stale
   * one under the open dialog.
   *
   * Deliberately *not* `pending`. That set doubles as the map's selection and as
   * the re-entry guard, so an entry left behind by a cancelled dialog would pin
   * the seat SELECTED **and** make `onSeatToggle` return early for that seat for
   * ever, with no recovery short of a page reload. Every dismissal path here is
   * therefore `setPromptSeatId(null)` and nothing else, which makes cancellation
   * structurally incapable of leaving residue.
   */
  const [promptSeatId, setPromptSeatId] = useState<string | null>(null);
  /** The seat the currently-open dialog has already been confirmed for. A ref
   *  and not state on purpose — see `onConfirmName`, which is the only writer. */
  const confirmedSeatId = useRef<string | null>(null);
  /** Last name submitted, so naming a family's six seats is Enter, Enter, Enter.
   *  In memory only — localStorage would be scope creep and a hydration hazard. */
  const [lastName, setLastName] = useState('');
  const promptSeat = promptSeatId === null ? undefined : seats.find((s) => s.id === promptSeatId);

  const markPending = useCallback((seatId: string, on: boolean) => {
    setPending((current) => {
      const next = new Set(current);
      if (on) next.add(seatId);
      else next.delete(seatId);
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: seatsQueryKey(eventId, subsector.code),
    });
  }, [eventId, queryClient, subsector.code]);

  /** The intent is carried explicitly rather than re-derived from `seat.status`
   *  in each callback, so book and release can never be confused by a poll that
   *  lands between the click and the response. */
  interface ToggleVars {
    seat: SeatDTO;
    action: 'book' | 'release';
    name?: string;
    note?: string;
  }

  const toggle = useMutation({
    mutationFn: async ({ seat, action, name, note }: ToggleVars) => {
      const path = `/api/seats/${encodeURIComponent(seat.id)}`;
      if (action === 'book') {
        // `apiFetch` adds Content-Type whenever a body is present, so the name
        // needs no extra plumbing. DELETE stays body-free.
        //
        // `JSON.stringify` drops an `undefined` value entirely, so a booking with
        // no note sends `{"name":"…"}` — byte-identical to the request this made
        // before the field existed, which is why no server-side default is needed
        // for "absent".
        await apiFetch<{ seat: unknown }>(path, {
          method: 'POST',
          body: JSON.stringify({ name, note }),
        });
        return 'booked' as const;
      }
      await apiFetch<{ released: boolean }>(path, { method: 'DELETE' });
      return 'released' as const;
    },
    onSuccess: (result, { seat, name }) => {
      pushToast({
        variant: 'success',
        message:
          result === 'booked'
            ? t(locale, 'book.bookedFor', {
                name: name ?? '',
                row: String(seat.row),
                seat: String(seat.number),
              })
            : t(locale, 'book.released', {
                row: String(seat.row),
                seat: String(seat.number),
              }),
      });
    },
    onError: (error, { seat }) => {
      // 409 SEATS_TAKEN is the expected loser of a race, not a fault.
      const taken = error instanceof ApiRequestError && error.code === 'SEATS_TAKEN';
      pushToast({
        variant: taken ? 'info' : 'error',
        message: taken
          ? t(locale, 'book.lost', { row: String(seat.row), seat: String(seat.number) })
          : error instanceof ApiRequestError
            ? t(locale, error.messageKey)
            : t(locale, 'error.INTERNAL'),
      });
    },
    onSettled: (_result, _error, { seat }) => {
      markPending(seat.id, false);
      void refresh();
    },
  });

  const onSeatToggle = useCallback(
    (seat: SeatDTO) => {
      if (pendingRef.current.has(seat.id)) return; // already in flight
      // `mine` is tested FIRST because your own seat is RESERVED, not FREE — an
      // order-swapped version of this falls straight through into the dialog and
      // asks you to name a seat you are trying to release.
      if (seat.mine) {
        markPending(seat.id, true);
        toggle.mutate({ seat, action: 'release' });
        return;
      }
      if (seat.status !== 'FREE') return; // someone else's — SeatMap already toasted
      // Disarm the confirm latch: it guards one dialog, and this is a new one.
      confirmedSeatId.current = null;
      setPromptSeatId(seat.id); // nothing is booked yet
    },
    [markPending, toggle],
  );

  const onConfirmName = useCallback(
    ({ name, note }: { name: string; note: string | null }) => {
      const seat = promptSeat;
      if (seat === undefined || pendingRef.current.has(seat.id)) return;
      /**
       * The second half of the double-submit guard, and the load-bearing one.
       *
       * `pendingRef` mirrors *state*, so it is only as fresh as the last render.
       * When two submits land in the SAME task — two `click()`s dispatched
       * together, or a click racing the Enter that activated the button — React
       * batches them: nothing re-renders in between, so both calls read an empty
       * set, both read the same `promptSeat`, and two POSTs go out. Measured on
       * the real app before this line existed.
       *
       * That is not a cosmetic duplicate. The session cookie is minted by the
       * first write, so two simultaneous first-ever POSTs mint two different
       * `sid`s; the loser's cookie is the one that sticks, and the seat comes
       * back RESERVED-but-not-`mine` — booked by you, and impossible to release
       * from the UI.
       *
       * This ref is written imperatively, right here, so the second call sees the
       * first without waiting for a render. It is disarmed in `onSeatToggle`,
       * because what it guards is one *opened dialog*, not one seat for ever.
       */
      if (confirmedSeatId.current === seat.id) return;
      confirmedSeatId.current = seat.id;
      // Only the name is remembered for the next seat. See `SeatNameDialog`'s
      // reset for why a sticky note would be a silent relabelling.
      setLastName(name);
      // Close in the same commit as `markPending`. The POST cannot be recalled
      // once sent, so a dialog left open with a spinner would be a Cancel button
      // that lies; `pending` already paints the seat SELECTED, which is exactly
      // the feedback click-to-book gave before this feature existed.
      setPromptSeatId(null);
      markPending(seat.id, true);
      toggle.mutate({ seat, action: 'book', name, note: note ?? undefined });
    },
    [promptSeat, markPending, toggle],
  );

  /**
   * The map polls every 7 s and a seat can go from under an open dialog.
   * Closing beats letting someone finish typing into a seat they have already
   * lost. `promptSeatId` is already null during our own submit, so this cannot
   * misfire on the booking we just made. A half-typed note is discarded with the
   * name — deliberate: re-showing text for a seat that is already gone is worse
   * than losing it.
   */
  useEffect(() => {
    if (promptSeatId === null) return;
    const live = seats.find((s) => s.id === promptSeatId);
    if (live !== undefined && live.status === 'FREE' && !live.mine) return;
    setPromptSeatId(null);
    if (live === undefined) return; // subsector changed under us: nothing to say
    pushToast({ variant: 'info', message: seatUnavailableMessage(locale, live) });
  }, [promptSeatId, seats, locale]);

  /**
   * Tapping an occupied seat is the primary *touch* route to the holder's name:
   * a phone cannot hover, but this is the gesture a phone user already makes.
   */
  const onSeatUnavailable = useCallback(
    (seat: SeatDTO) => {
      pushToast({ variant: 'info', message: seatUnavailableMessage(locale, seat) });
    },
    [locale],
  );

  // The seat being named reads as selected under the dialog. **Derived**, never
  // stored in `pending`, so cancelling cannot strand a highlight.
  const selection = useMemo(
    () => (promptSeatId === null ? pending : new Set([...pending, promptSeatId])),
    [pending, promptSeatId],
  );

  // A seat this browser booked renders via `mine`; the in-flight set is passed as
  // the selection so a click gives immediate feedback without lying about status.
  //
  // The dialog is a sibling of the map, never a child: React events bubble along
  // the *React* tree, so a dialog rendered inside `SeatMap` would send its
  // keystrokes into the map's keydown handler, where Enter, Space, the arrows and
  // `+ - 0` are all bound and preventDefault'ed.
  return (
    <section className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">{t(locale, 'book.hint')}</p>

      <SeatMap
        subsector={subsector}
        seats={seats}
        selectedSeatIds={selection}
        onSeatToggle={onSeatToggle}
        onSeatUnavailable={onSeatUnavailable}
        isRefreshing={isFetching}
        pitchSide={subsector.pitchSide}
        locale={locale}
      />

      {/* A top-layer dialog cannot be out-z-indexed: if a message ever has to be
          visible *while* this is open, it belongs inside the dialog, not in the
          toaster. Today the dialog is always closed before any toast is pushed. */}
      <SeatNameDialog
        seat={promptSeat ?? null}
        defaultName={lastName}
        onConfirm={onConfirmName}
        onCancel={() => setPromptSeatId(null)}
        locale={locale}
      />

      <Legend variant="seats" locale={locale} />
    </section>
  );
}

/**
 * Basket store — the client's seat selection for one event.
 *
 * Deliberately small: it holds *what the user picked* plus *the hold the server
 * gave us back*. Server state (seat statuses, the reservation itself) lives in
 * TanStack Query; this store never fetches.
 *
 * Selection is scoped to a single event. `setEvent` on a different event id
 * wipes the basket rather than silently mixing seats from two matches.
 *
 * Not persisted. A full page reload drops the selection on purpose — the
 * durable handle for a hold is the reservation `code` in the URL
 * (`/reservations/[code]`), not client storage.
 */

import { useMemo } from 'react';
import { create } from 'zustand';

import type { SeatDTO } from '@/lib/types';
import { MAX_SEATS_PER_RESERVATION } from '@/lib/zodSchemas';

/**
 * The server's cap, re-exported under the name the client UI uses.
 *
 * Imported rather than duplicated: `lib/zodSchemas.ts` owns the single
 * definition and depends on nothing but `zod` and type-only imports, so it is
 * safe in the browser bundle (`lib/reservations.ts`, which the API contract
 * advertises the constant from, re-exports the same value). One definition, so
 * the client can never offer an 11th seat the server would refuse.
 */
export const MAX_SELECTED_SEATS = MAX_SEATS_PER_RESERVATION;

/** The minimum a chip in the basket bar needs to describe itself. */
export interface BasketSeat {
  id: string;
  row: number;
  number: number;
  /** Cyrillic subsector code, e.g. "А1". */
  subsectorCode: string;
  /** Latin fallback, e.g. "A1". Display only. */
  subsectorLatin: string;
}

/** Why `add()` refused. */
export type AddRejectionReason =
  /** Already at `MAX_SELECTED_SEATS`. */
  | 'LIMIT'
  /** The seat is not FREE (and not ours) — someone else got it. */
  | 'NOT_SELECTABLE'
  /** Already in the basket. */
  | 'ALREADY_SELECTED'
  /** A hold exists; the seat set is frozen until it is cancelled. */
  | 'HOLD_ACTIVE';

export interface BasketRejection {
  reason: AddRejectionReason;
  /** i18n key for `t()`, together with `vars`. */
  messageKey: string;
  vars?: Record<string, string | number>;
  /** `Date.now()` of the rejection — lets a toast key off "the newest one". */
  at: number;
}

export interface AddResult {
  ok: boolean;
  /** Present exactly when `ok === false`. */
  rejection?: BasketRejection;
}

const OK: AddResult = { ok: true };

function reject(
  reason: AddRejectionReason,
  messageKey: string,
  vars?: Record<string, string | number>,
): { result: AddResult; rejection: BasketRejection } {
  const rejection: BasketRejection = { reason, messageKey, vars, at: Date.now() };
  return { result: { ok: false, rejection }, rejection };
}

export interface BasketState {
  /** The event this selection belongs to. */
  eventId: string | null;
  /** seatId → seat. */
  seats: Record<string, BasketSeat>;
  /** Selection order, so chips keep the order the user clicked in. */
  order: string[];
  /** Active hold, once `POST /reservations` succeeded. */
  reservationCode: string | null;
  /** ISO instant the hold expires. */
  expiresAt: string | null;
  /** Newest refused `add()`, for the UI to explain itself. */
  lastRejection: BasketRejection | null;

  /** Point the basket at an event; clears it when the event changes. */
  setEvent: (eventId: string) => void;
  add: (seat: BasketSeat) => AddResult;
  remove: (seatId: string) => void;
  /** Add if absent, remove if present. Removal always succeeds. */
  toggle: (seat: BasketSeat) => AddResult;
  /** Drop the selection (keeps `eventId`, drops the hold reference). */
  clear: () => void;
  clearRejection: () => void;
  /** Record the hold returned by `POST /api/events/:id/reservations`. */
  setHold: (code: string, expiresAt: string | null) => void;
  /** Forget the hold. `keepSelection` lets the user edit and re-hold. */
  clearHold: (options?: { keepSelection?: boolean }) => void;
  /**
   * Merge a fresh seat list in and drop selections that are no longer ours to
   * take. Returns the dropped seats (empty array = nothing changed, and the
   * state object identity is left untouched so this is safe to call on every
   * poll). Seats absent from `seats` are left alone — the list only covers one
   * subsector.
   */
  reconcile: (seats: readonly SeatDTO[]) => BasketSeat[];
}

/** A seat we are allowed to keep selected: free, or already ours. */
function isSelectable(seat: SeatDTO): boolean {
  return seat.status === 'FREE' || seat.mine;
}

const EMPTY_DROPPED: BasketSeat[] = [];

export const useBasketStore = create<BasketState>((set, get) => ({
  eventId: null,
  seats: {},
  order: [],
  reservationCode: null,
  expiresAt: null,
  lastRejection: null,

  setEvent: (eventId) => {
    if (get().eventId === eventId) return;
    set({
      eventId,
      seats: {},
      order: [],
      reservationCode: null,
      expiresAt: null,
      lastRejection: null,
    });
  },

  add: (seat) => {
    const state = get();

    if (state.reservationCode !== null) {
      const { result, rejection } = reject('HOLD_ACTIVE', 'basket.holding');
      set({ lastRejection: rejection });
      return result;
    }
    if (state.seats[seat.id]) {
      // Not normally reachable: the UI goes through `toggle`.
      const { result, rejection } = reject('ALREADY_SELECTED', 'error.generic');
      set({ lastRejection: rejection });
      return result;
    }
    if (state.order.length >= MAX_SELECTED_SEATS) {
      const { result, rejection } = reject('LIMIT', 'basket.maxSeats', {
        max: MAX_SELECTED_SEATS,
      });
      set({ lastRejection: rejection });
      return result;
    }

    const order = [...state.order, seat.id];
    const seats = { ...state.seats, [seat.id]: seat };
    set({ order, seats, lastRejection: null });
    return OK;
  },

  remove: (seatId) => {
    const state = get();
    if (!state.seats[seatId]) return;
    const seats = { ...state.seats };
    delete seats[seatId];
    const order = state.order.filter((id) => id !== seatId);
    set({ order, seats, lastRejection: null });
  },

  toggle: (seat) => {
    if (get().seats[seat.id]) {
      get().remove(seat.id);
      return OK;
    }
    return get().add(seat);
  },

  clear: () => {
    set({
      seats: {},
      order: [],
      reservationCode: null,
      expiresAt: null,
      lastRejection: null,
    });
  },

  clearRejection: () => {
    if (get().lastRejection === null) return;
    set({ lastRejection: null });
  },

  setHold: (code, expiresAt) => set({ reservationCode: code, expiresAt }),

  clearHold: (options) => {
    if (options?.keepSelection) {
      set({ reservationCode: null, expiresAt: null });
      return;
    }
    get().clear();
  },

  reconcile: (fresh) => {
    const state = get();
    if (state.order.length === 0) return EMPTY_DROPPED;

    const byId = new Map<string, SeatDTO>();
    for (const seat of fresh) byId.set(seat.id, seat);

    const dropped: BasketSeat[] = [];
    const nextOrder: string[] = [];
    const nextSeats: Record<string, BasketSeat> = {};

    for (const id of state.order) {
      const selected = state.seats[id];
      if (!selected) continue;

      const live = byId.get(id);
      if (!live) {
        // Not part of this subsector's list — no information, keep it.
        nextOrder.push(id);
        nextSeats[id] = selected;
        continue;
      }
      if (!isSelectable(live)) {
        dropped.push(selected);
        continue;
      }
      nextOrder.push(id);
      nextSeats[id] = selected;
    }

    if (dropped.length === 0) return EMPTY_DROPPED;

    set({ order: nextOrder, seats: nextSeats });
    return dropped;
  },
}));

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Build a `BasketSeat` from an API seat plus the subsector it came from. */
export function toBasketSeat(
  seat: Pick<SeatDTO, 'id' | 'row' | 'number'>,
  subsector: { code: string; latin: string },
): BasketSeat {
  return {
    id: seat.id,
    row: seat.row,
    number: seat.number,
    subsectorCode: subsector.code,
    subsectorLatin: subsector.latin,
  };
}

/* ------------------------------------------------------------------ *
 * Selector hooks
 *
 * Every selector returns a primitive or a reference that only changes when the
 * store mutates — never a freshly built object/array, which would make
 * `useSyncExternalStore` re-render forever. Derived collections are assembled
 * with `useMemo` from those stable references instead.
 * ------------------------------------------------------------------ */

/** The selection, in the order the user picked. */
export function useBasketSeats(): BasketSeat[] {
  const order = useBasketStore((s) => s.order);
  const seats = useBasketStore((s) => s.seats);
  return useMemo(
    () => order.map((id) => seats[id]).filter((seat): seat is BasketSeat => Boolean(seat)),
    [order, seats],
  );
}

export function useBasketCount(): number {
  return useBasketStore((s) => s.order.length);
}

export function useIsSeatSelected(seatId: string): boolean {
  return useBasketStore((s) => Boolean(s.seats[seatId]));
}

/** `Set` of selected seat ids — stable while the selection is unchanged. */
export function useSelectedSeatIds(): ReadonlySet<string> {
  const order = useBasketStore((s) => s.order);
  return useMemo(() => new Set(order), [order]);
}

export function useBasketReservationCode(): string | null {
  return useBasketStore((s) => s.reservationCode);
}

export function useBasketExpiresAt(): string | null {
  return useBasketStore((s) => s.expiresAt);
}

export function useBasketRejection(): BasketRejection | null {
  return useBasketStore((s) => s.lastRejection);
}

export function useBasketIsFull(): boolean {
  return useBasketStore((s) => s.order.length >= MAX_SELECTED_SEATS);
}

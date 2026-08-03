/**
 * `useSeats` — server state for one subsector's seat map.
 *
 * Wraps `GET /api/events/:eventId/subsectors/:code/seats`
 * (docs/API_CONTRACT.md). Polls every 7 s and refetches on window focus, per
 * § Conventions. Previous data is kept across refetches so the map never
 * flashes empty while a poll is in flight.
 *
 * The subsector `code` is **Cyrillic** and is URL-encoded here — callers pass
 * the raw code ("А1", U+0410), never the Latin fallback.
 */

'use client';

import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query';

import type { ApiError, SeatDTO, SubsectorMeta, SubsectorSeatsResponse } from '@/lib/types';

/** Poll interval from docs/API_CONTRACT.md § Conventions. */
export const SEATS_POLL_INTERVAL_MS = 7_000;

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

/**
 * A non-2xx response, carrying the structured body from
 * docs/API_CONTRACT.md § Error codes so the UI can translate it with
 * `t(locale, 'error.' + code)`.
 */
export class ApiRequestError extends Error {
  readonly status: number;
  /** Machine code, e.g. `"SEATS_TAKEN"`. `"NETWORK"` when the fetch itself failed. */
  readonly code: string;
  readonly conflictSeats?: string[];
  readonly details?: unknown;

  constructor(status: number, body: Partial<ApiError> & { error?: string }) {
    super(body.message ?? `Request failed with status ${status}`);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = body.error ?? 'INTERNAL';
    this.conflictSeats = body.conflictSeats;
    this.details = body.details;
  }

  /** i18n key for this error, e.g. `"error.SEATS_TAKEN"`. */
  get messageKey(): string {
    return `error.${this.code}`;
  }
}

export function isApiRequestError(value: unknown): value is ApiRequestError {
  return value instanceof ApiRequestError;
}

async function readError(response: Response): Promise<never> {
  let body: Partial<ApiError> = {};
  try {
    const parsed: unknown = await response.json();
    if (parsed && typeof parsed === 'object') body = parsed as Partial<ApiError>;
  } catch {
    // Non-JSON error page (proxy, 502, …) — fall back to the status code.
  }
  throw new ApiRequestError(response.status, body);
}

/**
 * `fetch` + structured-error unwrapping, shared by the hooks here and available
 * to pages that need to call the same API by hand (reservation POST/PATCH).
 */
export async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  } catch (cause) {
    throw new ApiRequestError(0, {
      error: 'NETWORK',
      message: cause instanceof Error ? cause.message : 'Network request failed',
    });
  }
  if (!response.ok) await readError(response);
  return (await response.json()) as T;
}

/* ------------------------------------------------------------------ *
 * Query
 * ------------------------------------------------------------------ */

/** Stable query key. Keyed on the raw Cyrillic code, not the encoded one. */
export function seatsQueryKey(eventId: string, subsectorCode: string) {
  return ['seats', eventId, subsectorCode] as const;
}

export function seatsUrl(eventId: string, subsectorCode: string): string {
  return `/api/events/${encodeURIComponent(eventId)}/subsectors/${encodeURIComponent(
    subsectorCode,
  )}/seats`;
}

export function fetchSubsectorSeats(
  eventId: string,
  subsectorCode: string,
  signal?: AbortSignal,
): Promise<SubsectorSeatsResponse> {
  return apiFetch<SubsectorSeatsResponse>(seatsUrl(eventId, subsectorCode), {
    cache: 'no-store',
    signal,
  });
}

export interface UseSeatsOptions {
  eventId: string;
  /** Raw Cyrillic subsector code, e.g. "А1". */
  subsectorCode: string;
  /** Defaults to true; pass false while the route params are still unknown. */
  enabled?: boolean;
  /** Override the 7 s poll (0 or false disables polling). */
  refetchInterval?: number | false;
}

export interface UseSeatsResult {
  seats: readonly SeatDTO[];
  subsector: SubsectorMeta | undefined;
  /** First load only — false during background polls. */
  isLoading: boolean;
  /** True whenever a request is in flight, including polls. */
  isFetching: boolean;
  isError: boolean;
  error: ApiRequestError | null;
  /** `Date.now()`-based timestamp of the freshest successful fetch. */
  updatedAt: number;
  /**
   * Force a fresh read. Call this immediately before creating a hold so the
   * user is not sent into a POST with a stale seat list.
   */
  refetch: () => Promise<readonly SeatDTO[]>;
  /** Escape hatch for anything the wrapper does not expose. */
  query: UseQueryResult<SubsectorSeatsResponse, ApiRequestError>;
}

const NO_SEATS: readonly SeatDTO[] = [];

export function useSeats({
  eventId,
  subsectorCode,
  enabled = true,
  refetchInterval = SEATS_POLL_INTERVAL_MS,
}: UseSeatsOptions): UseSeatsResult {
  const query = useQuery<SubsectorSeatsResponse, ApiRequestError>({
    queryKey: seatsQueryKey(eventId, subsectorCode),
    queryFn: ({ signal }) => fetchSubsectorSeats(eventId, subsectorCode, signal),
    enabled: enabled && Boolean(eventId) && Boolean(subsectorCode),
    // Statuses are the whole point of this endpoint: never serve them stale.
    staleTime: 0,
    gcTime: 60_000,
    refetchInterval: refetchInterval === 0 ? false : refetchInterval,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    // Keep the old map on screen while switching subsectors / re-polling.
    placeholderData: keepPreviousData,
    // A 404 (unknown subsector) is not worth retrying.
    retry: (failureCount, error) => error.status >= 500 && failureCount < 2,
  });

  const refetch = async (): Promise<readonly SeatDTO[]> => {
    const result = await query.refetch();
    return result.data?.seats ?? NO_SEATS;
  };

  return {
    seats: query.data?.seats ?? NO_SEATS,
    subsector: query.data?.subsector,
    isLoading: query.isPending,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error ?? null,
    updatedAt: query.dataUpdatedAt,
    refetch,
    query,
  };
}

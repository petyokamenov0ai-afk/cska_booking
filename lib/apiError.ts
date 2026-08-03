/**
 * Error/response helpers for route handlers — `docs/API_CONTRACT.md § Error codes`.
 *
 * The point of this module is that a route handler never builds a JSON error by
 * hand and never owns a status-code decision:
 *
 * ```ts
 * export async function POST(req: Request) {
 *   try {
 *     ...
 *     return jsonOk({ reservation }, { status: 201, cache: 'no-store' });
 *   } catch (err) {
 *     return toApiErrorResponse(err);
 *   }
 * }
 * ```
 *
 * ## How service errors are recognised
 *
 * Deliberately **structurally**, via an `apiCode` property — not `instanceof`.
 * That keeps this module free of any import from `lib/reservations.ts`, so
 * nothing here pulls Prisma in, and it survives the duplicate-module-instance
 * problem that makes `instanceof` unreliable across bundler boundaries.
 * Any thrown object shaped like `{ apiCode: ApiErrorCode, message: string }`
 * maps to the right status automatically (see `ServiceError` in
 * `lib/reservations.ts`).
 */

import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import type { ApiError, ApiErrorCode } from '@/lib/types';

/* ------------------------------------------------------------------ *
 * Status mapping (the table from docs/API_CONTRACT.md)
 * ------------------------------------------------------------------ */

export const ERROR_STATUS: Readonly<Record<ApiErrorCode, number>> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  SEATS_TAKEN: 409,
  INVALID_STATE: 409,
  EXPIRED: 410,
  SALES_CLOSED: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

const DEFAULT_MESSAGE: Readonly<Record<ApiErrorCode, string>> = {
  VALIDATION: 'The request body is invalid.',
  NOT_FOUND: 'Not found.',
  SEATS_TAKEN: 'One or more of the selected seats are no longer available.',
  INVALID_STATE: 'The reservation is not in a state that allows this operation.',
  EXPIRED: 'The hold on these seats has expired.',
  SALES_CLOSED: 'Tickets for this event are not on sale.',
  RATE_LIMITED: 'Too many requests. Please slow down.',
  INTERNAL: 'Something went wrong on our side.',
};

/** Every `ApiErrorCode` and its HTTP status, for docs/tests. */
export function statusForErrorCode(code: ApiErrorCode): number {
  return ERROR_STATUS[code];
}

/* ------------------------------------------------------------------ *
 * Cache headers
 * ------------------------------------------------------------------ */

/** Anything reservation- or seat-status-shaped. */
export const CACHE_NO_STORE = 'no-store';

/** `GET /api/events/:eventId/availability` — cached ~10 s per the contract. */
export const CACHE_AVAILABILITY = 'public, max-age=10';

export type CacheDirective = 'no-store' | 'availability' | string;

function cacheControlValue(cache: CacheDirective): string {
  if (cache === 'no-store') return CACHE_NO_STORE;
  if (cache === 'availability') return CACHE_AVAILABILITY;
  return cache;
}

/* ------------------------------------------------------------------ *
 * Success
 * ------------------------------------------------------------------ */

export interface JsonOkInit {
  status?: number;
  cache?: CacheDirective;
  headers?: Record<string, string>;
}

/** 2xx JSON response with the right `Cache-Control`. */
export function jsonOk<T>(body: T, init: JsonOkInit = {}): NextResponse<T> {
  const headers: Record<string, string> = { ...init.headers };
  if (init.cache !== undefined) {
    headers['Cache-Control'] = cacheControlValue(init.cache);
  }
  return NextResponse.json(body, { status: init.status ?? 200, headers });
}

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

export interface ApiErrorInit {
  /** 409 SEATS_TAKEN — the exact seat ids the client must un-select. */
  conflictSeats?: string[];
  /** 400 VALIDATION — `ZodError.flatten()` output. */
  details?: unknown;
  /** 429 RATE_LIMITED — becomes the `Retry-After` header. */
  retryAfterSeconds?: number;
  headers?: Record<string, string>;
  /** Overrides the table in `ERROR_STATUS`. Almost never needed. */
  status?: number;
}

/** Builds any `ApiError` response, status taken from the contract's table. */
export function apiError(
  code: ApiErrorCode,
  message?: string,
  init: ApiErrorInit = {},
): NextResponse<ApiError> {
  const body: ApiError = {
    error: code,
    message: message?.trim() ? message : DEFAULT_MESSAGE[code],
  };
  if (init.conflictSeats !== undefined) body.conflictSeats = init.conflictSeats;
  if (init.details !== undefined) body.details = init.details;

  const headers: Record<string, string> = {
    'Cache-Control': CACHE_NO_STORE,
    ...init.headers,
  };
  if (init.retryAfterSeconds !== undefined) {
    headers['Retry-After'] = String(Math.max(1, Math.ceil(init.retryAfterSeconds)));
  }

  return NextResponse.json(body, {
    status: init.status ?? ERROR_STATUS[code],
    headers,
  });
}

/** 400 with `details = flatten()`. */
export function validationError(
  error: ZodError | unknown,
  message = 'The request body is invalid.',
): NextResponse<ApiError> {
  const details = error instanceof ZodError ? error.flatten() : undefined;
  return apiError('VALIDATION', message, { details });
}

/** 404. */
export function notFoundError(message?: string): NextResponse<ApiError> {
  return apiError('NOT_FOUND', message);
}

/** 409 with the losing seat ids so the UI can un-select exactly those. */
export function seatsTakenError(
  conflictSeats: string[],
  message?: string,
): NextResponse<ApiError> {
  return apiError('SEATS_TAKEN', message, { conflictSeats });
}

/** 429 with `Retry-After`. */
export function rateLimitedError(
  retryAfterSeconds: number,
  message?: string,
): NextResponse<ApiError> {
  return apiError('RATE_LIMITED', message, { retryAfterSeconds });
}

/** 500. Never echoes the underlying message to the client. */
export function internalError(cause?: unknown): NextResponse<ApiError> {
  if (cause !== undefined) console.error('[api] unhandled error:', cause);
  return apiError('INTERNAL');
}

/* ------------------------------------------------------------------ *
 * Structural recognition of service errors
 * ------------------------------------------------------------------ */

/**
 * The shape `lib/reservations.ts` throws. Anything carrying a valid `apiCode`
 * is mapped automatically by `toApiErrorResponse`.
 */
export interface ServiceErrorLike {
  apiCode: ApiErrorCode;
  message: string;
  conflictSeats?: string[];
  retryAfterSeconds?: number;
  details?: unknown;
}

function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && value in ERROR_STATUS;
}

export function isServiceErrorLike(value: unknown): value is ServiceErrorLike {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { apiCode?: unknown; message?: unknown };
  return isApiErrorCode(candidate.apiCode) && typeof candidate.message === 'string';
}

function stringArrayOrUndefined(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
    ? value
    : undefined;
}

/**
 * The one-liner every route handler's `catch` should use.
 *
 * - `ZodError`            → 400 `VALIDATION` with `details`
 * - anything with `apiCode` → the contract's status for that code
 * - everything else       → 500 `INTERNAL`, logged, message not leaked
 */
export function toApiErrorResponse(error: unknown): NextResponse<ApiError> {
  if (error instanceof ZodError) return validationError(error);

  if (isServiceErrorLike(error)) {
    const candidate = error as ServiceErrorLike & { retryAfterSeconds?: unknown };
    const init: ApiErrorInit = {
      conflictSeats: stringArrayOrUndefined(error.conflictSeats),
      details: error.details,
    };
    if (typeof candidate.retryAfterSeconds === 'number') {
      init.retryAfterSeconds = candidate.retryAfterSeconds;
    }
    // 5xx is our fault, so log it; 4xx is the caller's, so don't.
    if (ERROR_STATUS[error.apiCode] >= 500) console.error('[api]', error);
    return apiError(error.apiCode, error.message, init);
  }

  return internalError(error);
}

/* ------------------------------------------------------------------ *
 * Cron authentication (POST /api/cron/expire)
 * ------------------------------------------------------------------ */

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch; compare lengths separately.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * True when the request carries the shared `x-cron-secret`.
 * Fails closed: no `CRON_SECRET` in the environment means nobody is authorised.
 */
export function isCronAuthorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const provided = request.headers.get('x-cron-secret');
  if (provided === null) return false;
  return constantTimeEquals(provided, expected);
}

/** 404 rather than 401 — an unauthenticated caller learns nothing. */
export function cronUnauthorizedResponse(): NextResponse<ApiError> {
  return notFoundError('Not found.');
}

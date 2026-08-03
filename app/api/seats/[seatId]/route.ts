/**
 * Click-to-book endpoints for a single seat.
 *
 *   POST   /api/seats/:seatId   -> book it
 *   DELETE /api/seats/:seatId   -> free it
 *
 * POST carries two fields — `{ name, note }`. `name` (who the seat is for) is
 * required: labelling the seat is the whole point of the booking dialog. `note`
 * is free text about that one seat and is optional; absent, blank and
 * renders-as-nothing all mean the same thing and store NULL. DELETE still takes
 * no body at all; the seat id in the path is the whole request.
 *
 * There is still no basket and no contact details. See lib/booking.ts — in
 * particular the notes that DELETE is unauthenticated by design (anyone can free
 * anyone's seat) and that the name is public to every visitor.
 */

import { bookSeat, releaseSeat } from '@/lib/booking';
import {
  jsonOk,
  rateLimitedError,
  toApiErrorResponse,
  validationError,
} from '@/lib/apiError';
import { consume } from '@/lib/rateLimit';
import { ensureSessionId } from '@/lib/session';
import { bookSeatSchema } from '@/lib/zodSchemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Ctx {
  params: Promise<{ seatId: string }>;
}

/** First hop of x-forwarded-for, or a constant when running locally. */
function clientIp(request: Request): string {
  const header = request.headers.get('x-forwarded-for');
  return header?.split(',')[0]?.trim() || 'local';
}

/**
 * Generous enough to click along a whole row, tight enough that a script cannot
 * sweep the stadium. Per-process only — see the note in lib/rateLimit.ts.
 */
function overBudget(request: Request, sessionId: string): boolean {
  return (
    !consume(`seat:session:${sessionId}`, 120, 60_000) ||
    !consume(`seat:ip:${clientIp(request)}`, 300, 60_000)
  );
}

export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  try {
    const { seatId } = await ctx.params;
    const sessionId = await ensureSessionId();
    // Budget check before the body is even read, so a flood of malformed
    // requests is still cheap to reject.
    if (overBudget(request, sessionId)) return rateLimitedError(60);

    // `request.json()` throws SyntaxError on an empty or malformed body, and
    // `toApiErrorResponse` recognises neither ZodError nor ServiceErrorLike in
    // that case — it would answer with a *logged 500* for what is plainly a
    // client mistake. So the parse gets its own catch.
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return validationError(undefined, 'Malformed request body.');
    }

    const parsed = bookSeatSchema.safeParse(raw);
    // `flatten()` carries messages only, and 4xx is never logged, so a rejected
    // name or note is neither echoed back nor written anywhere — which matters
    // more for the note, since free text is where a booker puts a phone number.
    if (!parsed.success) {
      return validationError(parsed.error, 'Invalid seat holder name or note.');
    }

    return jsonOk(
      {
        seat: await bookSeat({
          seatId,
          sessionId,
          name: parsed.data.name,
          // `undefined` when the field was absent, blank, or made only of
          // characters that render nothing — the schema has already collapsed
          // all three into the same "no note" shape, so `bookSeat` stores NULL.
          note: parsed.data.note,
        }),
      },
      { status: 201 },
    );
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

export async function DELETE(request: Request, ctx: Ctx): Promise<Response> {
  try {
    const { seatId } = await ctx.params;
    const sessionId = await ensureSessionId();
    if (overBudget(request, sessionId)) return rateLimitedError(60);

    return jsonOk({ seatId, released: await releaseSeat({ seatId }) });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

/**
 * Toasts.
 *
 * The queue is a **module-level store** rather than a React context, for one
 * practical reason: the map components need to raise a toast from places that
 * are not always inside a provider (a `reconcile()` result handled in an
 * effect, a rejected `add()` deep in the seat layer). `pushToast()` therefore
 * works from anywhere — including outside React — and any single `<Toaster />`
 * mounted in the tree renders the queue.
 *
 * Wiring: render `<Toaster />` once, near the root of the page (or in
 * `app/providers.tsx`). Nothing breaks if it is missing — toasts are simply
 * queued and expire unseen.
 */

'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { Check, CircleAlert, Info, TriangleAlert, X } from 'lucide-react';

import { cn } from '@/lib/format';
import { DEFAULT_LOCALE, t, type Locale } from '@/lib/i18n';

export type ToastVariant = 'info' | 'success' | 'warning' | 'error';

export interface ToastInput {
  message: string;
  title?: string;
  variant?: ToastVariant;
  /** Auto-dismiss delay in ms. `0` keeps it until dismissed. */
  duration?: number;
  /**
   * Stable id. Pushing the same id twice replaces the existing toast instead of
   * stacking duplicates — useful for a repeating poll-driven message.
   */
  id?: string;
}

export interface ToastItem {
  id: string;
  message: string;
  title?: string;
  variant: ToastVariant;
  duration: number;
  createdAt: number;
}

/** Beyond this the oldest toasts are dropped. */
export const MAX_VISIBLE_TOASTS = 4;

const DEFAULT_DURATION: Record<ToastVariant, number> = {
  info: 5_000,
  success: 4_000,
  warning: 7_000,
  error: 8_000,
};

/* ------------------------------------------------------------------ *
 * Store
 * ------------------------------------------------------------------ */

let queue: ToastItem[] = [];
let sequence = 0;
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Frozen empty array: a stable server snapshot keeps hydration quiet. */
const SERVER_SNAPSHOT: ToastItem[] = [];

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ToastItem[] {
  return queue;
}

function getServerSnapshot(): ToastItem[] {
  return SERVER_SNAPSHOT;
}

function clearTimer(id: string): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
}

/** Queue a toast. Returns its id, so it can be dismissed programmatically. */
export function pushToast(input: ToastInput): string {
  const variant = input.variant ?? 'info';
  const id = input.id ?? `toast-${++sequence}`;
  const item: ToastItem = {
    id,
    message: input.message,
    title: input.title,
    variant,
    duration: input.duration ?? DEFAULT_DURATION[variant],
    createdAt: Date.now(),
  };

  clearTimer(id);
  const withoutDuplicate = queue.filter((toast) => toast.id !== id);
  queue = [...withoutDuplicate, item].slice(-MAX_VISIBLE_TOASTS);

  if (item.duration > 0) {
    timers.set(
      id,
      setTimeout(() => dismissToast(id), item.duration),
    );
  }
  emit();
  return id;
}

export function dismissToast(id: string): void {
  clearTimer(id);
  const next = queue.filter((toast) => toast.id !== id);
  if (next.length === queue.length) return;
  queue = next;
  emit();
}

export function clearToasts(): void {
  for (const id of [...timers.keys()]) clearTimer(id);
  if (queue.length === 0) return;
  queue = [];
  emit();
}

/** Live queue, for a custom viewport. */
export function useToasts(): ToastItem[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

const TOAST_API = Object.freeze({
  toast: pushToast,
  dismiss: dismissToast,
  clear: clearToasts,
});

/** `const { toast } = useToast();` — the module functions, no provider needed. */
export function useToast(): typeof TOAST_API {
  return TOAST_API;
}

/* ------------------------------------------------------------------ *
 * Presentation
 * ------------------------------------------------------------------ */

const VARIANT_CLASS: Record<ToastVariant, string> = {
  info: 'border-border bg-surface-raised text-foreground',
  success: 'border-success/40 bg-surface-raised text-foreground',
  warning: 'border-warning/50 bg-surface-raised text-foreground',
  error: 'border-destructive/50 bg-surface-raised text-foreground',
};

const ICON_CLASS: Record<ToastVariant, string> = {
  info: 'text-muted-foreground',
  success: 'text-success',
  warning: 'text-warning',
  error: 'text-destructive',
};

function VariantIcon({ variant }: { variant: ToastVariant }) {
  const className = cn('size-5 shrink-0', ICON_CLASS[variant]);
  switch (variant) {
    case 'success':
      return <Check className={className} aria-hidden="true" />;
    case 'warning':
      return <TriangleAlert className={className} aria-hidden="true" />;
    case 'error':
      return <CircleAlert className={className} aria-hidden="true" />;
    default:
      return <Info className={className} aria-hidden="true" />;
  }
}

export interface ToastProps {
  toast: ToastItem;
  onDismiss?: (id: string) => void;
  locale?: Locale;
  className?: string;
}

/** A single toast card. Exported for stories/tests and custom viewports. */
export function Toast({ toast, onDismiss, locale = DEFAULT_LOCALE, className }: ToastProps) {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div
      data-testid="toast"
      role={toast.variant === 'error' ? 'alert' : 'status'}
      className={cn(
        'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border p-3 shadow-lg',
        'transition-all duration-200 motion-reduce:transition-none',
        shown ? 'translate-y-0 opacity-100' : '-translate-y-2 opacity-0',
        VARIANT_CLASS[toast.variant],
        className,
      )}
    >
      <VariantIcon variant={toast.variant} />
      <div className="min-w-0 flex-1">
        {toast.title ? <p className="text-sm font-semibold">{toast.title}</p> : null}
        <p className="text-sm break-words text-muted-foreground">{toast.message}</p>
      </div>
      <button
        type="button"
        onClick={() => (onDismiss ?? dismissToast)(toast.id)}
        aria-label={t(locale, 'common.close')}
        className="-m-1 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground motion-reduce:transition-none"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}

export interface ToasterProps {
  locale?: Locale;
  /** Positioning override. Replaces the default fixed placement. */
  className?: string;
}

/**
 * The viewport. Mount once. Sits top-centre on mobile and top-right on
 * desktop, out of the way of the sticky basket bar at the bottom.
 */
export default function Toaster({ locale = DEFAULT_LOCALE, className }: ToasterProps) {
  const toasts = useToasts();

  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className={cn(
        'pointer-events-none fixed inset-x-0 top-0 z-50 flex flex-col items-center gap-2 p-3 sm:items-end sm:p-4',
        className,
      )}
    >
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} locale={locale} />
      ))}
    </div>
  );
}

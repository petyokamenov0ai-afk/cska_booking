import Link from 'next/link';

/**
 * Drill-down breadcrumb: `Матчове → CSKA–Levski → Сектор А → Подсектор А1`.
 *
 * Deliberately dependency-free (only `next/link`) so it can be rendered from
 * both Server Components (the pages) and Client Components (EventMapClient,
 * which recomputes the trail as the focused sector changes).
 */
export interface Crumb {
  label: string;
  /** Omit for the current page — rendered as plain text with aria-current. */
  href?: string;
}

export interface BreadcrumbsProps {
  items: Crumb[];
  /** Accessible name for the nav landmark. */
  label?: string;
  className?: string;
}

export default function Breadcrumbs({
  items,
  label = 'Breadcrumb',
  className,
}: BreadcrumbsProps) {
  if (items.length === 0) return null;

  return (
    <nav
      aria-label={label}
      className={['min-w-0 text-sm', className].filter(Boolean).join(' ')}
    >
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          return (
            <li key={`${item.label}-${index}`} className="flex min-w-0 items-center gap-x-1.5">
              {index > 0 && (
                <span aria-hidden="true" className="text-muted-foreground/60 select-none">
                  /
                </span>
              )}
              {item.href && !isLast ? (
                <Link
                  href={item.href}
                  className="truncate text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  {item.label}
                </Link>
              ) : (
                <span
                  aria-current={isLast ? 'page' : undefined}
                  className={
                    isLast
                      ? 'truncate font-medium text-foreground'
                      : 'truncate text-muted-foreground'
                  }
                >
                  {item.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

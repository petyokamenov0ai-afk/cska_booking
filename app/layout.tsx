import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import Link from 'next/link';

import { DEFAULT_LOCALE, t } from '@/lib/i18n';
import Providers from './providers';
import './globals.css';

// Cyrillic is mandatory: sector codes (А Б В Г) and all bg copy are Cyrillic.
const inter = Inter({
  subsets: ['latin', 'latin-ext', 'cyrillic', 'cyrillic-ext'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: `${t(DEFAULT_LOCALE, 'brand.name')} — ${t(DEFAULT_LOCALE, 'brand.tagline')}`,
    template: `%s · ${t(DEFAULT_LOCALE, 'brand.name')}`,
  },
  description: `${t(DEFAULT_LOCALE, 'brand.stadium')} — ${t(DEFAULT_LOCALE, 'brand.tagline')}`,
  applicationName: 'CSKA Booking',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  // The light theme is pinned on <html>, so the browser chrome should match it
  // rather than following the OS.
  themeColor: '#ffffff',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // `light` on <html> pins the white theme regardless of the OS setting. The dark
  // tokens in globals.css are kept intact, so dropping this class (or swapping it
  // for `dark`) is all a future theme toggle needs.
  return (
    <html lang={DEFAULT_LOCALE} className={`${inter.variable} light`}>
      <body className="min-h-dvh bg-background font-sans text-foreground antialiased">
        <Providers>
          <div className="flex min-h-dvh flex-col">
            <header className="sticky top-0 z-40 border-b border-border bg-surface/85 backdrop-blur supports-[backdrop-filter]:bg-surface/70">
              <div className="mx-auto flex w-full max-w-[1800px] items-center gap-3 px-4 py-3 sm:px-6">
                <Link href="/" className="flex items-baseline gap-2 no-underline">
                  <span className="text-lg font-extrabold tracking-tight text-primary">
                    {t(DEFAULT_LOCALE, 'brand.name')}
                  </span>
                  <span className="hidden text-sm text-muted-foreground sm:inline">
                    {t(DEFAULT_LOCALE, 'brand.stadium')}
                  </span>
                </Link>
                <span className="ml-auto text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  {t(DEFAULT_LOCALE, 'brand.tagline')}
                </span>
              </div>
            </header>

            <main className="mx-auto w-full max-w-[1800px] flex-1 px-4 py-6 sm:px-6">{children}</main>

            <footer className="border-t border-border px-4 py-6 text-center text-xs text-muted-foreground">
              {t(DEFAULT_LOCALE, 'brand.stadium')}
            </footer>
          </div>
        </Providers>
      </body>
    </html>
  );
}

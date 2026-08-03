/**
 * /login — the one page outside the middleware gate. A visitor who already
 * carries a valid `admin` cookie is bounced straight home.
 */

import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { AUTH_COOKIE, verifyAuthToken } from '@/lib/auth';
import { DEFAULT_LOCALE, t } from '@/lib/i18n';

import LoginForm from './LoginForm';

export const dynamic = 'force-dynamic';

const locale = DEFAULT_LOCALE;

export const metadata: Metadata = {
  title: t(locale, 'auth.title'),
};

export default async function LoginPage() {
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  if (token !== undefined && (await verifyAuthToken(token)) !== null) redirect('/');

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center">
      <div className="w-full max-w-[22rem] rounded-xl border border-border bg-surface-raised p-6 shadow-sm">
        <h1 className="mb-4 text-lg font-semibold">{t(locale, 'auth.title')}</h1>
        <LoginForm locale={locale} />
      </div>
    </div>
  );
}

import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /**
   * Pin the workspace root to this directory.
   *
   * There is a stray `package-lock.json` in a parent directory on some dev
   * machines, and with multiple lockfiles in scope Next infers the *outer* one
   * as the root. That makes `next build` warn, and it makes standalone output
   * tracing walk the wrong tree. Anchor it to this file instead of `cwd`.
   */
  outputFileTracingRoot: fileURLToPath(new URL('.', import.meta.url)),
  // Prisma must run on the Node runtime; keep it out of the bundler's tracing.
  serverExternalPackages: ['@prisma/client'],
  eslint: {
    // CI runs `npm run lint` separately; don't fail production builds on lint.
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
};

export default nextConfig;

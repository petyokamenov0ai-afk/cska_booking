/**
 * `.env` loading for the test suites.
 *
 * Neither Vitest nor `@prisma/client` reads `.env` (only the Prisma *CLI* does),
 * so without this every integration suite would find `DATABASE_URL` undefined,
 * skip itself, and report green while testing nothing.
 *
 * Deliberately hand-rolled rather than pulling in `dotenv`: this lives in
 * `vitest.config.ts`'s `globalSetup`, and a `globalSetup` that fails to resolve
 * an import takes the **entire run** down rather than just the cleanup. Keeping
 * it dependency-free removes that failure mode. (`dotenv` is currently present
 * in `node_modules` only transitively, via `c12` — it is not a declared
 * dependency of this project and must not be imported.)
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Repo root, derived from this file rather than from `process.cwd()`. */
export const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Minimal `.env` parser.
 *
 * Supports `KEY=value`, `export KEY=value`, `#` comments, blank lines, and
 * single/double quoted values (with `\n` unescaped inside double quotes only,
 * matching dotenv).
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * Loads the given env files in order, never overwriting a variable that is
 * already set — an explicit `DATABASE_URL=… vitest run` always wins.
 */
export function loadDotEnv(files: readonly string[] = ['.env', '.env.local']): void {
  for (const name of files) {
    const path = `${PROJECT_ROOT}${name}`;
    if (!existsSync(path)) continue;
    const parsed = parseEnvFile(readFileSync(path, 'utf8'));
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

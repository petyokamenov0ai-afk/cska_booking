import type { Config } from 'tailwindcss';

/**
 * Tailwind v4 is configured primarily in CSS (`app/globals.css` — `@theme`).
 * This file exists for tooling that still expects a config module (editor
 * plugins, `content` hints) and must stay in sync with the CSS theme.
 */
const config: Config = {
  // Dark mode is defined in CSS (`@custom-variant dark` in app/globals.css):
  // it follows the OS setting and can be forced with `.dark` / `.light` on
  // <html>. Do not add a `darkMode` key here — v4 would not read it anyway.
  content: [
    './app/**/*.{ts,tsx,mdx}',
    './components/**/*.{ts,tsx,mdx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;

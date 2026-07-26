import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  server: { host: true, port: 5173 },
  build: { target: 'es2022' },
  test: {
    // Playwright owns tests/e2e; vitest must not try to run those.
    exclude: ['**/node_modules/**', 'tests/e2e/**'],
  },
});

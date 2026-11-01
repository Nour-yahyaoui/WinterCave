import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    // The preview proxy serves the app from <port>-<sandbox>.e2b.app.
    allowedHosts: true,
    fs: { strict: false },
  },
  build: { target: 'es2022', sourcemap: true },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    environmentMatchGlobs: [['tests/dom/**', 'happy-dom']],
  },
});

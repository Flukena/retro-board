import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { PUBLIC_RELAY_PORT, PUBLIC_RELAY_PREFIX } from './src/server/public-wall-config.js';

export default defineConfig({
  plugins: [react()],
  server: {
    // Local commands stay loopback-only. Docker opts into 0.0.0.0 with the
    // explicit VITE_DEV_HOST environment variable in docker-compose.yml.
    host: process.env.VITE_DEV_HOST || '127.0.0.1',
    port: 5173,
    proxy: { [PUBLIC_RELAY_PREFIX]: { target: `http://127.0.0.1:${PUBLIC_RELAY_PORT}`, ws: true } },
    strictPort: false,
    // Production is served by nginx. Keeping the development allowlist local
    // prevents DNS-rebinding access to a developer's Vite process.
    allowedHosts: ['localhost', '127.0.0.1'],
  },
});

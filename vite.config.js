import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Local commands stay loopback-only. Docker opts into 0.0.0.0 with the
    // explicit VITE_DEV_HOST environment variable in docker-compose.yml.
    host: process.env.VITE_DEV_HOST || '127.0.0.1',
    port: 5173,
    strictPort: false,
    // Production is served by nginx. Keeping the development allowlist local
    // prevents DNS-rebinding access to a developer's Vite process.
    allowedHosts: ['localhost', '127.0.0.1'],
  },
});

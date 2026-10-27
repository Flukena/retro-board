import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'maintainer',
  build: {
    outDir: '../dist-maintainer',
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: 'maintainer.js', assetFileNames: 'maintainer.[ext]' } },
  },
});

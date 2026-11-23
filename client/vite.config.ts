import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  define: {
    global: 'window',
  },
  resolve: {
    alias: {
      util: path.resolve(__dirname, 'src/lib/util-shim.ts'),
      events: path.resolve(__dirname, 'src/lib/events-shim.ts'),
      os: path.resolve(__dirname, 'src/lib/os-shim.ts'),
      path: path.resolve(__dirname, 'src/lib/path-shim.ts'),
      fs: path.resolve(__dirname, 'src/lib/fs-shim.ts'),
      crypto: path.resolve(__dirname, 'src/lib/crypto-shim.ts'),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    target: 'es2021',
    outDir: 'dist',
  },
});

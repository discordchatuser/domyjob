import { defineConfig } from 'vite';
export default defineConfig({
  root: 'client',
  server: { host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:3001' } },
  build: { target: 'es2022', outDir: '../dist', emptyOutDir: true },
});

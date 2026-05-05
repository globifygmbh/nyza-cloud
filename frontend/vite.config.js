import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Build output goes directly into ../cloud/assets/ — that's the folder the
// PHP entry point serves from, so a `npm run build` immediately makes the
// production app available without any copy step.
//
// Asset URLs use `base: './'` so the same build works whether mounted at
// the web root, /cloud/, or any deeper path. PHP injects window.NYZA_BASE
// at runtime so the API client + router know their prefix.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: './',
  root: '.',
  build: {
    outDir: path.resolve(__dirname, '../cloud/assets'),
    emptyOutDir: true,
    sourcemap: mode === 'development',
    target: 'es2020',
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        // Predictable but content-hashed names for the long-cache .htaccess rule.
        entryFileNames: 'app-[hash].js',
        chunkFileNames: 'chunk-[hash].js',
        assetFileNames: '[name]-[hash][extname]',
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      // During `npm run dev`, proxy API calls to the PHP backend so a single
      // origin behavior matches production.
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
    },
  },
}));

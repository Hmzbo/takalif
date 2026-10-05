import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      // injectManifest ignores the `workbox` block: caching lives in src/sw.ts,
      // which keeps the same contract (precached shell, /api/* always network).
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}'],
      },
      manifest: {
        name: 'Takalif',
        short_name: 'Takalif',
        description: 'Recurring commitments, and how faithfully you kept them.',
        theme_color: '#0e7c5b',
        background_color: '#0b0f0e',
        display: 'standalone',
        start_url: '.',
        scope: '.',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      // No `workbox` block: with injectManifest the caching strategy lives in
      // src/sw.ts (precached shell, /api/* always network).
    }),
  ],
  server: {
    // `pnpm --filter @takalif/server dev` on :8787, `pnpm --filter @takalif/web dev` here.
    proxy: {
      '/api': {
        target: process.env.TAKALIF_API ?? 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
  },
});

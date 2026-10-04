import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
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
      workbox: {
        // The app shell works offline; the ledger itself lives on the server.
        // API responses are never cached — a stale ledger is worse than none.
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: /^https?:.*\/api\/.*/i,
            handler: 'NetworkOnly',
          },
        ],
      },
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

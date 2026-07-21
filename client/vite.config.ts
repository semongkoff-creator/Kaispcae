import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    // Listen on all interfaces (0.0.0.0) so other devices on the same LAN can
    // open http://<this-machine-ip>:5173 to play together — see
    // client/src/services/serverUrl.ts for how the socket then points back at
    // the same host's :3001.
    host: true,
    // Vite 5.4.12+ memeriksa Host header (perlindungan DNS-rebinding) dan
    // menolak host yang tidak dikenal dengan "Blocked request. This host is
    // not allowed." Tanpa baris ini, URL quick-tunnel Cloudflare ditolak
    // sebelum halaman sempat termuat. Awalan titik = cocokkan semua subdomain.
    allowedHosts: ['.trycloudflare.com'],
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      // Diteruskan supaya frontend dan backend bisa berbagi SATU tunnel:
      // browser hanya kenal origin tunnel, Vite yang meneruskan ke :3001.
      // ws: true wajib — tanpa itu hanya polling yang lewat, upgrade ke
      // WebSocket gagal dan realtime-nya patah-patah.
      //
      // Selain menyederhanakan (satu URL, bukan dua), ini juga menjaga
      // semuanya same-origin: cookie sesi upload diset sameSite: 'lax'
      // (server/src/middleware/auth.ts), jadi lewat dua tunnel terpisah
      // cookie-nya tidak akan ikut terkirim dan semua avatar/gambar 401.
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
      },
    },
  },
});

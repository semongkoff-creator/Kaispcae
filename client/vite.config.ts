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
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});

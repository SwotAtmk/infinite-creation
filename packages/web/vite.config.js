import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:4600',
      '/files': 'http://127.0.0.1:4600',
      '/ws': { target: 'ws://127.0.0.1:4600', ws: true },
    },
  },
});

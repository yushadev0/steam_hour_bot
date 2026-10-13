import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Geliştirmede API isteklerini çalışan sunucuya (npm start) yönlendir
const apiTarget = process.env.SHB_API ?? 'http://127.0.0.1:8090';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': { target: apiTarget, ws: true },
    },
  },
});

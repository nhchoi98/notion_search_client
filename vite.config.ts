import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget =
  process.env.VITE_MCP_API_BASE_URL || process.env.VITE_API_BASE_URL || 'http://localhost:4000';

export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: ['react-compiler'],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        secure: false,
      },
    },
  },
});

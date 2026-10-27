import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// The app reads VITE_API_BASE_URL at runtime (src/lib/api.ts). When it is unset
// we talk to http://localhost:4000. In `npm run dev` we additionally proxy /api
// to the local backend so relative requests work without CORS fuss.
export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        proxy: {
            '/api': {
                target: 'http://localhost:4000',
                changeOrigin: true,
            },
        },
    },
    build: {
        outDir: 'dist',
        sourcemap: false,
    },
});

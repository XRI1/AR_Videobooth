import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS is required for camera + motion sensors on phones, so the default dev
// server uses a self-signed cert and is exposed on the LAN (`host: true`).
// `npm run dev:local` serves plain http://localhost for desktop testing
// (localhost counts as a secure context, so the camera still works).
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: mode === 'http' ? [] : [basicSsl()],
  server: { host: mode !== 'http', port: mode === 'http' ? 5174 : 5173 },
  preview: { host: true, port: 4173 },
}));

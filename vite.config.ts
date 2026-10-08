import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const serverPort = Number(process.env.HERDR_WEB_PORT ?? 7681)

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // ghostty-web inlines its ~400 KB WASM module into the bundle.
  build: { chunkSizeWarningLimit: 1500 },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
      '@shared': path.resolve(import.meta.dirname, './shared'),
    },
  },
  server: {
    proxy: {
      '/ws': { target: `ws://127.0.0.1:${serverPort}`, ws: true },
      '/api': { target: `http://127.0.0.1:${serverPort}` },
    },
  },
})

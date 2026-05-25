import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const AGENTS_URL = process.env.ELECTRIC_AGENTS_URL ?? 'http://localhost:4437'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/_electric': { target: AGENTS_URL, changeOrigin: true },
      '/assistant': { target: AGENTS_URL, changeOrigin: true },
      '/episodes': { target: AGENTS_URL, changeOrigin: true },
    },
  },
})

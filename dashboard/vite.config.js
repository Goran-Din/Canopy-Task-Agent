import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/',
  build: {
    rollupOptions: {
      input: {
        landscape: resolve(__dirname, 'index.html'),
        hardscape: resolve(__dirname, 'hardscape.html'),
      },
    },
  },
  server: {
    proxy: {
      '/landscape': 'http://localhost:3100',
      '/api': 'http://localhost:3100',
      '/dashboard': 'http://localhost:3100',
    },
  },
})

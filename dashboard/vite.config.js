import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/crews/',
  server: {
    proxy: {
      '/landscape': 'http://localhost:3100',
      '/api': 'http://localhost:3100',
      '/dashboard': 'http://localhost:3100',
    },
  },
})

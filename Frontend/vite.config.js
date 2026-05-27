import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react({
      include: /\.[jt]sx?$/,
    }),
  ],
  server: {
    allowedHosts: true,
    proxy: {
      '/sessions': 'http://localhost:3001',
      '/games': 'http://localhost:3001',
      '/team-members': 'http://localhost:3001',
      '/invite': 'http://localhost:3001',
      '/users': 'http://localhost:3001',
      '/auth': 'http://localhost:3001',
      '/bots': 'http://localhost:3001',
      '/moves': 'http://localhost:3001',
      '/chat': 'http://localhost:3001',
      '/chats': 'http://localhost:3001',
      '/player-reserves': 'http://localhost:3001',
    },
  },
})

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Vite configuration for EarthContours B2
// The React plugin provides JSX transform and Fast Refresh during development.
// The proxy forwards WebSocket connections to the Express + OSC server (index.js).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true, // Expose to network so it can be accessed from local IP too
    open: false,
    // Proxy Socket.IO WebSocket connections to the Express server (index.js on port 3000)
    // This lets the browser connect to Vite's port and still reach the WebSocket server.
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,  // Enable WebSocket proxying
      },
    },
  },
  build: {
    target: 'es2020',
    sourcemap: true, // Keep source maps for debugging
  },
  // Allow top-level await (needed for some async data loading patterns)
  esbuild: {
    target: 'es2020',
  },
})

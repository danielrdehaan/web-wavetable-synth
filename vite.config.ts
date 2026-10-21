import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The app lives in app/; web/ (the WASM engine, its worklet and client, fonts, the plain demo page)
// is served as-is at the site root.
export default defineConfig({
  root: 'app',
  publicDir: '../web',
  plugins: [react()],
  server: { port: 5291, strictPort: true },
  build: { outDir: '../dist', emptyOutDir: true },
})

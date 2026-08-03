import { defineConfig } from 'vite'
// @ts-ignore - JS module without types
import nodeStdlibBrowser from './vite-plugin-node-stdlib-browser.js'

export default defineConfig({
  server: {
    port: 4560,
    // No COOP/COEP - setting them blocks the cross-origin iframe to fkn/web at :1234.
  },
  assetsInclude: ['**/*.wasm'],
  optimizeDeps: {
    include: ['@fkn/lib/net', '@fkn/lib/dgram', '@fkn/lib'],
    exclude: ['libtorrent.js'],
  },
  plugins: [
    nodeStdlibBrowser(),
  ],
})

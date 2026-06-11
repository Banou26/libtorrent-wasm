import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    target: 'esnext',
    outDir: 'build',
    minify: false,
    emptyOutDir: false,
    lib: {
      entry: {
        index: 'src/index.ts',
        opfs: 'src/opfs.ts',
        types: 'src/types.ts',
      },
      formats: ['es'],
    },
    rollupOptions: {
      // Don't try to bundle the emscripten glue - `src/index.ts` dynamic-imports
      // `./libtorrent.js` at runtime, which copy-wasm puts alongside the bundle.
      external: ['./libtorrent.js', '../dist/libtorrent.js'],
      output: {
        entryFileNames: '[name].js',
      },
    },
  },
})

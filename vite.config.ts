import { defineConfig } from 'vite-plus'

export default defineConfig({
  fmt: { semi: false, singleQuote: true },
  lint: {
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    rules: {
      'vite-plus/prefer-vite-plus-imports': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
    },
    options: { typeAware: true, typeCheck: true },
    overrides: [
      {
        files: ['tests/**', '**/*.spec.ts', '**/*.test.ts', 'examples/**'],
        rules: {
          'no-floating-promises': 'off',
          'no-unused-vars': 'off',
          'no-unused-expressions': 'off',
        },
      },
    ],
  },
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

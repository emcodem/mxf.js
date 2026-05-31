import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  publicDir: false,
  server: {
    open: '/demo/index.html',
    headers: {
      // Required for SharedArrayBuffer / cross-origin isolation if needed later
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'Jsmxf',
      formats: ['es', 'umd'],
      fileName: (format) => `jsmxf.${format === 'es' ? 'esm' : 'umd'}.js`,
    },
    outDir: 'dist',
    sourcemap: true,
  },
  worker: {
    format: 'es',
  },
});

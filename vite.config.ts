import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  publicDir: false,
  server: {
    open: '/demo/index.html',
    // NOTE: deliberately NOT setting COOP/COEP. `Cross-Origin-Embedder-Policy: require-corp`
    // makes the page cross-origin isolated, which blocks the worker's fetch() of an MXF served
    // from another origin (e.g. http://localhost:8000/clip.mxf) unless that server also sends
    // Cross-Origin-Resource-Policy — so URL playback "didn't work at all". Nothing here uses
    // SharedArrayBuffer, so isolation isn't needed. Cross-origin URLs still require normal CORS
    // (Access-Control-Allow-Origin) on the file server.
  },
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'MxfJs',
      formats: ['es', 'umd'],
      fileName: (format) => `mxf.${format === 'es' ? 'esm' : 'umd'}.js`,
    },
    outDir: 'dist',
    sourcemap: true,
  },
  worker: {
    format: 'es',
  },
});

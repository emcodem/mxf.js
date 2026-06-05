import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: true,
    rollupOptions: {
      input: 'src/worker/demux-worker.ts',
      output: {
        format: 'es',
        entryFileNames: 'demux-worker.js',
      },
    },
  },
});

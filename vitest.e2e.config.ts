import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 30_000,
    reporters: ['verbose'],
    // Run e2e files ONE AT A TIME. Each file spins up its own Vite/range server +
    // a non-headless Chrome; running them in parallel starves the servers (sockets
    // get ECONNREFUSED before they finish binding) and the browsers (frame-timing
    // and manifest-load assertions miss under CPU contention). Sequential keeps each
    // test's server+browser isolated so results are deterministic.
    fileParallelism: false,
  },
});

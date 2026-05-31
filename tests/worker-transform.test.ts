/**
 * Guards the demux worker against module-load breakage. The worker is loaded as an ES module
 * (`new Worker(url, { type: 'module' })`); if any module in its import graph fails to transform,
 * the browser fires a contentless error event and the player reports "Worker failed to load".
 * This reproduces the dev server's job — transforming every src module via the REAL vite.config.ts —
 * and fails only when a transform THROWS (an empty result is valid: type-only modules such as
 * worker-messages.ts erase to nothing after esbuild strips their types).
 */
import { describe, test, expect } from 'vitest';
import { createServer } from 'vite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function allTs(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) allTs(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('worker module graph transforms under the real vite config', () => {
  test('no src/*.ts throws when transformed by the dev server', async () => {
    const server = await createServer({ root, logLevel: 'silent', server: { middlewareMode: true } });
    const failures: string[] = [];
    try {
      for (const file of allTs(path.join(root, 'src'))) {
        const url = '/' + path.relative(root, file).split(path.sep).join('/');
        try {
          await server.transformRequest(url); // null (empty) is fine — type-only modules erase to nothing
        } catch (e) {
          failures.push(`${url}: ${(e as Error).message}`);
        }
      }
    } finally {
      await server.close();
    }
    expect(failures, `Modules failed to transform:\n${failures.join('\n')}`).toEqual([]);
  }, 60_000);
});

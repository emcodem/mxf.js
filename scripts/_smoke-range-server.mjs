// Scratch smoke test for range-server.mjs (delete after). Exercises HEAD, full/ranged/open-ended/
// suffix GET, bad range (416), OPTIONS, encoded traversal (403/404), latency timing, and throttle.
import { startRangeServer } from './range-server.mjs';
import { readFileSync } from 'node:fs';

const fails = [];
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!cond) fails.push(name);
};

const dir = 'C:/dev/jsmxf';
const file = 'package.json';
const size = readFileSync(`${dir}/${file}`).length;

const LAT = 60;
const srv = await startRangeServer({ dir, port: 0, latencyMs: LAT, bytesPerSec: 0 });
const base = `${srv.url}/${file}`;

let t = performance.now();
let r = await fetch(base, { method: 'HEAD' });
const headMs = performance.now() - t;
ok('HEAD 200', r.status === 200);
ok('HEAD content-length', Number(r.headers.get('content-length')) === size, `${r.headers.get('content-length')} vs ${size}`);
ok('HEAD accept-ranges', r.headers.get('accept-ranges') === 'bytes');
ok('CORS allow-origin', r.headers.get('access-control-allow-origin') === '*');
ok('latency applied (HEAD)', headMs >= LAT - 5, `${headMs.toFixed(0)}ms`);

r = await fetch(base, { headers: { Range: 'bytes=0-9' } });
ok('range 206', r.status === 206);
ok('range content-range', r.headers.get('content-range') === `bytes 0-9/${size}`, r.headers.get('content-range') ?? '');
ok('range content-length', Number(r.headers.get('content-length')) === 10);
ok('range body length', (await r.arrayBuffer()).byteLength === 10);

r = await fetch(base, { headers: { Range: `bytes=${size - 5}-` } });
ok('open-ended 206', r.status === 206);
ok('open-ended content-range', r.headers.get('content-range') === `bytes ${size - 5}-${size - 1}/${size}`, r.headers.get('content-range') ?? '');

r = await fetch(base, { headers: { Range: 'bytes=-7' } });
ok('suffix 206', r.status === 206);
ok('suffix content-range', r.headers.get('content-range') === `bytes ${size - 7}-${size - 1}/${size}`, r.headers.get('content-range') ?? '');

r = await fetch(base, { headers: { Range: `bytes=${size + 100}-${size + 200}` } });
ok('bad range 416', r.status === 416);
ok('bad range content-range', r.headers.get('content-range') === `bytes */${size}`, r.headers.get('content-range') ?? '');
await r.arrayBuffer().catch(() => {});

r = await fetch(base, { method: 'OPTIONS' });
ok('OPTIONS 204', r.status === 204);
ok('OPTIONS allow-headers', (r.headers.get('access-control-allow-headers') ?? '').toLowerCase().includes('range'));

r = await fetch(`${srv.url}/%2e%2e/%2e%2e/Windows/win.ini`);
ok('encoded traversal blocked', r.status === 403 || r.status === 404, `status ${r.status}`);
await r.arrayBuffer().catch(() => {});

r = await fetch(base);
ok('full GET 200', r.status === 200);
ok('full GET body size', (await r.arrayBuffer()).byteLength === size);

await srv.close();

const big = 'package-lock.json';
let bigSize;
try { bigSize = readFileSync(`${dir}/${big}`).length; } catch { bigSize = 0; }
if (bigSize > 200_000) {
  const RATE = 256 * 1024;
  const srv2 = await startRangeServer({ dir, port: 0, latencyMs: 0, bytesPerSec: RATE });
  const end = Math.min(bigSize - 1, 256 * 1024 - 1);
  t = performance.now();
  r = await fetch(`${srv2.url}/${big}`, { headers: { Range: `bytes=0-${end}` } });
  await r.arrayBuffer();
  const ms = performance.now() - t;
  const expected = ((end + 1) / RATE) * 1000;
  ok('throttle paces transfer', ms >= expected * 0.6, `${ms.toFixed(0)}ms for ~${expected.toFixed(0)}ms`);
  await srv2.close();
} else {
  console.log('SKIP throttle test — no large file available');
}

console.log(fails.length ? `\n${fails.length} FAILURE(S): ${fails.join(', ')}` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);

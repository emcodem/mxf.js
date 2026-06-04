import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { parseRate } from './scripts/range-server.mjs';

// Serve local MXF test assets same-origin at /media/<file>.mxf with HTTP Range support,
// so the demo's "Load URL" works against the Vite dev server itself — no second
// range-capable server, and no CORS (same origin). HttpLoader requires 206 for ranged GETs,
// which this middleware honours. Point MXF_MEDIA_DIR at your asset folder (default C:/temp/mxf.js).
//
// Network simulation (same knobs as scripts/range-server.mjs) is driven by query params so the
// demo UI can vary it per load without restarting Vite — every HttpLoader fetchRange reuses the
// full URL (query string included), so the throttle applies to the probe and every read:
//   /media/vistek.mxf?latency=50&rate=10m   → 50 ms RTT per request, ~10 MB/s body pacing
//   latency (ms) is paid once per request BEFORE the response; rate=0 (or absent) = unthrottled.
const MEDIA_DIR = path.resolve(process.env.MXF_MEDIA_DIR ?? 'C:/temp/mxf.js');
const THROTTLE_CHUNK = 64 * 1024;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Live network-sim overrides, settable at runtime via POST /__latency, so the demo's knobs can
// change latency/bandwidth mid-playback without reloading the file. null = unset → the /media
// handler falls back to the per-URL ?latency=/?rate= query params (back-compat).
let liveLatencyMs: number | null = null;
let liveBytesPerSec: number | null = null;

// Pipe a read stream to the response, optionally pacing to `bytesPerSec` (0 = no throttle).
// Honours backpressure and bails if the client aborts (a superseded seek/scrub), so a cancelled
// read doesn't keep pacing a dead socket. Mirrors range-server.mjs's streamRange.
async function pipeThrottled(stream: any, res: any, bytesPerSec: number) {
  if (!bytesPerSec) { stream.pipe(res); return; }
  let aborted = false;
  const onClose = () => { aborted = true; stream.destroy(); };
  res.on('close', onClose);
  try {
    for await (const chunk of stream) {
      if (aborted) return;
      if (!res.write(chunk)) {
        await new Promise((resolve) => { res.once('drain', resolve); res.once('close', resolve); });
        if (aborted) return;
      }
      await delay((chunk.length / bytesPerSec) * 1000);
    }
    res.end();
  } catch {
    if (!aborted) res.end();
  } finally {
    res.off('close', onClose);
  }
}

function mediaServer() {
  return {
    name: 'mxf-media',
    configureServer(server: any) {
      // Runtime network-sim control: POST /__latency?ms=<n>&rate=<k|m|g> sets the live latency and
      // bandwidth applied to every subsequent /media read (so the demo's knobs take effect at once,
      // mid-playback); GET returns the current values. A blank/absent param clears that override to
      // null (→ fall back to the URL query params). rate accepts 0/blank = unlimited, or k/m/g suffixes.
      server.middlewares.use('/__latency', (req: any, res: any) => {
        const u = new URL(req.url ?? '/', 'http://x');
        if (req.method === 'POST') {
          const msRaw = u.searchParams.get('ms');
          const rateRaw = u.searchParams.get('rate');
          liveLatencyMs = msRaw == null || msRaw === '' ? null : Math.max(0, parseInt(msRaw, 10) || 0);
          liveBytesPerSec = rateRaw == null || rateRaw === '' ? null : parseRate(rateRaw);
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ latencyMs: liveLatencyMs, bytesPerSec: liveBytesPerSec }));
      });

      server.middlewares.use('/media', async (req: any, res: any, next: any) => {
        const u = new URL(req.url ?? '/', 'http://x');
        const rel = decodeURIComponent(u.pathname);
        const file = path.join(MEDIA_DIR, rel);
        // Containment guard: refuse paths that escape MEDIA_DIR (e.g. ../).
        if (!file.startsWith(MEDIA_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          return next();
        }
        const { size } = fs.statSync(file);
        // Live override (set via POST /__latency) wins; otherwise fall back to the URL query params.
        const latencyMs = liveLatencyMs ?? Math.max(0, parseInt(u.searchParams.get('latency') ?? '0', 10) || 0);
        const bytesPerSec = liveBytesPerSec ?? parseRate(u.searchParams.get('rate'));

        // Latency first: every request (the loader's HEAD, its 1-byte probe, every real read) pays
        // the RTT before any byte goes out — same ordering as range-server.mjs.
        if (latencyMs > 0) await delay(latencyMs);

        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', 'application/mxf');

        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Length': size });
          return res.end();
        }

        const range = req.headers.range as string | undefined;
        if (range) {
          const m = /bytes=(\d*)-(\d*)/.exec(range);
          const start = m && m[1] ? parseInt(m[1], 10) : 0;
          const end = m && m[2] ? parseInt(m[2], 10) : size - 1;
          if (start >= size || end >= size || start > end) {
            res.writeHead(416, { 'Content-Range': `bytes */${size}` });
            return res.end();
          }
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Content-Length': end - start + 1,
          });
          await pipeThrottled(fs.createReadStream(file, { start, end, highWaterMark: THROTTLE_CHUNK }), res, bytesPerSec);
        } else {
          res.writeHead(200, { 'Content-Length': size });
          await pipeThrottled(fs.createReadStream(file, { highWaterMark: THROTTLE_CHUNK }), res, bytesPerSec);
        }
      });
    },
  };
}

export default defineConfig({
  root: '.',
  publicDir: false,
  plugins: [mediaServer()],
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

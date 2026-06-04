/**
 * Standalone HTTP file server with real Range support, plus configurable artificial
 * network latency and bandwidth throttling — for testing/reproducing the player's
 * behaviour over a "corporate" (low-latency, high-bandwidth) vs "internet"
 * (higher-latency / capped-bandwidth) connection.
 *
 * Dependency-free (Node built-ins only). Two ways to use it:
 *
 *  1. As a CLI (manual testing / demo URL playback):
 *       node scripts/range-server.mjs --dir C:\temp\mxf.js --port 8000 --latency 50 --rate 100m
 *
 *  2. Imported from the E2E tests:
 *       import { startRangeServer } from '../../scripts/range-server.mjs';
 *       const srv = await startRangeServer({ dir, port: 0, latencyMs: 50, bytesPerSec: 0 });
 *       // ... srv.url ...
 *       await srv.close();
 *
 * The latency is applied once per request, BEFORE the response, so HEAD, the loader's
 * 1-byte range probe, and every real ranged read each pay the round-trip cost — which
 * mirrors the player's per-fetchRange HTTP cost (see src/loader/http-loader.ts).
 */

import http from 'node:http';
import fs from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = {
  '.mxf': 'application/mxf',
  '.mp4': 'video/mp4',
  '.json': 'application/json',
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const CHUNK = 64 * 1024; // read granularity
// Minimum sleep granule for the deadline pacer. setTimeout below ~1 ms is clamped by Node (and fires
// late under load), so pacing per 64 KB chunk would floor any rate at ~64 KB/1 ms ≈ 512 Mbit and tax
// every read — a 1G/10G rate could never simulate a fast line. We sleep only when ahead of schedule
// by at least this much, keeping low rates accurate and high rates near-transparent.
const PACE_MIN_MS = 4;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
}

/**
 * Stream a byte range from `filePath`, optionally paced to `bytesPerSec`.
 * `bytesPerSec === 0` → no throttle (plain pipe). Honours backpressure and bails if
 * the client aborts, so a superseded/cancelled read doesn't keep pacing a dead socket.
 */
async function streamRange(res, filePath, start, end, bytesPerSec) {
  const stream = fs.createReadStream(filePath, { start, end, highWaterMark: CHUNK });
  let aborted = false;
  const onClose = () => { aborted = true; stream.destroy(); };
  res.on('close', onClose);
  stream.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end(); });

  if (!bytesPerSec) {
    stream.pipe(res);
    return;
  }

  // Deadline-based pacing: track cumulative bytes against a wall-clock start and sleep only when
  // ahead of the ideal schedule by ≥PACE_MIN_MS. A per-chunk setTimeout(bytes/rate) would clamp to
  // Node's ~1 ms timer floor on every 64 KB, capping any rate at ~512 Mbit and taxing every read —
  // so high settings (1G/10G) behaved no faster than ~512 Mbit. This keeps low rates accurate and
  // high rates near-transparent.
  const t0 = performance.now();
  let sent = 0;
  try {
    for await (const chunk of stream) {
      if (aborted) return;
      if (!res.write(chunk)) {
        // backpressure: wait for the socket to drain (or the client to vanish) before continuing.
        // Remove BOTH listeners when either fires — otherwise the losing listener (usually 'close')
        // leaks one per backpressure cycle, tripping MaxListenersExceededWarning during a scrub.
        await new Promise((resolve) => {
          const done = () => { res.off('drain', done); res.off('close', done); resolve(undefined); };
          res.once('drain', done); res.once('close', done);
        });
        if (aborted) return;
      }
      sent += chunk.length;
      const ahead = (sent / bytesPerSec) * 1000 - (performance.now() - t0);
      if (ahead >= PACE_MIN_MS) await delay(ahead);
    }
    res.end();
  } catch {
    if (!aborted) res.end();
  } finally {
    res.off('close', onClose);
  }
}

function createHandler({ dir, latencyMs, bytesPerSec }, stats) {
  const root = path.resolve(dir);

  return async (req, res) => {
    try {
      // Count every request up front — each one is a network round-trip the client paid for.
      // This is the "bulkiness" signal: how many serialized round-trips an action costs.
      stats.requests++;
      if (req.method === 'GET' || req.method === 'HEAD') stats.reads++;

      // 1. Latency first — every request (HEAD, probe, real read) pays the RTT.
      if (latencyMs > 0) await delay(latencyMs);

      // 2. CORS + preflight.
      setCors(res);
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405); res.end(); return;
      }

      // 3. Resolve path and sandbox to the served directory.
      const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const filePath = path.resolve(path.join(root, pathname));
      if (filePath !== root && !filePath.startsWith(root + path.sep)) {
        res.writeHead(403); res.end('Forbidden'); return;
      }

      // 4. Stat.
      let st;
      try {
        st = await stat(filePath);
      } catch {
        res.writeHead(404); res.end('Not found'); return;
      }
      if (!st.isFile()) { res.writeHead(404); res.end('Not found'); return; }
      const size = st.size;

      // 5. Common headers.
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream');

      // 6. HEAD — size only.
      if (req.method === 'HEAD') {
        res.setHeader('Content-Length', size);
        res.writeHead(200); res.end(); return;
      }

      // 7. Range parse.
      const rangeHeader = req.headers['range'];
      if (!rangeHeader) {
        res.setHeader('Content-Length', size);
        res.writeHead(200);
        await streamRange(res, filePath, 0, size - 1, bytesPerSec);
        return;
      }

      const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
      if (!m) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return;
      }
      let start, end;
      if (m[1] === '') {
        // suffix range: bytes=-N  → last N bytes
        const n = parseInt(m[2], 10);
        start = Math.max(0, size - n);
        end = size - 1;
      } else {
        start = parseInt(m[1], 10);
        end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
      }
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return;
      }

      // 8. 206 Partial Content.
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', end - start + 1);
      res.writeHead(206);
      await streamRange(res, filePath, start, end, bytesPerSec);
    } catch (e) {
      // 9. Last-resort error handling.
      if (!res.headersSent) res.writeHead(500);
      res.end(String(e?.message ?? e));
    }
  };
}

/**
 * Start the range server.
 * @param {{dir: string, port?: number, latencyMs?: number, bytesPerSec?: number, host?: string}} opts
 * @returns {Promise<{url: string, port: number, dir: string, latencyMs: number, bytesPerSec: number, close: () => Promise<void>}>}
 */
export async function startRangeServer({ dir, port = 0, latencyMs = 0, bytesPerSec = 0, host = '127.0.0.1' } = {}) {
  if (!dir) throw new Error('startRangeServer: `dir` is required');
  const stats = { requests: 0, reads: 0 };
  const server = http.createServer(createHandler({ dir, latencyMs, bytesPerSec }, stats));
  server.on('clientError', (_e, socket) => { try { socket.destroy(); } catch { /* ignore */ } });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });

  const actualPort = server.address().port;
  return {
    url: `http://${host}:${actualPort}`,
    port: actualPort,
    dir,
    latencyMs,
    bytesPerSec,
    /** Live request counters since start (or last reset) — the "round-trips per action" signal. */
    stats: () => ({ ...stats }),
    resetStats: () => { stats.requests = 0; stats.reads = 0; },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Parse `100m`/`2g`/`500k` byte-rate suffixes into bytes/sec. Plain numbers pass through. */
export function parseRate(v) {
  if (v == null) return 0;
  const m = /^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i.exec(String(v).trim());
  if (!m) return parseInt(v, 10) || 0;
  const mult = { '': 1, k: 1e3, m: 1e6, g: 1e9 }[m[2].toLowerCase()];
  return Math.round(parseFloat(m[1]) * mult);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    let key = argv[i];
    if (!key.startsWith('--')) continue;
    key = key.slice(2);
    let val;
    const eq = key.indexOf('=');
    if (eq >= 0) {
      val = key.slice(eq + 1);
      key = key.slice(0, eq);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      val = argv[++i];
    } else {
      val = true; // bare flag
    }
    out[key] = val;
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = parseArgs(process.argv.slice(2));
  const opts = {
    dir: args.dir ?? 'C:\\temp\\mxf.js',
    port: args.port ? parseInt(args.port, 10) : 8000,
    latencyMs: args.latency ? parseInt(args.latency, 10) : 0,
    bytesPerSec: parseRate(args.rate),
    host: args.host ?? '0.0.0.0',
  };
  startRangeServer(opts).then((srv) => {
    const rate = srv.bytesPerSec ? `${(srv.bytesPerSec / 1e6).toFixed(1)} MB/s` : 'unlimited';
    console.log(`range-server: serving ${path.resolve(opts.dir)}`);
    console.log(`  → ${srv.url}  (latency ${srv.latencyMs}ms, bandwidth ${rate})`);
    console.log('  Ctrl+C to stop.');
    const shutdown = () => { srv.close().then(() => process.exit(0)); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }).catch((e) => {
    console.error('range-server failed to start:', e.message);
    process.exit(1);
  });
}

#!/usr/bin/env node
// ---------------------------------------------------------------------------
// live-download-verify.mjs
//
// Standalone Node harness that downloads the live recorder's GROWING .mxf files
// the same way the player's worker does — HTTP `Range` reads against a file that
// is still being written, size polled via HEAD — but OUTSIDE the browser, with
// no decode/transcode/MSE in the loop. The only thing under test is the byte
// pipeline: nginx range-serving a growing file.
//
// For every rotated segment it writes the reconstructed file to OUT_DIR and, once
// the recorder has closed it (a contiguous successor appears), MD5-compares the
// downloaded copy against the original on disk (the nginx /media/ source). A
// mismatch means the live download dropped / duplicated / corrupted bytes; a match
// means the download path is faithful and any glitching is downstream (decode /
// edge-riding), per debug_start_time.md.
//
// Mirrors production:
//   - size via HEAD Content-Length, cache: 'no-store'      (http-loader.ts refreshFileSize)
//   - bytes via `Range: bytes=start-end`, expects 206       (http-loader.ts fetchRange)
//   - file list + contiguous-successor rotation             (mxf_test.html liveEdgePoll)
// Differs deliberately: anchors each file at byte 0 (not the live edge) so the
// finished artifact is the WHOLE file and the MD5 check is meaningful.
//
// Usage:
//   node scripts/live-download-verify.mjs
//   MXF_CH=1 MXF_POLL_MS=500 MXF_CHUNK=4194304 node scripts/live-download-verify.mjs
//
// Env knobs (all optional):
//   MXF_BASE        base URL                  (default http://localhost:7070)
//   MXF_CH          channel number            (default 1)
//   MXF_MEDIA_ROOT  disk root for /media/     (default C:/temp/recordings/media.dir)
//   MXF_OUT_DIR     where to save downloads   (default C:/temp/debuglive)
//   MXF_CHUNK       range read size in bytes  (default 4 MiB)
//   MXF_POLL_MS     growth/list poll interval (default 500 ms)
//   MXF_STABLE      polls a file's size must hold, after a successor appears,
//                   before it's declared final and MD5-checked (default 2)
//   MXF_LIVE_ONLY   1 = ignore the backlog; only download the currently-growing
//                   file (and its successors as they rotate). Pair with a small
//                   MXF_CHUNK + MXF_POLL_MS to stress the write frontier.
//
// Stress the growing-file frontier with tiny rapid reads:
//   MXF_LIVE_ONLY=1 MXF_CHUNK=16384 MXF_POLL_MS=25 node scripts/live-download-verify.mjs
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { createWriteStream, createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const BASE       = process.env.MXF_BASE       || 'http://localhost:7070';
const CH         = String(process.env.MXF_CH  || '1');
const MEDIA_ROOT = (process.env.MXF_MEDIA_ROOT || 'C:/temp/recordings/media.dir').replace(/\\/g, '/');
const OUT_DIR    = (process.env.MXF_OUT_DIR    || 'C:/temp/debuglive').replace(/\\/g, '/');
const CHUNK      = Number(process.env.MXF_CHUNK  || 4 * 1024 * 1024);
const POLL_MS    = Number(process.env.MXF_POLL_MS || 500);
const STABLE     = Number(process.env.MXF_STABLE  || 2);
// Live-only: ignore the on-disk backlog and follow ONLY the currently-growing file
// (anchor on the newest at startup; advance to each successor as it appears). Use with
// a tiny MXF_CHUNK + small MXF_POLL_MS to hammer the write frontier with rapid reads.
const LIVE_ONLY  = process.env.MXF_LIVE_ONLY === '1';

const MB = (n) => (n / 1048576).toFixed(2) + ' MB';
const now = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(now(), ...a);
const warn = (...a) => console.warn(now(), 'WARN', ...a);
const err = (...a) => console.error(now(), 'ERROR', ...a);

let totals = { files: 0, ok: 0, mismatch: 0, error: 0 };

// --- HTTP, mirroring http-loader.ts -----------------------------------------

const abs = (urlPath) => (urlPath.startsWith('http') ? urlPath : BASE + urlPath);

// Current size of a (possibly growing) file. HEAD + Content-Length, no-store so a
// stale cached size never hides freshly-written bytes (http-loader.ts:80).
async function headSize(urlPath) {
  const res = await fetch(abs(urlPath), { method: 'HEAD', cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } });
  if (!res.ok) throw new Error(`HEAD ${urlPath} → ${res.status} ${res.statusText}`);
  const len = res.headers.get('content-length');
  if (!len) throw new Error(`HEAD ${urlPath} → no Content-Length`);
  return parseInt(len, 10);
}

// One range read: bytes=start-end inclusive, must be 206 (http-loader.ts:91).
async function fetchRange(urlPath, start, end) {
  const res = await fetch(abs(urlPath), {
    headers: { Range: `bytes=${start}-${end}`, 'Cache-Control': 'no-cache' },
    cache: 'no-store',
  });
  if (res.status === 200) throw new Error(`${urlPath}: server ignored Range (200, not 206) — not range-capable`);
  if (res.status !== 206) throw new Error(`Range ${start}-${end} on ${urlPath} → ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
}

async function liveFiles() {
  const res = await fetch(`${BASE}/api/live-files/${CH}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`/api/live-files/${CH} → ${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.files || [];
}

// --- disk mapping + hashing -------------------------------------------------

// /media/CH01/ARCHIVE/foo.mxf → C:/temp/recordings/media.dir/CH01/ARCHIVE/foo.mxf
function diskPath(urlPath) {
  const m = urlPath.match(/\/media\/(.*)$/);
  if (!m) throw new Error(`cannot map URL to disk (no /media/ prefix): ${urlPath}`);
  return path.posix.join(MEDIA_ROOT, m[1]);
}

function md5File(filePath) {
  return new Promise((resolve, reject) => {
    const h = createHash('md5');
    createReadStream(filePath)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

// Full byte diff between two files. Returns total differing bytes, the differing
// offsets coalesced into contiguous [start,end] runs (capped), and a hex sample of
// the first few. Lets us tell a benign MXF finalization (a couple of partition-status
// bytes flipped open→closed) apart from real essence corruption (many scattered diffs).
// Only called on a confirmed MD5 mismatch, so reading both fully is acceptable.
async function diffReport(a, b, maxRuns = 12, maxSamples = 8) {
  const [ba, bb] = await Promise.all([fs.readFile(a), fs.readFile(b)]);
  const n = Math.min(ba.length, bb.length);
  let count = 0;
  const runs = [];   // [start, end] inclusive contiguous differing ranges
  const samples = []; // {off, a, b}
  let runStart = -1;
  for (let i = 0; i < n; i++) {
    if (ba[i] !== bb[i]) {
      count++;
      if (samples.length < maxSamples) samples.push({ off: i, a: ba[i], b: bb[i] });
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      if (runs.length < maxRuns) runs.push([runStart, i - 1]);
      runStart = -1;
    }
  }
  if (runStart >= 0 && runs.length < maxRuns) runs.push([runStart, n - 1]);
  // last differing offset (independent of the run cap) so we can see how far diffs reach
  let lastOffset = -1;
  for (let i = n - 1; i >= 0; i--) if (ba[i] !== bb[i]) { lastOffset = i; break; }
  // length difference counts as trailing diff
  const lenDiff = Math.abs(ba.length - bb.length);
  return { count, runs, samples, lastOffset, lenDiff, runsCapped: runs.length >= maxRuns };
}

const hex = (v) => v.toString(16).padStart(2, '0');

// --- per-file download state ------------------------------------------------

/** @type {Map<string, {url:string, name:string, cursor:number, stream:import('fs').WriteStream, localPath:string}>} */
const dl = new Map();

function writeChunk(stream, buf) {
  return new Promise((resolve, reject) => {
    stream.write(buf, (e) => (e ? reject(e) : resolve()));
  });
}

function closeStream(stream) {
  return new Promise((resolve) => stream.end(resolve));
}

function startDownload(url) {
  const name = url.split('/').pop();
  const localPath = path.posix.join(OUT_DIR, name);
  const stream = createWriteStream(localPath);
  dl.set(url, { url, name, cursor: 0, stream, localPath });
  log(`▶ download start  ${name}  → ${localPath}`);
}

// Drain everything currently available (cursor → live size) in CHUNK-sized reads.
async function drain(state) {
  const size = await headSize(state.url);
  while (state.cursor < size) {
    const start = state.cursor;
    const end = Math.min(start + CHUNK, size) - 1; // inclusive
    const buf = await fetchRange(state.url, start, end);
    if (buf.length === 0) break; // nothing returned — try again next poll
    if (state.cursor + buf.length > size) {
      // grew between HEAD and GET; that's fine, just account for what we got
    }
    await writeChunk(state.stream, buf);
    state.cursor += buf.length;
  }
  return size;
}

// File has a successor → recorder closed it. Final drain, close, MD5 vs disk source.
async function finalize(state) {
  // Re-HEAD + drain once more: the recorder may have flushed a final tail between the
  // last poll and the moment the successor appeared.
  await drain(state);
  await closeStream(state.stream);
  totals.files++;

  const src = diskPath(state.url);
  let srcSize = -1;
  try {
    srcSize = (await fs.stat(src)).size;
  } catch (e) {
    err(`✗ ${state.name}: source not on disk (${src}): ${e.message}`);
    totals.error++;
    return;
  }

  const sizeNote = state.cursor === srcSize
    ? `size ok (${MB(srcSize)})`
    : `SIZE MISMATCH downloaded=${state.cursor} (${MB(state.cursor)}) disk=${srcSize} (${MB(srcSize)})`;

  const [dlMd5, srcMd5] = await Promise.all([md5File(state.localPath), md5File(src)]);

  if (dlMd5 === srcMd5) {
    totals.ok++;
    log(`✓ ${state.name}  MD5 match  ${dlMd5}  ${sizeNote}`);
  } else {
    totals.mismatch++;
    const d = await diffReport(state.localPath, src);
    err(`✗ ${state.name}  MD5 MISMATCH`);
    err(`    downloaded ${dlMd5}  (${state.localPath})`);
    err(`    disk       ${srcMd5}  (${src})`);
    err(`    ${sizeNote}`);
    err(`    differing bytes: ${d.count}${d.lenDiff ? ` (+${d.lenDiff} length diff)` : ''} in ${d.runs.length}${d.runsCapped ? '+' : ''} run(s); last diff @ ${d.lastOffset} (${MB(d.lastOffset)})`);
    for (const [s, e] of d.runs) err(`      run @ ${s}..${e} (${e - s + 1} byte${e > s ? 's' : ''})`);
    for (const { off, a, b } of d.samples) err(`      @${off}: downloaded=0x${hex(a)} disk=0x${hex(b)}`);
  }
}

// --- main loop --------------------------------------------------------------

// Ordered list of every file we've ever seen, so a file that scrolls out of the
// /api/live-files window after we started it can still be finished (URL stays
// valid on disk via nginx /media/). A file is "complete" once a later file exists.
const seen = []; // url[] in discovery order
const seenSet = new Set();
let queueHead = 0; // index in `seen` of the file we're currently downloading
let anchored = false; // LIVE_ONLY: have we skipped the backlog yet?

async function tick() {
  let files;
  try {
    files = await liveFiles();
  } catch (e) {
    warn(`live-files poll failed: ${e.message}`);
    return;
  }
  for (const f of files) {
    if (!seenSet.has(f)) {
      seenSet.add(f);
      seen.push(f);
      if (!LIVE_ONLY || !anchored) log(`· discovered ${f.split('/').pop()}  (seen=${seen.length})`);
    }
  }

  // LIVE_ONLY: jump the queue to the newest (still-growing) file once, skipping every
  // file that already existed at startup. Thereafter the queue advances one-per-rotation,
  // so we only ever download files we caught while they were growing.
  if (LIVE_ONLY && !anchored && seen.length > 0) {
    queueHead = seen.length - 1;
    anchored = true;
    log(`· LIVE_ONLY: skipped ${queueHead} backlog file(s); anchoring on growing file ${seen[queueHead].split('/').pop()}`);
  }

  // Process the queue: download head file; if it has a successor, finalize and advance.
  // Loop so we can catch up through several already-complete files in one tick.
  while (queueHead < seen.length) {
    const url = seen[queueHead];
    if (!dl.has(url)) startDownload(url);
    const state = dl.get(url);

    const hasSuccessor = queueHead < seen.length - 1;

    try {
      const size = await drain(state);
      if (!hasSuccessor) {
        // This is the live (newest) file, still growing — leave it open, wait next poll.
        if (state.cursor < size) continue; // (shouldn't happen: drain emptied it)
        break;
      }
      // Successor exists → finalize this one and move on.
      await finalize(state);
      dl.delete(url);
      queueHead++;
    } catch (e) {
      err(`download of ${state.name} failed: ${e.message}`);
      totals.error++;
      try { await closeStream(state.stream); } catch { /* ignore */ }
      dl.delete(url);
      queueHead++; // skip the broken one rather than wedge the queue
      if (!hasSuccessor) break;
    }
  }
}

let stopping = false;
async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  log(`live-download-verify`);
  log(`  base=${BASE} ch=${CH}`);
  log(`  media-root=${MEDIA_ROOT}`);
  log(`  out-dir=${OUT_DIR}`);
  log(`  chunk=${CHUNK} bytes (${MB(CHUNK)}) poll=${POLL_MS}ms live-only=${LIVE_ONLY}`);
  log(`  (anchors each file at byte 0 — full-file reconstruction for MD5)`);

  process.on('SIGINT', () => {
    if (stopping) process.exit(1);
    stopping = true;
    log('— SIGINT: finishing current tick, then summary —');
  });

  while (!stopping) {
    await tick();
    if (stopping) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  log(`— summary —  files=${totals.files}  match=${totals.ok}  mismatch=${totals.mismatch}  errors=${totals.error}`);
  process.exit(totals.mismatch > 0 || totals.error > 0 ? 1 : 0);
}

main().catch((e) => { err(e.stack || e.message); process.exit(2); });

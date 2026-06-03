/**
 * E2E: player behaviour under simulated network latency for URL sources.
 *
 * Reproduces/regression-guards the "bulky over a corporate 10G connection" symptom by serving the
 * MXF through a real Range-capable HTTP server (scripts/range-server.mjs) with injected per-request
 * latency + bandwidth throttling, and measuring how the player reacts at two network profiles:
 *   - corporate: ~1 ms RTT, unlimited bandwidth
 *   - internet:  ~50 ms RTT (+ optional bandwidth cap)
 *
 * The headline "bulkiness" signal is the number of HTTP ROUND-TRIPS each action costs, counted at
 * the server (latency-independent, so it isolates serialized-read behaviour from raw RTT). Load time
 * legitimately scales with latency × round-trips, so we don't bar it on a tight ratio; instead we
 * bound the round-trip COUNT (a regression that adds serial reads trips it at any latency) plus a
 * generous absolute time ceiling.
 *
 * Pass/fail model (confirmed with the user — "~10% noise must not fail, a big discrepancy must"):
 *   - tight ~10% FRAME-COUNT band on steady playback (should stay near fps regardless of RTT),
 *   - round-trip-count ceiling for load (the bulkiness guard),
 *   - relative guard on play-to-first-frame (playback startup shouldn't need many serial reads),
 *   - scrub must never wedge and its throughput must not collapse.
 * The per-profile metrics table is always logged — it is the real, durable output.
 *
 * Defaults to C:/temp/mxf.js/vistek.mxf. Skips gracefully if absent. Override via env (see below).
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { startRangeServer } from '../../scripts/range-server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const PORT = 5198; // distinct from player.test.ts's 5199 so both can run together

// --- env-configurable knobs ---
const FILE_DIR = process.env.MXF_SERVE_DIR ?? 'C:/temp/mxf.js';
const URL_FILE = process.env.TEST_URL_MXF ?? 'vistek.mxf';
const LOW_MS = Number(process.env.MXF_LAT_LOW ?? 1);
const HIGH_MS = Number(process.env.MXF_LAT_HIGH ?? 50);
const RATE_HIGH = Number(process.env.MXF_RATE_HIGH ?? 0); // bytes/sec for the internet profile (0 = unlimited)
const REPEATS = Number(process.env.MXF_LAT_REPEATS ?? 3);
const PLAY_TOL = Number(process.env.MXF_PLAY_TOL ?? 2.0);
const SCRUB_TOL = Number(process.env.MXF_SCRUB_TOL ?? 2.5);
const FRAME_BAND = Number(process.env.MXF_FRAME_BAND ?? 0.9);
const ABS_FLOOR_MS = Number(process.env.MXF_ABS_FLOOR_MS ?? 300);
const LOAD_MAX_MS = Number(process.env.MXF_LOAD_MAX_MS ?? 15_000);
// Generous ceiling on round-trips-to-manifest. Current vistek.mxf bootstrap is ~40; a regression
// that explodes the serialized-read count (the "bulky" symptom) trips this. Logged either way.
const LOAD_READS_MAX = Number(process.env.MXF_LOAD_READS_MAX ?? 80);

const FILE_PATH = path.join(FILE_DIR, URL_FILE);

let vite: ViteDevServer;
let browser: Browser;
let lowSrv: Awaited<ReturnType<typeof startRangeServer>> | undefined;
let highSrv: Awaited<ReturnType<typeof startRangeServer>> | undefined;

beforeAll(async () => {
  if (!fs.existsSync(FILE_PATH)) return; // skip-guard handled per test
  vite = await createServer({
    root: projectRoot,
    logLevel: 'silent',
    server: { port: PORT, headers: {} },
    worker: { format: 'es' },
  });
  await vite.listen();

  browser = await puppeteer.launch({
    headless: false,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-features=WebCodecs'],
  });

  lowSrv = await startRangeServer({ dir: FILE_DIR, port: 0, latencyMs: LOW_MS, bytesPerSec: 0 });
  highSrv = await startRangeServer({ dir: FILE_DIR, port: 0, latencyMs: HIGH_MS, bytesPerSec: RATE_HIGH });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await vite?.close();
  await lowSrv?.close();
  await highSrv?.close();
});

interface ScenarioResult {
  error?: string;
  indexMode?: string;
  longGop?: boolean;
  loadToManifestMs: number;
  loadReads: number;          // server round-trips between loadUrl and manifest (the bulkiness signal)
  actionReads: number;        // server round-trips during play+scrub (prefetch + previews)
  playToFirstFrameMs: number;
  framesIn1sAfterStart: number;
  scrubPresentedFrames: number;
  scrubDistinctShown: number;
  scrubSettleMs: number;
  finalTime: number;
  releaseT: number;
}

type Srv = NonNullable<typeof lowSrv>;

/** Phase 1: set up the frame counter, load the URL, and wait for the manifest event. */
async function loadPhase(page: Page, fileUrl: string) {
  return page.evaluate(async (url) => {
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    const now = () => performance.now();
    const w = window as any;
    w.__perf = { presented: 0, shown: new Set<string>(), running: true };
    const video = document.getElementById('video') as HTMLVideoElement;
    const rvfc = (video as any).requestVideoFrameCallback?.bind(video);
    if (rvfc) {
      const onF = (_n: number, md: { mediaTime: number }) => {
        w.__perf.presented++;
        if (md && typeof md.mediaTime === 'number') w.__perf.shown.add(md.mediaTime.toFixed(2));
        if (w.__perf.running) rvfc(onF);
      };
      rvfc(onF);
    }
    const events = () => (w.__mxfEvents ?? []) as Array<{ name: string; t: number; detail: any }>;
    const lastEvent = (name: string) => [...events()].reverse().find(e => e.name === name);

    const tClick = now();
    (document.getElementById('urlInput') as HTMLInputElement).value = url;
    (document.getElementById('loadUrl') as HTMLButtonElement).click();

    let manifest: any;
    const t0 = now();
    for (;;) {
      manifest = lastEvent('manifest');
      if (manifest) break;
      if (now() - t0 > 30_000) return { error: 'manifest-timeout' };
      await sleep(20);
    }
    return {
      loadToManifestMs: manifest.t - tClick,
      indexMode: manifest.detail?.indexMode,
      longGop: manifest.detail?.longGop,
    };
  }, fileUrl);
}

/** Phase 2: play (time to first frame + steady-state frame count), then scrub sweep + settle. */
async function actionPhase(page: Page, scrubWindowMs: number) {
  return page.evaluate(async (windowMs) => {
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    const now = () => performance.now();
    const w = window as any;
    const P = w.__perf;
    const player = w.__mxfPlayer;
    const video = document.getElementById('video') as HTMLVideoElement;
    const lastEvent = (name: string) =>
      [...((w.__mxfEvents ?? []) as Array<{ name: string; t: number; detail: any }>)].reverse().find(e => e.name === name);

    // PLAY: time to first painted frame, then steady-state frames over 1 s.
    const presentedAtPlay = P.presented;
    const tPlay = now();
    player.play();
    const tp0 = now();
    while (P.presented <= presentedAtPlay && now() - tp0 < 15_000) await sleep(16);
    const playToFirstFrameMs = now() - tPlay;
    const presentedAfterFirst = P.presented;
    await sleep(1_000);
    const framesIn1sAfterStart = P.presented - presentedAfterFirst;

    // SCRUB: ping-pong sweep across the timeline, count frames presented during the window.
    const dur = Math.max(1, player.duration || video.duration || 1);
    const presentedScrubStart = P.presented;
    const shownScrubStart = P.shown.size;
    player.beginScrub();
    const t0 = now();
    let last = t0, pos = 0, dir = 1;
    const cps = dur / 6;
    while (now() - t0 < windowMs) {
      const t = now();
      const dt = (t - last) / 1000; last = t;
      pos += dir * cps * dt;
      if (pos >= dur) { pos = dur; dir = -1; }
      if (pos <= 0) { pos = 0; dir = 1; }
      player.scrubTo(pos);
      await sleep(16);
    }
    const scrubPresentedFrames = P.presented - presentedScrubStart;
    const scrubDistinctShown = P.shown.size - shownScrubStart;

    // Release at the middle and time the accurate settle.
    const releaseT = dur * 0.5;
    const tRelease = now();
    player.endScrub(releaseT);
    const ts0 = now();
    for (;;) {
      const tu = lastEvent('timeupdate');
      if (tu && Math.abs((tu.detail?.currentTime ?? -1) - releaseT) < 0.5) break;
      if (now() - ts0 > 8_000) break;
      await sleep(20);
    }
    const scrubSettleMs = now() - tRelease;
    P.running = false;

    return {
      playToFirstFrameMs, framesIn1sAfterStart, scrubPresentedFrames, scrubDistinctShown,
      scrubSettleMs, finalTime: video.currentTime, releaseT,
    };
  }, scrubWindowMs);
}

/** Drive one full load→play→scrub cycle on a fresh page, snapshotting server round-trips per phase. */
async function runScenario(srv: Srv): Promise<ScenarioResult> {
  const page = await browser.newPage();
  const logs: string[] = [];
  page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
  const empty: ScenarioResult = {
    loadToManifestMs: -1, loadReads: -1, actionReads: -1, playToFirstFrameMs: -1,
    framesIn1sAfterStart: 0, scrubPresentedFrames: 0, scrubDistinctShown: 0,
    scrubSettleMs: -1, finalTime: 0, releaseT: 0,
  };
  try {
    await page.goto(`http://localhost:${PORT}/demo/index.html?e2e=1`, { waitUntil: 'networkidle0' });

    const reads0 = srv.stats().reads;
    const load = await loadPhase(page, `${srv.url}/${URL_FILE}`);
    if ('error' in load) return { ...empty, error: load.error };
    const loadReads = srv.stats().reads - reads0;

    const reads1 = srv.stats().reads;
    const action = await actionPhase(page, 3_000);
    const actionReads = srv.stats().reads - reads1;

    const fatal = logs.filter(l => /FATAL|pageerror/.test(l));
    return {
      ...empty, ...load, ...action, loadReads, actionReads,
      error: fatal.length ? fatal.join(' | ') : undefined,
    };
  } finally {
    await page.close();
  }
}

const median = (xs: number[]): number => {
  const s = xs.filter(v => typeof v === 'number' && v >= 0).sort((a, b) => a - b);
  const n = s.length;
  return n === 0 ? NaN : n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

/** Run the scenario REPEATS times against a profile and reduce each metric to its median. */
async function profile(srv: Srv): Promise<ScenarioResult & { runs: ScenarioResult[] }> {
  const runs: ScenarioResult[] = [];
  for (let i = 0; i < REPEATS; i++) runs.push(await runScenario(srv));
  const errored = runs.filter(r => r.error);
  const pick = (k: keyof ScenarioResult) => median(runs.map(r => r[k] as number));
  return {
    runs,
    error: errored.length ? errored.map(r => r.error).join(' || ') : undefined,
    indexMode: runs.find(r => r.indexMode)?.indexMode,
    longGop: runs.find(r => r.longGop !== undefined)?.longGop,
    loadToManifestMs: pick('loadToManifestMs'),
    loadReads: pick('loadReads'),
    actionReads: pick('actionReads'),
    playToFirstFrameMs: pick('playToFirstFrameMs'),
    framesIn1sAfterStart: pick('framesIn1sAfterStart'),
    scrubPresentedFrames: pick('scrubPresentedFrames'),
    scrubDistinctShown: pick('scrubDistinctShown'),
    scrubSettleMs: pick('scrubSettleMs'),
    finalTime: pick('finalTime'),
    releaseT: runs[0]?.releaseT ?? 0,
  };
}

describe('URL playback under network latency', () => {
  test('corporate (1ms) vs internet (50ms): reaction times, round-trips + frames displayed', async () => {
    if (!fs.existsSync(FILE_PATH)) {
      console.log(`skip latency test — file not found: ${FILE_PATH}`);
      return;
    }

    const low = await profile(lowSrv!);
    const high = await profile(highSrv!);

    const row = (label: string, p: ScenarioResult) => ({
      profile: label,
      loadMs: Math.round(p.loadToManifestMs),
      loadReads: p.loadReads,
      playFirstFrameMs: Math.round(p.playToFirstFrameMs),
      framesIn1s: p.framesIn1sAfterStart,
      actionReads: p.actionReads,
      scrubShown: p.scrubPresentedFrames,
      scrubDistinct: p.scrubDistinctShown,
      scrubSettleMs: Math.round(p.scrubSettleMs),
    });
    console.log('\n=== URL latency metrics (median of ' + REPEATS + ') ===');
    console.log('file:', URL_FILE, '| indexMode:', low.indexMode, '| longGop:', low.longGop);
    console.table([row(`corporate(${LOW_MS}ms)`, low), row(`internet(${HIGH_MS}ms)`, high)]);

    // Hard failures: a profile that never produced a manifest / frame is a real bug, not slowness.
    expect(low.error, `corporate profile errored: ${low.error}`).toBeUndefined();
    expect(high.error, `internet profile errored: ${high.error}`).toBeUndefined();

    // 1) BULKINESS: round-trips-to-manifest. Latency-independent, so it isolates serialized reads.
    //    Counts should match across profiles; a ceiling guards against a serial-read explosion.
    expect(high.loadReads, `load round-trips exploded (bulky bootstrap): ${high.loadReads}`).toBeLessThan(LOAD_READS_MAX);
    expect(
      Math.abs(high.loadReads - low.loadReads),
      `round-trip count is latency-dependent (retries?): low=${low.loadReads} high=${high.loadReads}`,
    ).toBeLessThanOrEqual(Math.max(2, low.loadReads * 0.15));

    // 2) Generous absolute load ceiling — gross-failure guard, machine-independent enough at 15 s.
    expect(high.loadToManifestMs, `load far too slow at ${HIGH_MS}ms: ${high.loadToManifestMs}`).toBeLessThan(LOAD_MAX_MS);

    // 3) Play-to-first-frame: relative guard. Playback startup should not be dominated by serial reads.
    expect(
      high.playToFirstFrameMs,
      `play-to-first-frame blew up: low=${low.playToFirstFrameMs} high=${high.playToFirstFrameMs}`,
    ).toBeLessThan(low.playToFirstFrameMs * PLAY_TOL + ABS_FLOOR_MS);

    // 4) FRAME BAND (~10% tolerance): steady playback should present near the same number of frames
    //    regardless of latency — the metric where a tight tolerance is meaningful.
    expect(
      high.framesIn1sAfterStart,
      `steady playback dropped frames under latency: low=${low.framesIn1sAfterStart} high=${high.framesIn1sAfterStart}`,
    ).toBeGreaterThan(low.framesIn1sAfterStart * FRAME_BAND);

    // 5) Scrub: never wedge; high profile keeps moving and relative throughput stays sane.
    if (low.indexMode !== 'none') {
      expect(high.scrubPresentedFrames, `scrub showed nothing at ${HIGH_MS}ms`).toBeGreaterThanOrEqual(1);
      expect(high.scrubDistinctShown, `scrub wedged on one frame at ${HIGH_MS}ms`).toBeGreaterThan(1);
      expect(
        low.scrubPresentedFrames / Math.max(1, high.scrubPresentedFrames),
        `scrub throughput collapsed under latency: low=${low.scrubPresentedFrames} high=${high.scrubPresentedFrames}`,
      ).toBeLessThan(SCRUB_TOL);
    }

    // Settle must converge on the released position.
    expect(Math.abs(high.finalTime - high.releaseT), `internet endScrub did not settle`).toBeLessThan(3);
  }, 180_000);
});

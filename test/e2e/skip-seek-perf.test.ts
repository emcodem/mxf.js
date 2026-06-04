/**
 * E2E: skip-seek + play RESPONSE-TIME characterization.
 *
 * Captures the behaviour and timings of the exact user gesture we want to optimize later:
 *
 *     skip +10s × 3  →  play          (jump forward ~30s, then watch)
 *     skip −10s × 2  →  play          (jump back ~20s, then watch)
 *
 * Driven through the REAL demo keyboard transport (ArrowUp/ArrowDown = ±10s, Space = play/pause),
 * so it exercises the shipped player.seek()/play() path end-to-end. For each phase it records:
 *   - per-press dispatch times and the resulting target time,
 *   - every 'seeked' event the element fired during the batch (shows how rapid skips coalesce),
 *   - responseToLastSkipMs — last skip keypress → first frame actually PAINTED at the new position
 *     (requestVideoFrameCallback), i.e. how long the picture takes to catch up to the jump,
 *   - playToFirstFrameMs — Space(play) → first painted frame, and frames presented in the next 1s.
 *
 * This is a CHARACTERIZATION test: the per-phase metrics table is the durable output. Assertions are
 * deliberately loose (no wedge, picture eventually catches up, play eventually paints) so the numbers
 * can be tracked/optimized without the test going red on normal machine-to-machine variance.
 *
 * Defaults to the MPEG-2 long-GOP file (xdcam_vistek.mxf) — the per-keyframe-transcode seek path is
 * the slow case worth measuring. Override with TEST_SKIP_FILE. Skips gracefully if absent.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const PORT = 5197; // distinct from latency(5198) / player(5199) so all three can run together

// MPEG-2 long-GOP by default: the per-keyframe transcode seek is the path worth optimizing.
const SKIP_FILE = process.env.TEST_SKIP_FILE ?? 'C:/temp/mxf.js/xdcam_vistek.mxf';
// Cadence between successive skip keypresses (ms). A real user taps the arrow key a few times in
// quick succession; 120 ms ≈ a brisk repeated tap. Override to 0 to model a key-repeat burst.
const PRESS_GAP_MS = Number(process.env.MXF_SKIP_GAP_MS ?? 120);

let vite: ViteDevServer;
let browser: Browser;

beforeAll(async () => {
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
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await vite?.close();
});

interface PhaseMetrics {
  presses: number;
  targetTime: number;            // video.currentTime after the final skip in the batch
  seekedEvents: number;          // 'seeked' events fired during the batch (rapid skips coalesce)
  seekedTimes: number[];         // currentTime at each 'seeked' (shows where the element settled)
  responseToLastSkipMs: number;  // last skip keypress → first painted frame at the new position
  playToFirstFrameMs: number;    // Space(play) → first painted frame
  framesIn1sAfterPlay: number;   // steady-state frames presented in the 1s after play started
}

/** Install a frame-paint counter (requestVideoFrameCallback) + a 'seeked' log on window.__skip. */
async function installProbes(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    const video = document.getElementById('video') as HTMLVideoElement;
    w.__skip = { frames: [] as Array<{ t: number; mediaTime: number }>, seeks: [] as Array<{ t: number; ct: number }>, running: true };
    video.addEventListener('seeked', () => w.__skip.seeks.push({ t: performance.now(), ct: video.currentTime }));
    const rvfc = (video as any).requestVideoFrameCallback?.bind(video);
    if (rvfc) {
      const onF = (_n: number, md: { mediaTime: number }) => {
        w.__skip.frames.push({ t: performance.now(), mediaTime: md?.mediaTime ?? -1 });
        if (w.__skip.running) rvfc(onF);
      };
      rvfc(onF);
    }
  });
}

/**
 * Run one phase: ensure paused, fire `presses` skip keypresses (`key`), measure how long the picture
 * takes to catch up to the final position, then press Space to play and measure play-to-first-frame.
 */
async function runPhase(page: Page, key: 'ArrowUp' | 'ArrowDown', presses: number, gapMs: number): Promise<PhaseMetrics> {
  return page.evaluate(async (key, presses, gapMs) => {
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    const now = () => performance.now();
    const w = window as any;
    const S = w.__skip;
    const player = w.__mxfPlayer;
    const video = document.getElementById('video') as HTMLVideoElement;

    // Harness setup (NOT a measured action): land in a known paused state so the Space below reliably
    // PLAYS (Space is a toggle). This pause is between phases, not part of the gesture under test.
    if (!video.paused) player.pause();
    await sleep(150);

    const framesBase = S.frames.length;
    const seeksBase = S.seeks.length;

    // --- the skip batch: dispatch real ArrowUp/ArrowDown keydowns at the demo's document handler ---
    let lastPressT = 0;
    for (let i = 0; i < presses; i++) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      lastPressT = now();
      if (i < presses - 1) await sleep(gapMs);
    }
    const targetTime = video.currentTime;

    // Picture catch-up: first frame PAINTED after the last keypress (the perceived response).
    let responseToLastSkipMs = -1;
    const r0 = now();
    while (now() - r0 < 8_000) {
      const f = S.frames.slice(framesBase).find((x: { t: number }) => x.t >= lastPressT);
      if (f) { responseToLastSkipMs = f.t - lastPressT; break; }
      await sleep(8);
    }

    const seekedSlice = S.seeks.slice(seeksBase);

    // --- then play: Space toggles a paused element into play ---
    const framesBeforePlay = S.frames.length;
    const tPlay = now();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    let playToFirstFrameMs = -1;
    const p0 = now();
    while (now() - p0 < 10_000) {
      if (S.frames.length > framesBeforePlay) { playToFirstFrameMs = S.frames[framesBeforePlay].t - tPlay; break; }
      await sleep(8);
    }
    const framesAfterFirst = S.frames.length;
    await sleep(1_000);
    const framesIn1sAfterPlay = S.frames.length - framesAfterFirst;

    return {
      presses,
      targetTime,
      seekedEvents: seekedSlice.length,
      seekedTimes: seekedSlice.map((s: { ct: number }) => +s.ct.toFixed(2)),
      responseToLastSkipMs,
      playToFirstFrameMs,
      framesIn1sAfterPlay,
    } as PhaseMetrics;
  }, key, presses, gapMs);
}

describe('skip-seek + play response times', () => {
  test('skip +10s×3 → play, then skip −10s×2 → play (characterization)', async () => {
    if (!fs.existsSync(SKIP_FILE)) {
      console.log(`skip skip-seek test — file not found: ${SKIP_FILE} (set TEST_SKIP_FILE)`);
      return;
    }

    const page = await browser.newPage();
    const logs: string[] = [];
    page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));

    try {
      await page.goto(`http://localhost:${PORT}/demo/index.html?e2e=1`, { waitUntil: 'networkidle0' });

      const input = await page.$('#fileInput');
      if (!input) throw new Error('#fileInput not found');
      await input.uploadFile(SKIP_FILE);
      await page.waitForFunction(
        () => (document.querySelector('#log')?.textContent ?? '').includes('Manifest loaded'),
        { timeout: 30_000 },
      );
      // Let the initial buffer-ahead settle so we measure seek response, not cold-start contention.
      await new Promise(r => setTimeout(r, 2_000));

      await installProbes(page);

      // Start each gesture from a clean origin so the forward skips don't clamp at the end.
      await page.evaluate(async () => {
        const w = window as any;
        w.__mxfPlayer.pause();
        w.__mxfPlayer.seek(0);
        await new Promise(r => setTimeout(r, 300));
      });

      const meta = await page.evaluate(() => {
        const w = window as any;
        const v = document.getElementById('video') as HTMLVideoElement;
        return { duration: w.__mxfPlayer.duration || v.duration || 0, indexMode: w.__mxfPlayer.indexMode };
      });

      const forward = await runPhase(page, 'ArrowUp', 3, PRESS_GAP_MS);
      const backward = await runPhase(page, 'ArrowDown', 2, PRESS_GAP_MS);

      // stop the rvfc loop
      await page.evaluate(() => { (window as any).__skip.running = false; });

      const rvfcAvailable = await page.evaluate(
        () => typeof (document.getElementById('video') as any).requestVideoFrameCallback === 'function',
      );

      console.log('\n=== skip-seek response (file: ' + path.basename(SKIP_FILE) + ') ===');
      console.log(`duration: ${meta.duration?.toFixed?.(1)}s | indexMode: ${meta.indexMode} | press gap: ${PRESS_GAP_MS}ms | rvfc: ${rvfcAvailable}`);
      console.table([
        {
          phase: 'fwd +10s ×3',
          presses: forward.presses,
          targetTime: +forward.targetTime.toFixed(2),
          seekedEvents: forward.seekedEvents,
          settledAt: forward.seekedTimes.join(','),
          skipResponseMs: Math.round(forward.responseToLastSkipMs),
          playFirstFrameMs: Math.round(forward.playToFirstFrameMs),
          framesIn1s: forward.framesIn1sAfterPlay,
        },
        {
          phase: 'back −10s ×2',
          presses: backward.presses,
          targetTime: +backward.targetTime.toFixed(2),
          seekedEvents: backward.seekedEvents,
          settledAt: backward.seekedTimes.join(','),
          skipResponseMs: Math.round(backward.responseToLastSkipMs),
          playFirstFrameMs: Math.round(backward.playToFirstFrameMs),
          framesIn1s: backward.framesIn1sAfterPlay,
        },
      ]);

      // Hard guards only — no fatal/page errors during the gesture.
      const fatal = logs.filter(l => l.includes('FATAL') || l.includes('pageerror'));
      expect(fatal, `errors during skip-seek:\n${fatal.join('\n')}`).toHaveLength(0);

      // Behaviour sanity (loose — this is characterization, not a perf bar):
      //  - the picture catches up to each jump (a frame paints at the new position),
      //  - play eventually delivers frames.
      expect(forward.responseToLastSkipMs, `forward skip never painted: ${JSON.stringify(forward)}`).toBeGreaterThanOrEqual(0);
      expect(backward.responseToLastSkipMs, `backward skip never painted: ${JSON.stringify(backward)}`).toBeGreaterThanOrEqual(0);
      expect(forward.playToFirstFrameMs, `play after forward skip never painted: ${JSON.stringify(forward)}`).toBeGreaterThanOrEqual(0);
      expect(backward.playToFirstFrameMs, `play after backward skip never painted: ${JSON.stringify(backward)}`).toBeGreaterThanOrEqual(0);
    } finally {
      await page.close();
    }
  }, 120_000);
});

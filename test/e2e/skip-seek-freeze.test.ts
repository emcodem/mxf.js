/**
 * E2E: try to REPRODUCE the "ends up frozen" symptom from chaotic skip/play gestures.
 *
 * The clean characterization test (skip-seek-perf) waits between presses and for paint before play —
 * too well-behaved to freeze. Real users race the state machine: mashing ±10s while playing, with no
 * gap, interleaving play/pause, skipping into unbuffered regions. This test fires several adversarial
 * gesture patterns through the real demo keyboard transport, then calls play() and watches whether the
 * playhead actually advances. A FREEZE = play() requested, not paused, but currentTime stuck and no
 * frames painted for the watch window.
 *
 * On a freeze it dumps the player's internal latch flags (fetchPending / pendingSeeks / previewParked /
 * bufferFull) — TS `private` fields are plain runtime properties in the dist bundle — plus the <video>
 * readyState/buffered, so we can see WHICH latch is stuck. This is a diagnostic repro: it logs every
 * pattern's outcome and only fails if a freeze is actually caught (so it's a regression guard once we
 * fix the cause).
 *
 * Defaults to xdcam_vistek.mxf (MPEG-2 long-GOP — the per-keyframe transcode seek, most freeze-prone).
 * Override with TEST_SKIP_FILE. Skips gracefully if absent.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const PORT = 5196;

const SKIP_FILE = process.env.TEST_SKIP_FILE ?? 'C:/temp/mxf.js/xdcam_vistek.mxf';

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

// 'scrub' = a fast slider sweep + release (beginScrub/scrubTo/endScrub) injected mid-gesture.
type Key = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | ' ' | 'j' | 'l' | 'k' | 'scrub';

interface PatternResult {
  name: string;
  froze: boolean;
  startTime: number;
  endTime: number;          // currentTime when play() was issued
  advancedBy: number;       // how far currentTime moved during the watch window
  tailAdvance: number;      // how far it moved in the LAST ~1.2s (catches a mid-window stall)
  framesPainted: number;    // frames presented during the watch window
  tailFrames: number;       // frames painted in the last ~1.2s
  playbackRate: number;
  paused: boolean;
  readyState: number;
  bufferedAhead: number;
  flags: Record<string, unknown>;
}

/**
 * Run one chaotic gesture: fire `keys` (real keydowns, or a 'scrub' sweep) `gapMs` apart, then
 * explicitly play() and watch for `watchMs` whether the playhead advances + frames paint. Judges both
 * the whole window AND its TAIL (so an advance-then-stall is caught). Returns a verdict + internals.
 *
 * NOTE: playbackRate is intentionally NOT reset here — leaking a fast-forward rate is exactly one of
 * the suspected freeze causes, so we observe it rather than paper over it.
 */
async function runPattern(page: Page, name: string, keys: Key[], gapMs: number, watchMs: number): Promise<PatternResult> {
  return page.evaluate(async (name, keys, gapMs, watchMs) => {
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    const w = window as any;
    const player = w.__mxfPlayer;
    const bar = document.getElementById('seekBar') as HTMLInputElement;
    const playBtn = document.getElementById('playBtn') as HTMLButtonElement;
    const video = document.getElementById('video') as HTMLVideoElement;

    // frame-paint counter for this pattern (timestamped, so we can inspect the tail)
    const paints: number[] = [];
    let running = true;
    const rvfc = (video as any).requestVideoFrameCallback?.bind(video);
    if (rvfc) {
      const onF = () => { paints.push(performance.now()); if (running) rvfc(onF); };
      rvfc(onF);
    }

    // Known starting point: paused at 0 so patterns are comparable and forward skips have room.
    player.pause();
    player.seek(0);
    await sleep(400);

    const startTime = video.currentTime;
    const dur = Math.max(1, player.duration || video.duration || 1);

    // Fire the gesture — no waiting for paint, just like a user mashing keys.
    for (const k of keys) {
      if (k === 'scrub') {
        // Fast slider sweep, ~0→60% and back, then release at 40% — the real demo wiring.
        bar.dispatchEvent(new Event('mousedown'));
        let pos = 0, dir = 1;
        for (let i = 0; i < 24; i++) {
          pos += dir * (dur / 12) * 0.12;
          if (pos >= dur * 0.6) dir = -1;
          if (pos <= 0) { pos = 0; dir = 1; }
          bar.value = String(pos);
          bar.dispatchEvent(new Event('input'));
          await sleep(20);
        }
        bar.value = String(dur * 0.4);
        bar.dispatchEvent(new Event('change'));
      } else {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
      }
      if (gapMs > 0) await sleep(gapMs);
    }

    const endTime = video.currentTime;
    // Realistic recovery: the user clicks the PLAY BUTTON to watch normally — the most common "I'm
    // done messing about, play it" action, and one of the paths that must reset any J/L fast motion.
    // (Deliberately NOT K/Space: K already reset speed before the fix, so recovering via K would mask
    // the real bug, which is that the play button / skip / scrub did NOT.) Click once; if that landed
    // on pause (gesture left it playing, e.g. after fast-forward), click again so we end up PLAYING.
    // After the fix this must yield normal 1× advancing playback; on the old code the leaked rate /
    // still-running rewind timer wedges it.
    playBtn.click();
    await sleep(120);
    if (video.paused) { playBtn.click(); await sleep(120); }

    // Watch: sample currentTime over time so we can judge both the whole window and its tail.
    const paintsAtPlay = paints.length;
    const samples: Array<{ t: number; ct: number }> = [];
    const t0 = performance.now();
    while (performance.now() - t0 < watchMs) {
      samples.push({ t: performance.now(), ct: video.currentTime });
      await sleep(200);
    }
    running = false;

    const framesPainted = paints.length - paintsAtPlay;
    const cts = samples.map(s => s.ct);
    const advancedBy = Math.max(...cts) - Math.min(...cts);
    // Tail = last ~1.2s of the window.
    const tailStart = t0 + watchMs - 1_200;
    const tailSamples = samples.filter(s => s.t >= tailStart).map(s => s.ct);
    const tailAdvance = tailSamples.length ? Math.max(...tailSamples) - Math.min(...tailSamples) : 0;
    const tailFrames = paints.filter(t => t >= tailStart).length;
    // After the K→Space recovery the player MUST be in healthy 1× playback: not paused, the playhead
    // advancing, frames painting, and the rate back to 1×. Anything else is a freeze (judged on the
    // TAIL so an advance-then-stall is caught, not just dead-from-start).
    const froze = video.paused || tailAdvance < 0.3 || tailFrames === 0 || Math.abs(video.playbackRate - 1) > 0.01;

    // Dump internal latch flags (plain runtime props in the dist bundle). If a name was mangled it
    // shows as undefined — harmless.
    const flags = {
      fetchPending: player.fetchPending,
      pendingSeeks: player.pendingSeeks,
      previewParked: player.previewParked,
      bufferFull: player.bufferFull,
      nextFetchFrame: player.nextFetchFrame,
      seekTargetFrame: player.seekTargetFrame,
      activeSeekMode: player.activeSeekMode,
      scrubActive: player.scrub?.isActive,
    };

    const b = video.buffered;
    let aheadEnd = 0;
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) <= video.currentTime + 0.01 && video.currentTime <= b.end(i) + 0.01) aheadEnd = b.end(i);
    }

    return {
      name,
      froze,
      startTime: +startTime.toFixed(2),
      endTime: +endTime.toFixed(2),
      advancedBy: +advancedBy.toFixed(2),
      tailAdvance: +tailAdvance.toFixed(2),
      framesPainted,
      tailFrames,
      playbackRate: video.playbackRate,
      paused: video.paused,
      readyState: video.readyState,
      bufferedAhead: +(aheadEnd - video.currentTime).toFixed(2),
      flags,
    } as PatternResult;
  }, name, keys, gapMs, watchMs);
}

describe('skip/play freeze repro', () => {
  test('chaotic skip + play gestures — does any wedge the playhead?', async () => {
    if (!fs.existsSync(SKIP_FILE)) {
      console.log(`skip freeze repro — file not found: ${SKIP_FILE} (set TEST_SKIP_FILE)`);
      return;
    }

    const page = await browser.newPage();
    const logs: string[] = [];
    page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));

    const results: PatternResult[] = [];
    try {
      await page.goto(`http://localhost:${PORT}/demo/index.html?e2e=1`, { waitUntil: 'networkidle0' });
      const input = await page.$('#fileInput');
      if (!input) throw new Error('#fileInput not found');
      await input.uploadFile(SKIP_FILE);
      await page.waitForFunction(
        () => (document.querySelector('#log')?.textContent ?? '').includes('Manifest loaded'),
        { timeout: 30_000 },
      );
      await new Promise(r => setTimeout(r, 2_000)); // let initial buffer settle

      const U: Key = 'ArrowUp', D: Key = 'ArrowDown', AL: Key = 'ArrowLeft', AR: Key = 'ArrowRight', SP: Key = ' ';
      const J: Key = 'j', L: Key = 'l', K: Key = 'k', SC: Key = 'scrub';
      // Each pattern: [keys, gapMs]. Watch window 4s.
      const patterns: Array<{ name: string; keys: Key[]; gap: number }> = [
        { name: 'clean fwd ×3 (baseline)',        keys: [U, U, U],                  gap: 120 },
        { name: 'mash fwd ×8 no gap',             keys: [U, U, U, U, U, U, U, U],   gap: 0   },
        { name: 'ping-pong ±10 ×6',               keys: [U, D, U, D, U, D],         gap: 40  },
        { name: 'fwd then space-spam',            keys: [U, SP, U, SP, U, SP],      gap: 50  },
        { name: 'back into start ×4',             keys: [D, D, D, D],               gap: 40  },
        { name: 'frame-step burst then fwd',      keys: [AR, AR, AR, U, U],         gap: 30  },
        { name: 'fwd ×3 + immediate play',        keys: [U, U, U],                  gap: 0   },
        // JKL transport (the keys just added) + their interaction with scrub:
        { name: 'fast-fwd L×4 (→16×) then play',  keys: [L, L, L, L],               gap: 120 },
        { name: 'rewind J×3 then play',           keys: [J, J, J],                  gap: 120 },
        { name: 'rewind J×2 then space',          keys: [J, J, SP],                 gap: 120 },
        { name: 'L×4 then K then play',           keys: [L, L, L, L, K],            gap: 100 },
        { name: 'rewind J×2 then SCRUB',          keys: [J, J, SC],                 gap: 120 },
        { name: 'L×4 (16×) then SCRUB',           keys: [L, L, L, L, SC],           gap: 120 },
        { name: 'scrub then fwd ×2',              keys: [SC, U, U],                 gap: 120 },
      ];

      for (const p of patterns) {
        results.push(await runPattern(page, p.name, p.keys, p.gap, 4_000));
      }

      console.log('\n=== freeze repro (file: ' + path.basename(SKIP_FILE) + ') ===');
      console.table(results.map(r => ({
        pattern: r.name,
        froze: r.froze,
        to: r.endTime,
        advanced: r.advancedBy,
        tailAdv: r.tailAdvance,
        painted: r.framesPainted,
        tailFr: r.tailFrames,
        rate: r.playbackRate,
        paused: r.paused,
        ready: r.readyState,
        ahead: r.bufferedAhead,
      })));
      const frozen = results.filter(r => r.froze);
      if (frozen.length) {
        console.log('\n--- FROZEN patterns: internal flags ---');
        for (const r of frozen) console.log(`${r.name}:`, JSON.stringify(r.flags));
      }
    } finally {
      await page.close();
    }

    const fatal = logs.filter(l => l.includes('pageerror'));
    expect(fatal, `page errors:\n${fatal.join('\n')}`).toHaveLength(0);

    const frozen = results.filter(r => r.froze);
    // The whole point is to catch a freeze. If one reproduces, FAIL with the diagnostic so we can fix
    // it; once fixed this becomes a regression guard. If none froze on this machine, the table still
    // documents the behaviour and the test passes.
    expect(
      frozen,
      `FREEZE reproduced in ${frozen.length} pattern(s):\n` +
        frozen.map(r => `  • ${r.name} — advanced ${r.advancedBy}s, painted ${r.framesPainted}, flags=${JSON.stringify(r.flags)}`).join('\n'),
    ).toHaveLength(0);
  }, 180_000);
});

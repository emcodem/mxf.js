/**
 * E2E measurement: scrub-release → playback-resumes latency + buffering visibility.
 *
 * Reproduces "drag 50%→75% and hit play, wait >2s until image continues" and breaks the wait into:
 *   release → first 'seeking'        (the accurate settle starts)
 *   release → first painted frame    (target picture appears)
 *   release → playback advancing      (currentTime climbs across 2 samples — real resume)
 * Also samples video.readyState over the gap and records whether ANY buffering signal exists today.
 *
 * Diagnostic/characterization — logs the breakdown, asserts only that playback eventually resumes.
 * Defaults to xdcam_vistek.mxf (MPEG-2 long-GOP). Skips if absent.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { getChromePath } from './chrome-path.js';
import puppeteer, { type Browser } from 'puppeteer';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const PORT = 5195;
const SKIP_FILE = process.env.TEST_SKIP_FILE ?? 'C:/temp/mxf.js/xdcam_vistek.mxf';

let vite: ViteDevServer;
let browser: Browser;

beforeAll(async () => {
  vite = await createServer({ root: projectRoot, logLevel: 'silent', server: { port: PORT, headers: {} }, worker: { format: 'es' } });
  await vite.listen();
  browser = await puppeteer.launch({
    headless: false,
    executablePath: getChromePath(),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-features=WebCodecs'],
  });
}, 60_000);

afterAll(async () => { await browser?.close(); await vite?.close(); });

describe('scrub-release → resume latency', () => {
  test('drag 50%→75%, release, measure time to picture + playback resume', async () => {
    if (!fs.existsSync(SKIP_FILE)) { console.log(`skip — file not found: ${SKIP_FILE}`); return; }
    const page = await browser.newPage();
    const logs: string[] = [];
    page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
    await page.goto(`http://localhost:${PORT}/demo/index.html?e2e=1`, { waitUntil: 'networkidle0' });
    const input = await page.$('#fileInput');
    await input!.uploadFile(SKIP_FILE);
    await page.waitForFunction(() => (document.querySelector('#log')?.textContent ?? '').includes('Manifest loaded'), { timeout: 30_000 });
    await new Promise(r => setTimeout(r, 1_500));

    const result = await page.evaluate(async () => {
      const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
      const now = () => performance.now();
      const w = window as any;
      const player = w.__mxfPlayer;
      const bar = document.getElementById('seekBar') as HTMLInputElement;
      const video = document.getElementById('video') as HTMLVideoElement;
      const dur = Math.max(1, player.duration || video.duration || 1);

      // frame-paint timestamps
      const paints: number[] = [];
      let running = true;
      const rvfc = (video as any).requestVideoFrameCallback?.bind(video);
      if (rvfc) { const onF = () => { paints.push(now()); if (running) rvfc(onF); }; rvfc(onF); }

      // capture seeking events + any 'buffering' player events
      let firstSeekingT = -1;
      video.addEventListener('seeking', () => { if (firstSeekingT < 0) firstSeekingT = now(); });
      const bufferingLog: Array<{ t: number; buffering: boolean }> = [];
      player.on('buffering', (d: any) => { bufferingLog.push({ t: now(), buffering: d.buffering }); });

      // Start playing for ~1.5s from the middle so it's genuinely "playing" before the scrub.
      player.seek(dur * 0.5);
      await sleep(300);
      player.play();
      await sleep(1_200);

      // Scrub 50% → 75% and release at 75% (mirror demo wiring).
      bar.dispatchEvent(new Event('mousedown'));
      for (let i = 0; i <= 10; i++) {
        const t = dur * (0.5 + 0.025 * i); // 50% → 75%
        bar.value = String(t);
        bar.dispatchEvent(new Event('input'));
        await sleep(30);
      }
      const releaseT = dur * 0.75;
      firstSeekingT = -1;            // reset: we care about the post-release settle seeking
      const paintsBefore = paints.length;
      const tRelease = now();
      bar.value = String(releaseT);
      bar.dispatchEvent(new Event('change')); // endScrub → settle + resume

      // Watch: first paint after release, then playback ADVANCING (currentTime climbs).
      let firstPaintT = -1, advancingT = -1;
      let prevCt = video.currentTime;
      const readyStates: number[] = [];
      const t0 = now();
      while (now() - t0 < 6_000) {
        if (firstPaintT < 0 && paints.length > paintsBefore) firstPaintT = paints[paintsBefore];
        const ct = video.currentTime;
        if (advancingT < 0 && !video.paused && ct > prevCt + 0.04 && Math.abs(ct - releaseT) < 5) advancingT = now();
        prevCt = ct;
        readyStates.push(video.readyState);
        if (advancingT > 0 && firstPaintT > 0) break;
        await sleep(100);
      }
      // Watch a little longer so we capture steady state (did playback sustain after the resume?).
      await sleep(2_500);
      running = false;
      const advancedAfter = +(video.currentTime - releaseT).toFixed(2); // content seconds played post-release
      const postRelease = bufferingLog.filter(e => e.t >= tRelease);
      return {
        releaseToFirstSeekingMs: firstSeekingT > 0 ? Math.round(firstSeekingT - tRelease) : -1,
        releaseToFirstPaintMs: firstPaintT > 0 ? Math.round(firstPaintT - tRelease) : -1,
        releaseToAdvancingMs: advancingT > 0 ? Math.round(advancingT - tRelease) : -1,
        bufferingTransitionsPostRelease: postRelease.length,
        bufferingSequencePostRelease: postRelease.map(e => (e.buffering ? 'B' : 'p')).join(''),
        advancedSecondsPostRelease: advancedAfter,
        readyStateSamples: readyStates.join(''),
        finalTime: +video.currentTime.toFixed(2),
        releaseT: +releaseT.toFixed(2),
        paused: video.paused,
      };
    });

    console.log('\n=== scrub-release → resume latency ===');
    console.log(JSON.stringify(result, null, 2));
    await page.close();

    const fatal = logs.filter(l => l.includes('pageerror'));
    expect(fatal, fatal.join('\n')).toHaveLength(0);
    // Playback resumes after release …
    expect(result.releaseToAdvancingMs, `playback never resumed after release: ${JSON.stringify(result)}`).toBeGreaterThanOrEqual(0);
    // … and sustains (the playhead really advances afterwards, not just a single frame) …
    expect(result.advancedSecondsPostRelease, `playback did not sustain after resume: ${JSON.stringify(result)}`).toBeGreaterThan(0.5);
    // … buffering is SURFACED during the load (the whole point — no silent freeze) …
    expect(result.bufferingTransitionsPostRelease, `no buffering signal emitted: ${JSON.stringify(result)}`).toBeGreaterThanOrEqual(1);
    // … and the buffering state does NOT oscillate (the one-shot gate must not flip-flop play/pause).
    expect(result.bufferingTransitionsPostRelease, `buffering oscillated: ${JSON.stringify(result)}`).toBeLessThanOrEqual(8);
  }, 120_000);
});

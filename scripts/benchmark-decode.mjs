#!/usr/bin/env node
/**
 * Ad-hoc decode-speed benchmark: loads an MXF file into the real demo player (Chrome + WebCodecs/MSE)
 * from a cold start and drives native video.playbackRate the same way the demo's J/L fast-forward
 * ladder does (see demo/index.html fastForward()), measuring how much wall-clock time a full
 * play-through takes at each rate. One fresh page load per rate — reusing a page and seeking back to
 * 0 between trials was found to leave the MSE SourceBuffer in a stale buffered-range state (playhead
 * at 0 while the buffer still spanned a much later range from the previous trial), which stalled
 * playback for reasons unrelated to raw decode throughput.
 *
 * Usage: node scripts/benchmark-decode.mjs <path-to-mxf> [maxRate]
 */
import puppeteer from 'puppeteer';
import { createServer } from 'vite';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const PORT = 5205;

const FILE = process.argv[2];
const RATES_ARG = process.argv[3];
if (!FILE || !fs.existsSync(FILE)) {
  console.error('Usage: node scripts/benchmark-decode.mjs <path-to-mxf> [maxRate|rate1,rate2,...]');
  process.exit(1);
}
const explicitRates = RATES_ARG?.includes(',') ? RATES_ARG.split(',').map(Number) : null;
const MAX_RATE = explicitRates ? Infinity : Number(RATES_ARG ?? 16);

function resolveChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  try { return puppeteer.executablePath(); } catch { return undefined; }
}

const vite = await createServer({
  root: projectRoot,
  logLevel: 'silent',
  server: { port: PORT, headers: {} },
  worker: { format: 'es' },
});
await vite.listen();

const browser = await puppeteer.launch({
  headless: false,
  executablePath: resolveChrome(),
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-features=WebCodecs'],
});

async function runOneRate(rate) {
  const page = await browser.newPage();
  page.on('pageerror', err => console.log('[pageerror]', err.message));
  let lastStallLog = 0;
  page.on('console', msg => {
    const t = msg.text();
    if (/waiting|underrun|FATAL|quota|buffer full|mse\]|stall-watchdog|gate cur|transcode\]|videoSegment/i.test(t)) { console.log(`  [console] ${t}`); return; }
    if (/stall/i.test(t)) {
      const now = Date.now();
      if (now - lastStallLog > 5000) { console.log(`  [console] ${t}`); lastStallLog = now; }
    }
  });

  try {
    await page.goto(`http://localhost:${PORT}/demo/index.html`, { waitUntil: 'networkidle0' });
    const input = await page.$('#fileInput');
    await input.uploadFile(FILE);

    await page.waitForFunction(() => {
      const t = document.querySelector('#log')?.textContent ?? '';
      return t.includes('Manifest loaded') || t.includes('FATAL') || t.includes('Error:');
    }, { timeout: 30_000 });

    const meta = await page.$eval('#meta', el => el.textContent);
    const fps = Number(meta.match(/FPS:\s*([\d.]+)/)?.[1] ?? 25);

    await page.waitForFunction(() => (document.querySelector('#video')?.readyState ?? 0) >= 2, { timeout: 15_000 });
    const duration = await page.evaluate(() => document.querySelector('#video').duration);

    // Let autoplay establish normal 1x playback first (real usage never starts cold at Nx), then drive
    // the rate change through the demo's own J/L ladder (native keypresses -> fastForward()) instead of
    // poking video.playbackRate directly, so the player's internal state (jklDir/jklSpeedIdx, gating)
    // stays consistent with how a real user would reach this rate. SPEED_LADDER = [1,2,4,8,16], and each
    // consecutive 'l' press advances one step; the Nth press for rate R = log2(R)+1 presses.
    await page.waitForFunction(() => (document.querySelector('#video')?.currentTime ?? 0) > 0.3, { timeout: 10_000 });
    if (rate > 1) {
      const presses = Math.log2(rate) + 1;
      for (let i = 0; i < presses; i++) {
        await page.keyboard.press('l');
        await new Promise(r => setTimeout(r, 80));
      }
    }

    const start = await page.evaluate(() => document.querySelector('#video').currentTime);
    const t0 = Date.now();

    const maxWaitMs = Number(process.env.BENCH_MAX_WAIT_MS) || Math.max(20_000, (duration / rate) * 1000 * 5 + 10_000);
    let lastT = start;
    let ended = false;
    let lastRangesStr = '';
    while (Date.now() - t0 < maxWaitMs) {
      const s = await page.evaluate(() => {
        const v = document.querySelector('#video');
        const dump = (b) => { const r = []; for (let i = 0; i < b.length; i++) r.push([+b.start(i).toFixed(2), +b.end(i).toFixed(2)]); return r; };
        const mc = window.player?.mseController;
        const vsb = mc?.sourceBuffers?.get('video');
        const asb = mc?.sourceBuffers?.get('audio');
        return {
          t: v.currentTime,
          ended: v.ended,
          elementRanges: dump(v.buffered),
          videoSbRanges: vsb ? dump(vsb.buffered) : null,
          audioSbRanges: asb ? dump(asb.buffered) : null,
          gapVideo: mc ? mc.findGapAhead('video', v.currentTime, 30) : undefined,
          gapAudio: mc ? mc.findGapAhead('audio', v.currentTime, 30) : undefined,
        };
      });
      lastT = s.t;
      const rangesStr = JSON.stringify({ e: s.elementRanges, v: s.videoSbRanges, a: s.audioSbRanges, gv: s.gapVideo, ga: s.gapAudio });
      if (rangesStr !== lastRangesStr) {
        console.log(`  [buffered] t=${s.t.toFixed(2)} ${rangesStr}`);
        lastRangesStr = rangesStr;
      }
      if (s.ended || (duration - s.t) < 0.05) { ended = true; break; }
      await new Promise(r => setTimeout(r, 500));
    }
    const wallSeconds = (Date.now() - t0) / 1000;
    const contentSeconds = lastT - start;
    const speedMultiple = wallSeconds > 0 ? contentSeconds / wallSeconds : 0;
    const decodeFps = speedMultiple * fps;

    return { rate, ended, duration, contentSeconds, wallSeconds, speedMultiple, decodeFps, meta };
  } finally {
    await page.close();
  }
}

try {
  const RATES = explicitRates ?? [1, 2, 4, 8, 16].filter(r => r <= MAX_RATE);
  const results = [];

  for (const rate of RATES) {
    console.log(`--- rate=${rate}x (cold page load) ---`);
    const r = await runOneRate(rate);
    if (results.length === 0) console.log(`meta: ${r.meta}\ncontent duration: ${r.duration.toFixed(2)}s`);
    results.push(r);
    console.log(
      `rate=${r.rate}x  ended=${r.ended}  content=${r.contentSeconds.toFixed(2)}s  wall=${r.wallSeconds.toFixed(2)}s  ` +
      `realized_speed=${r.speedMultiple.toFixed(2)}x  effective_decodeFps=${r.decodeFps.toFixed(1)}\n`,
    );
    if (!r.ended && r.speedMultiple < 0.9) {
      console.log(`  -> decode cannot sustain ${rate}x (realized ${r.speedMultiple.toFixed(2)}x), stopping ladder\n`);
      break;
    }
  }

  console.log('summary:');
  for (const r of results) {
    console.log(
      `  ${String(r.rate).padStart(2)}x -> realized ${r.speedMultiple.toFixed(2)}x, ` +
      `${r.decodeFps.toFixed(1)} fps effective, ended=${r.ended}`,
    );
  }
} finally {
  await browser.close();
  await vite.close();
}

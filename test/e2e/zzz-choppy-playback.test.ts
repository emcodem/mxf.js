/**
 * Diagnostic: play XDCAMHD_Choppy.mxf in real Chrome and sample playback health over ~15 s to see
 * whether the choppiness is production-bound (buffer can't fill) or player-side (buffer pinned /
 * playhead stalls despite a healthy buffer). Logs which decode path is active.
 */
import { describe, test, beforeAll, afterAll } from 'vitest';
import puppeteer, { type Browser } from 'puppeteer';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const PORT = 5198;
const FILE = process.env.TEST_MXF_FILE ?? 'C:/temp/mxf.js/XDCAMHD_Choppy.mxf';

let vite: ViteDevServer;
let browser: Browser;

beforeAll(async () => {
  vite = await createServer({ root: projectRoot, logLevel: 'silent', server: { port: PORT, headers: {} }, worker: { format: 'es' } });
  await vite.listen();
  browser = await puppeteer.launch({
    headless: false,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-features=WebCodecs', '--autoplay-policy=no-user-gesture-required'],
  });
}, 30_000);

afterAll(async () => { await browser?.close(); await vite?.close(); });

describe('choppy playback diagnosis', () => {
  test('sample playback health', async () => {
    if (!fs.existsSync(FILE)) throw new Error(`missing ${FILE}`);
    const page = await browser.newPage();
    const console_: string[] = [];
    page.on('console', m => console_.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', e => console_.push(`[pageerror] ${e.message}`));
    await page.goto(`http://localhost:${PORT}/demo/index.html`, { waitUntil: 'networkidle0' });

    await (await page.$('#fileInput'))!.uploadFile(FILE);
    await page.waitForFunction(
      () => (document.querySelector('#log')?.textContent ?? '').includes('Manifest loaded'),
      { timeout: 30_000 });

    const samples = await page.evaluate(async () => {
      const v = document.getElementById('video') as HTMLVideoElement;
      const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
      const bufAhead = () => { const b = v.buffered; for (let i = 0; i < b.length; i++) if (v.currentTime >= b.start(i) && v.currentTime <= b.end(i) + 0.05) return b.end(i) - v.currentTime; return 0; };
      const bufTotal = () => { const b = v.buffered; let t = 0; for (let i = 0; i < b.length; i++) t += b.end(i) - b.start(i); return t; };
      try { await v.play(); } catch { /* autoplay may already be running */ }
      const out: Array<{ t: number; ct: number; paused: boolean; rs: number; ahead: number; total: number; dropped: number; decoded: number }> = [];
      const wall0 = performance.now();
      for (let i = 0; i < 60; i++) {
        const q = v.getVideoPlaybackQuality?.();
        out.push({
          t: +((performance.now() - wall0) / 1000).toFixed(2),
          ct: +v.currentTime.toFixed(3),
          paused: v.paused,
          rs: v.readyState,
          ahead: +bufAhead().toFixed(2),
          total: +bufTotal().toFixed(2),
          dropped: q?.droppedVideoFrames ?? 0,
          decoded: q?.totalVideoFrames ?? 0,
        });
        await sleep(250);
      }
      return out;
    });
    await page.close();

    const wasm = console_.find(l => l.includes('WASM kernels active'));
    const jsfb = console_.find(l => l.includes('JS decode path'));
    console.log('\nDECODE PATH:', wasm ? 'WASM kernels active' : jsfb ? `JS fallback (${jsfb})` : 'unknown');

    const first = samples[0], last = samples[samples.length - 1];
    const wall = last.t - first.t;
    const adv = last.ct - first.ct;
    let stalls = 0;
    for (let i = 1; i < samples.length; i++) if (!samples[i].paused && samples[i].ct === samples[i - 1].ct) stalls++;
    console.log(`PLAYHEAD: advanced ${adv.toFixed(2)}s over ${wall.toFixed(2)}s wall = ${(adv / wall).toFixed(2)}x realtime`);
    console.log(`STALLS (no advance while not paused): ${stalls}/${samples.length - 1} samples`);
    console.log(`BUFFER ahead: min ${Math.min(...samples.map(s => s.ahead)).toFixed(2)}s  max ${Math.max(...samples.map(s => s.ahead)).toFixed(2)}s`);
    console.log(`DROPPED frames (total at end): ${last.dropped} of ${last.decoded} decoded`);
    console.log('\nt | currentTime | paused | readyState | aheadSec | totalBuf | dropped');
    for (const s of samples.filter((_, i) => i % 2 === 0)) console.log(`${s.t}\t${s.ct}\t${s.paused ? 'P' : '.'}\t${s.rs}\t${s.ahead}\t${s.total}\t${s.dropped}`);

    // Worker progress + any errors: shows how far fetching/decoding got (last [transcode] startFrame)
    // and whether a worker error / SourceBuffer error / quota fired around the stall.
    const transcodes = console_.filter(l => l.includes('[transcode] startFrame='));
    console.log(`\nWORKER [transcode] chunks: ${transcodes.length}`);
    transcodes.forEach(l => console.log('  ' + l.replace(/^\[\w+\]\s*/, '')));
    const errs = console_.filter(l => /error|fail|fatal|quota|exceeded|pageerror|previewParked|bufferFull/i.test(l) && !l.includes('[transcode]'));
    console.log(`\nSUSPICIOUS lines: ${errs.length}`);
    errs.slice(0, 40).forEach(l => console.log('  ' + l));

    const trace = console_.filter(l => l.includes('[trace]'));
    console.log(`\nTRACE (${trace.length} lines):`);
    trace.forEach(l => console.log('  ' + l.replace(/^\[\w+\]\s*/, '')));
  }, 60_000);
});

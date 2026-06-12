/**
 * E2E: non-live (STATIC) HLS playlist mode.
 *
 * Encodes a 20 s MPEG-2 source and splits it into 2 s, GOP-aligned MXF clips with ffmpeg's
 * `segment` muxer, emitting a static `#EXT-X-ENDLIST` m3u8 of those clips. A custom Range-capable
 * Python server (demo/hls-server.py) serves the repo root; Puppeteer drives demo/playlist.html and
 * asserts the playlist plays as ONE continuous spanning timeline:
 *
 *   1. clip 0's manifest is parsed (the shared header template),
 *   2. the MSE duration grows to span ALL clips (~20 s), not just clip 0 (~2 s),
 *   3. a seek to 15 s — which lands in a LATER clip (clip 7) — actually paints a frame,
 *   4. no SourceBuffer / fatal / page errors fire across the clip boundaries.
 *
 * Requires the built bundle (demo/playlist.html loads dist/mxf.umd.js): run `npm run build` first.
 * Skips cleanly if ffmpeg or python is not on PATH.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import puppeteer, { type Browser } from 'puppeteer';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const HLS_DIR = path.join(projectRoot, 'demo', 'hls');
const M3U8 = path.join(HLS_DIR, 'playlist.m3u8');
const SERVER_PY = path.join(projectRoot, 'demo', 'hls-server.py');
const PORT = 5198;

const DURATION = 20; // seconds of source
const SEG = 2;       // seconds per segment → 10 clips
const FPS = 25;

function which(cmd: string): string | null {
  for (const c of [cmd, `${cmd}.exe`]) {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [c], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.split(/\r?\n/)[0].trim();
  }
  return null;
}

const ffmpeg = which('ffmpeg');
const python = which('python') ?? which('python3') ?? which('py');

let browser: Browser;
let server: ChildProcess | null = null;

/** Encode + segment the test clips into demo/hls/ (relative names so the m3u8 entries are relative). */
function makeClips(): void {
  fs.mkdirSync(HLS_DIR, { recursive: true });
  for (const f of fs.readdirSync(HLS_DIR)) fs.rmSync(path.join(HLS_DIR, f), { force: true });
  const args = [
    '-y',
    '-f', 'lavfi', '-i', `testsrc=size=640x480:rate=${FPS}:duration=${DURATION}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${DURATION}`,
    '-c:v', 'mpeg2video', '-pix_fmt', 'yuv420p', '-b:v', '5M',
    '-g', String(SEG * FPS), '-force_key_frames', `expr:gte(t,n_forced*${SEG})`,
    '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2',
    '-f', 'segment', '-segment_time', String(SEG), '-segment_format', 'mxf',
    '-reset_timestamps', '1',
    '-segment_list', 'playlist.m3u8', '-segment_list_type', 'm3u8',
    'clip%03d.mxf',
  ];
  const r = spawnSync(ffmpeg!, args, { cwd: HLS_DIR, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed (${r.status}):\n${r.stderr ?? ''}`);
}

/** Wait until the Range server answers a HEAD on the demo page. */
async function waitForServer(timeoutMs = 10_000): Promise<void> {
  const url = `http://127.0.0.1:${PORT}/demo/playlist.html`;
  const t0 = Date.now();
  for (;;) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.ok) return;
    } catch { /* not bound yet */ }
    if (Date.now() - t0 > timeoutMs) throw new Error('Range server did not start in time');
    await new Promise(r => setTimeout(r, 150));
  }
}

beforeAll(async () => {
  if (!ffmpeg || !python) return; // tests below self-skip

  if (!fs.existsSync(M3U8)) makeClips();

  server = spawn(python!, [SERVER_PY, '--root', projectRoot, '--port', String(PORT), '--host', '127.0.0.1'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', d => { if (process.env.VERBOSE) process.stderr.write(`[py] ${d}`); });
  await waitForServer();

  browser = await puppeteer.launch({
    headless: false,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-features=WebCodecs', '--autoplay-policy=no-user-gesture-required'],
  });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  if (server && !server.killed) server.kill();
});

describe('HLS playlist (static / non-live) E2E', () => {
  test('static m3u8 plays as one spanning timeline; cross-clip seek paints', async () => {
    if (!ffmpeg) { console.log('skip — ffmpeg not on PATH'); return; }
    if (!python) { console.log('skip — python not on PATH'); return; }
    if (!fs.existsSync(path.join(projectRoot, 'dist', 'mxf.umd.js'))) {
      throw new Error('dist/mxf.umd.js missing — run `npm run build` before this E2E');
    }

    // Sanity: the generated playlist is static (ENDLIST) with the expected clip count.
    const m3u8 = fs.readFileSync(M3U8, 'utf8');
    const clipCount = (m3u8.match(/^clip\d+\.mxf/gm) ?? []).length;
    expect(m3u8, 'playlist must be static (#EXT-X-ENDLIST)').toContain('#EXT-X-ENDLIST');
    expect(clipCount, `expected ~${DURATION / SEG} clips`).toBeGreaterThanOrEqual((DURATION / SEG) - 1);

    const page = await browser.newPage();
    const console_: string[] = [];
    const media: string[] = [];
    page.on('console', m => console_.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', e => console_.push(`[pageerror] ${e.message}`));
    const cdp = await page.createCDPSession();
    try {
      await cdp.send('Media.enable');
      cdp.on('Media.playerMessagesLogged', ({ messages }: { messages: Array<{ level: string; message: string }> }) => {
        for (const m of messages) media.push(`[media:${m.level}] ${m.message}`);
      });
    } catch { /* CDP Media optional */ }

    await page.goto(`http://127.0.0.1:${PORT}/demo/playlist.html`, { waitUntil: 'networkidle0' });

    // Type the m3u8 URL and load.
    await page.$eval('#url', (el, url) => { (el as HTMLInputElement).value = url; },
      `http://127.0.0.1:${PORT}/demo/hls/playlist.m3u8`);
    await page.click('#load');

    // (1) clip 0's manifest parsed.
    await page.waitForFunction(
      () => (document.querySelector('#log')?.textContent ?? '').includes('manifest: clip0'),
      { timeout: 30_000 },
    );

    // (2) duration grows to span ALL clips (static-known) — not just clip 0's ~2 s.
    await page.waitForFunction(
      (expected) => {
        const v = document.getElementById('video') as HTMLVideoElement;
        return Number.isFinite(v.duration) && v.duration >= expected;
      },
      { timeout: 30_000 },
      DURATION - SEG - 0.5, // tolerate the last partial segment
    );

    // (3) seek into a LATER clip (15 s ≈ clip 7) and confirm a frame actually paints.
    const seekResult = await page.evaluate(async () => {
      const v = document.getElementById('video') as HTMLVideoElement;
      const decoded = () => v.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
      const before = decoded();
      const target = 15;
      await new Promise<void>(resolve => {
        const onSeeked = () => { v.removeEventListener('seeked', onSeeked); resolve(); };
        v.addEventListener('seeked', onSeeked);
        v.currentTime = target;
        setTimeout(resolve, 8_000); // don't hang if 'seeked' never fires
      });
      await new Promise(r => setTimeout(r, 1_500)); // let the preview frame paint
      return {
        duration: v.duration,
        currentTime: v.currentTime,
        target,
        readyState: v.readyState,
        decodedAfter: decoded() - before,
      };
    });

    console.log('playlist seek result:', JSON.stringify(seekResult));
    if (process.env.VERBOSE) {
      console.log('--- console ---'); console_.forEach(l => console.log(l));
      console.log('--- media ---'); media.forEach(l => console.log(l));
    }

    const domLog: string = await page.$eval('#log', el => el.textContent ?? '');
    await page.close();

    // (4) no errors across clip boundaries.
    const sbErrors = console_.filter(l => /SourceBuffer error|QuotaExceeded/i.test(l));
    expect(sbErrors, `SourceBuffer/quota errors:\n${sbErrors.join('\n')}`).toHaveLength(0);
    const pageErrors = console_.filter(l => l.includes('[pageerror]'));
    expect(pageErrors, `page errors:\n${pageErrors.join('\n')}`).toHaveLength(0);
    expect(domLog, `player logged a fatal error:\n${domLog}`).not.toMatch(/error \(fatal\)/);

    // Spanning timeline + cross-clip seek landed and painted.
    expect(seekResult.duration, 'timeline did not span all clips').toBeGreaterThanOrEqual(DURATION - SEG - 0.5);
    expect(Math.abs(seekResult.currentTime - seekResult.target), `seek did not land: ${JSON.stringify(seekResult)}`).toBeLessThan(1.5);
    expect(seekResult.readyState, `video has no current frame after cross-clip seek: ${JSON.stringify(seekResult)}`).toBeGreaterThanOrEqual(2);
    expect(seekResult.decodedAfter, `no frame painted after cross-clip seek: ${JSON.stringify(seekResult)}`).toBeGreaterThanOrEqual(1);
  }, 120_000);
});

/**
 * E2E: Safari via safaridriver (WebDriver protocol).
 *
 * Requires: Develop → Allow Remote Automation enabled in Safari.
 * Safaridriver is started by the test; no manual setup beyond the one-time UI toggle.
 *
 * Run:
 *   TEST_MXF_FILE="/Users/liveencoder/mxf.js/media/xdcamhd_1920_25i_16tracks.mxf" \
 *   npm run test:e2e -- test/e2e/safari.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const VITE_PORT = 5197;
const WD_PORT = 4447;
const WD_BASE = `http://localhost:${WD_PORT}`;

const TEST_FILE = process.env.TEST_MXF_FILE ??
  path.resolve(projectRoot, 'media/xdcamhd_1920_25i_16tracks.mxf');

// ── WebDriver helpers ────────────────────────────────────────────────────────

let sessionId: string;

async function wd(method: string, path: string, body?: unknown) {
  const res = await fetch(`${WD_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json: any = await res.json();
  if (json?.value?.error) throw new Error(`WD ${method} ${path}: ${json.value.message}`);
  return json?.value;
}

const navigate = (url: string) => wd('POST', `/session/${sessionId}/url`, { url });
const execute  = (script: string, args: unknown[] = []) =>
  wd('POST', `/session/${sessionId}/execute/sync`, { script, args });
const findEl   = (css: string) =>
  wd('POST', `/session/${sessionId}/element`, { using: 'css selector', value: css });
const sendKeys = (elId: string, text: string) =>
  wd('POST', `/session/${sessionId}/element/${elId}/value`, { text, value: text.split('') });

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 30_000, pollMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, pollMs));
  }
  throw new Error('waitFor timeout');
}

// ── Test lifecycle ───────────────────────────────────────────────────────────

let vite: ViteDevServer;
let safariProc: ChildProcess;

beforeAll(async () => {
  // Start Vite
  vite = await createServer({
    root: projectRoot,
    logLevel: 'silent',
    server: { port: VITE_PORT, headers: {} },
    worker: { format: 'es' },
  });
  await vite.listen();

  // Start safaridriver
  safariProc = spawn('safaridriver', ['--port', String(WD_PORT)], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 1500)); // let it bind

  // Create Safari session
  const result = await wd('POST', '/session', {
    capabilities: { alwaysMatch: { browserName: 'safari' } },
  });
  sessionId = result.sessionId;

  // Give Safari a moment to fully launch
  await new Promise(r => setTimeout(r, 1000));
}, 40_000);

afterAll(async () => {
  if (sessionId) await wd('DELETE', `/session/${sessionId}`).catch(() => {});
  safariProc?.kill();
  await vite?.close();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('MXF player E2E — Safari', () => {

  test('demo page loads', async () => {
    await navigate(`http://localhost:${VITE_PORT}/demo/index.html`);
    await new Promise(r => setTimeout(r, 1500));
    const title = await wd('GET', `/session/${sessionId}/title`);
    expect(title).toContain('mxf.js');
    const h1 = await execute(`return document.querySelector('h1')?.textContent`);
    expect(h1).toContain('mxf.js');
  });

  test('MSE + WebCodecs available', async () => {
    await navigate(`http://localhost:${VITE_PORT}/demo/index.html`);
    await new Promise(r => setTimeout(r, 1000));

    const result: any = await execute(`
      return {
        mediasource: 'MediaSource' in window,
        managedMediaSource: 'ManagedMediaSource' in window,
        webcodecs: 'VideoEncoder' in window,
        avc1Supported: (() => {
          try {
            const ms = ('ManagedMediaSource' in window)
              ? new ManagedMediaSource()
              : new MediaSource();
            return ms.constructor.isTypeSupported('video/mp4; codecs="avc1.42E01E"');
          } catch { return false; }
        })(),
        safariVersion: navigator.userAgent,
      };
    `);

    console.log('Safari capabilities:', JSON.stringify(result, null, 2));

    // Safari uses ManagedMediaSource — either classic or managed must be present
    expect(result.mediasource || result.managedMediaSource,
      'Neither MediaSource nor ManagedMediaSource found').toBe(true);
    expect(result.avc1Supported, 'H.264 mp4 not supported').toBe(true);
  });

  test('MXF file: manifest received, no SourceBuffer error', async () => {
    if (!fs.existsSync(TEST_FILE)) {
      console.log(`skip: ${TEST_FILE} not found`);
      return;
    }

    await navigate(`http://localhost:${VITE_PORT}/demo/index.html`);
    await new Promise(r => setTimeout(r, 1500));

    // Upload file via the file input
    const el = await findEl('#fileInput');
    const elId = el['element-6066-11e4-a52e-4f735466cecf'] ?? el.ELEMENT ?? Object.values(el)[0];
    await sendKeys(elId, TEST_FILE);

    // Wait for manifest loaded, error, or timeout
    let logText = '';
    try {
      await waitFor(async () => {
        logText = await execute(`return document.querySelector('#log')?.textContent ?? ''`) as string;
        return logText.includes('Manifest loaded') || logText.includes('FATAL') || logText.includes('Error:');
      }, 30_000);
    } catch {
      logText = await execute(`return document.querySelector('#log')?.textContent ?? ''`) as string;
    }

    // Extra settle time for async SourceBuffer errors
    await new Promise(r => setTimeout(r, 4_000));
    logText = await execute(`return document.querySelector('#log')?.textContent ?? ''`) as string;

    const consoleLogs: string[] = await execute(`
      return window.__mxfTestLogs ?? [];
    `) as string[] ?? [];

    console.log('--- Safari DOM log ---');
    console.log(logText.slice(0, 2000));

    const sbErrors = logText.match(/SourceBuffer error/g) ?? [];
    expect(sbErrors, `SourceBuffer errors: ${sbErrors.join(', ')}`).toHaveLength(0);

    const fatalErrors = logText.match(/FATAL[^\n]*/g) ?? [];
    expect(fatalErrors, `Fatal errors: ${fatalErrors.join('\n')}`).toHaveLength(0);

    const manifested = logText.includes('Manifest loaded');
    const codecUnsupported = logText.includes('codec-unsupported') || logText.includes('codecUnsupported');
    expect(manifested || codecUnsupported,
      `Expected manifest or codec-unsupported — player hung.\nLog:\n${logText}`).toBe(true);
  }, 60_000);

  // Regression for the Safari 16.x VideoEncoder silent-failure that the ½-scale retry works around.
  // Encodes happen in a Worker (where the production transcoder runs). Two cases, both asserted:
  //   1. 1920×1088 with the full transcoder options (latencyMode/hwAccel/bitrateMode) → ZERO chunks.
  //      This is the bug: flush() resolves, no error fires, but no output is produced.
  //   2. 960×544 (½ scale) with minimal options → produces chunks. This is the retry path.
  // The discovery matrix that pinned the cause (size threshold, RGBA vs I420, per-option isolation,
  // isConfigSupported lying) is recorded in memory/project_safari_videoencoder.md; not re-run here.
  test('VideoEncoder: full-option 1920×1088 yields no output, ½-scale minimal recovers', async () => {
    await navigate(`http://localhost:${VITE_PORT}/demo/index.html`);
    await new Promise(r => setTimeout(r, 1000));

    // Run a one-frame I420 encode inside a Worker and report how many chunks flush() produced.
    const workerEncode = (configJson: string, w: number, h: number) => `
      return new Promise((resolve) => {
        const blob = new Blob([\`
          self.onmessage = async () => {
            const chunks = [];
            try {
              await new Promise((res, rej) => {
                const enc = new VideoEncoder({
                  output(chunk) { chunks.push(chunk.type); },
                  error(e) { rej(e); },
                });
                enc.configure(${configJson});
                const ySize = ${w}*${h}, uvSize = (${w}>>1)*(${h}>>1);
                const buf = new Uint8Array(ySize + uvSize*2); buf.fill(16, 0, ySize); buf.fill(128, ySize);
                const vf = new VideoFrame(buf, { format: 'I420', codedWidth: ${w}, codedHeight: ${h}, timestamp: 0 });
                enc.encode(vf, { keyFrame: true }); vf.close();
                enc.flush().then(() => { enc.close(); res(); }).catch(rej);
              });
              self.postMessage({ status: 'ok', chunks });
            } catch(e) { self.postMessage({ status: 'error', msg: String(e), chunks }); }
          };
        \`], { type: 'application/javascript' });
        const w = new Worker(URL.createObjectURL(blob));
        const timer = setTimeout(() => { w.terminate(); resolve({ status: 'timeout', chunks: [] }); }, 15000);
        w.onmessage = (e) => { clearTimeout(timer); w.terminate(); resolve(e.data); };
        w.onerror = (e) => { clearTimeout(timer); w.terminate(); resolve({ status: 'worker-error', msg: String(e.message), chunks: [] }); };
        w.postMessage(null);
      });
    `;

    // Case 1: full transcoder options at 1920×1088 — the silent failure.
    const full: any = await execute(workerEncode(`{
      codec: 'avc1.4d0028', width: 1920, height: 1088, displayWidth: 1920, displayHeight: 1080,
      bitrate: 8_000_000, framerate: 25, bitrateMode: 'variable', latencyMode: 'realtime',
      hardwareAcceleration: 'prefer-hardware', avc: { format: 'avc' }
    }`, 1920, 1088));
    console.log('Worker 1920×1088 full-option result:', JSON.stringify(full));

    // Case 2: ½-scale minimal options — what the retry path uses.
    const half: any = await execute(workerEncode(`{
      codec: 'avc1.4d001f', width: 960, height: 544,
      bitrate: 2_000_000, framerate: 25, avc: { format: 'avc' }
    }`, 960, 544));
    console.log('Worker 960×544 minimal-option result:', JSON.stringify(half));

    // The bug: full-option 1920×1088 produces no output (status ok/timeout but zero chunks).
    expect(full.chunks?.length ?? 0, `1920×1088 unexpectedly produced output: ${JSON.stringify(full)}`).toBe(0);
    // The workaround: ½-scale minimal config produces chunks.
    expect(half.status, `½-scale encode failed: ${JSON.stringify(half)}`).toBe('ok');
    expect(half.chunks?.length ?? 0, `½-scale produced no output: ${JSON.stringify(half)}`).toBeGreaterThan(0);
  }, 60_000);

});

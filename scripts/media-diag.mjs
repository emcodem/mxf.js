#!/usr/bin/env node
/**
 * Like benchmark-decode.mjs but wires up Chrome's CDP `Media` domain (same mechanism
 * test/e2e/player.test.ts uses) to capture the browser's OWN internal media-pipeline diagnostics —
 * decoder errors, pipeline state changes, dropped-frame reasons — instead of inferring what's wrong
 * from the outside. Built for the Issue A ProRes decode-stall investigation (see
 * todo_transcode_stall_and_fallback.md): the re-encoded H.264 NAL structure checks out as valid, so
 * whatever wedges playback has to show up here if it's a real decoder-side problem.
 *
 * Usage: node scripts/media-diag.mjs <path-to-mxf> [waitMs]
 */
import puppeteer from 'puppeteer';
import { createServer } from 'vite';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const PORT = 5206;

const FILE = process.argv[2];
const WAIT_MS = Number(process.argv[3]) || 60_000;
if (!FILE || !fs.existsSync(FILE)) {
  console.error('Usage: node scripts/media-diag.mjs <path-to-mxf> [waitMs]');
  process.exit(1);
}

function resolveChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  try { return puppeteer.executablePath(); } catch { return undefined; }
}

const vite = await createServer({
  root: projectRoot,
  logLevel: 'silent',
  server: { port: PORT, headers: {}, open: false },
  worker: { format: 'es' },
});
await vite.listen();

const EXTRA_ARGS = process.env.EXTRA_CHROME_ARGS ? process.env.EXTRA_CHROME_ARGS.split(' ') : [];
const browser = await puppeteer.launch({
  headless: !process.env.E2E_HEADFUL,
  executablePath: resolveChrome(),
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-features=WebCodecs', ...EXTRA_ARGS],
});
// A puppeteer-launched window is not necessarily the OS-focused foreground window — Chrome may treat
// it as backgrounded and throttle/suspend GPU-accelerated video decode resources for power savings,
// which would look exactly like a hardware-decoder wedge but actually be a window-focus artifact of
// how this diagnostic launches Chrome, not a real player bug.
async function focusPage(page) {
  await page.bringToFront();
  try { await page.evaluate(() => window.focus()); } catch { /* ignore */ }
}

try {
  const page = await browser.newPage();
  const mediaLogs = [];
  let lastConsoleStall = 0;

  const client = await page.createCDPSession();
  await client.send('Media.enable');
  client.on('Media.playerPropertiesChanged', ({ properties }) => {
    for (const p of properties) mediaLogs.push(`[t+${(Date.now() - t0Ref.t0).toFixed(0)}ms][media:prop] ${p.name}=${p.value}`);
  });
  client.on('Media.playerMessagesLogged', ({ messages }) => {
    for (const m of messages) mediaLogs.push(`[t+${(Date.now() - t0Ref.t0).toFixed(0)}ms][media:${m.level}] ${m.message}`);
  });
  client.on('Media.playerEventsAdded', ({ events }) => {
    for (const e of events) mediaLogs.push(`[t+${(Date.now() - t0Ref.t0).toFixed(0)}ms][media:event] ${e.value}`);
  });
  client.on('Media.playerErrorsRaised', ({ errors }) => {
    for (const e of errors) mediaLogs.push(`[t+${(Date.now() - t0Ref.t0).toFixed(0)}ms][media:ERROR] ${JSON.stringify(e)}`);
  });

  const t0Ref = { t0: Date.now() };

  page.on('pageerror', err => console.log('[pageerror]', err.message));
  page.on('console', msg => {
    const t = msg.text();
    if (/waiting|underrun|FATAL|quota|buffer full|mse\]|stall-watchdog|gate cur/i.test(t)) {
      console.log(`  [t+${(Date.now() - t0Ref.t0).toFixed(0)}ms] [console] ${t}`);
      return;
    }
    if (/stall/i.test(t)) {
      const now = Date.now();
      if (now - lastConsoleStall > 5000) { console.log(`  [t+${(now - t0Ref.t0).toFixed(0)}ms] [console] ${t}`); lastConsoleStall = now; }
    }
  });

  await page.goto(`http://localhost:${PORT}/demo/index.html`, { waitUntil: 'networkidle0' });
  await focusPage(page);
  const input = await page.$('#fileInput');
  await input.uploadFile(FILE);

  await page.waitForFunction(() => {
    const t = document.querySelector('#log')?.textContent ?? '';
    return t.includes('Manifest loaded') || t.includes('FATAL') || t.includes('Error:');
  }, { timeout: 30_000 });

  await focusPage(page);
  t0Ref.t0 = Date.now();
  console.log('--- manifest loaded, watching playback + CDP Media domain ---');

  const start = Date.now();
  let lastT = -1;
  let stuckSince = null;
  while (Date.now() - start < WAIT_MS) {
    const s = await page.evaluate(() => {
      const v = document.querySelector('#video');
      return { t: v.currentTime, ended: v.ended, paused: v.paused, readyState: v.readyState };
    });
    if (s.t !== lastT) {
      console.log(`  [t+${(Date.now() - t0Ref.t0).toFixed(0)}ms] currentTime=${s.t.toFixed(3)} paused=${s.paused} readyState=${s.readyState}`);
      lastT = s.t;
      stuckSince = Date.now();
    } else if (stuckSince && Date.now() - stuckSince > 25000) {
      console.log(`  >>> STUCK at currentTime=${s.t.toFixed(3)} for 8s+ (paused=${s.paused}, readyState=${s.readyState}) — dumping media log and exiting <<<`);
      break;
    }
    if (s.ended) { console.log('  ended=true'); break; }
    await new Promise(r => setTimeout(r, 300));
  }

  console.log('\n=== CDP Media domain log ===');
  for (const line of mediaLogs) console.log(line);
  console.log(`=== end (${mediaLogs.length} lines) ===`);
} finally {
  await browser.close();
  await vite.close();
}

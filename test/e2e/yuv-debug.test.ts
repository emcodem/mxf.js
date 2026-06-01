/**
 * Puppeteer test: loads test/e2e/debug.html, decodes the first MPEG-2 video frame,
 * saves the YUV canvas as a PNG, and asserts the frame looks non-trivial.
 *
 * Run: $env:TEST_MXF_FILE="C:/temp/mxf.js/vistek.mxf"; npm run test:e2e
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import puppeteer, { type Browser } from 'puppeteer';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const PORT        = 5198;
const TEST_FILE   = process.env.TEST_MXF_FILE ?? 'C:/temp/mxf.js/vistek.mxf';

let vite:    ViteDevServer;
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
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await vite?.close();
});

describe('MPEG-2 YUV decoder debug', () => {
  test('decodes first video frame and renders non-trivial canvas', async () => {
    if (!fs.existsSync(TEST_FILE)) {
      throw new Error(`Test file not found: ${TEST_FILE}`);
    }

    const page = await browser.newPage();
    const logs: string[] = [];
    page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));

    await page.goto(`http://localhost:${PORT}/test/e2e/debug.html`, { waitUntil: 'networkidle0' });

    const input = await page.$('#fileInput');
    if (!input) throw new Error('#fileInput not found');
    await input.uploadFile(TEST_FILE);

    // Wait until status says "Decoded" or "Error"
    await page.waitForFunction(() => {
      const s = document.getElementById('status')?.textContent ?? '';
      return s.startsWith('Decoded') || s.startsWith('Error') || s.startsWith('No video') || s.startsWith('Decoder');
    }, { timeout: 60_000 });

    // If a reference YUV is present, upload it to trigger the per-MB diff.
    const REF_FILE = process.env.TEST_REF_YUV ?? 'C:/temp/mxf.js/ref.yuv';
    if (fs.existsSync(REF_FILE)) {
      const refInput = await page.$('#refInput');
      if (refInput) {
        await refInput.uploadFile(REF_FILE);
        await page.waitForFunction(
          () => (window as unknown as { __diffDone?: boolean }).__diffDone === true,
          { timeout: 30_000 },
        ).catch(() => { /* fall through; diff logs captured anyway */ });
        await new Promise(r => setTimeout(r, 500));
      }
    }

    const statusText = await page.$eval('#status', el => el.textContent ?? '');
    const infoText   = await page.$eval('#info',   el => el.textContent ?? '');

    console.log('\n=== YUV debug ===');
    console.log('Status:', statusText);
    console.log('Info:\n' + infoText);
    if (logs.length) { console.log('Console:'); logs.forEach(l => console.log(' ', l)); }

    // Save canvas as PNG
    const canvasDataUrl: string = await page.evaluate(() => {
      const c = document.getElementById('yuv') as HTMLCanvasElement;
      return c.width > 0 ? c.toDataURL('image/png') : '';
    });

    if (canvasDataUrl) {
      const pngBuf = Buffer.from(canvasDataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
      const outPath = path.join(projectRoot, 'debug-yuv.png');
      fs.writeFileSync(outPath, pngBuf);
      console.log(`Canvas saved → ${outPath}`);
    }

    // Save the multi-frame montage too (exercises the P/B motion-comp path).
    const montageDataUrl: string = await page.evaluate(() => {
      const c = document.getElementById('montage') as HTMLCanvasElement;
      return c && c.width > 0 ? c.toDataURL('image/png') : '';
    });
    if (montageDataUrl) {
      const buf = Buffer.from(montageDataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
      const outPath = path.join(projectRoot, 'debug-montage.png');
      fs.writeFileSync(outPath, buf);
      console.log(`Montage saved → ${outPath}`);
    }

    // Pixel variance check: sample every 64th pixel, compute std-dev of R channel.
    // A fully-green/corrupt frame has very low variance within uniform regions.
    const pixelStats: { rMean: number; rStd: number; width: number; height: number } =
      await page.evaluate(() => {
        const c = document.getElementById('yuv') as HTMLCanvasElement;
        if (c.width === 0) return { rMean: 0, rStd: 0, width: 0, height: 0 };
        const ctx = c.getContext('2d')!;
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        let sum = 0, count = 0;
        for (let i = 0; i < data.length; i += 4 * 64) { sum += data[i]; count++; }
        const mean = sum / count;
        let variance = 0;
        for (let i = 0; i < data.length; i += 4 * 64) { const d = data[i] - mean; variance += d * d; }
        return {
          rMean: mean,
          rStd: Math.sqrt(variance / count),
          width: c.width,
          height: c.height,
        };
      });

    console.log(`Canvas: ${pixelStats.width}×${pixelStats.height}  R mean=${pixelStats.rMean.toFixed(1)}  R std=${pixelStats.rStd.toFixed(1)}`);

    await page.close();

    expect(statusText, 'Decoder failed').toMatch(/^Decoded/);
    expect(pixelStats.width, 'Canvas not rendered').toBeGreaterThan(0);
    // A std-dev > 5 means the frame has meaningful spatial variation (not solid color)
    expect(pixelStats.rStd, 'Frame looks like a solid color — likely corrupt').toBeGreaterThan(5);
  }, 90_000);
});

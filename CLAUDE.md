# mxf.js

MXF demuxer browser plugin. HTTP Range / File API → Web Worker → fMP4 remux → MSE `<video>`.

## Commands

```powershell
npm run dev        # Vite dev server at localhost:5173
npm test           # vitest unit tests
npm run test:e2e   # Puppeteer E2E — requires TEST_MXF_FILE
$env:TEST_MXF_FILE="C:/temp/mxf.js/vistek.mxf"; npm run test:e2e
npm run typecheck  # tsc --noEmit
```

## E2E test setup

Puppeteer uses system Chrome at `C:\Program Files\Google\Chrome\Application\chrome.exe` (headless — bundled Chromium lacks proprietary codec support).

**E2E tests run the built `dist` bundle** — run `npm run build` after changing player/worker source. Latency test knobs (env vars): `MXF_RATE_HIGH` (bytes/sec, 0=unlimited), `MXF_LAT_HIGH`/`MXF_LAT_LOW` (ms RTT), `TEST_URL_MXF`.

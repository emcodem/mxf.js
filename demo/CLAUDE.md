# demo/ — keyboard transport

JKL: `Space` play/pause, `J`/`L` rewind/fast-forward (1/2/4/8/16× ladder), `K` stop+1×, `←`/`→` frame-step, `↑`/`↓` ±10 s. Rewind uses a 125 ms `setInterval` (MSE has no negative `playbackRate`). Every transport action calls `resetSpeed()` — a leaked rate or running rewind timer causes playback freeze. Regression: `test/e2e/skip-seek-freeze.test.ts`.

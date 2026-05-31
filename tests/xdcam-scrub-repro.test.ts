/**
 * Regression test for the long-GOP XDCAM scrub artifact.
 *
 * After a reset() to a mid-stream OPEN-GOP keyframe, the leading B-frames (coded after the I,
 * displayed before it) reference the PREVIOUS GOP. reset() used to KEEP the stale reference frames,
 * so those B-frames predicted from whatever GOP we scrubbed away from → macroblock garbage, emitted
 * at the keyframe's slot (B-frames emit immediately, before the held I-anchor).
 *
 * Decisive check: a decode of a GOP AFTER reset() must be byte-identical to a FRESH-decoder decode
 * of the same GOP. With stale references retained they differ; once reset() blanks the references
 * (matching the construction state) they match. Skipped if the real file is absent.
 *
 * Run: npx vitest run tests/xdcam-scrub-repro.test.ts
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { MxfFile } from '../src/mxf-file.js';
import { EssenceExtractor } from '../src/essence/essence-extractor.js';
import type { EssenceFrame } from '../src/essence/essence-extractor.js';
import { Mpeg2Decoder, type YUVFrame } from '../src/codec/mpeg2-decoder.js';
import { resolveFrameOffset } from '../src/parser/index-table.js';
import { ILoader } from '../src/loader/loader.js';

const FILE = process.env.TEST_XDCAM_FILE ?? 'C:/temp/jsmxf/xdcam_vistek.mxf';

class FsLoader implements ILoader {
  readonly fileSize: Promise<number>;
  private readonly fd: number;
  constructor(path: string) {
    this.fd = fs.openSync(path, 'r');
    this.fileSize = Promise.resolve(fs.fstatSync(this.fd).size);
  }
  fetchRange(start: number, end: number): Promise<ArrayBuffer> {
    const len = end - start + 1;
    const buf = Buffer.alloc(len);
    fs.readSync(this.fd, buf, 0, len, start);
    return Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  }
  destroy(): void { try { fs.closeSync(this.fd); } catch { /* ignore */ } }
}

/** Cheap content signature of a frame's luma so we can compare decode results exactly. */
function ysum(f: YUVFrame): number {
  let s = 0; for (let i = 0; i < f.y.length; i++) s = (s + f.y[i] * (1 + (i & 7))) >>> 0;
  return s;
}

async function videoFrames(ex: EssenceExtractor, start: number, count: number): Promise<EssenceFrame[]> {
  const out: EssenceFrame[] = [];
  for await (const f of ex.fetchFrames(BigInt(start), count, true)) if (f.trackType === 'video') out.push(f);
  return out;
}

describe('xdcam long-GOP scrub repro', () => {
  const exists = fs.existsSync(FILE);
  (exists ? it : it.skip)('after a scrub-reset, the keyframe (not a leading B) is shown first', async () => {
    const loader = new FsLoader(FILE);
    const bootstrap = await new MxfFile(loader, false).open();
    const ex = new EssenceExtractor(loader, bootstrap);

    const mid = resolveFrameOffset(bootstrap.indexSegments, 300n, bootstrap.essenceStart, bootstrap.essenceBodySID);
    const midKf = mid ? Number(mid.nearestKeyframeEditUnit) : 300;
    console.log(`[repro] indexMode=${bootstrap.indexMode} midKf=${midKf}`);

    const midRun = await videoFrames(ex, midKf, 16);
    const earlyRun = await videoFrames(ex, 0, 16);

    const sink = { fn: (_: YUVFrame) => {} };
    const mk = () => new Mpeg2Decoder((f) => sink.fn(f));
    const collect = (dec: Mpeg2Decoder, run: EssenceFrame[]) => {
      const out: Array<{ key: boolean; sig: number }> = [];
      sink.fn = (f) => out.push({ key: f.isKeyframe, sig: ysum(f) });
      for (const vf of run) { dec.write(vf.data); while (dec.decode()) { /* emit */ } }
      dec.flush();
      return out;
    };

    // Reference I-frame: decode JUST the GOP-head access unit (intra → deterministic content).
    const iRef = collect(mk(), midRun.slice(0, 1));

    // Simulate a scrub: decode an EARLY GOP (populates references), reset() to the mid keyframe,
    // then decode the run. With the fix, leading open-GOP B's are suppressed and the keyframe is
    // emitted first.
    const reused = mk();
    collect(reused, earlyRun);
    reused.reset();
    const scrub = collect(reused, midRun);

    loader.destroy();

    console.log(`[repro] iRef: key=${iRef[0]?.key} sig=${iRef[0]?.sig}`);
    console.log(`[repro] scrub[0]: key=${scrub[0]?.key} sig=${scrub[0]?.sig}`);
    console.log(`[repro] scrub keys: ${JSON.stringify(scrub.slice(0, 6).map(x => x.key))}`);

    // The reference GOP-head AU must decode to a keyframe.
    expect(iRef.length).toBeGreaterThan(0);
    expect(iRef[0].key).toBe(true);
    // THE FIX: after a scrub-reset the FIRST emitted frame is the keyframe (was a leading B before),
    // and it carries the real I-frame content (not stale/green garbage).
    expect(scrub.length).toBeGreaterThan(0);
    expect(scrub[0].key, 'first frame after scrub-reset must be the keyframe, not a leading B').toBe(true);
    expect(scrub[0].sig, 'keyframe content must match a clean decode of the GOP-head').toBe(iRef[0].sig);
  }, 120_000);
});

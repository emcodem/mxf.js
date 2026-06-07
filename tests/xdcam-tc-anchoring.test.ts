/**
 * System Item timecode is PRESENTATION-TIMELINE metadata anchored by content-package (storage) edit
 * unit — NOT a per-picture property carried through the MPEG-2 B-frame reorder.
 *
 * In this file the System Item TC counts linearly per content package (cp118→…04:18, cp119→…04:19, …),
 * independent of the coded picture sharing that package. The worker anchors TC by storage edit unit
 * (demux-worker buildTcAnchors) and the player resolves nearest-preceding-anchor + offset against the
 * presentation edit unit. Because cp index and presentation slot advance in lockstep, that resolution
 * reproduces the per-cp TC exactly for the continuous run, and surfaces a deliberate single outlier
 * (faked 11:00:05:00 at cp125) at its own edit-unit slot. This test guards both the file invariant and
 * the anchor→resolve math (replicated inline; the worker/player functions aren't import-safe in node).
 * Self-skips if the sample file is absent.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { MxfFile } from '../src/mxf-file.js';
import { EssenceExtractor } from '../src/essence/essence-extractor.js';
import { ILoader } from '../src/loader/loader.js';
import { formatTimecode, frameCountToTimecode, timecodeToFrameCount, type Timecode } from '../src/parser/timecode.js';

const FILE = 'C:/dev/mxf.js/media/xdcamhd_1920_25i_16tracks.mxf';

class FsLoader implements ILoader {
  readonly fileSize: Promise<number>;
  private readonly fd: number;
  constructor(p: string) { this.fd = fs.openSync(p, 'r'); this.fileSize = Promise.resolve(fs.fstatSync(this.fd).size); }
  fetchRange(s: number, e: number): Promise<ArrayBuffer> {
    const l = e - s + 1; const b = Buffer.alloc(l); fs.readSync(this.fd, b, 0, l, s);
    return Promise.resolve(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
  }
  destroy(): void { try { fs.closeSync(this.fd); } catch { /* ignore */ } }
}

interface Anchor { editUnit: number; frameCount: number; base: number; dropFrame: boolean }

/** Mirror of demux-worker.buildTcAnchors: keep frames that break linear continuation. */
function buildTcAnchors(pairs: { editUnit: number; tc?: Timecode }[]): Anchor[] {
  const sorted = pairs.filter(p => p.tc).sort((a, b) => a.editUnit - b.editUnit);
  const anchors: Anchor[] = [];
  let prev: Anchor | null = null;
  for (const p of sorted) {
    const tc = p.tc!;
    const fc = timecodeToFrameCount(tc);
    if (prev && prev.base === tc.base && prev.dropFrame === tc.dropFrame &&
        fc === prev.frameCount + (p.editUnit - prev.editUnit)) continue;
    prev = { editUnit: p.editUnit, frameCount: fc, base: tc.base, dropFrame: tc.dropFrame };
    anchors.push(prev);
  }
  return anchors;
}

/** Mirror of mxf-player.systemTimecodeAt: nearest preceding anchor + linear offset. */
function resolveAt(anchors: Anchor[], editUnit: number): string | null {
  let best: Anchor | null = null;
  for (const a of anchors) if (a.editUnit <= editUnit && (!best || a.editUnit > best.editUnit)) best = a;
  if (!best) return null;
  return formatTimecode(frameCountToTimecode(best.frameCount + (editUnit - best.editUnit), best.base, best.dropFrame));
}

describe('xdcam System Item TC anchoring (by edit unit)', () => {
  const ok = fs.existsSync(FILE);
  (ok ? it : it.skip)('SYS TC counts linearly per content package; outlier sits at its own edit unit', async () => {
    const loader = new FsLoader(FILE);
    const b = await new MxfFile(loader, false).open();
    const ex = new EssenceExtractor(loader, b);

    const stor: { editUnit: number; tc?: Timecode }[] = [];
    let eu = 0;
    for await (const f of ex.fetchFrames(0n, 135, true)) {
      if (f.trackType === 'video') stor.push({ editUnit: eu++, tc: f.systemTimecode });
    }
    loader.destroy();
    expect(stor.length).toBeGreaterThan(130);

    // Invariant: TC is monotonic +1 per content package, EXCEPT the single faked outlier at cp125.
    for (let i = 1; i < stor.length; i++) {
      if (i === 125 || i === 126) continue; // outlier + its resume break linearity by design
      const a = stor[i - 1].tc, c = stor[i].tc;
      if (!a || !c) continue;
      expect(timecodeToFrameCount(c)).toBe(timecodeToFrameCount(a) + 1);
    }
    expect(stor[125].tc && formatTimecode(stor[125].tc)).toBe('11:00:05:00');

    // The continuous run compresses to few anchors (one per linear segment), and resolving by
    // presentation edit unit reproduces each content package's own TC.
    const anchors = buildTcAnchors(stor);
    expect(anchors.length).toBeLessThan(5); // ~3: start, the fake at 125, resume at 126

    expect(resolveAt(anchors, 120)).toBe('10:00:04:20');
    expect(resolveAt(anchors, 124)).toBe('10:00:04:24');
    expect(resolveAt(anchors, 125)).toBe('11:00:05:00'); // outlier surfaces at its OWN edit-unit slot
    expect(resolveAt(anchors, 126)).toBe('10:00:05:01');
    expect(resolveAt(anchors, 130)).toBe('10:00:05:05');
  }, 60000);
});

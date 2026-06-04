/**
 * SMPTE timecode math + formatting, shared by the header-metadata path (computed Material/Source
 * package start timecode) and the per-frame System Item path. Pure / dependency-free / unit-tested.
 *
 * A {@link Timecode} is HH:MM:SS:FF plus its rounded frame `base` (e.g. 25, 30) and a drop-frame flag.
 * The two conversions are exact inverses; drop-frame is the standard NTSC algorithm (Andrew Duncan's),
 * computed purely from the ROUNDED base + integer drop count (2 frames/min for base 30, 4 for base 60,
 * none dropped on every 10th minute), so 29.97/59.94 need only `base = round(actualRate)`.
 */

export interface Timecode {
  hours: number;
  minutes: number;
  seconds: number;
  frames: number;
  dropFrame: boolean;
  /** Rounded timecode base (frames per second, e.g. 25 or 30). 0 = unknown. */
  base: number;
}

function pad2(n: number): string {
  return (n < 10 ? '0' : '') + n;
}

/** Drop-frame applies only to base 30 (29.97) and 60 (59.94). */
function isDrop(base: number, dropFrame: boolean): boolean {
  return dropFrame && (base === 30 || base === 60);
}

function dropPerMinute(base: number): number {
  return base === 60 ? 4 : 2; // base === 30
}

/** Absolute frame index (frames since 00:00:00:00) for a timecode at its own base. */
export function timecodeToFrameCount(tc: Timecode): number {
  const base = tc.base;
  if (base <= 0) return 0;
  let fc = ((tc.hours * 60 + tc.minutes) * 60 + tc.seconds) * base + tc.frames;
  if (isDrop(base, tc.dropFrame)) {
    const drop = dropPerMinute(base);
    const totalMinutes = tc.hours * 60 + tc.minutes;
    fc -= drop * (totalMinutes - Math.floor(totalMinutes / 10));
  }
  return fc;
}

/** Inverse of {@link timecodeToFrameCount}: a frame index → HH:MM:SS:FF at `base`. */
export function frameCountToTimecode(frameCount: number, base: number, dropFrame: boolean): Timecode {
  if (base <= 0) return { hours: 0, minutes: 0, seconds: 0, frames: 0, dropFrame: false, base };
  let fn = frameCount < 0 ? 0 : Math.floor(frameCount);
  const df = isDrop(base, dropFrame);
  if (df) {
    const drop = dropPerMinute(base);
    const framesPer10Min = base * 600 - drop * 9; // 17982 for base 30
    const framesPerMin = base * 60 - drop;        // 1798 for base 30
    const d = Math.floor(fn / framesPer10Min);
    const m = fn % framesPer10Min;
    fn += drop * 9 * d + (m > drop ? drop * Math.floor((m - drop) / framesPerMin) : 0);
  }
  const frames = fn % base;
  const seconds = Math.floor(fn / base) % 60;
  const minutes = Math.floor(fn / (base * 60)) % 60;
  const hours = Math.floor(fn / (base * 3600)) % 24;
  return { hours, minutes, seconds, frames, dropFrame: df, base };
}

/** "HH:MM:SS:FF" (drop-frame uses ";" before the frames field, per convention). */
export function formatTimecode(tc: Timecode): string {
  const sep = isDrop(tc.base, tc.dropFrame) ? ';' : ':';
  return `${pad2(tc.hours)}:${pad2(tc.minutes)}:${pad2(tc.seconds)}${sep}${pad2(tc.frames)}`;
}

function inRange(tc: Timecode, base: number): boolean {
  return tc.hours >= 0 && tc.hours < 24 &&
         tc.minutes >= 0 && tc.minutes < 60 &&
         tc.seconds >= 0 && tc.seconds < 60 &&
         tc.frames >= 0 && (base <= 0 || tc.frames < Math.max(base, 1) + 4); // tolerate >base for HFR/odd bases
}

/**
 * Decode an 8-byte SMPTE 12M timecode word (LTC/VITC BCD packing, as carried in the MXF System Item
 * and in TimecodeComponent arrays). Tens/units are BCD nibbles; the top bits of each byte are flag
 * bits (colour-frame, drop-frame, field/BGF) masked off here. `base` is filled by the caller (the
 * BCD word does not carry the frame rate). Returns null only if `bytes` is too short.
 */
export function decodeSmpte12mBcd(bytes: Uint8Array, base = 0): Timecode | null {
  if (bytes.length < 4) return null;
  const frames  = (bytes[0] & 0x0f) + ((bytes[0] >> 4) & 0x03) * 10;
  const dropFrame = (bytes[0] & 0x40) !== 0;
  const seconds = (bytes[1] & 0x0f) + ((bytes[1] >> 4) & 0x07) * 10;
  const minutes = (bytes[2] & 0x0f) + ((bytes[2] >> 4) & 0x07) * 10;
  const hours   = (bytes[3] & 0x0f) + ((bytes[3] >> 4) & 0x03) * 10;
  return { hours, minutes, seconds, frames, dropFrame, base };
}

/**
 * Best-effort extraction of the per-frame timecode from an MXF Generic Container **System Item**
 * value (SMPTE ST 385 System Metadata Pack). The pack starts with a fixed header (bitmap, rate,
 * type, channel handle, continuity count = 7 bytes) and may carry two 17-byte timestamps, each
 * `[type(1)][SMPTE-12M(8)][date(8)]` with a `0x81` coding byte: a **Creation** Date/Time stamp
 * (earlier, constant for the file) followed by the **User** Date/Time stamp — the per-frame TIMECODE.
 *
 * The exact offsets are bitmap-driven and vary by encoder (D-10 CP vs XDCAM/XAVC GC), and a fixed
 * offset can land on the constant creation stamp or on trailing zero padding (which decodes to a
 * valid `00:00:00:00` — so the timecode appears frozen). To avoid that we scan for the `0x81` coding
 * byte and take the **LAST** in-range candidate (User Date comes after Creation). Every candidate is
 * range-checked, so an unrecognised layout yields null (no system TC) — never a wrong timecode. The
 * `0x80` field/BGF flag some 50p/59.94p files set in the hours byte (each TC value spanning two
 * output frames) is masked off by decodeSmpte12mBcd. See scripts/verify-meta.mjs to dump raw bytes.
 */
export function parseSystemItemTimecode(value: Uint8Array, base: number): Timecode | null {
  // Prefer the LAST 0x81-marked, in-range SMPTE-12M word: that's the User Date/Time (the timecode),
  // not the earlier (constant) Creation stamp, and not trailing zeros.
  let last: Timecode | null = null;
  for (let i = 7; i + 9 <= value.length; i++) {
    if (value[i] !== 0x81) continue;
    const tc = decodeSmpte12mBcd(value.subarray(i + 1, i + 9), base);
    if (tc && inRange(tc, base)) last = tc;
  }
  if (last) return last;

  // Fallback for encoders that don't write the 0x81 coding byte: the standard fixed offsets.
  const tryAt = (tsOffset: number): Timecode | null => {
    if (tsOffset + 9 > value.length) return null;
    const tc = decodeSmpte12mBcd(value.subarray(tsOffset + 1, tsOffset + 9), base);
    return tc && inRange(tc, base) ? tc : null;
  };
  return tryAt(40) ?? tryAt(23);
}

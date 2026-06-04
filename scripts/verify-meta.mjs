// Validation harness for per-frame System Item timecode parsing.
//
//   node scripts/verify-meta.mjs <file.mxf> [maxFrames=10]
//
// Walks KLV packets from the start of the file and, for each Generic Container System Item
// (key bytes [8..11] = 0D 01 03 01, item byte [12] = 0x04 CP / 0x14 GC), prints the raw value
// bytes plus a best-effort SMPTE 12M timecode decode at the standard offsets and via a scan. Use
// this to confirm the byte offset per format (D-10 CP vs XDCAM/XAVC GC) against ffprobe / bmx, then
// tune src/parser/timecode.ts:parseSystemItemTimecode if a format sits at a different offset.
//
// Pure / dependency-free (mirrors the decode in src/parser/timecode.ts) so it runs without a build.

import { readFileSync } from 'node:fs';

const path = process.argv[2];
const maxFrames = Number(process.argv[3] ?? 10);
if (!path) { console.error('usage: node scripts/verify-meta.mjs <file.mxf> [maxFrames]'); process.exit(1); }

const buf = readFileSync(path);

function berLength(off) {
  const first = buf[off];
  if (first < 0x80) return { length: first, bytesRead: 1 };
  const n = first & 0x7f;
  let len = 0;
  for (let i = 0; i < n; i++) len = len * 256 + buf[off + 1 + i];
  return { length: len, bytesRead: 1 + n };
}

function hex(bytes) { return [...bytes].map(b => b.toString(16).padStart(2, '0')).join(' '); }

function decodeBcd(b) {
  if (b.length < 4) return null;
  const frames  = (b[0] & 0x0f) + ((b[0] >> 4) & 0x03) * 10;
  const dropFrame = (b[0] & 0x40) !== 0;
  const seconds = (b[1] & 0x0f) + ((b[1] >> 4) & 0x07) * 10;
  const minutes = (b[2] & 0x0f) + ((b[2] >> 4) & 0x07) * 10;
  const hours   = (b[3] & 0x0f) + ((b[3] >> 4) & 0x03) * 10;
  return { hours, minutes, seconds, frames, dropFrame };
}
const inRange = tc => tc && tc.hours < 24 && tc.minutes < 60 && tc.seconds < 60 && tc.frames < 64;
const fmt = tc => tc ? `${p2(tc.hours)}:${p2(tc.minutes)}:${p2(tc.seconds)}${tc.dropFrame ? ';' : ':'}${p2(tc.frames)}` : '(none)';
const p2 = n => String(n).padStart(2, '0');

// All 0x81-marked, in-range SMPTE-12M candidates (creation stamp, user/TC stamp, …) in offset order.
// The parser uses the LAST one (User Date/Time = the per-frame timecode).
function candidates(value) {
  const out = [];
  for (let i = 7; i + 9 <= value.length; i++) {
    if (value[i] !== 0x81) continue;
    const tc = decodeBcd(value.subarray(i + 1, i + 9));
    if (inRange(tc)) out.push({ off: i, tc });
  }
  return out;
}

let off = 0, seen = 0;
const limit = Math.min(buf.length, 64 * 1024 * 1024); // scan up to 64 MB
while (off + 17 <= buf.length && seen < maxFrames) {
  const key = buf.subarray(off, off + 16);
  const { length, bytesRead } = berLength(off + 16);
  const valueOff = off + 16 + bytesRead;
  if (valueOff + length > buf.length) break;

  const isGC = key[8] === 0x0d && key[9] === 0x01 && key[10] === 0x03 && key[11] === 0x01;
  const isSystem = isGC && (key[12] === 0x04 || key[12] === 0x14);
  if (isSystem) {
    const value = buf.subarray(valueOff, valueOff + length);
    const cands = candidates(value);
    const chosen = cands.length ? cands[cands.length - 1] : null; // parser picks the LAST (User Date)
    console.log(`\n# System Item @${off}  key[12]=0x${key[12].toString(16)}  len=${length}`);
    console.log(`  value: ${hex(value.subarray(0, Math.min(value.length, 64)))}${value.length > 64 ? ' …' : ''}`);
    console.log(`  0x81 candidates: ${cands.length ? cands.map(c => `@${c.off}=${fmt(c.tc)}`).join('  ') : '(none)'}`);
    console.log(`  → chosen (User Date): ${fmt(chosen?.tc)}`);
    seen++;
  }
  off = valueOff + length;
  if (off > limit) break;
}
if (seen === 0) console.log('No System Items found in the scanned region.');

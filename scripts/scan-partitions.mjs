// Scan an MXF for partition packs → tells whether a "growing" file is one continuous MXF
// (a single header partition) or concatenated segments (many header/footer partitions), and
// reports each partition's kind + open/closed status. Useful for diagnosing live/growing sources.
//   node scripts/scan-partitions.mjs <path-to.mxf>
import fs from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('usage: node scripts/scan-partitions.mjs <path-to.mxf>');
  process.exit(2);
}
const fd = fs.openSync(path, 'r');
const size = fs.fstatSync(fd).size;
const PREFIX = Buffer.from([0x06, 0x0e, 0x2b, 0x34, 0x02, 0x05, 0x01, 0x01, 0x0d, 0x01, 0x02, 0x01, 0x01]);
const KIND = { 0x02: 'HEADER', 0x03: 'BODY', 0x04: 'FOOTER' };
const STAT = { 0x01: 'OpenInc', 0x02: 'ClosedInc', 0x03: 'OpenComp', 0x04: 'ClosedComp' };
const CHUNK = 8 * 1024 * 1024, OV = 16;
let pos = 0, carry = Buffer.alloc(0);
const found = [];
const buf = Buffer.alloc(CHUNK);
while (pos < size) {
  const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
  if (n <= 0) break;
  const hay = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
  const base = pos - carry.length;
  let i = 0;
  while ((i = hay.indexOf(PREFIX, i)) !== -1) {
    if (i + 16 <= hay.length) {
      found.push({ off: base + i, kind: KIND[hay[i + 13]] || ('0x' + hay[i + 13].toString(16)), status: STAT[hay[i + 14]] || ('0x' + hay[i + 14].toString(16)) });
      i += 16;
    } else break;
  }
  carry = hay.subarray(Math.max(0, hay.length - OV));
  pos += n;
}
fs.closeSync(fd);
console.log(`file size: ${(size / 1048576).toFixed(1)} MB`);
console.log(`partition packs found: ${found.length}`);
const byKind = {};
for (const f of found) byKind[f.kind + '/' + f.status] = (byKind[f.kind + '/' + f.status] || 0) + 1;
console.log('by kind/status:', JSON.stringify(byKind));
console.log('first 14:');
found.slice(0, 14).forEach(f => console.log(`  @${f.off} (${(f.off / 1048576).toFixed(2)} MB) ${f.kind} ${f.status}`));
const hdrs = found.filter(f => f.kind === 'HEADER');
if (hdrs.length > 1) console.log(`HEADER spacing[0..1]: ${((hdrs[1].off - hdrs[0].off) / 1048576).toFixed(2)} MB`);

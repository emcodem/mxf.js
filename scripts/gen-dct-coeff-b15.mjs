/**
 * Converts the FFmpeg ff_mpeg2_vlc_table (Table B-15, alternate DCT coefficient
 * VLC for MPEG-2 intra blocks) into the ternary-tree format used by mpeg2-decoder.ts.
 *
 * Source data from libavcodec/mpeg12data.c (LGPL, Fabrice Bellard / Michael Niedermayer).
 *
 * Run with: node scripts/gen-dct-coeff-b15.mjs
 */

// ff_mpeg2_vlc_table[i] = [code_msb_first, bit_length]
// Indices 0..MPEG12_RL_NB_ELEMS-1 correspond to ff_mpeg12_run / ff_mpeg12_level.
// Last 2 entries: escape (index 111) and EOB (index 112).
const MPEG12_RL_NB_ELEMS = 111;

const ff_mpeg2_vlc = [
  [0x02, 2], [0x06, 3], [0x07, 4], [0x1c, 5],
  [0x1d, 5], [0x05, 6], [0x04, 6], [0x7b, 7],
  [0x7c, 7], [0x23, 8], [0x22, 8], [0xfa, 8],
  [0xfb, 8], [0xfe, 8], [0xff, 8], [0x1f,14],
  [0x1e,14], [0x1d,14], [0x1c,14], [0x1b,14],
  [0x1a,14], [0x19,14], [0x18,14], [0x17,14],
  [0x16,14], [0x15,14], [0x14,14], [0x13,14],
  [0x12,14], [0x11,14], [0x10,14], [0x18,15],
  [0x17,15], [0x16,15], [0x15,15], [0x14,15],
  [0x13,15], [0x12,15], [0x11,15], [0x10,15],
  [0x02, 3], [0x06, 5], [0x79, 7], [0x27, 8],
  [0x20, 8], [0x16,13], [0x15,13], [0x1f,15],
  [0x1e,15], [0x1d,15], [0x1c,15], [0x1b,15],
  [0x1a,15], [0x19,15], [0x13,16], [0x12,16],
  [0x11,16], [0x10,16], [0x05, 5], [0x07, 7],
  [0xfc, 8], [0x0c,10], [0x14,13], [0x07, 5],
  [0x26, 8], [0x1c,12], [0x13,13], [0x06, 6],
  [0xfd, 8], [0x12,12], [0x07, 6], [0x04, 9],
  [0x12,13], [0x06, 7], [0x1e,12], [0x14,16],
  [0x04, 7], [0x15,12], [0x05, 7], [0x11,12],
  [0x78, 7], [0x11,13], [0x7a, 7], [0x10,13],
  [0x21, 8], [0x1a,16], [0x25, 8], [0x19,16],
  [0x24, 8], [0x18,16], [0x05, 9], [0x17,16],
  [0x07, 9], [0x16,16], [0x0d,10], [0x15,16],
  [0x1f,12], [0x1a,12], [0x19,12], [0x17,12],
  [0x16,12], [0x1f,13], [0x1e,13], [0x1d,13],
  [0x1c,13], [0x1b,13], [0x1f,16], [0x1e,16],
  [0x1d,16], [0x1c,16], [0x1b,16],
  [0x01, 6], // escape → 0xffff
  [0x06, 4], // EOB    → 0xFFFE  (different from B-14's 0x0001 trick)
];

const ff_mpeg12_level = [
   1,  2,  3,  4,  5,  6,  7,  8,
   9, 10, 11, 12, 13, 14, 15, 16,
  17, 18, 19, 20, 21, 22, 23, 24,
  25, 26, 27, 28, 29, 30, 31, 32,
  33, 34, 35, 36, 37, 38, 39, 40,
   1,  2,  3,  4,  5,  6,  7,  8,
   9, 10, 11, 12, 13, 14, 15, 16,
  17, 18,  1,  2,  3,  4,  5,  1,
   2,  3,  4,  1,  2,  3,  1,  2,
   3,  1,  2,  3,  1,  2,  1,  2,
   1,  2,  1,  2,  1,  2,  1,  2,
   1,  2,  1,  2,  1,  2,  1,  2,
   1,  1,  1,  1,  1,  1,  1,  1,
   1,  1,  1,  1,  1,  1,  1,
];

const ff_mpeg12_run = [
   0,  0,  0,  0,  0,  0,  0,  0,
   0,  0,  0,  0,  0,  0,  0,  0,
   0,  0,  0,  0,  0,  0,  0,  0,
   0,  0,  0,  0,  0,  0,  0,  0,
   0,  0,  0,  0,  0,  0,  0,  0,
   1,  1,  1,  1,  1,  1,  1,  1,
   1,  1,  1,  1,  1,  1,  1,  1,
   1,  1,  2,  2,  2,  2,  2,  3,
   3,  3,  3,  4,  4,  4,  5,  5,
   5,  6,  6,  6,  7,  7,  8,  8,
   9,  9, 10, 10, 11, 11, 12, 12,
  13, 13, 14, 14, 15, 15, 16, 16,
  17, 18, 19, 20, 21, 22, 23, 24,
  25, 26, 27, 28, 29, 30, 31,
];

// Build (bits_string → result_value) map
const entries = []; // { bits: string, value: number }

for (let i = 0; i < MPEG12_RL_NB_ELEMS; i++) {
  const [code, len] = ff_mpeg2_vlc[i];
  const run   = ff_mpeg12_run[i];
  const level = ff_mpeg12_level[i];
  const value = (run << 8) | level;
  const bits  = code.toString(2).padStart(len, '0');
  entries.push({ bits, value });
}
// Escape: index 111
{
  const [code, len] = ff_mpeg2_vlc[111];
  entries.push({ bits: code.toString(2).padStart(len, '0'), value: 0xffff });
}
// EOB: index 112 — use 0xFFFE (handled explicitly in decodeBlock for B-15)
{
  const [code, len] = ff_mpeg2_vlc[112];
  entries.push({ bits: code.toString(2).padStart(len, '0'), value: 0xFFFE });
}

// Build the ternary tree.
// Each node: [left_state_or_0, right_state_or_0, terminal_value_or_0]
// Non-terminal: codeTable[node] != 0 (points to child node index)
// Terminal:     codeTable[node] == 0 AND codeTable[node+2] != 0
// Layout: node i uses indices [i, i+1, i+2].

const nodes = [[0, 0, 0]]; // node 0 = root

function getOrCreateChild(nodeIdx, bit) {
  if (nodes[nodeIdx][bit] === 0) {
    const childIdx = nodes.length * 3;
    nodes.push([0, 0, 0]);
    nodes[nodeIdx][bit] = childIdx;
  }
  return nodes[nodeIdx][bit] / 3;
}

for (const { bits, value } of entries) {
  let nodeIdx = 0;
  for (let b = 0; b < bits.length - 1; b++) {
    nodeIdx = getOrCreateChild(nodeIdx, parseInt(bits[b]));
  }
  // Last bit → terminal
  const lastBit = parseInt(bits[bits.length - 1]);
  if (nodes[nodeIdx][lastBit] !== 0) {
    console.error(`COLLISION at node ${nodeIdx}, bit ${lastBit}, bits=${bits}, value=${value.toString(16)}`);
    process.exit(1);
  }
  // Create terminal node
  const termIdx = nodes.length * 3;
  nodes.push([0, 0, value]);
  nodes[nodeIdx][lastBit] = termIdx;
}

// Flatten the node array
const flat = [];
for (const node of nodes) {
  flat.push(...node);
}

// Verify no collisions
console.log(`Tree nodes: ${nodes.length}, flat entries: ${flat.length}`);

// Output as TypeScript const
const rows = [];
for (let i = 0; i < flat.length; i += 12) {
  rows.push('  ' + flat.slice(i, i + 12).join(', ') + ',');
}
console.log(`\nconst DCT_COEFF_B15 = new Int32Array([\n${rows.join('\n')}\n]);`);

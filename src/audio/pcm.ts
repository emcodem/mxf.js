/**
 * MXF PCM sound-essence → interleaved Float32 decoder.
 *
 * MXF stores uncompressed audio as little-endian signed PCM, but two container layouts occur
 * in the wild and both must be handled the same way downstream (a single interleaved Float32
 * buffer for Web Audio):
 *
 *  - **Multiple mono elements per edit unit** (e.g. XDCAM HD422): each channel is its own
 *    GC sound element (`blockAlign = bytesPerSample`, descriptor `channelCount = 1`), and a
 *    content package carries N of them in channel order (elnum 0..N-1).
 *  - **One interleaved element per edit unit** (e.g. XAVC / AVC-Intra): a single element holds
 *    all channels interleaved (`blockAlign = channelCount * bytesPerSample`).
 *
 * Both reduce to: per edit unit, the sound elements (in file order) are channel groups; within
 * an element, `channelsPerElement` channels are interleaved at `bytesPerSample` each. The global
 * channel index is `elementIndex * channelsPerElement + channelInElement`.
 *
 * Samples are sign-extended little-endian and normalised to [-1, 1) using the container size
 * (left-justified, the WAVE convention — a 20-bit sample in a 3-byte container reads correctly).
 */

export interface PcmLayout {
  /** Bits per sample from the descriptor (QuantizationBits, e.g. 16 or 24). */
  bitDepth: number;
  /** WAVE block align of one element = channelsPerElement * bytesPerSample (0 if unknown). */
  blockAlign: number;
  /** Descriptor channel count (channels carried per element). Fallback when blockAlign is 0. */
  channelCount: number;
}

export interface PcmElement {
  /** Edit unit this sound element belongs to (groups channels of one content package). */
  editUnit: number | bigint;
  /** Raw little-endian PCM bytes (the KLV value). */
  data: ArrayBuffer;
  /** True for AES3-wrapped sound (SMPTE 331M / D-10): 4-byte header + 8×32-bit subframe words. */
  aes3?: boolean;
}

export interface DecodedPcm {
  /** Interleaved Float32 samples, `channelCount` channels. */
  samples: Float32Array;
  /** Total channels = elementsPerEditUnit * channelsPerElement. */
  channelCount: number;
}

/**
 * Decode a run of PCM sound essence elements (one fetch segment) into one interleaved Float32
 * buffer. Elements must be supplied in file order; they are grouped by `editUnit` so the
 * channel ordering of separate-mono layouts is preserved across edit units.
 */
/** Group elements by edit unit, preserving first-seen (file) order both across and within groups. */
function groupByEditUnit(elements: PcmElement[]): { order: string[]; groups: Map<string, ArrayBuffer[]> } {
  const groups = new Map<string, ArrayBuffer[]>();
  const order: string[] = [];
  for (const el of elements) {
    const key = String(el.editUnit);
    let g = groups.get(key);
    if (!g) { g = []; groups.set(key, g); order.push(key); }
    g.push(el.data);
  }
  return { order, groups };
}

/**
 * Decode AES3-wrapped sound (SMPTE 331M / D-10): each element is a 4-byte header followed by
 * interleaved 8-channel 32-bit little-endian subframe words; the 24-bit audio sample sits in bits
 * 4–27 (i.e. `(word >> 4) & 0xFFFFFF`, signed). Unused channels carry only channel-status bits and
 * decode to silence. Output mirrors the plain-PCM path: one interleaved Float32 buffer.
 */
function decodeAes3Elements(elements: PcmElement[]): DecodedPcm {
  const HEADER = 4, CHANNELS = 8, WORD = 4, STRIDE = CHANNELS * WORD;
  const { order, groups } = groupByEditUnit(elements);
  if (order.length === 0) return { samples: new Float32Array(0), channelCount: CHANNELS };

  const elementsPerEditUnit = groups.get(order[0])!.length;
  const totalChannels = Math.max(1, elementsPerEditUnit * CHANNELS);
  const framesIn = (b: ArrayBuffer) => Math.max(0, Math.floor((b.byteLength - HEADER) / STRIDE));

  let totalFrames = 0;
  for (const key of order) { const g = groups.get(key)!; totalFrames += g.length ? framesIn(g[0]) : 0; }

  const out = new Float32Array(totalFrames * totalChannels);
  const norm = 8388608; // 2^23
  let frameBase = 0;
  for (const key of order) {
    const g = groups.get(key)!;
    const framesHere = g.length ? framesIn(g[0]) : 0;
    const elems = Math.min(g.length, elementsPerEditUnit);
    for (let e = 0; e < elems; e++) {
      const dv = new DataView(g[e]);
      for (let s = 0; s < framesHere; s++) {
        const rowBase = (frameBase + s) * totalChannels + e * CHANNELS;
        const sampBase = HEADER + s * STRIDE;
        for (let c = 0; c < CHANNELS; c++) {
          const word = dv.getUint32(sampBase + c * WORD, true);
          let v = (word >>> 4) & 0xffffff;
          if (v & 0x800000) v -= 0x1000000; // sign-extend 24-bit
          out[rowBase + c] = v / norm;
        }
      }
    }
    frameBase += framesHere;
  }
  return { samples: out, channelCount: totalChannels };
}

export function decodePcmElements(elements: PcmElement[], layout: PcmLayout): DecodedPcm {
  if (elements.length > 0 && elements[0].aes3) return decodeAes3Elements(elements);

  const bytesPerSample = Math.max(1, Math.round(layout.bitDepth / 8));
  const channelsPerElement = layout.blockAlign > 0
    ? Math.max(1, Math.round(layout.blockAlign / bytesPerSample))
    : Math.max(1, layout.channelCount);
  const stride = channelsPerElement * bytesPerSample; // bytes per interleaved sample-frame

  const { order, groups } = groupByEditUnit(elements);
  if (order.length === 0) return { samples: new Float32Array(0), channelCount: Math.max(1, layout.channelCount) };

  const elementsPerEditUnit = groups.get(order[0])!.length;
  const totalChannels = Math.max(1, elementsPerEditUnit * channelsPerElement);

  // Sum samples-per-channel across edit units (first element of each group defines its length).
  let totalFrames = 0;
  for (const key of order) {
    const g = groups.get(key)!;
    totalFrames += g.length ? Math.floor(g[0].byteLength / stride) : 0;
  }

  const out = new Float32Array(totalFrames * totalChannels);
  const norm = Math.pow(2, bytesPerSample * 8 - 1);
  const signShift = 32 - bytesPerSample * 8;

  let frameBase = 0;
  for (const key of order) {
    const g = groups.get(key)!;
    const framesHere = g.length ? Math.floor(g[0].byteLength / stride) : 0;
    // Only iterate channels we actually have elements for (guards a ragged final group).
    const elems = Math.min(g.length, elementsPerEditUnit);
    for (let e = 0; e < elems; e++) {
      const bytes = new Uint8Array(g[e]);
      for (let s = 0; s < framesHere; s++) {
        const rowBase = (frameBase + s) * totalChannels + e * channelsPerElement;
        for (let c = 0; c < channelsPerElement; c++) {
          const o = s * stride + c * bytesPerSample;
          let v = 0;
          for (let b = 0; b < bytesPerSample; b++) v |= bytes[o + b] << (8 * b);
          v = (v << signShift) >> signShift; // arithmetic sign-extend to 32-bit
          out[rowBase + c] = v / norm;
        }
      }
    }
    frameBase += framesHere;
  }

  return { samples: out, channelCount: totalChannels };
}

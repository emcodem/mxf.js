export interface BerLength {
  length: number;
  bytesRead: number;
}

export function decodeBerLength(view: DataView, offset: number): BerLength {
  const first = view.getUint8(offset);
  if (first < 0x80) {
    return { length: first, bytesRead: 1 };
  }
  const numBytes = first & 0x7f;
  if (numBytes === 0) {
    throw new Error('Indefinite BER length not supported');
  }
  if (numBytes > 6) {
    throw new Error(`BER length too large: ${numBytes} bytes`);
  }
  let length = 0;
  for (let i = 0; i < numBytes; i++) {
    length = (length * 256) + view.getUint8(offset + 1 + i);
  }
  return { length, bytesRead: 1 + numBytes };
}

export function encodeBerLength(length: number): Uint8Array {
  if (length < 0x80) {
    return new Uint8Array([length]);
  }
  if (length < 0x100) {
    return new Uint8Array([0x81, length]);
  }
  if (length < 0x10000) {
    return new Uint8Array([0x82, (length >> 8) & 0xff, length & 0xff]);
  }
  if (length < 0x1000000) {
    return new Uint8Array([0x83, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]);
  }
  return new Uint8Array([
    0x84,
    (length >>> 24) & 0xff,
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
  ]);
}

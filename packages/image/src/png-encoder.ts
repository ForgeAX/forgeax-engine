import pako from 'pako';

/** Deterministic RGBA8 PNG (filter 0, zlib level 6); no browser canvas required. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++)
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const chunks = [
    pngChunk('IHDR', header),
    pngChunk('IDAT', pako.deflate(raw, { level: 6 })),
    pngChunk('IEND', new Uint8Array()),
  ];
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const out = new Uint8Array(8 + chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  out.set(signature);
  let cursor = 8;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return out;
}

function pngChunk(type: string, body: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(body.byteLength + 12);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, body.byteLength);
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(body, 8);
  view.setUint32(8 + body.byteLength, crc32(chunk.subarray(4, 8 + body.byteLength)));
  return chunk;
}

let crcTable: Uint32Array | undefined;

function crc32(bytes: Uint8Array): number {
  if (crcTable === undefined) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function chunk(type: string, data: Uint8Array): number[] {
  const body = new Uint8Array([...Array.from(type, (ch) => ch.charCodeAt(0)), ...data]);
  return [...u32(data.length), ...body, ...u32(crc32(body))];
}

/** zlib stream made of stored (uncompressed) deflate blocks, so no compressor is needed. */
function zlibStored(raw: Uint8Array): Uint8Array {
  const out: number[] = [0x78, 0x01];
  for (let offset = 0; offset < raw.length || offset === 0; offset += 65535) {
    const block = raw.subarray(offset, Math.min(raw.length, offset + 65535));
    const final = offset + 65535 >= raw.length ? 1 : 0;
    out.push(
      final,
      block.length & 0xff,
      block.length >>> 8,
      ~block.length & 0xff,
      (~block.length >>> 8) & 0xff,
      ...block,
    );
    if (final) break;
  }
  let a = 1;
  let b = 0;
  for (const byte of raw) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  out.push(...u32(((b << 16) | a) >>> 0));
  return new Uint8Array(out);
}

/** Encodes RGBA8 pixels as a valid 8-bit truecolor-alpha PNG. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++)
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const ihdr = new Uint8Array([...u32(width), ...u32(height), 8, 6, 0, 0, 0]);
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk('IHDR', ihdr),
    ...chunk('IDAT', zlibStored(raw)),
    ...chunk('IEND', new Uint8Array()),
  ]);
}

/** Radiance RGBE with new-style RLE scanlines; every pixel is `rgbe`. */
export function encodeHdr(
  width: number,
  height: number,
  rgbe: readonly [number, number, number, number],
): Uint8Array {
  const header = Array.from(
    `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`,
    (ch) => ch.charCodeAt(0),
  );
  const body: number[] = [];
  for (let y = 0; y < height; y++) {
    body.push(2, 2, width >>> 8, width & 0xff);
    for (const channel of rgbe) body.push(128 + width, channel);
  }
  return new Uint8Array([...header, ...body]);
}

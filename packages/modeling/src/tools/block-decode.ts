/**
 * Reference decoders for the two-channel block formats the Renderer samples normal
 * maps from (BC4 / BC5, Microsoft block compression specification), so verification
 * measures the bytes a GPU would read rather than the encoder's intermediate.
 */

/** One BC4 block (8 bytes) to 16 unorm8 values, texel-major within the 4x4 block. */
export function decodeBc4Block(block: Uint8Array): Uint8Array {
  const r0 = block[0] as number;
  const r1 = block[1] as number;
  const palette = [r0, r1];
  if (r0 > r1) {
    for (let k = 1; k < 7; k++) palette.push(Math.floor(((7 - k) * r0 + k * r1 + 3) / 7));
  } else {
    for (let k = 1; k < 5; k++) palette.push(Math.floor(((5 - k) * r0 + k * r1 + 2) / 5));
    palette.push(0, 255);
  }
  const out = new Uint8Array(16);
  let bits = 0;
  let have = 0;
  let next = 2;
  for (let t = 0; t < 16; t++) {
    while (have < 3) {
      bits |= (block[next++] as number) << have;
      have += 8;
    }
    out[t] = palette[bits & 7] as number;
    bits >>>= 3;
    have -= 3;
  }
  return out;
}

/** A BC4 (`channels` 1) or BC5 (`channels` 2) level to tight unorm8 texels. */
export function decodeBcLevel(
  data: Uint8Array,
  width: number,
  height: number,
  channels: 1 | 2,
): Uint8Array {
  const out = new Uint8Array(width * height * channels);
  const bw = Math.ceil(width / 4);
  const stride = 8 * channels;
  for (let by = 0; by < Math.ceil(height / 4); by++) {
    for (let bx = 0; bx < bw; bx++) {
      const o = (by * bw + bx) * stride;
      for (let c = 0; c < channels; c++) {
        const values = decodeBc4Block(data.subarray(o + c * 8, o + c * 8 + 8));
        for (let t = 0; t < 16; t++) {
          const x = bx * 4 + (t % 4);
          const y = by * 4 + Math.floor(t / 4);
          if (x < width && y < height) out[(y * width + x) * channels + c] = values[t] as number;
        }
      }
    }
  }
  return out;
}

// f32-to-f16-bytes.ts — IEEE 754 binary16 half-float conversion.
//
// Pure arithmetic codec extracted from runtime/render-resource-table.ts (D-3)
// so build-time image-importer and runtime uploadCubemapFromEquirect share
// a single SSOT. Takes a Uint8Array view over packed Float32 RGBA pixels
// and returns a Uint8Array with half the byte length of the equivalent
// binary16 interleaved pixels (little-endian).
//
// Out-of-range f32 values saturate to +/-inf, NaN propagates, and subnormals
// round-to-zero (industry-standard f32->f16 path, semantic-preserving
// extraction).
//
// Related: plan-strategy §2 D-3; research Finding 5 + C3; requirements C3;
//          w1 test file: packages/math/src/__tests__/f32-to-f16-bytes.test.ts.

/**
 * Convert a packed float32 RGBA byte buffer into the equivalent float16 RGBA
 * byte buffer (IEEE 754 binary16, little-endian). The output length is
 * `src.byteLength / 2`.
 *
 * @param src A Uint8Array whose underlying buffer is an interleaved Float32Array.
 * @returns A Uint8Array of packed binary16 pixels, exactly half the length.
 */
export function f32ToF16Bytes(src: Uint8Array): Uint8Array {
  const f32 = new Float32Array(src.buffer, src.byteOffset, src.byteLength / 4);
  const out = new Uint8Array(f32.length * 2);
  const view = new DataView(out.buffer);
  const scratch = new ArrayBuffer(4);
  const scratchF = new Float32Array(scratch);
  const scratchU = new Uint32Array(scratch);
  for (let i = 0; i < f32.length; i++) {
    scratchF[0] = f32[i] ?? 0;
    const bits = scratchU[0] ?? 0;
    const sign = (bits >>> 31) & 0x1;
    const exp = (bits >>> 23) & 0xff;
    let mant = bits & 0x7fffff;
    let half: number;
    if (exp === 0xff) {
      half = (sign << 15) | 0x7c00 | (mant ? 0x200 : 0);
    } else if (exp === 0) {
      half = sign << 15;
    } else {
      const e = exp - 127 + 15;
      if (e >= 0x1f) {
        half = (sign << 15) | 0x7c00;
      } else if (e <= 0) {
        if (e < -10) {
          half = sign << 15;
        } else {
          mant = (mant | 0x800000) >> (1 - e);
          if (mant & 0x1000) mant += 0x2000;
          half = (sign << 15) | (mant >> 13);
        }
      } else {
        if (mant & 0x1000) {
          mant += 0x2000;
          if (mant & 0x800000) {
            mant = 0;
            half = (sign << 15) | ((e + 1) << 10);
          } else {
            half = (sign << 15) | (e << 10) | (mant >> 13);
          }
        } else {
          half = (sign << 15) | (e << 10) | (mant >> 13);
        }
      }
    }
    view.setUint16(i * 2, half & 0xffff, true);
  }
  return out;
}

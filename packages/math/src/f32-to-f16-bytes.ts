// IEEE 754 binary16 codec shared by import, upload and readback.
// Conversion first rounds to float32, then to the nearest binary16 value;
// midpoint ties round away from zero. Overflow becomes signed infinity.

const scratchF32 = new Float32Array(1);
const scratchU32 = new Uint32Array(scratchF32.buffer);

/** Encode one number as binary16 bits, including signed zero and quiet NaN. */
export function f32ToF16(value: number): number {
  scratchF32[0] = value;
  const bits = scratchU32[0] ?? 0;
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
  return half & 0xffff;
}

/** Convert packed, aligned float32 bytes to little-endian binary16 bytes. */
export function f32ToF16Bytes(src: Uint8Array): Uint8Array {
  const f32 = new Float32Array(src.buffer, src.byteOffset, src.byteLength / 4);
  const out = new Uint8Array(f32.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < f32.length; i++) {
    view.setUint16(i * 2, f32ToF16(f32[i] ?? 0), true);
  }
  return out;
}

/** Decode one IEEE 754 binary16 bit pattern, preserving signed zero, subnormals and infinities. */
export function f16ToF32(bits: number): number {
  const sign = (bits & 0x8000) === 0 ? 1 : -1;
  const exponent = (bits >>> 10) & 0x1f;
  const fraction = bits & 0x03ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

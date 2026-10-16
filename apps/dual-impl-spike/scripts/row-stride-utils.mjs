// apps/dual-impl-spike/scripts/row-stride-utils.mjs
//
// 256-byte row stride padding helpers (feat-20260511-asset-system-v1
// M6 / w17; D-P6 + R-1 padding helper isolation per plan-strategy §3).
//
// WebGPU `GPUImageDataLayout.bytesPerRow` is normatively required to be
// a multiple of 256 when copies span multiple rows (W3C §GPUImageDataLayout
// 6.1.1; research Finding 3). The dual-impl spike uploads a tightly-packed
// 4x4 RGBA8 texel block (16 bytes per row * 4 rows = 64 bytes tight) but
// must pad to bytesPerRow=256 on the upload side AND must allocate a 256-
// byte-stride readback buffer on the copyTextureToBuffer side. This helper
// SSOT-lives the padding math once so the spike cell, its unit test, and
// any future AI-user AssetRegistry Node-path texture upload all consume
// the same round-trip invariant.
//
// Invariants (byte-exact, ε=0):
//   padRowStride(tight, width, height, bpp, stride):
//     - tight.byteLength === width * height * bpp
//     - returns Uint8Array of size stride * height
//     - for each row r in [0, height): padded[r*stride .. r*stride + width*bpp] == tight[r*width*bpp ..]
//     - remaining stride - width*bpp bytes per row are zero-filled
//   unpadRowStride(padded, width, height, bpp, stride):
//     - inverse of padRowStride; ignores any bytes in the per-row tail
//     - returns Uint8Array of size width * height * bpp
//
// Purity: both helpers are pure data-transform functions; no GPU + no fetch.
// Safe to import from vitest (no top-level awaits + no binding side-effects).

/** 256-byte row stride required by WebGPU spec for multi-row copies. */
export const WEBGPU_COPY_BYTES_PER_ROW_ALIGNMENT = 256;

/**
 * Compute the minimum 256-byte-aligned bytesPerRow for a tight-packed row
 * of `width * bpp` bytes. The value is a multiple of
 * WEBGPU_COPY_BYTES_PER_ROW_ALIGNMENT (256) that fits the whole row.
 *
 * Examples: alignedBytesPerRow(4, 4) === 256 (4x4 RGBA8: tight=16, pad=256).
 */
export function alignedBytesPerRow(width, bytesPerPixel) {
  if (!Number.isInteger(width) || width <= 0) {
    throw new Error(`alignedBytesPerRow: width must be positive integer, got ${width}`);
  }
  if (!Number.isInteger(bytesPerPixel) || bytesPerPixel <= 0) {
    throw new Error(`alignedBytesPerRow: bytesPerPixel must be positive integer, got ${bytesPerPixel}`);
  }
  const tight = width * bytesPerPixel;
  return Math.ceil(tight / WEBGPU_COPY_BYTES_PER_ROW_ALIGNMENT) * WEBGPU_COPY_BYTES_PER_ROW_ALIGNMENT;
}

/**
 * Pad a tight-packed pixel buffer (size = width*height*bpp) into a padded
 * buffer (size = alignedBytesPerRow(width, bpp) * height). Trailing tail
 * bytes in each row are zero-filled. Used for queue.writeTexture upload
 * when the source is a packed Uint8Array and the RHI shim requires
 * bytesPerRow % 256 == 0.
 *
 * @param {Uint8Array} tight source (width * height * bpp bytes)
 * @param {number} width
 * @param {number} height
 * @param {number} bpp bytes per pixel
 * @returns {{ padded: Uint8Array, bytesPerRow: number }}
 */
export function padRowStride(tight, width, height, bpp) {
  const bytesPerRow = alignedBytesPerRow(width, bpp);
  const tightRow = width * bpp;
  const expected = tightRow * height;
  if (tight.byteLength !== expected) {
    throw new Error(`padRowStride: tight length ${tight.byteLength} !== ${expected} (width=${width} * height=${height} * bpp=${bpp})`);
  }
  const padded = new Uint8Array(bytesPerRow * height);
  for (let r = 0; r < height; r++) {
    padded.set(tight.subarray(r * tightRow, (r + 1) * tightRow), r * bytesPerRow);
  }
  return { padded, bytesPerRow };
}

/**
 * Inverse of padRowStride. Extracts the tight-packed bytes from a padded
 * readback buffer (output of copyTextureToBuffer), dropping the per-row
 * tail bytes.
 *
 * @param {Uint8Array} padded readback buffer (bytesPerRow * height)
 * @param {number} width
 * @param {number} height
 * @param {number} bpp bytes per pixel
 * @param {number} bytesPerRow row stride in the padded buffer (must be multiple of 256 and >= width*bpp)
 * @returns {Uint8Array} tight buffer of size width*height*bpp
 */
export function unpadRowStride(padded, width, height, bpp, bytesPerRow) {
  if (!Number.isInteger(bytesPerRow) || bytesPerRow % WEBGPU_COPY_BYTES_PER_ROW_ALIGNMENT !== 0) {
    throw new Error(`unpadRowStride: bytesPerRow ${bytesPerRow} must be positive multiple of ${WEBGPU_COPY_BYTES_PER_ROW_ALIGNMENT}`);
  }
  const tightRow = width * bpp;
  if (bytesPerRow < tightRow) {
    throw new Error(`unpadRowStride: bytesPerRow ${bytesPerRow} < tightRow ${tightRow}`);
  }
  const expectedPadded = bytesPerRow * height;
  if (padded.byteLength < expectedPadded) {
    throw new Error(`unpadRowStride: padded length ${padded.byteLength} < ${expectedPadded}`);
  }
  const out = new Uint8Array(tightRow * height);
  for (let r = 0; r < height; r++) {
    out.set(padded.subarray(r * bytesPerRow, r * bytesPerRow + tightRow), r * tightRow);
  }
  return out;
}

/**
 * Byte-exact equality check (ε=0) for two Uint8Array buffers. Returns
 * { equal: true } on match; { equal: false, firstDiffIndex, a, b } on
 * first mismatch so the spike caller can render a structured verdict.
 *
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 */
export function bytesEqual(a, b) {
  if (a.byteLength !== b.byteLength) {
    return { equal: false, reason: 'length-mismatch', aLength: a.byteLength, bLength: b.byteLength };
  }
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) {
      return { equal: false, reason: 'byte-mismatch', firstDiffIndex: i, a: a[i], b: b[i] };
    }
  }
  return { equal: true };
}

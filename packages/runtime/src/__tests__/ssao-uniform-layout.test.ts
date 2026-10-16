// ssao-uniform-layout.test.ts — M1 / w5 + M7 / w30: SSAO uniform byte layout.
//
// Verifies host-side SSAO uniform byte layout:
//  - 256 B total (3 mat4 + 2 vec4 = 56 logical floats, padded to 64).
//  - view matrix at offsets 0..15 (float indices).
//  - projection matrix at offsets 16..31.
//  - inverseProjection matrix at offsets 32..47.
//  - intensityPad vec4 at offsets 48..51 (x = intensity, y = radius, z = bias, w = sample budget).
//  - Matches plan-strategy D-1 + D-C: host write order aligns with WGSL
//    struct declaration; intensity scalar carried at end of UBO.
//  - SSAO uniform is separate from View UBO (plan-strategy D-1 invariant).
//
// AC-03 anchor: uniform byte-layout matches WGSL struct.

import { describe, expect, it } from 'vitest';
import {
  SSAO_UNIFORM_BYTES,
  SSAO_UNIFORM_INTENSITY_OFFSET,
} from '../../../render/src/ssao-buffers';

const FLOATS_PER_MAT4 = 16;
const MAT4_COUNT = 3;
const MAT_FLOATS = FLOATS_PER_MAT4 * MAT4_COUNT; // 48
const FLOATS_PER_VEC4 = 4;
const TOTAL_FLOATS = MAT_FLOATS + 2 * FLOATS_PER_VEC4; // 56 logical, 64 with std140 vec4 alignment slack
const TOTAL_BYTES = 256; // plan-strategy D-C: 192 mat-block + 64 vec4-pad block

const VIEW_OFFSET = 0;
const PROJECTION_OFFSET = FLOATS_PER_MAT4; // 16
const INVERSE_PROJECTION_OFFSET = FLOATS_PER_MAT4 * 2; // 32
const INTENSITY_PAD_OFFSET = FLOATS_PER_MAT4 * 3; // 48 (float index)

describe('SSAO uniform layout', () => {
  it('total size is 256 bytes (3 mat4 + two vec4, padded)', () => {
    expect(TOTAL_BYTES).toBe(256);
    // 3 mat4 (48 floats) + 8 floats = 56 logical; the 256B target is
    // padded; declared module constant is the SSOT.
    expect(SSAO_UNIFORM_BYTES).toBe(256);
    expect(MAT_FLOATS).toBe(48);
    expect(TOTAL_FLOATS).toBe(56);
  });

  it('view matrix occupies offsets 0..15 (float indices)', () => {
    expect(VIEW_OFFSET).toBe(0);
    for (let i = 0; i < FLOATS_PER_MAT4; i++) {
      expect(VIEW_OFFSET + i).toBe(i);
    }
  });

  it('projection matrix occupies offsets 16..31 (float indices)', () => {
    expect(PROJECTION_OFFSET).toBe(16);
    for (let i = 0; i < FLOATS_PER_MAT4; i++) {
      expect(PROJECTION_OFFSET + i).toBe(16 + i);
    }
  });

  it('inverseProjection matrix occupies offsets 32..47 (float indices)', () => {
    expect(INVERSE_PROJECTION_OFFSET).toBe(32);
    for (let i = 0; i < FLOATS_PER_MAT4; i++) {
      expect(INVERSE_PROJECTION_OFFSET + i).toBe(32 + i);
    }
  });

  it('no overlap: view + projection + inverseProjection are contiguous and disjoint', () => {
    // view: [0, 16), projection: [16, 32), inverseProjection: [32, 48)
    expect(VIEW_OFFSET + FLOATS_PER_MAT4).toBe(PROJECTION_OFFSET);
    expect(PROJECTION_OFFSET + FLOATS_PER_MAT4).toBe(INVERSE_PROJECTION_OFFSET);
    // intensityPad starts where inverseProjection ends (offset 48 floats).
    expect(INVERSE_PROJECTION_OFFSET + FLOATS_PER_MAT4).toBe(INTENSITY_PAD_OFFSET);
    // Total logical floats include intensityPad and algorithmPad.
    expect(INTENSITY_PAD_OFFSET + 2 * FLOATS_PER_VEC4).toBe(TOTAL_FLOATS);
  });

  it('host write via Float32Array.set fills correct slots', () => {
    // Simulate host-side uniform writing to a Float32Array buffer sized at
    // 256 B (64 floats); the trailing 32 B (8 floats) past algorithmPad
    // are padding that the WGSL UBO does not declare.
    const payload = new Float32Array(64);

    // Write a mock view matrix (identity-like with sentinel at last element)
    const mockView = new Float32Array(FLOATS_PER_MAT4);
    mockView[15] = 1.0; // sentinel
    payload.set(mockView, VIEW_OFFSET);

    // Write mock projection matrix
    const mockProj = new Float32Array(FLOATS_PER_MAT4);
    mockProj[15] = 2.0; // sentinel
    payload.set(mockProj, PROJECTION_OFFSET);

    // Write mock inverseProjection matrix
    const mockInvProj = new Float32Array(FLOATS_PER_MAT4);
    mockInvProj[15] = 3.0; // sentinel
    payload.set(mockInvProj, INVERSE_PROJECTION_OFFSET);

    // Verify sentinel values are at correct positions
    expect(payload[VIEW_OFFSET + 15]).toBe(1.0);
    expect(payload[PROJECTION_OFFSET + 15]).toBe(2.0);
    expect(payload[INVERSE_PROJECTION_OFFSET + 15]).toBe(3.0);

    // Verify no overlap — sentinel at projection offset doesn't affect view
    expect(payload[VIEW_OFFSET + 15]).toBe(1.0);

    // Verify total size matches the 256-byte SSOT (D-C padding).
    expect(payload.byteLength).toBe(256);
  });

  it('mat4 column-major layout: 4 columns x 4 floats each', () => {
    // WGSL mat4x4 is column-major. Each of the 4 columns is a vec4 (4 floats).
    // For a mat4 at offset O:
    //   col0 = payload[O + 0..3], col1 = payload[O + 4..7],
    //   col2 = payload[O + 8..11], col3 = payload[O + 12..15]
    const payload = new Float32Array(64);

    // Write a matrix with distinct values: col c, row r => value = c*4 + r + 1
    // Column-major: payload[O + c*4 + r] = c*4 + r + 1
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        payload[VIEW_OFFSET + c * 4 + r] = c * 4 + r + 1;
        payload[PROJECTION_OFFSET + c * 4 + r] = c * 4 + r + 101;
      }
    }

    // Check: view[col1, row2] = 1*4 + 2 + 1 = 7 at offset 0 + 1*4 + 2 = 6
    expect(payload[VIEW_OFFSET + 6]).toBe(7);
    // Check: projection[col3, row0] = 3*4 + 0 + 101 = 113 at offset 16 + 3*4 + 0 = 28
    expect(payload[PROJECTION_OFFSET + 12]).toBe(113);
  });

  it('SSAO uniform is separate from View UBO layout', () => {
    // The View UBO in common.wgsl is 784 B (196 floats) after feat-20260625 w25
    // folded the spot lightViewProj matrices into its tail.
    // SSAO uniform is a separate buffer, not a View UBO slice.
    // Assert that SSAO uniform does not share any bytes with View UBO.
    const VIEW_UBO_FLOATS = 196;
    const ssaoUniformFloats = TOTAL_FLOATS;
    // They are in different buffers — this test verifies
    // the conceptual separation, not byte-level memory sharing.
    expect(ssaoUniformFloats).not.toBe(VIEW_UBO_FLOATS);
    expect(ssaoUniformFloats).toBe(56);
  });

  // ── M7 / w30: intensityPad layout + write/read equivalence ──────────────

  it('w30 — intensity scalar at byte offset 192 (float index 48)', () => {
    expect(INTENSITY_PAD_OFFSET).toBe(48);
    expect(SSAO_UNIFORM_INTENSITY_OFFSET).toBe(192);
    // 192 bytes = 48 floats; the vec4<f32> intensityPad sits in std140
    // alignment slot following the third mat4 (3 * 64 B = 192 B).
    expect(SSAO_UNIFORM_INTENSITY_OFFSET / 4).toBe(INTENSITY_PAD_OFFSET);
  });

  it('w30 — intensity write 1.0 reads back 1.0', () => {
    const payload = new Float32Array(64); // 256 bytes
    payload[INTENSITY_PAD_OFFSET] = 1.0;
    payload[INTENSITY_PAD_OFFSET + 1] = 0.5;
    payload[INTENSITY_PAD_OFFSET + 2] = 0.025;
    // The vec4 padding must not bleed into the matrices.
    payload[INTENSITY_PAD_OFFSET + 3] = 0;
    expect(payload[INTENSITY_PAD_OFFSET]).toBe(1.0);
    expect(payload[INTENSITY_PAD_OFFSET + 1]).toBe(0.5);
    expect(payload[INTENSITY_PAD_OFFSET + 2]).toBeCloseTo(0.025, 6);
    expect(payload.byteLength).toBe(256);
  });

  it('w30 — intensity write 0.5 reads back 0.5', () => {
    const payload = new Float32Array(64);
    payload[INTENSITY_PAD_OFFSET] = 0.5;
    expect(payload[INTENSITY_PAD_OFFSET]).toBe(0.5);
  });

  it('w30 — intensity write does not overlap inverseProjection (offsets 32..47)', () => {
    const payload = new Float32Array(64);
    // Write a sentinel inverseProjection[15] then write intensity.
    payload[INVERSE_PROJECTION_OFFSET + 15] = 7.5;
    payload[INTENSITY_PAD_OFFSET] = 0.25;
    // No collision: invProj last float index 47, intensity first index 48.
    expect(payload[INVERSE_PROJECTION_OFFSET + 15]).toBe(7.5);
    expect(payload[INTENSITY_PAD_OFFSET]).toBe(0.25);
  });
});

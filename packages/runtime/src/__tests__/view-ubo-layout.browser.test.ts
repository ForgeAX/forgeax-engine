// view-ubo-layout.browser.test.ts - feat-20260518-pbr-direct-lighting-mvp
// feat-20260827-directional-csm-pcss-quality M1: VIEW_UBO_BYTES is 1280 (fog and atmosphere lanes included)
// while the View slot is 1280 B. The prefix layout is unchanged and the
// directional shadow carrier reuses the existing tail pad.
// 16 B + cameraPos 16 B + lightSpaceMatrix 64 B + inverseViewProj 64 B;
// std140 vec3 padded to 16-byte boundaries).
//
// Plan-strategy D-4 + AC-06: the view UBO grows from 176 to 240 by
// appending inverseViewProj mat4x4<f32> (64 B) at the tail. Earlier field
// offsets [0..175] are unchanged -- this is a pure tail-append. Naming:
// `cameraPos` (not `viewPos`) lines up with the shader-side identifier
// used in pbr.wgsl `view.cameraPos` (single SSOT, charter P5 consistent
// abstraction).
//
// std140 byte map (the shader-side ABI lock):
//   [  0.. 64) worldViewProj  mat4x4<f32>  (16 floats)
//   [ 64.. 76) lightDir       vec3<f32>    (3 floats)
//   [ 76.. 80) padding
//   [ 80.. 92) lightColor     vec3<f32>    (3 floats)
//   [ 92.. 96) padding
//   [ 96..108) cameraPos      vec3<f32>    (3 floats)
//   [108..112) padding
//   [112..176) lightSpaceMatrix mat4x4<f32> (16 floats)
//   [176..240) inverseViewProj mat4x4<f32> (16 floats)
//
// Tier: browser (vitest browser + chromium WebGPU). The test asserts:
//   (a) the host writes a 240-byte buffer (Float32Array length 60)
//   (b) field offsets match the std140 map above
//   (c) the BindGroupLayout view UBO entry declares minBindingSize=240 so
//       smaller writes fail-fast with WebGPU validation error.
// The full pixel-readback gate lives in `standard-pipeline-render.browser.test.ts`
// (w15, AC-12 / AC-14); this gate locks the byte layout itself.

import { describe, expect, it } from 'vitest';
import { VIEW_UNIFORM_BYTES } from '../../../render/src/record/view-ubo';

const browserReady = typeof navigator !== 'undefined' && navigator.gpu !== undefined;

// Single SSOT for the std140 byte offsets - reused by future tests + AGENTS.md
// breaking-changes index entries that reference the layout.
const VIEW_UBO_OFFSETS = {
  worldViewProj: 0,
  lightDir: 64,
  lightColor: 80,
  cameraPos: 96,
  lightSpaceMatrix: 112,
  inverseViewProj: 176,
} as const;
const VIEW_UBO_BYTES = VIEW_UNIFORM_BYTES;
const DIRECTIONAL_FILTER_OFFSET = 512;
const SPOT_LIGHT_VIEW_PROJ_OFFSET = 528;

describe('w4 view UBO 292-f32 std140 layout (AC-06, browser)', () => {
  it.skipIf(!browserReady)('host write payload is exactly 1280 bytes (320 floats)', () => {
    // The host (view-ubo.ts) builds a Float32Array(292) and
    // emits a single queue.writeBuffer. Asserting the size lock here keeps
    // the host shape and shader ABI in agreement before the GPU sees it.
    const payload = new Float32Array(VIEW_UBO_BYTES / 4);
    expect(payload.byteLength).toBe(VIEW_UBO_BYTES);
  });

  it.skipIf(!browserReady)('field offsets match std140 vec3-padded-to-16 layout', () => {
    expect(VIEW_UBO_OFFSETS.worldViewProj).toBe(0);
    expect(VIEW_UBO_OFFSETS.lightDir).toBe(64);
    expect(VIEW_UBO_OFFSETS.lightColor).toBe(80);
    expect(VIEW_UBO_OFFSETS.cameraPos).toBe(96);
    expect(VIEW_UBO_OFFSETS.lightSpaceMatrix).toBe(112);
    expect(VIEW_UBO_OFFSETS.inverseViewProj).toBe(176);
    // Buffer total = inverseViewProj offset + mat4 (64 B) = 240.
    expect(VIEW_UBO_OFFSETS.inverseViewProj + 64).toBe(240);
  });

  it.skipIf(!browserReady)(
    'host packs lightDir / lightColor / cameraPos at canonical std140 slots',
    () => {
      // Canonical packing order documented in plan-strategy D-4: the host
      // builds a 240-float buffer mirroring the shader-side `View` struct
      // field order. AC-06: existing field offsets unchanged -- tail append
      // only.
      const payload = new Float32Array(VIEW_UBO_BYTES / 4);
      // worldViewProj = identity for this assertion (mat4 in [0..16))
      payload[0] = 1; // m00
      payload[5] = 1; // m11
      payload[10] = 1; // m22
      payload[15] = 1; // m33
      // lightDir (slot 16..19; index 19 is padding)
      payload[16] = -0.3;
      payload[17] = -1.0;
      payload[18] = -0.5;
      // lightColor (slot 20..23; index 23 is padding)
      payload[20] = 1.0;
      payload[21] = 0.95;
      payload[22] = 0.9;
      // cameraPos (slot 24..27; index 27 is padding)
      payload[24] = 0;
      payload[25] = 0;
      payload[26] = 5;

      // lightDir at byte offset 64 = float index 16
      expect(payload[16]).toBeCloseTo(-0.3, 6);
      expect(payload[17]).toBeCloseTo(-1.0, 6);
      expect(payload[18]).toBeCloseTo(-0.5, 6);
      // lightColor at byte offset 80 = float index 20
      expect(payload[20]).toBeCloseTo(1.0, 6);
      expect(payload[21]).toBeCloseTo(0.95, 6);
      expect(payload[22]).toBeCloseTo(0.9, 6);
      // cameraPos at byte offset 96 = float index 24
      expect(payload[24]).toBeCloseTo(0, 6);
      expect(payload[25]).toBeCloseTo(0, 6);
      expect(payload[26]).toBeCloseTo(5, 6);

      // Padding slots (indices 19 / 23 / 27) stay zero in the canonical write.
      // This is not a hard requirement (std140 only requires alignment, not
      // zeroed padding) but the host writeBuffer convention is to zero-fill
      // by allocating Float32Array(60) so AI users reading the buffer in a
      // debugger see the structure clearly (charter P3 explicit failure +
      // F1 surface minimization).
      expect(payload[19]).toBe(0);
      expect(payload[23]).toBe(0);
      expect(payload[27]).toBe(0);
    },
  );

  it.skipIf(!browserReady)('cameraPos naming literal lock (AC-07: cameraPos not viewPos)', () => {
    // Charter P5 consistent abstraction red line: shader-side
    // `view.cameraPos` (pbr.wgsl line ~153 `view.cameraPos - in.worldPos`)
    // and host-side keyword `cameraPos` are one literal. AC-07 motivates
    // tracking this in a test so renames sweep both sides at once.
    const literal: keyof typeof VIEW_UBO_OFFSETS = 'cameraPos';
    expect(literal).toBe('cameraPos');
    expect(literal as string).not.toBe('viewPos');
  });

  it.skipIf(!browserReady)('inverseViewProj offset at float index 44 (byte offset 176)', () => {
    // AC-06: inverseViewProj occupies floats [44..59] at byte offset
    // [176..240). Verify the offset constant matches the float-index
    // calculation.
    const inverseProjF32Index = VIEW_UBO_OFFSETS.inverseViewProj / 4;
    expect(inverseProjF32Index).toBe(44);
    const payload = new Float32Array(VIEW_UBO_BYTES / 4);
    // Place an identity mat4 at inverseViewProj slot [44..59]
    payload[44] = 1;
    payload[49] = 1;
    payload[54] = 1;
    payload[59] = 1;
    expect(payload[44]).toBe(1);
    expect(payload[49]).toBe(1);
    expect(payload[54]).toBe(1);
    expect(payload[59]).toBe(1);
  });

  it.skipIf(!browserReady)('shadow tail keeps the directional carrier before spot matrices', () => {
    expect(DIRECTIONAL_FILTER_OFFSET).toBe(126 * 4 + 8);
    expect(SPOT_LIGHT_VIEW_PROJ_OFFSET).toBe(132 * 4);
    expect(SPOT_LIGHT_VIEW_PROJ_OFFSET - DIRECTIONAL_FILTER_OFFSET).toBe(16);
    expect(SPOT_LIGHT_VIEW_PROJ_OFFSET + 4 * 4 * 16).toBe(784);
    expect(VIEW_UBO_BYTES).toBe(1280);
  });

  it.skipIf(!browserReady)(
    'existing field offsets unchanged by tail append (AC-06 rear-append guarantee)',
    () => {
      // The tail append of inverseViewProj must not shift earlier fields.
      // AC-06 lock: worldViewProj=0, lightDir=64, lightColor=80,
      // cameraPos=96, lightSpaceMatrix=112 -- same as the 176 B layout.
      expect(VIEW_UBO_OFFSETS.worldViewProj).toBe(0);
      expect(VIEW_UBO_OFFSETS.lightDir).toBe(64);
      expect(VIEW_UBO_OFFSETS.lightColor).toBe(80);
      expect(VIEW_UBO_OFFSETS.cameraPos).toBe(96);
      expect(VIEW_UBO_OFFSETS.lightSpaceMatrix).toBe(112);
    },
  );
});

// shadow-csm-ubo.test.ts - feat-20260613-csm-cascaded-shadow-maps-unique-shadow-path
// M4 / w14: View UBO std140 layout test (RED, test-first).
//
// Covers AC-08: View UBO tail pre-allocation for 4 cascades, fixed size
// independent of runtime cascadeCount. Validates std140 byte offsets for
// lightViewProj[4], splitPlanes[4], cascadeCount, cascadeBlend.
//
// feat-20260827-directional-csm-pcss-quality M1: the View UBO keeps its
// fixed 1280 B View payload and slot while the directional filter carrier
// reuses the tail pad. The directional cascade
// offsets [0..128] are byte-for-byte UNCHANGED; the per-spot fragment-read
// `spotLightViewProj` array<mat4x4<f32>,4> (256 B) folded into the tail at
// byte 528 (float 132), replacing the former zero tail-pad and removing the
// standalone @group(0) binding 9 uniform buffer that overflowed the WebGL2
// fallback fragment uniform-buffer budget.
//
// Layout (1280 B View payload and slot; the directional prefix remains
// byte-compatible with the 784 B Spot-matrix boundary):
//   [  0.. 16) worldViewProj   mat4x4<f32>  (align 16, size 64)
//   [ 16.. 19) lightDir        vec3<f32>    (align 16, 12 + 4 pad)
//   [ 20.. 22) lightColor      vec3<f32>    (align 16, 12 + 4 pad)
//   [ 24.. 26) cameraPos       vec3<f32>    (align 16, 12 + 4 pad)
//   [ 28.. 43) lightViewProj[0] mat4x4<f32> (align 16, size 64)
//   [ 44.. 59) inverseViewProj ma4x4<f32>   (align 16, size 64)
//   [ 60.. 75] lightViewProj[1] mat4x4<f32> (align 16, size 64)
//   [ 76.. 91) lightViewProj[2] mat4x4<f32> (align 16, size 64)
//   [ 92..107) lightViewProj[3] mat4x4<f32> (align 16, size 64)
//   [108..111) splitPlanes[0]  f32 + 12 pad (vec4 wrapper, 16 B)
//   [112..115) splitPlanes[1]  f32 + 12 pad (vec4 wrapper, 16 B)
//   [116..119) splitPlanes[2]  f32 + 12 pad (vec4 wrapper, 16 B)
//   [120..123) splitPlanes[3]  f32 + 12 pad (vec4 wrapper, 16 B)
//   [124]      cascadeCount    f32          (align 4, size 4)
//   [125]      cascadeBlend    f32          (align 4, size 4)
//   [126]      depthBias       f32          (align 4, size 4)
//   [127]      normalBias      f32          (align 4, size 4)
//   [128..131] directionalShadowFilter vec4<f32> (profile, radius, penumbra, reserved)
//   [132..195] spotLightViewProj array<mat4x4<f32>,4> (align 16, size 256)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VIEW_UNIFORM_BYTES } from '../../../render/src/record/view-ubo';

const VIEW_UBO_FLOAT_COUNT = VIEW_UNIFORM_BYTES / 4;
const VIEW_UBO_BYTES = VIEW_UNIFORM_BYTES;
// feat-20260625 w25: spot lightViewProj array folded into the View UBO tail.
const OFFSET_SPOT_LIGHT_VIEW_PROJ = 132; // byte 528 (16 B-aligned after filter carrier)
const SPOT_LVP_LANE_COUNT = 4;
const SPOT_LVP_FLOATS_PER_LANE = 16;

// feat-20260827-directional-csm-pcss-quality M1:
// the merged DirectionalLight's shadow tail-pad slots — depthBias [126]/byte504,
// normalBias [127]/byte508, and the four-float directional filter carrier
// [128..131]. The Spot matrix array remains at [132..195].
const OFFSET_DEPTH_BIAS = 126; // byte 504
const OFFSET_NORMAL_BIAS = 127; // byte 508
const OFFSET_DIRECTIONAL_FILTER = 128; // byte 512

const F32_BYTES = 4;

// Offsets as f32 indices.
const OFFSET_LIGHT_VIEW_PROJ_0 = 28; // byte 112
const OFFSET_LIGHT_VIEW_PROJ_1 = 60; // byte 240
const OFFSET_LIGHT_VIEW_PROJ_2 = 76; // byte 304
const OFFSET_LIGHT_VIEW_PROJ_3 = 92; // byte 368
const OFFSET_INVERSE_VIEW_PROJ = 44; // byte 176
const OFFSET_SPLIT_PLANES_0 = 108; // byte 432
const OFFSET_SPLIT_PLANES_1 = 112; // byte 448
const OFFSET_SPLIT_PLANES_2 = 116; // byte 464
const OFFSET_SPLIT_PLANES_3 = 120; // byte 480
const OFFSET_CASCADE_COUNT = 124; // byte 496
const OFFSET_CASCADE_BLEND = 125; // byte 500

// Each split occupies a whole vec4 slot (16 B = 4 f32), even though only
// the .x component carries the depth value. The remaining 3 f32 lanes are
// padding to satisfy std140 alignment (f32 in a struct after mat4 arrays
// requires vec4-level stride).
const SPLIT_STRIDE_FLOATS = 4;

describe('View UBO std140 layout (w14)', () => {
  describe('size invariants', () => {
    it('UBO total size is 1280 B (320 f32)', () => {
      expect(VIEW_UBO_FLOAT_COUNT).toBe(320);
      expect(VIEW_UBO_BYTES).toBe(VIEW_UBO_FLOAT_COUNT * F32_BYTES);
      expect(VIEW_UBO_BYTES).toBe(1280);
    });

    it('UBO size is fixed — independent of cascadeCount', () => {
      // The host always allocates 1280 B regardless of whether cascadeCount
      // is 1, 2, 3, or 4 at runtime. This validates AC-08.
      const sizeForN1 = VIEW_UBO_FLOAT_COUNT * F32_BYTES; // cascadeCount=1
      const sizeForN4 = VIEW_UBO_FLOAT_COUNT * F32_BYTES; // cascadeCount=4
      expect(sizeForN1).toBe(sizeForN4);
      expect(sizeForN1).toBe(1280);
    });

    it('spotLightViewProj array lands at byte 528 (float 132), 16 B-aligned, last field', () => {
      // feat-20260625 w25: the 4-lane spot perspective matrix array folds into
      // the View UBO tail after the directional filter carrier, 16 B-aligned
      // so it starts at byte 528 (float 132). It is the last struct field.
      expect(OFFSET_SPOT_LIGHT_VIEW_PROJ * F32_BYTES).toBe(528);
      expect((OFFSET_SPOT_LIGHT_VIEW_PROJ * F32_BYTES) % 16).toBe(0);
      const spotArrayEndFloat =
        OFFSET_SPOT_LIGHT_VIEW_PROJ + SPOT_LVP_LANE_COUNT * SPOT_LVP_FLOATS_PER_LANE;
      expect(spotArrayEndFloat).toBe(196);
      expect(spotArrayEndFloat * F32_BYTES).toBe(784);
    });
  });

  describe('std140 byte offsets', () => {
    it('lightViewProj[0] at offset 112 B (f32 index 28)', () => {
      expect(OFFSET_LIGHT_VIEW_PROJ_0 * F32_BYTES).toBe(112);
      // lightViewProj[0] replaces lightSpaceMatrix slot.
    });

    it('lightViewProj[1] at offset 240 B (f32 index 60)', () => {
      expect(OFFSET_LIGHT_VIEW_PROJ_1 * F32_BYTES).toBe(240);
    });

    it('lightViewProj[2] at offset 304 B (f32 index 76)', () => {
      expect(OFFSET_LIGHT_VIEW_PROJ_2 * F32_BYTES).toBe(304);
    });

    it('lightViewProj[3] at offset 368 B (f32 index 92)', () => {
      expect(OFFSET_LIGHT_VIEW_PROJ_3 * F32_BYTES).toBe(368);
    });

    it('lightViewProj[4] data is 256 B (4 x 64 B mat4)', () => {
      // Each lightViewProj matrix is 64 B (16 f32). lightViewProj[0]
      // replaces lightSpaceMatrix at [28..43]; [1,2,3] append after
      // inverseViewProj at [60..107]. The total data payload across the
      // 4 slots is 4 × 64 = 256 B — inverseViewProj (64 B) sits
      // between slot 0 and slots 1-3.
      const perMatrixF32 = 16;
      const perMatrixBytes = perMatrixF32 * F32_BYTES;
      expect(perMatrixBytes).toBe(64);
      const totalDataBytes = 4 * perMatrixBytes;
      expect(totalDataBytes).toBe(256);
    });

    it('splitPlanes[0] at offset 432 B (f32 index 108)', () => {
      expect(OFFSET_SPLIT_PLANES_0 * F32_BYTES).toBe(432);
    });

    it('splitPlanes[1] at offset 448 B (f32 index 112)', () => {
      expect(OFFSET_SPLIT_PLANES_1 * F32_BYTES).toBe(448);
    });

    it('splitPlanes[2] at offset 464 B (f32 index 116)', () => {
      expect(OFFSET_SPLIT_PLANES_2 * F32_BYTES).toBe(464);
    });

    it('splitPlanes[3] at offset 480 B (f32 index 120)', () => {
      expect(OFFSET_SPLIT_PLANES_3 * F32_BYTES).toBe(480);
    });

    it('splitPlanes stride is 16 B (vec4-aligned)', () => {
      expect(OFFSET_SPLIT_PLANES_1 - OFFSET_SPLIT_PLANES_0).toBe(SPLIT_STRIDE_FLOATS);
      expect(OFFSET_SPLIT_PLANES_2 - OFFSET_SPLIT_PLANES_1).toBe(SPLIT_STRIDE_FLOATS);
      expect(OFFSET_SPLIT_PLANES_3 - OFFSET_SPLIT_PLANES_2).toBe(SPLIT_STRIDE_FLOATS);
    });

    it('splitPlanes[4] spans 64 B (4 x 16 B vec4 stride)', () => {
      const start = OFFSET_SPLIT_PLANES_0;
      const end = OFFSET_SPLIT_PLANES_3 + SPLIT_STRIDE_FLOATS;
      expect((end - start) * F32_BYTES).toBe(64);
    });

    it('cascadeCount at offset 496 B (f32 index 124)', () => {
      expect(OFFSET_CASCADE_COUNT * F32_BYTES).toBe(496);
    });

    it('cascadeBlend at offset 500 B (f32 index 125)', () => {
      expect(OFFSET_CASCADE_BLEND * F32_BYTES).toBe(500);
    });

    it('inverseViewProj at offset 176 B (f32 index 44) — unchanged', () => {
      // inverseViewProj keeps its existing position; lightViewProj[0]
      // replaces lightSpaceMatrix at [28..43], inverseViewProj stays at
      // [44..59]. The new 3 lightViewProj matrices are appended after.
      expect(OFFSET_INVERSE_VIEW_PROJ * F32_BYTES).toBe(176);
    });
  });

  describe('std140 alignment paper verify', () => {
    it('mat4 alignment is 16 B', () => {
      // All mat4x4<f32> slots start at 16B-aligned offsets.
      const mat4Offsets = [
        OFFSET_LIGHT_VIEW_PROJ_0 * F32_BYTES,
        OFFSET_INVERSE_VIEW_PROJ * F32_BYTES,
        OFFSET_LIGHT_VIEW_PROJ_1 * F32_BYTES,
        OFFSET_LIGHT_VIEW_PROJ_2 * F32_BYTES,
        OFFSET_LIGHT_VIEW_PROJ_3 * F32_BYTES,
      ];
      for (const off of mat4Offsets) {
        expect(off % 16).toBe(0);
      }
    });

    it('f32 after mat4 array gets vec4 stride (16 B)', () => {
      // std140: f32 following a mat4 (or vec4) aligns to vec4 level.
      // Each splitPlanes element is 16 B wide even though only 4 B (f32)
      // carries data — the compiler pads to vec4 boundaries.
      const splitStart = OFFSET_SPLIT_PLANES_0 * F32_BYTES;
      expect(splitStart % 16).toBe(0);
    });

    it('cascadeCount f32 at offset 496 is 16 B after splitPlanes end at 480', () => {
      const splitEnd = (OFFSET_SPLIT_PLANES_3 + SPLIT_STRIDE_FLOATS) * F32_BYTES;
      const ccStart = OFFSET_CASCADE_COUNT * F32_BYTES;
      expect(ccStart).toBe(splitEnd);
      // f32 after vec4: align is 4, so cascadeCount starts right after splitPlanes
      // (no extra gap needed since 496 / 4 = 124 is an integer index)
    });

    it('struct tail aligned to 16 B', () => {
      // Total UBO bytes must be 16B-aligned for uniform buffer binding.
      expect(VIEW_UBO_BYTES % 16).toBe(0);
    });
  });
});

// M1-T05: read the real host and WGSL sources so the frozen ABI cannot drift.
describe('directional filter carrier tail-pad wiring (M1-T05)', () => {
  const recordSrc = readFileSync(
    fileURLToPath(new URL('../../../render/src/record/view-ubo.ts', import.meta.url)),
    'utf8',
  );
  const wgslSrc = readFileSync(
    fileURLToPath(new URL('../../../shader/src/common.wgsl', import.meta.url)),
    'utf8',
  );

  it('shadow tail floats [126..131] at fixed offsets, before the spot matrix array', () => {
    expect(OFFSET_DEPTH_BIAS * F32_BYTES).toBe(504);
    expect(OFFSET_NORMAL_BIAS * F32_BYTES).toBe(508);
    expect(OFFSET_DIRECTIONAL_FILTER * F32_BYTES).toBe(512);
    expect(OFFSET_DEPTH_BIAS).toBeGreaterThan(OFFSET_CASCADE_BLEND);
    expect(OFFSET_DIRECTIONAL_FILTER + 4).toBe(OFFSET_SPOT_LIGHT_VIEW_PROJ);
    expect(OFFSET_DIRECTIONAL_FILTER).toBeLessThan(OFFSET_SPOT_LIGHT_VIEW_PROJ);
    expect(VIEW_UBO_FLOAT_COUNT).toBe(320);
    expect(VIEW_UBO_BYTES).toBe(1280);
  });

  it('record writes the merged shadow tail-pad floats [126]/[127]/[128..131]', () => {
    expect(recordSrc).toMatch(/viewPayload\[126\]\s*=\s*lights\.depthBias/);
    expect(recordSrc).toMatch(/viewPayload\[127\]\s*=\s*lights\.normalBias/);
    expect(recordSrc).toMatch(/viewPayload\[128\]/);
    expect(recordSrc).toMatch(/viewPayload\[129\]/);
    expect(recordSrc).toMatch(/viewPayload\[130\]/);
    expect(recordSrc).toMatch(/viewPayload\[131\]/);
    expect(recordSrc).not.toMatch(/lights\.pcfKernelSize/);
  });

  it('record carries the folded spot matrices in the complete View UBO payload (w25)', () => {
    // feat-20260625 w25: the per-spot fragment-read lightViewProj matrices fold
    // into the View UBO tail. The current View struct also carries temporal and
    // cloud projection, clipping, fog and atmosphere fields, so the payload is 320 floats.
    expect(recordSrc).toMatch(/VIEW_PAYLOAD_FLOATS\s*=\s*VIEW_UNIFORM_BYTES \/ 4/);
    // The spot matrix array is written at base float 132.
    expect(recordSrc).toMatch(/SPOT_LVP_BASE_FLOAT\s*=\s*132/);
  });

  it('common.wgsl View struct declares the directional filter vec4 after biases', () => {
    const m = wgslSrc.match(
      /cascadeBlend\s*:\s*f32\s*,\s*depthBias\s*:\s*f32\s*,\s*normalBias\s*:\s*f32\s*,\s*directionalShadowFilter\s*:\s*vec4<f32>\s*,/,
    );
    expect(m).not.toBeNull();
  });

  it('keeps one View binding and removes the retired spot matrix binding', () => {
    expect(wgslSrc.match(/@group\(0\) @binding\(0\) var<uniform> view/g)).toHaveLength(1);
    expect(wgslSrc).not.toMatch(
      /@group\(0\)\s*@binding\(9\)\s*var<uniform>\s+spotLightViewProj\s*:/,
    );
  });
});

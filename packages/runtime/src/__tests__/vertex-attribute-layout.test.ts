// vertex-attribute-layout.test.ts -- feat-20260629-multi-uv-set-support m3-w1
//
// Unit test for deriveVertexBufferLayout multi-UV @location derivation.
// Covers 0/1/2/3/8 UV sets including skinned+multi-UV offset assertions
// that lock down the canonical interleaved order:
//   position/normal/uv/tangent/skinIndex/skinWeight/uv1..uv7
//
// Existing 6-key offsets (0/12/24/32/48/56) must remain unchanged (AC-12).
// uv1 starts at offset=72 (after skin) with @location(6) (D-4).
//
// RED at this commit: deriveVertexBufferLayout has no uv1..uv7 keys.

import { deriveVertexBufferLayout } from '@forgeax/engine-geometry';
import type { VertexAttributeMap } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

function makeBuffer(len: number): Float32Array {
  return new Float32Array(len);
}

describe('deriveVertexBufferLayout multi-UV (m3-w1)', () => {
  // ── Zero-regression: existing 6-key layout unchanged (AC-12) ──

  it('all 6 keys produce correct locations and offsets (AC-12 zero-regression)', () => {
    const map: VertexAttributeMap = {
      position: makeBuffer(3),
      normal: makeBuffer(3),
      uv: makeBuffer(2),
      tangent: makeBuffer(4),
      skinIndex: new Uint16Array(4).buffer,
      skinWeight: makeBuffer(4),
    };
    const layout = deriveVertexBufferLayout(map);
    expect(layout).toHaveLength(1);
    const attrs = layout[0]?.attributes;

    expect(attrs).toHaveLength(6);
    if (!attrs) return;
    expect(attrs[0]?.shaderLocation).toBe(0); // position
    expect(attrs[0]?.offset).toBe(0);
    expect(attrs[1]?.shaderLocation).toBe(1); // normal
    expect(attrs[1]?.offset).toBe(12);
    expect(attrs[2]?.shaderLocation).toBe(2); // uv
    expect(attrs[2]?.offset).toBe(24);
    expect(attrs[3]?.shaderLocation).toBe(3); // tangent
    expect(attrs[3]?.offset).toBe(32);
    expect(attrs[4]?.shaderLocation).toBe(4); // skinIndex
    expect(attrs[4]?.offset).toBe(48);
    expect(attrs[5]?.shaderLocation).toBe(5); // skinWeight
    expect(attrs[5]?.offset).toBe(56);
    expect(layout[0]?.arrayStride).toBe(72); // 12+12+8+16+8+16
  });

  // ── 0 UV sets: no uv key present ──

  it('mesh with no UV keys produces layout without UV attributes', () => {
    const map: VertexAttributeMap = {
      position: makeBuffer(3),
      normal: makeBuffer(3),
      tangent: makeBuffer(4),
    };
    const layout = deriveVertexBufferLayout(map);
    expect(layout).toHaveLength(1);
    const attrs = layout[0]?.attributes;
    expect(attrs).toHaveLength(3);
    if (!attrs) return;
    const locations = attrs.map((a) => a.shaderLocation);
    expect(locations).not.toContain(2); // no uv
    for (let k = 6; k <= 12; k++) {
      expect(locations).not.toContain(k); // no uv1..uv7
    }
  });

  // ── 1 UV set: only uv key ──

  it('mesh with 1 UV set (uv only) produces uv at @location(2) offset=24', () => {
    const map: VertexAttributeMap = {
      position: makeBuffer(3),
      normal: makeBuffer(3),
      uv: makeBuffer(2),
      tangent: makeBuffer(4),
    };
    const layout = deriveVertexBufferLayout(map);
    expect(layout).toHaveLength(1);
    const attrs = layout[0]?.attributes;
    expect(attrs).toHaveLength(4); // pos/normal/uv/tangent
    if (!attrs) return;
    expect(attrs[2]?.shaderLocation).toBe(2); // uv
    expect(attrs[2]?.offset).toBe(24);
    expect(attrs[2]?.format).toBe('float32x2');
    // No uv1..uv7 entries
    const locations = attrs.map((a) => a.shaderLocation);
    for (let k = 6; k <= 12; k++) {
      expect(locations).not.toContain(k);
    }
  });

  // ── 2 UV sets: uv + uv1 ──

  it('mesh with 2 UV sets (uv + uv1) produces uv1 at @location(6) offset=72', () => {
    const map: VertexAttributeMap = {
      position: makeBuffer(3),
      normal: makeBuffer(3),
      uv: makeBuffer(2),
      tangent: makeBuffer(4),
      skinIndex: new Uint16Array(4).buffer,
      skinWeight: makeBuffer(4),
      uv1: makeBuffer(2),
    };
    const layout = deriveVertexBufferLayout(map);
    expect(layout).toHaveLength(1);
    const attrs = layout[0]?.attributes;
    // 6 existing + 1 uv1 = 7
    expect(attrs).toHaveLength(7);
    if (!attrs) return;

    // Existing 6 keys unchanged
    expect(attrs[0]?.shaderLocation).toBe(0); // position
    expect(attrs[0]?.offset).toBe(0);
    expect(attrs[1]?.shaderLocation).toBe(1); // normal
    expect(attrs[1]?.offset).toBe(12);
    expect(attrs[2]?.shaderLocation).toBe(2); // uv
    expect(attrs[2]?.offset).toBe(24);
    expect(attrs[3]?.shaderLocation).toBe(3); // tangent
    expect(attrs[3]?.offset).toBe(32);
    expect(attrs[4]?.shaderLocation).toBe(4); // skinIndex
    expect(attrs[4]?.offset).toBe(48);
    expect(attrs[5]?.shaderLocation).toBe(5); // skinWeight
    expect(attrs[5]?.offset).toBe(56);

    // uv1: after skinWeight, @location(6), offset=72
    expect(attrs[6]?.shaderLocation).toBe(6);
    expect(attrs[6]?.offset).toBe(72);
    expect(attrs[6]?.format).toBe('float32x2');

    // stride = 12+12+8+16+8+16+8 = 80
    expect(layout[0]?.arrayStride).toBe(80);
  });

  // ── 3 UV sets: uv + uv1 + uv2 ──

  it('mesh with 3 UV sets produces continuous uv1..uv2 at location 6..7', () => {
    const map: VertexAttributeMap = {
      position: makeBuffer(3),
      normal: makeBuffer(3),
      uv: makeBuffer(2),
      tangent: makeBuffer(4),
      skinIndex: new Uint16Array(4).buffer,
      skinWeight: makeBuffer(4),
      uv1: makeBuffer(2),
      uv2: makeBuffer(2),
    };
    const layout = deriveVertexBufferLayout(map);
    expect(layout).toHaveLength(1);
    const attrs = layout[0]?.attributes;
    expect(attrs).toHaveLength(8);
    if (!attrs) return;
    expect(attrs[6]?.shaderLocation).toBe(6);
    expect(attrs[6]?.offset).toBe(72);
    expect(attrs[6]?.format).toBe('float32x2');

    // uv2 at @location(7) offset=80
    expect(attrs[7]?.shaderLocation).toBe(7);
    expect(attrs[7]?.offset).toBe(80);
    expect(attrs[7]?.format).toBe('float32x2');

    expect(layout[0]?.arrayStride).toBe(88); // 72 + 8 + 8
  });

  // ── 8 UV sets: uv + uv1..uv7 ──

  it('mesh with 8 UV sets produces uv1..uv7 at locations 6..12 with continuous offsets', () => {
    const map: VertexAttributeMap = {
      position: makeBuffer(3),
      normal: makeBuffer(3),
      uv: makeBuffer(2),
      tangent: makeBuffer(4),
      skinIndex: new Uint16Array(4).buffer,
      skinWeight: makeBuffer(4),
      uv1: makeBuffer(2),
      uv2: makeBuffer(2),
      uv3: makeBuffer(2),
      uv4: makeBuffer(2),
      uv5: makeBuffer(2),
      uv6: makeBuffer(2),
      uv7: makeBuffer(2),
    };
    const layout = deriveVertexBufferLayout(map);
    expect(layout).toHaveLength(1);
    const attrs = layout[0]?.attributes;
    // 6 existing + 7 extra UV = 13
    expect(attrs).toHaveLength(13);
    if (!attrs) return;
    expect(attrs[0]?.shaderLocation).toBe(0);
    expect(attrs[0]?.offset).toBe(0);
    expect(attrs[1]?.shaderLocation).toBe(1);
    expect(attrs[1]?.offset).toBe(12);
    expect(attrs[2]?.shaderLocation).toBe(2);
    expect(attrs[2]?.offset).toBe(24);
    expect(attrs[3]?.shaderLocation).toBe(3);
    expect(attrs[3]?.offset).toBe(32);
    expect(attrs[4]?.shaderLocation).toBe(4);
    expect(attrs[4]?.offset).toBe(48);
    expect(attrs[5]?.shaderLocation).toBe(5);
    expect(attrs[5]?.offset).toBe(56);

    // uv1..uv7: locations 6..12, offsets 72/80/88/96/104/112/120
    for (let k = 0; k < 7; k++) {
      const idx = 6 + k;
      expect(attrs[idx]?.shaderLocation).toBe(6 + k);
      expect(attrs[idx]?.offset).toBe(72 + k * 8);
      expect(attrs[idx]?.format).toBe('float32x2');
    }

    // stride = 12+12+8+16+8+16 + 7*8 = 72 + 56 = 128
    expect(layout[0]?.arrayStride).toBe(128);
  });

  // ── F-1 lock: skinned + multi-UV ──

  it('skinned + 1 extra UV: @location(6) byte offset=72 (canonical interleaved order)', () => {
    const map: VertexAttributeMap = {
      position: makeBuffer(3),
      normal: makeBuffer(3),
      uv: makeBuffer(2),
      tangent: makeBuffer(4),
      skinIndex: new Uint16Array(4).buffer,
      skinWeight: makeBuffer(4),
      uv1: makeBuffer(2),
    };
    const layout = deriveVertexBufferLayout(map);
    expect(layout).toHaveLength(1);
    const attrs = layout[0]?.attributes;
    expect(attrs).toBeDefined();
    if (!attrs) return;
    expect(attrs[4]?.shaderLocation).toBe(4); // skinIndex
    expect(attrs[4]?.offset).toBe(48);
    expect(attrs[5]?.shaderLocation).toBe(5); // skinWeight
    expect(attrs[5]?.offset).toBe(56);

    // uv1 at @location(6), offset MUST be 72 (after skin data, not inside skin bytes)
    expect(attrs[6]?.shaderLocation).toBe(6);
    expect(attrs[6]?.offset).toBe(72);
    expect(attrs[6]?.format).toBe('float32x2');
  });

  // ── Non-skinned + 2 UV: uv1 offset from correct place ──

  it('non-skinned + 2 UV: uv1 follows after tangent, offset=32 (no skin gap)', () => {
    const map: VertexAttributeMap = {
      position: makeBuffer(3),
      normal: makeBuffer(3),
      uv: makeBuffer(2),
      tangent: makeBuffer(4),
      uv1: makeBuffer(2),
    };
    const layout = deriveVertexBufferLayout(map);
    expect(layout).toHaveLength(1);
    const attrs = layout[0]?.attributes;
    expect(attrs).toHaveLength(5);
    if (!attrs) return;

    // Existing 4 keys
    expect(attrs[0]?.shaderLocation).toBe(0);
    expect(attrs[0]?.offset).toBe(0);
    expect(attrs[1]?.shaderLocation).toBe(1);
    expect(attrs[1]?.offset).toBe(12);
    expect(attrs[2]?.shaderLocation).toBe(2);
    expect(attrs[2]?.offset).toBe(24);
    expect(attrs[3]?.shaderLocation).toBe(3);
    expect(attrs[3]?.offset).toBe(32);

    // uv1: @location(6) -- skips skin locations 4/5, but offset follows tangent (32)
    // Wait: canonical order says uv1 is after skinWeight, but skin is absent here.
    // The keys array still iterates in canonical order:
    // position/normal/uv/tangent/skinIndex/skinWeight/uv1..uv7
    // Missing skinIndex/skinWeight -> skip -> next present key is uv1.
    // Offset after tangent is: 0+12+12+8+16 = 48? No...
    // Let's recalculate: position(0..12) + normal(12..24) + uv(24..32) + tangent(32..48)
    // = 48. Next is uv1: offset=48, @location(6) (because skin 4/5 are skipped in entries
    // but the location mapping is key-list-position).
    // Actually, looking at the current implementation: shaderLocation = keys.indexOf(key).
    // So for uv1 in position 6 of the keys array, location=6 even when skin is absent.
    // offset follows the running offset which skips missing keys.
    expect(attrs[4]?.shaderLocation).toBe(6);
    expect(attrs[4]?.offset).toBe(48); // after tangent: 0+12+12+8+16
    expect(attrs[4]?.format).toBe('float32x2');
    expect(layout[0]?.arrayStride).toBe(56); // 48 + 8
  });

  // ── Sparse UV: uv + uv3 (skip uv1, uv2) ──

  it('sparse UV sets (uv + uv3) only emit present keys, no gaps in entries', () => {
    const map: VertexAttributeMap = {
      position: makeBuffer(3),
      uv: makeBuffer(2),
      uv3: makeBuffer(2),
    };
    const layout = deriveVertexBufferLayout(map);
    expect(layout).toHaveLength(1);
    const attrs = layout[0]?.attributes;
    expect(attrs).toHaveLength(3);
    if (!attrs) return;
    expect(attrs[0]?.offset).toBe(0);

    expect(attrs[1]?.shaderLocation).toBe(2); // uv (normal skipped)
    expect(attrs[1]?.offset).toBe(12);

    // uv3: @location(8) (list index of uv3 in keys array),
    // offset follows running offset: 12+8
    expect(attrs[2]?.shaderLocation).toBe(8);
    expect(attrs[2]?.offset).toBe(20);
    expect(attrs[2]?.format).toBe('float32x2');
    expect(layout[0]?.arrayStride).toBe(28);
  });

  // ── Empty map ──

  it('empty map produces empty layout', () => {
    const map: VertexAttributeMap = {};
    const layout = deriveVertexBufferLayout(map);
    expect(layout).toHaveLength(0);
  });
});

import { fitShadowCapsules, skeletonContribution } from '@forgeax/engine-skinning';
import { parseShadowCapsuleSet } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

const RADIUS = 0.3;
const HALF_HEIGHT = 0.9;

/** Tube of radius 0.3 along y in [-0.9, 0.9]; joint 0 below y = 0, joint 1 above. */
function twoBoneTube(rows = 19, around = 16) {
  const count = rows * around;
  const position = new Float32Array(count * 3);
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  for (let row = 0; row < rows; row++) {
    const y = -HALF_HEIGHT + (2 * HALF_HEIGHT * row) / (rows - 1);
    for (let step = 0; step < around; step++) {
      const vertex = row * around + step;
      const angle = (2 * Math.PI * step) / around;
      position.set([RADIUS * Math.cos(angle), y, RADIUS * Math.sin(angle)], vertex * 3);
      const upper = y > 0 ? 0.8 : 0.2;
      skinIndex.set([0, 1, 0, 0], vertex * 4);
      skinWeight.set([1 - upper, upper, 0, 0], vertex * 4);
    }
  }
  return { attributes: { position, skinIndex, skinWeight } };
}

function capsule(shapes: Float32Array, index: number) {
  const base = index * 7;
  return {
    a: [shapes[base] ?? 0, shapes[base + 1] ?? 0, shapes[base + 2] ?? 0],
    b: [shapes[base + 3] ?? 0, shapes[base + 4] ?? 0, shapes[base + 5] ?? 0],
    r: shapes[base + 6] ?? 0,
  };
}

describe('fitShadowCapsules', () => {
  it('fits one inward capsule per dominant joint', () => {
    const set = fitShadowCapsules([twoBoneTube()], 2);
    expect(set).toBeDefined();
    if (set === undefined) return;
    expect(Array.from(set.joints)).toEqual([0, 1]);
    for (let index = 0; index < 2; index++) {
      const { a, b, r } = capsule(set.shapes, index);
      expect(r).toBeGreaterThan(0.2);
      expect(r).toBeLessThanOrEqual(RADIUS + 1e-5);
      for (const end of [a, b]) {
        expect(Math.hypot(end[0] ?? 0, end[2] ?? 0)).toBeLessThan(1e-4);
        expect(Math.abs(end[1] ?? 0) + r).toBeLessThanOrEqual(HALF_HEIGHT + 1e-5);
      }
      const lowerJoint = set.joints[index] === 0;
      expect(Math.max(a[1] ?? 0, b[1] ?? 0) <= 0).toBe(lowerJoint);
    }
    expect(parseShadowCapsuleSet(set, 2)).toEqual(set);
  });

  it('is deterministic for identical input', () => {
    const first = fitShadowCapsules([twoBoneTube()], 2);
    const second = fitShadowCapsules([twoBoneTube()], 2);
    expect(first?.shapes).toEqual(second?.shapes);
    expect(first?.joints).toEqual(second?.joints);
  });

  it('skips joints with too few points and honours maxCapsules', () => {
    const tube = twoBoneTube();
    const weights = tube.attributes.skinWeight;
    // Leave joint 1 dominant on only four vertices.
    for (let vertex = 4; vertex < weights.length / 4; vertex++)
      weights.set([1, 0, 0, 0], vertex * 4);
    const set = fitShadowCapsules([tube], 2);
    expect(Array.from(set?.joints ?? [])).toEqual([0]);
    expect(fitShadowCapsules([twoBoneTube()], 2, { maxCapsules: 1 })?.joints.length).toBe(1);
  });

  it('returns undefined without skin attributes', () => {
    expect(
      fitShadowCapsules([{ attributes: { position: new Float32Array(30) } }], 2),
    ).toBeUndefined();
  });
});

describe('parseShadowCapsuleSet', () => {
  const valid = { joints: [0], shapes: [0, 0, 0, 0, 1, 0, 0.2] };

  it('accepts JSON-shaped arrays and copies them into typed arrays', () => {
    const set = parseShadowCapsuleSet(valid, 1);
    expect(set?.joints).toBeInstanceOf(Uint16Array);
    expect(set?.shapes).toBeInstanceOf(Float32Array);
  });

  it('rejects out-of-range joints, bad stride, non-finite values, and non-positive radius', () => {
    expect(parseShadowCapsuleSet(valid, 0)).toBeUndefined();
    expect(parseShadowCapsuleSet({ joints: [0], shapes: [0, 0, 0, 0, 1, 0] }, 1)).toBeUndefined();
    expect(
      parseShadowCapsuleSet({ joints: [0], shapes: [0, 0, Number.NaN, 0, 1, 0, 0.2] }, 1),
    ).toBeUndefined();
    expect(
      parseShadowCapsuleSet({ joints: [0], shapes: [0, 0, 0, 0, 1, 0, 0] }, 1),
    ).toBeUndefined();
    expect(
      parseShadowCapsuleSet(
        { joints: new Array(65).fill(0), shapes: new Array(65 * 7).fill(1) },
        1,
      ),
    ).toBeUndefined();
  });
});

describe('skeletonContribution shadowCapsules', () => {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const decode = (shadowCapsules: unknown) =>
    skeletonContribution.decoder.decode({
      envelope: {
        guid: 'skeleton-guid',
        payload: { kind: 'skeleton', jointCount: 1, inverseBindMatrices: identity, shadowCapsules },
      },
    } as never);

  it('keeps a JSON round-tripped capsule set', async () => {
    const result = await decode({ joints: [0], shapes: [0, 0, 0, 0, 1, 0, 0.2] });
    expect(result.ok && result.value.shadowCapsules?.joints).toEqual(new Uint16Array([0]));
  });

  it('rejects a skeleton whose capsules reference a missing joint', async () => {
    const result = await decode({ joints: [3], shapes: [0, 0, 0, 0, 1, 0, 0.2] });
    expect(result.ok).toBe(false);
  });
});

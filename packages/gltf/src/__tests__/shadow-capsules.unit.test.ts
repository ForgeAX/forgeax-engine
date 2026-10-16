import { describe, expect, it } from 'vitest';
import type { GltfDoc } from '../parse-gltf';
import { deriveGltfShadowCapsules } from '../shadow-capsules';

function tube(rows = 12, around = 12) {
  const count = rows * around;
  const positions = new Float32Array(count * 3);
  const joints0 = new Uint16Array(count * 4);
  const weights0 = new Float32Array(count * 4);
  for (let row = 0; row < rows; row++)
    for (let step = 0; step < around; step++) {
      const vertex = row * around + step;
      const angle = (2 * Math.PI * step) / around;
      positions.set([0.2 * Math.cos(angle), row / (rows - 1), 0.2 * Math.sin(angle)], vertex * 3);
      joints0.set([1, 0, 0, 0], vertex * 4);
      weights0.set([1, 0, 0, 0], vertex * 4);
    }
  return { positions, joints0, weights0 };
}

const skeleton = {
  jointCount: 2,
  inverseBindMatrices: new Float32Array(32),
  jointPaths: ['a', 'b'],
};

function doc(meshes: readonly object[], skinIndex: number | null): GltfDoc {
  return {
    meshes,
    meshPrimitiveCount: new Map([[0, meshes.length]]),
    nodes: [{ meshIndex: 0, skinIndex }],
    skeletons: [skeleton],
  } as unknown as GltfDoc;
}

describe('deriveGltfShadowCapsules', () => {
  it('fits capsules from every primitive drawn with the skin', () => {
    const [skel] = deriveGltfShadowCapsules(doc([tube(), tube()], 0)).skeletons;
    expect(Array.from(skel?.shadowCapsules?.joints ?? [])).toEqual([1]);
    expect(skel?.shadowCapsules?.shapes[6]).toBeCloseTo(0.2, 2);
  });

  it('leaves skeletons without skinned primitives unchanged', () => {
    const input = doc([tube()], null);
    expect(deriveGltfShadowCapsules(input).skeletons[0]).toBe(input.skeletons[0]);
  });
});

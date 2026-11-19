import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { mat4 } from '@forgeax/engine-math';
import { GlyphText } from '@forgeax/engine-render/authoring';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { queryMeshMatrix } from '../query-mesh';

function spawnLabel(worldOriented: boolean) {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const entity = world
    .spawn(
      { component: Transform, data: { pos: [2, 3, -4] } },
      {
        component: GlyphText,
        data: { text: 'AB', fontSize: 1, color: [1, 1, 1, 1], worldOriented },
      },
    )
    .unwrap();
  propagateTransforms(world);
  return { world, entity };
}

describe('GlyphText orientation picking', () => {
  it('keeps the entity world matrix for worldOriented labels', () => {
    const { world, entity } = spawnLabel(true);
    const view = mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
    const result = queryMeshMatrix(world, entity, { view } as never);
    expect(result).toBeDefined();
    expect(result?.[12]).toBeCloseTo(2);
    expect(result?.[13]).toBeCloseTo(3);
    expect(result?.[14]).toBeCloseTo(-4);
    // Axes stay the entity's own basis (translation-only here), not the camera basis.
    expect(result?.[0]).toBeCloseTo(1);
    expect(result?.[5]).toBeCloseTo(1);
    expect(result?.[10]).toBeCloseTo(1);
  });

  it('re-orients camera-facing labels toward the camera', () => {
    const { world, entity } = spawnLabel(false);
    const view = mat4.lookAt(mat4.create(), [2, 3, 6], [2, 3, -4], [0, 1, 0]);
    const result = queryMeshMatrix(world, entity, { view } as never);
    expect(result).toBeDefined();
    // Forward axis (column 2) points from the label toward the camera.
    expect(result?.[8]).toBeCloseTo(0);
    expect(result?.[9]).toBeCloseTo(0);
    expect(result?.[10]).toBeCloseTo(1);
  });
});

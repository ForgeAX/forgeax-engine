import { expect, it } from 'vitest';
import { projectRayScene } from '../../raytracing/scene-projection';
import { retainedTransportPlane } from './scene-projection.fixture';

it('projects the accepted material snapshot across edits without consulting newer World values', () => {
  const source = retainedTransportPlane({ kind: 'material', values: { emissiveIntensity: 99 } });
  const firstSlot = source.retained.slotsSnapshot()[0];
  expect(firstSlot).toBeDefined();
  if (firstSlot === undefined) throw new Error('missing retained fixture slot');
  const initial = {
    ...firstSlot.snapshot.material,
    materialSurfacePrograms: {
      'ray-hit': { programKey: 'accepted-program-A', evaluateCoverage: false },
    },
    paramSnapshot: { emissiveIntensity: 2 },
  };
  const replace = (material: typeof initial) =>
    source.retained.apply([
      {
        kind: 'update',
        worldId: 0,
        entityKey: 31,
        snapshot: { ...firstSlot.snapshot, material, materials: [material] },
      },
    ]);
  replace(initial);
  const first = source.project();
  const replacement = {
    ...initial,
    materialSurfacePrograms: {
      'ray-hit': { programKey: 'accepted-program-B', evaluateCoverage: true },
    },
    paramSnapshot: { emissiveIntensity: 4 },
  };
  replace(replacement);
  const second = source.project();
  expect(first.materials).toEqual([
    { worldId: 0, handle: initial.materialHandle, snapshot: initial },
  ]);
  expect(second.materials).toEqual([
    { worldId: 0, handle: initial.materialHandle, snapshot: replacement },
  ]);
  expect(first.materials[0]?.snapshot.paramSnapshot?.emissiveIntensity).toBe(2);
  // Geometry identity and acceleration inputs do not change with a material edit.
  expect(second.scene.triangles).toEqual(first.scene.triangles);
  expect(second.scene.nodes).toEqual(first.scene.nodes);
  // Equal numeric handles in two Worlds are distinct material identities.
  const secondWorld = retainedTransportPlane({ kind: 'material' });
  const slots = secondWorld.retained
    .slotsSnapshot()
    .map((slot) => ({ ...slot, slot: slot.slot + 1, worldId: 1 }));
  const combined = projectRayScene(
    [...source.retained.slotsSnapshot(), ...slots],
    [source.world, secondWorld.world],
    16,
  );
  expect(combined.materials.map((material) => [material.worldId, material.handle])).toEqual([
    [0, initial.materialHandle],
    [1, initial.materialHandle],
  ]);
});

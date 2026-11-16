import { expect, it } from 'vitest';
import { MaterialResource } from '../../material-resource';
import { retainedTransportPlane } from './scene-projection.fixture';

it('projects the accepted material snapshot across edits without consulting newer World values', () => {
  const source = retainedTransportPlane({ kind: 'material', values: { emissiveIntensity: 99 } });
  const firstSlot = source.retained.slotsSnapshot().at(0);
  expect(firstSlot).toBeDefined();
  if (firstSlot === undefined) throw new Error('missing retained fixture slot');
  const initial = {
    ...firstSlot.snapshot.material.snapshot,
    materialSurfacePrograms: {
      'ray-hit': { programKey: 'accepted-program-A', evaluateCoverage: false },
    },
    paramSnapshot: { emissiveIntensity: 2 },
  };
  const replace = (material: typeof initial) =>
    source.retained.apply([
      {
        kind: 'update',
        entityKey: 31,
        snapshot: {
          ...firstSlot.snapshot,
          material: MaterialResource.from(material),
          materials: [MaterialResource.from(material)],
        },
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
  expect(first.materials).toEqual([{ handle: initial.materialHandle, snapshot: initial }]);
  expect(second.materials).toEqual([{ handle: initial.materialHandle, snapshot: replacement }]);
  expect(first.materials[0]?.snapshot.paramSnapshot?.emissiveIntensity).toBe(2);
  // Geometry identity and acceleration inputs do not change with a material edit.
  expect(second.scene.triangles).toEqual(first.scene.triangles);
  expect(second.scene.nodes).toEqual(first.scene.nodes);
  // Independent Renderer sources cannot overwrite held accepted material facts.
  const other = retainedTransportPlane({ kind: 'material' });
  const otherProjection = other.project();
  expect(otherProjection.materials[0]?.snapshot).not.toBe(replacement);
  expect(second.materials).toEqual([{ handle: initial.materialHandle, snapshot: replacement }]);
});

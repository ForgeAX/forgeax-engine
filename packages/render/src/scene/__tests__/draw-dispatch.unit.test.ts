import { expect, it } from 'vitest';
import { MaterialResource } from '../../material-resource';
import { defaultMaterialSnapshot } from '../../render-system-extract';
import { projectDrawDispatch } from '../draw-dispatch';
import { MaterialFrame } from '../material-dispatch';

it('reuses a direct dispatch while row identities and materials are unchanged', () => {
  const material = new MaterialResource(defaultMaterialSnapshot(3));
  const frame = new MaterialFrame(undefined).with(material);
  const row = (layer = 0) =>
    ({
      source: {
        worldId: 0,
        entityKey: 9,
        layer,
        shadowCaster: true,
        material,
        materials: [material],
      },
      renderableIndex: 0,
      mesh: { submeshes: [{ materialSlot: 0 }] },
      submeshIndices: [0],
    }) as never;
  const first = projectDrawDispatch([row()], frame);
  // A moving entity republishes a new snapshot with the same draw facts.
  expect(projectDrawDispatch([row()], frame)).toBe(first);
  const moved = projectDrawDispatch([row(2)], frame);
  expect(moved).not.toBe(first);
  expect([...moved].every((entry) => entry.layer === 2)).toBe(true);
});

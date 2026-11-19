import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { vec3 } from '@forgeax/engine-math';
import { expect, it } from 'vitest';
import { MaterialResource } from '../../material-resource';
import type { MaterialSnapshot, RenderableSnapshot } from '../../render-system-extract';
import { setSceneRow } from '../../scene/__tests__/scene-row-writes';
import { MaterialDispatch } from '../../scene/material-dispatch';
import { MeshFrame } from '../../scene/mesh-frame';
import type { RenderSceneSlot } from '../../scene/render-scene-types';
import { SceneSlots } from '../../scene/scene-slots';
import { subsurfaceDemand } from '../demand';
import { SubsurfaceSelection } from '../selection';

function material(handle: number, extra: Partial<MaterialSnapshot> = {}): MaterialSnapshot {
  return {
    materialHandle: handle,
    baseColor: vec3.create(1, 1, 1),
    metallic: 0,
    roughness: 0.5,
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::default-unlit' },
        renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
      },
    ],
    ...extra,
  };
}

/** A row whose authored overrides replace every Mesh slot, as entity material overrides do. */
function overrideRow(placeholder: MaterialResource, override: MaterialResource): RenderSceneSlot {
  const snapshot: RenderableSnapshot = {
    entityKey: 1,
    assetHandle: 1,
    material: placeholder,
    materials: [placeholder],
    materialBindingSources: ['renderer-override'],
    materialOverrides: [override],
    transform: { world: new Float32Array(16) },
  };
  return { slot: 0, generation: 1, version: 0, entityKey: 1, snapshot };
}

it('reads the effective override bindings the material dispatch admitted', () => {
  // The direct placeholder is never drawn: the dispatch admits the effective
  // override resource and drops the placeholder from its material frame.
  const placeholder = new MaterialResource(material(0));
  const override = new MaterialResource(material(7));
  const meshes = new MeshFrame().with(
    1,
    { ...createPrimitiveMesh('cube').unwrap(), materialSlots: [{ slotName: 'body' }] },
    [placeholder],
  );
  const row = overrideRow(placeholder, override);
  const owner = new MaterialDispatch();
  owner.bind(row.slot, row.snapshot);
  owner.prepare(meshes);
  const slots = new SceneSlots();
  setSceneRow(slots, row.slot, row);
  owner.query(slots.capture(), meshes);
  const frame = owner.materials();
  expect(frame.get(placeholder)).toBeUndefined();
  expect(frame.get(override)).toBeDefined();

  // Without the Mesh version the direct placeholder has no accepted version.
  const direct = new SubsurfaceSelection();
  direct.add(row.snapshot, frame);
  expect(direct.demand).toBe('missing-material');
  expect(() => subsurfaceDemand(direct.demand)).toThrow(/accepted material version/);

  const effective = new SubsurfaceSelection();
  effective.add(row.snapshot, frame, meshes);
  expect(effective.demand).toBe(0);
  expect(subsurfaceDemand(effective.demand)).toBe(false);
});

it('counts an override subsurface profile and follows its later accepted version', () => {
  const placeholder = new MaterialResource(material(0));
  const skin = new MaterialResource(
    material(9, {
      surfaceModel: 'standard',
      deferredPass: true,
      paramSnapshot: { subsurfaceRadius: [1, 0.5, 0.25], subsurfaceWeight: 1 },
    }),
  );
  const meshes = new MeshFrame().with(
    1,
    { ...createPrimitiveMesh('cube').unwrap(), materialSlots: [{ slotName: 'body' }] },
    [placeholder],
  );
  const row = overrideRow(placeholder, skin);
  const owner = new MaterialDispatch();
  owner.bind(row.slot, row.snapshot);
  owner.prepare(meshes);
  const slots = new SceneSlots();
  setSceneRow(slots, row.slot, row);
  owner.query(slots.capture(), meshes);
  const frame = owner.materials();
  const selection = new SubsurfaceSelection();
  selection.add(row.snapshot, frame, meshes);
  selection.adopt(frame);
  expect(selection.demand).toBe(1);
  skin.adopt({
    ...skin.snapshot,
    paramSnapshot: { subsurfaceRadius: [0, 0, 0], subsurfaceWeight: 0 },
  });
  selection.adopt(frame.with(skin));
  expect(selection.demand).toBe(0);
});

import { vec3 } from '@forgeax/engine-math';
import { expect, it } from 'vitest';
import { MaterialResource } from '../../material-resource';
import type { MaterialSnapshot } from '../../render-system-extract';
import { MaterialFrame } from '../../scene/material-dispatch';
import { subsurfaceDemand } from '../demand';
import { SubsurfaceSelection } from '../selection';

function skin(handle: number): MaterialSnapshot {
  return {
    materialHandle: handle,
    baseColor: vec3.create(1, 1, 1),
    metallic: 0,
    roughness: 0.5,
    passes: [
      {
        name: 'GBuffer',
        program: { module: 'forgeax::default-unlit' },
        renderState: { tags: { LightMode: 'Deferred' }, queue: 2000 },
      },
    ],
    surfaceModel: 'standard',
    deferredPass: true,
    paramSnapshot: { subsurfaceRadius: [1, 0.5, 0.25], subsurfaceWeight: 1 },
  };
}

const EMPTY = new MaterialFrame(undefined);

it('does not fail on a hidden row whose material the dispatch has not admitted', () => {
  // The dispatch admits materials only for visible or prepared rows.
  const resource = new MaterialResource(skin(3));
  const hidden = {
    material: resource,
    materials: [],
    materialBindingSources: [],
    authorVisible: false,
  };
  const selection = new SubsurfaceSelection();
  selection.add(hidden, EMPTY);
  selection.adopt(EMPTY);
  expect(selection.demand).toBe(0);
  expect(subsurfaceDemand(selection.demand)).toBe(false);

  // Once the row gains demand, adoption counts the accepted version.
  const admitted = EMPTY.with(resource);
  selection.adopt(admitted);
  expect(selection.demand).toHaveLength(1);
  // Losing it again returns to no demand, not to a missing material.
  selection.adopt(EMPTY);
  expect(selection.demand).toBe(0);
});

it('keeps an absent material of a visible row an error, also when a hidden row selected it first', () => {
  const resource = new MaterialResource(skin(4));
  const selection = new SubsurfaceSelection();
  selection.add(
    { material: resource, materials: [], materialBindingSources: [], authorVisible: false },
    EMPTY,
  );
  expect(selection.demand).toBe(0);
  selection.add({ material: resource, materials: [], materialBindingSources: [] }, EMPTY);
  expect(selection.demand).toBe('missing-material');
  expect(() => subsurfaceDemand(selection.demand)).toThrow(/accepted material version/);

  const visible = new SubsurfaceSelection();
  visible.add({ material: resource, materials: [], materialBindingSources: [] }, EMPTY);
  expect(visible.demand).toBe('missing-material');
});

it('treats a hidden row with pipeline preparation as admitted', () => {
  const resource = new MaterialResource(skin(5));
  const selection = new SubsurfaceSelection();
  selection.add(
    {
      material: resource,
      materials: [],
      materialBindingSources: [],
      authorVisible: false,
      pipelinePreparation: [],
    },
    EMPTY,
  );
  expect(selection.demand).toBe('missing-material');
});

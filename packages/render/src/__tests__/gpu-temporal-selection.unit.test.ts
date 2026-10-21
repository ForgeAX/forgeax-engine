import { assert, expect, it } from 'vitest';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { GpuDrawSelection } from '../gpu-driven/draw-selection';
import type { PreparedGpuDrivenDraw } from '../gpu-driven/prepared-draw';
import { RenderScene } from '../scene/render-scene';
import { receiptRow } from './gpu-draw-selection-fixture';

it.each([
  ['forgeax::default-standard-pbr', 'rigid', undefined, false],
  ['forgeax::default-standard-pbr', 'rigid', [1], false],
  ['forgeax::default-standard-pbr', 'rigid', [1, 0.5], true],
  ['forgeax::default-standard-pbr', 'skin', [1, 0.5], false],
  ['game::custom', 'rigid', [1, 0.5], false],
] as const)('keeps CPU temporal work unless accepted GPU raster consumes it: %s %s %j', (material, deformation, coverages, owns) => {
  const scene = new RenderScene();
  const source = {
    ...receiptRow().source,
    lods: [{ mesh: '00000000-0000-7000-8000-000000000001' as never, screenCoverage: 0.5 }],
  };
  const topology = new BatchTopology();
  topology.apply(
    scene.apply([{ kind: 'update', worldId: 0, entityKey: source.entityKey, snapshot: source }]),
  );
  const batches = topology
    .query(topology.sourcePlan(), undefined)
    .batches.map(({ lod: _lod, ...batch }) => ({
      ...batch,
      prepared: {
        identity: { material, deformation, geometry: 'triangle' },
      } as PreparedGpuDrivenDraw,
      ...(coverages === undefined ? {} : { lod: { coverages, ranges: [] } }),
      get candidates(): never {
        throw new Error('Pass selection enumerated candidates');
      },
      get members(): never {
        throw new Error('Pass selection enumerated members');
      },
    }));
  const selection = new GpuDrawSelection(batches);
  const draw = source.gpuDrivenDraws?.[0];
  assert(draw);
  expect(selection.owns(source, draw, 0, 'forward')).toBe(true);
  expect(selection.owns(source, draw, 0, 'temporal')).toBe(owns);
  // Live material adoption cannot rewrite an accepted submission's execution.
  source.material.adopt({ ...source.material.snapshot, materialShaderId: 'game::replacement' });
  expect(selection.owns(source, draw, 0, 'temporal')).toBe(owns);
});

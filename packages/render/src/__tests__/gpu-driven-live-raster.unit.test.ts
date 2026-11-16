import type { Buffer } from '@forgeax/engine-rhi';
import { expect, it } from 'vitest';
import { projectLiveRaster } from '../gpu-driven/live-raster';
import type {
  FilteredProductionPlan,
  PreparedBatch,
} from '../gpu-driven/production-raster-prepare';

const mesh = { vertexBuffer: {}, indexBuffer: null };
const key = {
  drawKind: 'indexed',
  topology: 'triangle-list',
  materialPass: 'opaque',
  materialSlot: 3,
};
const row = (batchId: number, generation = 1, batch: object = {}) =>
  ({
    batch: {
      batchId,
      generation,
      key,
      visibleBase: 0,
      visibleCapacity: 1,
      visibleAllocationCapacity: 64,
      ...batch,
    },
    mesh,
    rasterClassKey: 'class',
    recordingRasterClassKey: 'class',
    materialBindingClass: 'standard',
  }) as unknown as PreparedBatch;
const plan = (batches: PreparedBatch[]) => ({ batches }) as unknown as FilteredProductionPlan;

it('keeps an unchanged row on a mesh whose earlier row was rebuilt', () => {
  const visible = {} as Buffer;
  const rigid = {};
  const kept = row(2);
  const first = projectLiveRaster(undefined, plan([row(1), kept]), visible, rigid, undefined);
  const next = projectLiveRaster(first, plan([row(1, 2), kept]), visible, rigid, undefined);
  expect(next.value[1]).toBe(first.value[1]);
  expect(next.value[0]?.meshBinding).toBe(first.value[0]?.meshBinding);
});

it('keeps the command identity when only GPU-culled candidates change', () => {
  const visible = {} as Buffer;
  const rigid = {};
  const first = projectLiveRaster(undefined, plan([row(1)]), visible, rigid, undefined);
  const live = first.value[0];
  if (live !== undefined) live.visibleBindGroups = { early: [] };
  const grown = row(1, 1, { candidates: [1, 2], visibleCapacity: 2, contentEpoch: 4 });
  const next = projectLiveRaster(first, plan([grown]), visible, rigid, undefined);
  expect(next.value[0]).not.toBe(live);
  expect(next.value[0]?.command).toBe(live?.command);
  const moved = row(1, 1, { key: { ...key, materialSlot: 4 } });
  const remapped = projectLiveRaster(next, plan([moved]), visible, rigid, undefined);
  expect(remapped.value[0]?.command).not.toBe(live?.command);
});

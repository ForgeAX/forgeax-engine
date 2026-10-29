import { World } from '@forgeax/engine-ecs';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_GPU_DRAW_SELECTION } from '../gpu-driven/draw-selection';
import { MaterialResource } from '../material-resource';
import { worldRenderResources } from '../publication/resource-scope';
import { createDynamicGeometryFrameBindings } from '../record/dynamic-geometry-consumption';
import { emitGpuDrivenDrawReceipts, summarizeGpuDrivenDraws } from '../record/gpu-draw-receipts';
import { receiptRow, receiptSelection } from './gpu-draw-selection-fixture';

describe('shared GPU draw selection and submitted receipts', () => {
  it('queries one shared execution per draw and emits the exact submitted source index', () => {
    const rows = [receiptRow()];
    const selection = receiptSelection(rows, (batch) => batch.binding?.drawItemIndex === 7);
    const owns = vi.spyOn(selection, 'owns');
    const drawn = vi.fn();
    emitGpuDrivenDrawReceipts(
      rows.map((row) => row.source),
      selection,
      drawn,
    );
    expect(owns).toHaveBeenCalledTimes(2);
    expect(drawn).toHaveBeenCalledExactlyOnceWith(rows[0], 7, { lane: 'gpu', ready: true });
    const summary = summarizeGpuDrivenDraws(
      rows.map((row) => row.source),
      selection,
    );
    expect(summary).toMatchObject({
      gpuDraws: 1,
      gpuEntities: 1,
      mixedEntities: 1,
      totalDraws: 2,
      cpuDraws: 1,
      semanticDraws: 1,
    });
  });

  it('queries shared geometry without reading entity identity or material values', () => {
    const row = receiptRow();
    const selection = receiptSelection([row], () => true);
    const source = {
      ...row.source,
      get entityKey(): number {
        throw new Error('entity scan');
      },
    };
    vi.spyOn(source.material, 'snapshot', 'get').mockImplementation(() => {
      throw new Error('material read');
    });
    expect(selection.ownsAll(source)).toBe(true);
    expect(selection.has(source, 7)).toBe(true);
    expect(selection.has(source, 99)).toBe(false);
  });

  it('keeps World, mesh, source draw index, geometry and resource identities separate', () => {
    const row = receiptRow();
    const selection = receiptSelection([row], () => true);
    const source = row.source;
    expect(selection.ownsAll({ ...source, worldId: 1 })).toBe(false);
    expect(selection.ownsAll({ ...source, assetHandle: 10 })).toBe(false);
    const replacement = new MaterialResource(source.material.snapshot);
    expect(selection.ownsAll({ ...source, material: replacement, materials: [replacement] })).toBe(
      false,
    );
    const draw = source.gpuDrivenDraws?.[0];
    if (draw === undefined) throw new Error('missing fixture draw');
    expect(selection.owns(source, { ...draw, drawItemIndex: 99 }, 0)).toBe(false);
    expect(
      selection.owns(
        source,
        {
          ...draw,
          geometry: { ...draw.geometry, receipt: { ...draw.geometry.receipt, identity: 'other' } },
        },
        0,
      ),
    ).toBe(false);
    expect(selection.ownsAll({ ...source, instances: { instanceCount: 0 } } as typeof source)).toBe(
      false,
    );
  });

  it('retains an accepted execution across a newer material adoption and selection', () => {
    const row = receiptRow();
    const accepted = receiptSelection([row], (batch) => batch.binding?.drawItemIndex === 7);
    row.source.material.adopt({ ...row.source.material.snapshot, transparent: true });
    const next = receiptSelection([row], () => false);
    const drawn = vi.fn();
    emitGpuDrivenDrawReceipts([row.source], next, drawn);
    expect(drawn).not.toHaveBeenCalled();
    const currentRow = { source: row.source, currentMesh: true };
    emitGpuDrivenDrawReceipts([currentRow.source], accepted, drawn);
    expect(drawn).toHaveBeenCalledExactlyOnceWith({ source: currentRow.source }, 7, {
      lane: 'gpu',
      ready: true,
    });
  });

  it('summarizes independently of a failing receipt callback', () => {
    const row = receiptRow();
    const selection = receiptSelection([row], () => true);
    const failure = new Error('receipt consumer failed');
    const drawn = vi.fn(() => {
      throw failure;
    });
    expect(() => emitGpuDrivenDrawReceipts([row.source], selection, drawn)).toThrow(failure);
    expect(drawn).toHaveBeenCalledTimes(1);
    expect(summarizeGpuDrivenDraws([row.source], selection)).toMatchObject({
      gpuDraws: 2,
    });
  });

  it('answers GPU-owned rows on demand and combines them with CPU receipts', () => {
    const world = worldRenderResources(new World());
    const bindings = createDynamicGeometryFrameBindings();
    const owns = vi.fn(
      (_worldId: number, entity: number, mesh: number) => entity === 42 && mesh === 9,
    );
    bindings.begin();
    bindings.onRenderableDraw([world]);
    bindings.onGpuOwnedDraws([world], owns);
    bindings.commit(true);
    expect(owns).not.toHaveBeenCalled();
    expect(bindings.recordStageLane(world, 42, 9)).toBe('gpu');
    expect(bindings.isConsumed(world, 42, 10)).toBe(false);
    bindings.begin();
    const cpu = bindings.onRenderableDraw([world]);
    cpu({ source: receiptRow().source }, 'cpu');
    bindings.onGpuOwnedDraws([world], owns);
    bindings.commit(true);
    expect(bindings.recordStageLane(world, 42, 9)).toBe('mixed');
    bindings.begin();
    bindings.onRenderableDraw([world]);
    bindings.onGpuOwnedDraws([world], owns);
    bindings.commit(false);
    expect(bindings.isConsumed(world, 42, 9)).toBe(false);
  });

  it('keeps a rejected submission unconsumed and permits retry after a newer preparation', () => {
    const world = new World();
    const bindings = createDynamicGeometryFrameBindings();
    const row = receiptRow();
    const selection = receiptSelection([row], () => true);
    bindings.begin();
    bindings.commit(false);
    expect(bindings.isConsumed(worldRenderResources(world), 42, 9)).toBe(false);
    emitGpuDrivenDrawReceipts([], EMPTY_GPU_DRAW_SELECTION, () => {});
    bindings.begin();
    const consume = bindings.onRenderableDraw([world].map(worldRenderResources));
    emitGpuDrivenDrawReceipts([row.source], selection, (entry, _index, receipt) =>
      consume(entry, receipt.lane),
    );
    bindings.commit(true);
    expect(bindings.recordStageLane(worldRenderResources(world), 42, 9)).toBe('gpu');
  });
});

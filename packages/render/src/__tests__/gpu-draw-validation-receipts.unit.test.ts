import { World } from '@forgeax/engine-ecs';
import { describe, expect, it, vi } from 'vitest';
import { GpuDrivenPreparationError } from '../errors/gpu-driven';
import { EMPTY_GPU_DRAW_SELECTION } from '../gpu-driven/draw-selection';
import { MaterialResource } from '../material-resource';
import { worldRenderResources } from '../publication/resource-scope';
import { DynamicGeometryReceipt } from '../record/dynamic-geometry-receipt';
import { emitGpuDrivenDrawReceipts, summarizeGpuDrivenDraws } from '../record/gpu-draw-receipts';
import type { GpuOwnedFrame, RenderableSnapshot } from '../render-system-extract';
import { presentedRenderableRecorder } from '../render-system-record';
import type { RecordAttempt } from '../render-system-record-attempt';
import type { ViewSettlementOwner } from '../world/view-settlement';
import { receiptRow, receiptSelection } from './gpu-draw-selection-fixture';

describe('shared GPU draw selection and submitted receipts', () => {
  it('reads mixed section and terrain evidence directly from the submitted GPU selection', () => {
    const row = receiptRow();
    const source = {
      ...row.source,
      terrainSection: { index: 5 } as NonNullable<RenderableSnapshot['terrainSection']>,
    };
    const owned = {
      row: vi.fn((key: number) => (key === source.entityKey ? source : undefined)),
    } satisfies Pick<GpuOwnedFrame, 'row'>;
    const world = new World();
    const owner = { internals: { renderWorld: world } } as ViewSettlementOwner;
    const attempt = { sourceScope: worldRenderResources(world) } as RecordAttempt;
    const frame = presentedRenderableRecorder(owner, attempt, owned);
    const next = receiptSelection([row], (batch) => batch.binding?.drawItemIndex === 7);
    const material = row.source.material.snapshot;
    expect(frame.markPresentedRenderable.needsMaterialReceipt?.(material)).toBe(true);
    frame.markPresentedRenderable(row, 2);
    expect(frame.markPresentedRenderable.needsMaterialReceipt?.(material)).toBe(false);
    expect(frame.drawObservation.commit(true)).toEqual({
      status: 'unavailable',
      reason: 'source-unavailable',
      draws: [],
    });
    expect(frame.presentedDraws.hasSubmesh(source.entityKey, 7)).toBe(false);
    expect(frame.presentedDraws.hasTerrain(source.entityKey, 5)).toBe(false);
    expect(owned.row).not.toHaveBeenCalled();
    frame.publishGpuSelection?.(next);
    expect(frame.presentedDraws.hasSubmesh(source.entityKey, 7)).toBe(true);
    expect(frame.presentedDraws.hasSubmesh(source.entityKey, 2)).toBe(true);
    expect(frame.presentedDraws.hasSubmesh(source.entityKey, 0)).toBe(false);
    expect(frame.presentedDraws.hasEntity(99)).toBe(false);
    expect(frame.presentedDraws.hasTerrain(source.entityKey, 5)).toBe(true);
    expect(frame.presentedDraws.hasTerrain(source.entityKey, 6)).toBe(false);
    for (const section of [0, 1, 3, 4, 5, 6]) frame.markPresentedRenderable(row, section);
    owned.row.mockClear();
    expect(frame.presentedDraws.firstMissingSubmesh(source.entityKey, 9)).toBe(8);
    expect(owned.row).toHaveBeenCalledExactlyOnceWith(source.entityKey);
  });

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

  it('keeps mesh, source draw index, geometry and resource identities separate', () => {
    const row = receiptRow();
    const selection = receiptSelection([row], () => true);
    const source = row.source;
    expect(selection.ownsAll({ ...source })).toBe(true);
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
    const bindings = new DynamicGeometryReceipt();
    const owns = vi.fn((entity: number, mesh: number) => entity === 42 && mesh === 9);
    bindings.onRenderableDraw(world);
    bindings.onGpuOwnedDraws(world, owns);
    bindings.commit();
    expect(owns).not.toHaveBeenCalled();
    expect(bindings.recordStageLane(world, 42, 9)).toBe('gpu');
    expect(bindings.isConsumed(world, 42, 10)).toBe(false);
    const cpu = bindings.onRenderableDraw(world);
    cpu({ source: receiptRow().source }, 'cpu');
    bindings.onGpuOwnedDraws(world, owns);
    bindings.commit();
    expect(bindings.recordStageLane(world, 42, 9)).toBe('mixed');
    bindings.onRenderableDraw(world);
    bindings.onGpuOwnedDraws(world, owns);
    bindings.clear();
    expect(bindings.isConsumed(world, 42, 9)).toBe(false);
  });

  it('keeps a rejected submission unconsumed and permits retry after a newer preparation', () => {
    const world = new World();
    const bindings = new DynamicGeometryReceipt();
    const row = receiptRow();
    const selection = receiptSelection([row], () => true);
    bindings.clear();
    expect(bindings.isConsumed(worldRenderResources(world), 42, 9)).toBe(false);
    emitGpuDrivenDrawReceipts([], EMPTY_GPU_DRAW_SELECTION, () => {});
    const consume = bindings.onRenderableDraw(worldRenderResources(world));
    emitGpuDrivenDrawReceipts([row.source], selection, (entry, _index, receipt) =>
      consume(entry, receipt.lane),
    );
    bindings.commit();
    expect(bindings.recordStageLane(worldRenderResources(world), 42, 9)).toBe('gpu');
  });
});

it('emits and counts no raster demand for hidden or empty-instance rows, without ownership queries', () => {
  const row = receiptRow();
  const selection = receiptSelection([row], () => true);
  const owns = vi.spyOn(selection, 'owns');
  const drawn = vi.fn();
  const hidden = { ...row.source, authorVisible: false };
  const empty = {
    ...row.source,
    instances: { transforms: new Float32Array(0), instanceCount: 0, cacheKey: 1, archVersion: 0 },
  };
  emitGpuDrivenDrawReceipts([hidden, empty], selection, drawn);
  expect(drawn).not.toHaveBeenCalled();
  const summary = summarizeGpuDrivenDraws([hidden, empty], selection);
  expect(summary).toMatchObject({
    gpuDraws: 0,
    gpuEntities: 0,
    totalDraws: 0,
    cpuDraws: 0,
    semanticDraws: 0,
  });
  expect(owns).not.toHaveBeenCalled();
});

it('keeps genuine visible resource failures in blocked lane evidence', () => {
  const row = receiptRow();
  const source = {
    ...row.source,
    gpuDrivenDraws: (row.source.gpuDrivenDraws ?? []).map((draw) => ({
      ...draw,
      preparationError: new GpuDrivenPreparationError('resource-not-ready', {
        owner: 'material',
        reason: 'material-resource-missing',
        recovery: 'retry-same-draw',
      }),
    })),
  };
  expect(summarizeGpuDrivenDraws([source], EMPTY_GPU_DRAW_SELECTION)).toMatchObject({
    totalDraws: 2,
    cpuDraws: 2,
    blockedDraws: 2,
    semanticDraws: 0,
  });
});

it('counts only CPU-admitted draws in an uncompacted retained frame', () => {
  const owned = receiptRow().source;
  const dormant = { ...owned, entityKey: 43, assetHandle: 11 };
  const cpu = { ...dormant, entityKey: 44 };
  const selection = receiptSelection([{ source: owned }], () => true);
  const counts = summarizeGpuDrivenDraws([owned, dormant, cpu], selection, (row) => row === cpu);
  expect(counts).toMatchObject({
    gpuDraws: 2,
    gpuEntities: 1,
    cpuDraws: 2,
    totalDraws: 4,
    mixedEntities: 0,
  });
});

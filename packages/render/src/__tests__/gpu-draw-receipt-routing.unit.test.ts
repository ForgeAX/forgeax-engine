import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { GpuDrawSelection } from '../gpu-driven/draw-selection';
import { MaterialResource } from '../material-resource';
import { worldRenderResources } from '../publication/resource-scope';
import { createDynamicGeometryFrameBindings } from '../record/dynamic-geometry-consumption';
import { emitGpuDrivenDrawReceipts } from '../record/gpu-draw-receipts';
import { defaultMaterialSnapshot } from '../render-system-extract';
import { PersistentRenderScene, RenderScene } from '../scene/render-scene';
import { receiptSelection, receiptRow as row } from './gpu-draw-selection-fixture';

describe('GPU draw receipt routing', () => {
  it('queries a shadow view selection by slot generation without building entity claims', () => {
    const original = row(0).source;
    const scene = new RenderScene();
    const topology = new BatchTopology();
    topology.apply(
      scene.apply(
        Array.from({ length: 10_000 }, (_, entityKey) => ({
          kind: 'update' as const,
          worldId: 0,
          entityKey,
          snapshot: { ...original, entityKey },
        })),
      ),
    );
    let reads = 0;
    const batches = topology.query(topology.sourcePlan(), undefined).batches.map((batch) => ({
      ...batch,
      candidates: new Proxy(
        batch.candidates.filter((candidate) => candidate.primitiveIndex % 2 === 0),
        {
          get(target, key, receiver) {
            if (key === Symbol.iterator || (typeof key === 'string' && /^\d+$/.test(key))) reads++;
            return Reflect.get(target, key, receiver);
          },
        },
      ),
    }));
    const selection = new GpuDrawSelection(batches);
    expect(reads).toBe(0);
    const selected = scene.slotAt(42);
    const absent = scene.slotAt(43);
    if (selected === undefined || absent === undefined) throw new Error('Missing source slots');
    expect(selection.ownsSlot(selected.snapshot, 7, selected.slot, selected.generation)).toBe(true);
    expect(selection.ownsSlot(absent.snapshot, 7, absent.slot, absent.generation)).toBe(false);
    expect(selection.ownsSlot(selected.snapshot, 7, selected.slot, selected.generation + 1)).toBe(
      false,
    );
    expect(reads).toBeLessThan(50);
    const changed = { ...selected.snapshot, assetHandle: 10 };
    expect(selection.ownsSlot(changed, 7, selected.slot, selected.generation)).toBe(false);
  });

  it.each([
    ['cpu', 'cpu', 'cpu'],
    ['gpu', 'gpu', 'gpu'],
    ['cpu', 'gpu', 'mixed'],
    ['gpu', 'cpu', 'mixed'],
  ] as const)('combines %s and %s draws for only the submitted mesh', (first, second, expected) => {
    const world = new World();
    const bindings = createDynamicGeometryFrameBindings();
    const original = row(0);
    bindings.begin();
    const consume = bindings.onRenderableDraw([world].map(worldRenderResources));
    consume(original, first);
    consume(original, second);
    consume(original, first);
    bindings.commit(true);
    expect(bindings.recordStageLane(worldRenderResources(world), 42, 9)).toBe(expected);

    // A replacement mesh owns a fresh lane even within this frame.
    bindings.begin();
    const consumeReplacement = bindings.onRenderableDraw([world].map(worldRenderResources));
    consumeReplacement(original, first);
    consumeReplacement(original, second);
    const replacement = { source: { ...original.source, assetHandle: 10 } };
    consumeReplacement(replacement, second);
    bindings.commit(true);
    expect(bindings.recordStageLane(worldRenderResources(world), 42, 9)).toBeUndefined();
    expect(bindings.recordStageLane(worldRenderResources(world), 42, 10)).toBe(second);

    bindings.begin();
    bindings.onRenderableDraw([world].map(worldRenderResources))(original, first);
    bindings.commit(false);
    expect(bindings.recordStageLane(worldRenderResources(world), 42, 9)).toBeUndefined();
    expect(bindings.recordStageLane(worldRenderResources(world), 42, 10)).toBeUndefined();
  });

  it('keeps submitted submeshes and geometry consumption with their stable World after reordering', () => {
    const first = new World();
    const second = new World();
    const scene = new PersistentRenderScene();
    const originalKeys = scene.visibilityWorldKeysFor([first, second].map(worldRenderResources));
    const worlds = [second, first];
    const worldKeys = scene.visibilityWorldKeysFor(worlds.map(worldRenderResources));
    expect(worldKeys).toEqual([originalKeys[1], originalKeys[0]]);
    const bindings = createDynamicGeometryFrameBindings();
    bindings.begin();
    const consume = bindings.onRenderableDraw(worlds.map(worldRenderResources));
    const receipts: { world: string; submesh: number; lane: string; ready: boolean }[] = [];
    const rows = [row(0), row(1)];
    emitGpuDrivenDrawReceipts(
      rows.map((row) => row.source),
      receiptSelection(
        rows,
        (batch) => batch.binding?.worldId === 0 && batch.binding.drawItemIndex === 7,
      ),
      (drawn, submesh, receipt) => {
        receipts.push({
          world: worlds[drawn.source.worldId]?.identity ?? '',
          submesh,
          lane: receipt.lane,
          ready: receipt.ready,
        });
        consume(drawn, receipt.lane);
      },
    );
    bindings.commit(true);
    expect(receipts).toEqual([{ world: second.identity, submesh: 7, lane: 'gpu', ready: true }]);
    expect(bindings.isConsumed(worldRenderResources(second), 42, 9)).toBe(true);
    expect(bindings.recordStageLane(worldRenderResources(second), 42, 9)).toBe('gpu');
    expect(bindings.isConsumed(worldRenderResources(first), 42, 9)).toBe(false);
  });

  it('uses source submesh indices and exact material resources while retaining the ordinal fallback', () => {
    const entry = row(0);
    const first = entry.source.gpuDrivenDraws?.[0];
    if (first === undefined) throw new Error('missing draw');
    const { drawItemIndex: _drawItemIndex, ...compactDraw } = first;
    const source = {
      ...entry.source,
      materials: [entry.source.material, new MaterialResource(defaultMaterialSnapshot(18))],
      gpuDrivenDraws: [first, compactDraw, { ...first, drawItemIndex: 7, materialSlot: 1 }],
    };
    const submeshes: number[] = [];
    const rows = [{ source }];
    emitGpuDrivenDrawReceipts(
      rows.map((row) => row.source),
      receiptSelection(rows, (batch) => batch.binding?.drawItemIndex !== 2),
      (_entry, submesh) => submeshes.push(submesh),
    );
    expect(submeshes).toEqual([1, 7]);
  });

  it('keeps failed submission geometry unconsumed', () => {
    const world = new World();
    const bindings = createDynamicGeometryFrameBindings();
    bindings.begin();
    const consume = bindings.onRenderableDraw([world].map(worldRenderResources));
    const rows = [row(0)];
    emitGpuDrivenDrawReceipts(
      rows.map((row) => row.source),
      receiptSelection(rows, (batch) => batch.binding?.drawItemIndex === 2),
      (entry, _submesh, receipt) => consume(entry, receipt.lane),
    );
    bindings.commit(false);
    expect(bindings.isConsumed(worldRenderResources(world), 42, 9)).toBe(false);
  });
});

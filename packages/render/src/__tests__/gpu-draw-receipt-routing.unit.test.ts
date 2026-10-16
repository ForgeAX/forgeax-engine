import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { gpuDrivenDrawKey } from '../extract/gpu-driven';
import { GpuDrivenProduction } from '../gpu-driven/production-raster';
import { createDynamicGeometryFrameBindings } from '../record/dynamic-geometry-consumption';
import { worldEntityKey } from '../record/frame-snapshot';
import { emitGpuDrivenDrawReceipts } from '../record/gpu-draw-receipts';
import { defaultMaterialSnapshot, type RenderableSnapshot } from '../render-system-extract';
import { PersistentRenderScene } from '../scene/render-scene';

function row(worldId: number) {
  const material = defaultMaterialSnapshot(17);
  const source: RenderableSnapshot = {
    worldId,
    entityKey: 42,
    assetHandle: 9,
    transform: { world: new Float32Array(16) },
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    gpuDrivenDraws: [2, 7].map((drawItemIndex) => ({
      drawItemIndex,
      kind: 'indexed',
      first: drawItemIndex * 3,
      count: 3,
      baseVertex: 0,
      topology: 'triangle-list',
      materialSlot: 0,
      pipelineClass: 'standard',
      materialResourceClass: '',
    })),
  };
  return { source };
}

async function validate(
  rows: readonly ReturnType<typeof row>[],
  claims: ReadonlySet<string>,
  worldKeys?: readonly number[],
) {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const owner = new GpuDrivenProduction(device, { createShaderModule: () => ok(shader) });
  try {
    return owner.recordCpuValidation(rows, claims, undefined, worldKeys);
  } finally {
    owner.dispose();
  }
}

describe('GPU draw receipt routing', () => {
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
    const consume = bindings.onRenderableDraw([world]);
    consume(original, first);
    consume(original, second);
    consume(original, first);
    bindings.commit(true);
    expect(bindings.recordStageLane(world, 42, 9)).toBe(expected);

    // A replacement mesh owns a fresh lane even within this frame.
    bindings.begin();
    const consumeReplacement = bindings.onRenderableDraw([world]);
    consumeReplacement(original, first);
    consumeReplacement(original, second);
    const replacement = { source: { ...original.source, assetHandle: 10 } };
    consumeReplacement(replacement, second);
    bindings.commit(true);
    expect(bindings.recordStageLane(world, 42, 9)).toBeUndefined();
    expect(bindings.recordStageLane(world, 42, 10)).toBe(second);

    bindings.begin();
    bindings.onRenderableDraw([world])(original, first);
    bindings.commit(false);
    expect(bindings.recordStageLane(world, 42, 9)).toBeUndefined();
    expect(bindings.recordStageLane(world, 42, 10)).toBeUndefined();
  });

  it('keeps submitted submeshes and geometry consumption with their stable World after reordering', async () => {
    const first = new World();
    const second = new World();
    const scene = new PersistentRenderScene();
    const originalKeys = scene.visibilityWorldKeysFor([first, second]);
    const worlds = [second, first];
    const worldKeys = scene.visibilityWorldKeysFor(worlds);
    expect(worldKeys).toEqual([originalKeys[1], originalKeys[0]]);
    const claims = new Set([gpuDrivenDrawKey(worldEntityKey(originalKeys[1] ?? -1, 42), 17, 7)]);
    const bindings = createDynamicGeometryFrameBindings();
    bindings.begin();
    const consume = bindings.onRenderableDraw(worlds);
    const receipts: { world: string; submesh: number; lane: string; ready: boolean }[] = [];
    const rows = [row(0), row(1)];
    emitGpuDrivenDrawReceipts(
      rows,
      await validate(rows, claims, worldKeys),
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
    expect(bindings.isConsumed(second, 42, 9)).toBe(true);
    expect(bindings.recordStageLane(second, 42, 9)).toBe('gpu');
    expect(bindings.isConsumed(first, 42, 9)).toBe(false);
  });

  it('uses source submesh indices and exact material handles while retaining the ordinal fallback', async () => {
    const entry = row(0);
    const first = entry.source.gpuDrivenDraws?.[0];
    if (first === undefined) throw new Error('missing draw');
    const { drawItemIndex: _drawItemIndex, ...compactDraw } = first;
    const source = {
      ...entry.source,
      materials: [entry.source.material, defaultMaterialSnapshot(18)],
      gpuDrivenDraws: [first, compactDraw, { ...first, drawItemIndex: 7, materialSlot: 1 }],
    };
    const claims = new Set([
      gpuDrivenDrawKey(worldEntityKey(0, 42), 17, 1),
      gpuDrivenDrawKey(worldEntityKey(0, 42), 18, 7),
      gpuDrivenDrawKey(worldEntityKey(0, 43), 17, 2),
    ]);
    const submeshes: number[] = [];
    const rows = [{ source }];
    emitGpuDrivenDrawReceipts(rows, await validate(rows, claims), (_entry, submesh) =>
      submeshes.push(submesh),
    );
    expect(submeshes).toEqual([1, 7]);
  });

  it('keeps failed submission geometry unconsumed', async () => {
    const world = new World();
    const bindings = createDynamicGeometryFrameBindings();
    bindings.begin();
    const consume = bindings.onRenderableDraw([world]);
    const rows = [row(0)];
    const claims = new Set([gpuDrivenDrawKey(worldEntityKey(0, 42), 17, 2)]);
    emitGpuDrivenDrawReceipts(rows, await validate(rows, claims, [0]), (entry, _submesh, receipt) =>
      consume(entry, receipt.lane),
    );
    bindings.commit(false);
    expect(bindings.isConsumed(world, 42, 9)).toBe(false);
  });
});

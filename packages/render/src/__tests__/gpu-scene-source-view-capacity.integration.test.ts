import { writeFile } from 'node:fs/promises';
import type { EntityHandle } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import type { MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import { assert, expect, it, onTestFinished, vi } from 'vitest';
import { publishRuntimeAssets } from '../../../assets-runtime/src/__tests__/fixtures/runtime-publication';
import { createMaterialPackCooker } from '../../../shader-compiler/src/material/pack-cooker';
import { MeshFilter, MeshRenderer } from '../components';
import type { GpuSceneCapacityPreparation } from '../gpu-scene-capacity';
import type { GpuSceneInputPreparation } from '../gpu-scene-inputs';
import * as hdrpBuffersModule from '../hdrp-buffers';
import { Materials } from '../materials';
import { worldRenderResources } from '../publication/resource-scope';
import { getOpaqueResourceIdentity } from '../record/frame-snapshot';
import { finishRendererInput, rendererInputHandoffFixture } from './renderer-input-handoff-fixture';

it('admits closed Source addresses without cold View storage in the next old-world draw', () =>
  runSourceViewCase(false));
it(
  'retains old medium candidate-frame storage while admitting closed Source addresses',
  () => runSourceViewCase(true),
  30_000,
);

async function runSourceViewCase(medium: boolean) {
  const f = await rendererInputHandoffFixture({ sharedShaderRegistry: medium });
  let phase = 'warmup';
  const evidence = medium ? recordHdrpInputs(f, () => phase) : undefined;
  onTestFinished(async () => {
    evidence?.restore();
    try {
      const closed = await f.close();
      if (!closed.ok) throw closed.error;
    } finally {
      if (evidence !== undefined)
        await writeFile(
          '/tmp/forgeax-level-surface-hdrp-groups-20261117.json',
          JSON.stringify(evidence.records, null, 2),
        );
    }
  });
  if (medium) await addOldMedium(f);
  phase = 'private source';
  const owner = f.internals.sceneComposition?.entry?.projection;
  assert(owner);
  const original = owner.slotsSnapshot().at(0)?.snapshot;
  assert(original?.assetHandle !== undefined);
  const rows = Array.from({ length: 65 }, (_, index) =>
    owner.prepareRow({ ...original, entityKey: (1 << 20) + index }),
  );
  const source = worldRenderResources(f.world);
  const asset = source.resolveAsset<MeshAsset>(original.assetHandle).unwrap();
  const revision = source.assetRevision(original.assetHandle);
  assert(revision !== undefined);
  const views = f.manager.currentOwner.gpuDriven.inputBindingViews(f.scene);
  assert(views.length > 0);
  const stableRaster = views.map((view) => ({
    view,
    visible: view.visibleBuffer,
    indirect: view.indirectBuffer,
    generation: view.graphResourceGeneration,
    rebuilds: view.inspect().bufferRebuilds,
  }));
  let capacity: GpuSceneCapacityPreparation | undefined;
  let input: GpuSceneInputPreparation | undefined;
  let admitted = false;
  const work = f.scene.prepareSourceRows(
    rows.map((row) => row.row),
    (value) => {
      capacity = value;
    },
    () => rows.every((row) => row.isCurrent()),
    [{ handle: original.assetHandle, asset, identity: source.identity, revision }],
  );
  try {
    finish(work);
    assert(capacity);
    finish(f.scene.prepareSourceData(capacity));
    finish(
      f.scene.prepareSourceInputs(
        capacity,
        (value) => {
          input = value;
        },
        () => rows.every((row) => row.isCurrent()),
      ),
    );
    assert(input);
    finishRendererInput(input);
    const extent = f.scene.preparedAddressExtent(capacity);
    assert(extent !== undefined);
    phase = 'address preparation';
    const storage = f.manager.prepareAddressCapacity(f.scene, extent, () =>
      rows.every((row) => row.isCurrent()),
    );
    for (;;) {
      const step = storage.next();
      if (step.done) break;
      await drawWithoutColdStorage(f);
    }
    finishRendererInput(input);
    while (!capacity.isCurrent()) capacity.step().unwrap();
    const target = f.scene.prepareCapacityBindingTarget(capacity).unwrap();
    phase = 'handoff';
    const bindings = f.manager.prepareInputBindings(f.scene, input, target).unwrap();
    bindings.publish().unwrap();
    admitted = true;
    phase = 'after Data';
    expect(f.scene.rowAddressExtent).toBeGreaterThan(64);
    const creates = vi.spyOn(f.internals.device, 'createBuffer');
    const groups = vi.spyOn(f.internals.device, 'createBindGroup');
    try {
      await f.draw();
      expect(creates.mock.calls.map(([descriptor]) => descriptor.label)).toEqual([]);
      expect(groups.mock.calls.map(([descriptor]) => descriptor.label)).toEqual([]);
      for (const before of stableRaster) {
        expect(before.view.visibleBuffer).toBe(before.visible);
        expect(before.view.indirectBuffer).toBe(before.indirect);
        expect(before.view.graphResourceGeneration).toBe(before.generation);
        expect(before.view.inspect().bufferRebuilds).toBe(before.rebuilds);
      }
    } finally {
      creates.mockRestore();
      groups.mockRestore();
    }
  } finally {
    if (admitted && capacity !== undefined) f.scene.detachSourceData(capacity).unwrap();
    input?.release();
    work.return(undefined as never);
    for (const row of rows) row.release();
    await f.internals.device.queue.onSubmittedWorkDone();
    if (capacity !== undefined)
      for (let index = 0; !capacity.retireStep() && index < 1000; index++) {
        /* owner drain */
      }
  }
}

function finish<T>(work: Generator<void, T>): T {
  for (let index = 0; index < 10000; index++) {
    const result = work.next();
    if (result.done) return result.value;
  }
  throw new Error('Source View preparation did not finish');
}

async function addOldMedium(f: Awaited<ReturnType<typeof rendererInputHandoffFixture>>) {
  const owner = f.internals.sceneComposition?.entry?.projection;
  const original = owner?.slotsSnapshot().at(0)?.snapshot;
  assert(original?.assetHandle !== undefined);
  const mesh = f.world.get(original.entityKey as EntityHandle, MeshFilter).unwrap().assetHandle;
  expect(mesh).toBe(original.assetHandle);
  const material = f.assets.create(Materials.standard({ baseColor: [1, 1, 1, 1] })).unwrap();
  for (let index = 0; index < 64; index++)
    f.world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
  const authored: MaterialAsset = {
    kind: 'material',
    parameters: [],
    values: {},
    surface: {
      model: 'single-layer-medium',
      module: 'forgeax_material::default_single_layer_medium_surface',
    },
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::single-layer-medium' },
        renderState: { tags: { LightMode: 'Forward' } },
      },
    ],
  };
  const guid = '019f0000-0000-7000-8000-0000000008c1';
  const cooked = await createMaterialPackCooker().cook({ guid, source: authored });
  publishRuntimeAssets(f.assets, [{ guid, asset: cooked.payload as MaterialAsset }]);
  const medium = (await f.assets.load(f.assets.parseGuid(guid), 'material')).unwrap();
  f.world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [medium] } },
    )
    .unwrap();
  const buffers = vi.spyOn(f.internals.device, 'createBuffer');
  const writes = vi.spyOn(f.internals.device.queue, 'writeBuffer');
  try {
    await f.draw();
    const frameBuffers = buffers.mock.calls.flatMap(([descriptor], index) => {
      const result = buffers.mock.results[index]?.value;
      return descriptor.label === 'surface-dynamic-frame-input' && result?.ok ? [result.value] : [];
    });
    expect(frameBuffers.length).toBeGreaterThan(0);
    // Medium rows address the full filtered candidate order after 65 nonmedium candidates.
    expect(
      writes.mock.calls.some(
        ([buffer, offset, data]) =>
          frameBuffers.includes(buffer) && offset === 65 * 48 && data.byteLength === 48,
      ),
    ).toBe(true);
    expect(f.manager.currentOwner.gpuDriven.inspect().surfaceFrameRowAllocations).toBeGreaterThan(
      0,
    );
  } finally {
    buffers.mockRestore();
    writes.mockRestore();
  }
}

async function drawWithoutColdStorage(f: Awaited<ReturnType<typeof rendererInputHandoffFixture>>) {
  const buffers = vi.spyOn(f.internals.device, 'createBuffer');
  const groups = vi.spyOn(f.internals.device, 'createBindGroup');
  try {
    await f.draw();
    expect.soft(buffers.mock.calls.map(([descriptor]) => descriptor.label)).toEqual([]);
    expect.soft(groups.mock.calls.map(([descriptor]) => descriptor.label)).toEqual([]);
  } finally {
    buffers.mockRestore();
    groups.mockRestore();
  }
}

function recordHdrpInputs(
  f: Awaited<ReturnType<typeof rendererInputHandoffFixture>>,
  phase: () => string,
) {
  const records: Record<string, unknown>[] = [];
  const create = hdrpBuffersModule.createHdrpUnifiedBindGroup;
  const query = vi
    .spyOn(hdrpBuffersModule, 'createHdrpUnifiedBindGroup')
    .mockImplementation((...args) => {
      const hdrp = args[1],
        capture = args[5];
      const facts = {
        phase: phase(),
        hdrp: getOpaqueResourceIdentity(hdrp),
        layout: getOpaqueResourceIdentity(hdrp.unifiedBindGroupLayout),
        requestedBuffer: getOpaqueResourceIdentity(args[2]),
        requestedBytes: args[4],
        sceneTransform: getOpaqueResourceIdentity(f.scene.transformBuffer),
        sceneTransformBytes: f.scene.transformByteLength,
        stack: new Error('HDRP binding issue').stack,
      };
      args[5] = (group, descriptor) => {
        records.push({
          ...facts,
          group: getOpaqueResourceIdentity(group),
          entries: [...descriptor.entries].map(({ binding, resource }) => ({
            binding,
            kind: resource.kind,
            id: getOpaqueResourceIdentity(
              resource.kind === 'buffer' ? resource.value.buffer : resource.value,
            ),
            ...(resource.kind === 'buffer'
              ? { offset: resource.value.offset, size: resource.value.size }
              : {}),
          })),
        });
        capture?.(group, descriptor);
      };
      return create(...args);
    });
  return { records, restore: () => query.mockRestore() };
}

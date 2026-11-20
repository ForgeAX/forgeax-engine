import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { Entity, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { err, RhiError } from '@forgeax/engine-rhi';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { assert, expect, it, vi } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import type { LevelCandidate } from '../../../app/src/levels/candidate';
import type { SourceViewPreparation } from '../assembly/source-view-preparation';
import { Camera, MeshFilter, MeshRenderer } from '../components';
import type { GpuTexture } from '../gpu-resource';
import { PrimitiveAllocations } from '../gpu-scene-allocations';
import { GpuSceneCapacityPreparation } from '../gpu-scene-capacity';
import { GPU_SCENE_LAYOUTS } from '../gpu-scene-schema';
import { Materials } from '../materials';
import {
  levelNativeResourcesFixture as fixture,
  levelInitialViewFixture,
  levelShaderManifestFixture,
} from './level-native-resources-fixture';

vi.mock('@forgeax/engine-render', () => import('../index'));
vi.mock('@forgeax/engine-render/internal', () => import('../internal'));

await levelShaderManifestFixture();

async function prepare(
  candidate: LevelCandidate,
  _draw?: () => Promise<unknown>,
  maxSteps = 10000,
) {
  let result = candidate.step();
  for (let steps = 0; result.ok && steps < maxSteps; steps++) {
    const pending = result.value.render?.pending;
    if (pending !== undefined) {
      await pending;
    }
    result = candidate.step();
  }
  return result;
}
async function retire(candidate: LevelCandidate) {
  for (let steps = 0; candidate.inspect().phase !== 'retired' && steps < 10000; steps++) {
    const status = candidate.retireStep().unwrap();
    if (status.render?.pending !== undefined) await status.render.pending;
  }
  expect(candidate.inspect().phase).toBe('retired');
}

async function attempt(failures: unknown[], run: () => unknown | Promise<unknown>) {
  try {
    await run();
  } catch (cause) {
    failures.push(cause);
  }
}
function report(failures: readonly unknown[]): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, 'Source assertions and cleanup failures');
}

function capturePhysicalSource(
  store: Awaited<ReturnType<typeof fixture>>['internals']['gpuStore'],
) {
  const prepareMesh = store.prepareMeshResidency.bind(store);
  const prepareTexture = store.prepareTextureResidencyForGraph.bind(store);
  let mesh: ReturnType<typeof prepareMesh> | undefined;
  let texture: ReturnType<typeof prepareTexture> | undefined;
  const meshes = vi.spyOn(store, 'prepareMeshResidency').mockImplementation((...args) => {
    mesh = prepareMesh(...args);
    return mesh;
  });
  const textures = vi
    .spyOn(store, 'prepareTextureResidencyForGraph')
    .mockImplementation((...args) => {
      texture = prepareTexture(...args);
      return texture;
    });
  return {
    get mesh() {
      return mesh;
    },
    get texture() {
      return texture;
    },
    meshes,
    textures,
    close() {
      meshes.mockRestore();
      textures.mockRestore();
    },
  };
}

it.each([
  'frame',
  'no-frame',
  'disposed',
  'shared',
] as const)('admits actual Source Data and retires after %s while execution and native Prepared stay closed', async (mode) => {
  const f = await fixture(false, 1, true);
  const failures: unknown[] = [];
  const store = f.internals.gpuStore;
  const physical = capturePhysicalSource(store);
  try {
    const result = await prepare(f.candidate, f.draw);
    expect(result.ok).toBe(false);
    if (result.ok) throw Error('incomplete native preparation was accepted');
    expect(result.error.detail.reason).toBe('native-preparation-incomplete');
    expect(f.candidate.inspect().render).toMatchObject({
      phase: 'resident-input',
      admitted: 1,
      resources: {
        phase: 'data',
        capacity: { phase: 'published' },
        inputs: { phase: 'committed' },
      },
    });
    const entry = f.internals.sceneComposition?.entry;
    assert(entry);
    const row = [...entry.projection.slotsSnapshot()].find(
      (slot) => slot.snapshot.residencyGroup !== undefined,
    );
    assert(row?.snapshot.assetHandle !== undefined && row.snapshot.residencyGroup !== undefined);
    expect(entry.topology.captureResidencySelection().includes(row.snapshot.residencyGroup)).toBe(
      false,
    );
    const { mesh, texture } = physical;
    const meshHandle = physical.meshes.mock.calls[0]?.[0];
    assert(meshHandle !== undefined);
    expect(meshHandle).toBe(row.snapshot.assetHandle);
    assert(mesh?.ok && texture?.ok);
    expect(store.getMeshGpuHandles(meshHandle, entry.source)).toBe(mesh.value.entry);
    const index = f.scene.primitiveIndexForSlot(row.slot);
    expect(index).toBeDefined();
    if (mode === 'shared') {
      const member = f.candidate.members.find((entity) =>
        f.world.hasComponent(entity, MeshRenderer),
      );
      assert(member);
      f.world
        .spawn(
          { component: Transform, data: { pos: [20, 0, 0] } },
          { component: MeshFilter, data: f.world.get(member, MeshFilter).unwrap() },
          { component: MeshRenderer, data: f.world.get(member, MeshRenderer).unwrap() },
        )
        .unwrap();
    }
    if (mode === 'frame' || mode === 'shared') {
      expect((await f.draw()).presentation).toBe('ready');
      expect(f.scene.primitiveIndexForSlot(row.slot)).toBe(index);
      expect(store.getMeshGpuHandles(meshHandle, entry.source)).toBe(mesh.value.entry);
    }
    expect(physical.meshes).toHaveBeenCalledTimes(1);
    expect(physical.textures).toHaveBeenCalledTimes(1);
    if (mode === 'disposed') f.scene.dispose();
    await retire(f.candidate);
    expect(f.scene.primitiveIndexForSlot(row.slot)).toBeUndefined();
    expect(f.scene.materialIndexForResource(row.snapshot.material) === undefined).toBe(
      mode !== 'shared',
    );
    expect(store.getMeshGpuHandles(meshHandle, entry.source) === undefined).toBe(mode !== 'shared');
    expect(mesh.value.entry.vertexBuffer.isDestroyed).toBe(mode !== 'shared');
    expect(texture.value.entry.texture.isDestroyed).toBe(mode !== 'shared');
  } catch (cause) {
    failures.push(cause);
  } finally {
    physical.close();
    await attempt(failures, () => retire(f.candidate));
    await attempt(failures, async () => {
      const closed = await f.close();
      if (!closed.ok) throw closed.error;
    });
  }
  report(failures);
});

it.each([
  'mesh',
  'texture',
] as const)('retires a cold %s publication cancelled before Data handoff', async (kind) => {
  const f = await fixture(false, 1, true);
  const failures: unknown[] = [];
  const store = f.internals.gpuStore;
  const physical = capturePhysicalSource(store);
  try {
    const entry = f.internals.sceneComposition?.entry;
    assert(entry);
    const before = f.scene.tableBindingIdentity;
    let result = f.candidate.step();
    let published = false;
    for (let step = 0; result.ok && step < 10000; step++) {
      const meshHandle = physical.meshes.mock.calls[0]?.[0];
      const textureHandle = physical.textures.mock.calls[0]?.[0];
      published =
        kind === 'mesh'
          ? meshHandle !== undefined &&
            store.getMeshGpuHandles(meshHandle, entry.source) !== undefined
          : textureHandle !== undefined &&
            store.getTextureGpuView(textureHandle, entry.source) !== undefined;
      if (published) break;
      const pending = result.value.render?.pending;
      if (pending !== undefined) {
        await pending;
      }
      result = f.candidate.step();
    }
    expect(published).toBe(true);
    expect(result.ok).toBe(true);
    expect(f.candidate.inspect().render?.admitted).toBe(0);
    expect(f.scene.tableBindingIdentity).toBe(before);
    const { mesh, texture } = physical;
    assert(mesh?.ok && texture?.ok);
    await retire(f.candidate);
    expect(mesh.value.entry.vertexBuffer.isDestroyed).toBe(true);
    expect(texture.value.entry.texture.isDestroyed).toBe(true);
    const meshHandle = physical.meshes.mock.calls[0]?.[0];
    const textureHandle = physical.textures.mock.calls[0]?.[0];
    assert(meshHandle !== undefined && textureHandle !== undefined);
    expect(store.getMeshGpuHandles(meshHandle, entry.source)).toBeUndefined();
    expect(store.getTextureGpuView(textureHandle, entry.source)).toBeUndefined();
  } catch (cause) {
    failures.push(cause);
  } finally {
    physical.close();
    await attempt(failures, () => retire(f.candidate));
    await attempt(failures, async () => {
      const result = await f.close();
      if (!result.ok) throw result.error;
    });
  }
  report(failures);
});

it.each([
  'same-world',
  'other-world',
] as const)('retires old Source Data without harming the %s composition consumer', async (kind) => {
  const f = await fixture(false, 1, true);
  const failures: unknown[] = [];
  const physical = capturePhysicalSource(f.internals.gpuStore);
  let copiedAssets: AssetRegistry | undefined;
  try {
    await prepare(f.candidate, f.draw);
    const composition = f.internals.sceneComposition;
    const previous = composition?.entry;
    const handle = physical.meshes.mock.calls[0]?.[0];
    const member = f.candidate.members.find((entity) => f.world.hasComponent(entity, MeshRenderer));
    assert(composition && previous && handle !== undefined && member !== undefined);
    if (kind === 'other-world')
      copiedAssets = new AssetRegistry({ shaderRegistry: f.assets.shaderRegistry });
    const world = copiedAssets === undefined ? f.world : new World({ assets: copiedAssets });
    let meshData = f.world.get(member, MeshFilter).unwrap();
    let materialData = f.world.get(member, MeshRenderer).unwrap();
    if (copiedAssets !== undefined) {
      const copied = copiedAssets.create(createBoxGeometry(3, 1, 1).unwrap()).unwrap();
      // Asset identities are process-owned; a second registry gets its own handle.
      expect(copied).not.toBe(handle);
      meshData = { ...meshData, assetHandle: copied };
      materialData = {
        ...materialData,
        materials: [
          copiedAssets
            .create(Materials.standard({ baseColor: [1, 1, 1, 1], emissive: [0.2, 0.4, 0.8] }))
            .unwrap(),
        ],
      };
      f.source.dispose();
      expect(f.candidate.inspect().phase).not.toBe('retired');
      const receipt = physical.mesh;
      assert(receipt?.ok);
      expect(f.internals.gpuStore.getMeshGpuHandles(handle, previous.source)).toBe(
        receipt.value.entry,
      );
    }
    const attached =
      kind === 'same-world' ? { ok: true as const, value: f.source } : f.renderer.attach(world);
    assert(attached.ok);
    const source = attached.value;
    if (kind === 'other-world')
      world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 4] } },
          { component: Camera, data: f.world.get(f.camera, Camera).unwrap() },
        )
        .unwrap();
    const alias = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 0] } },
        { component: MeshFilter, data: meshData },
        { component: MeshRenderer, data: materialData },
      )
      .unwrap();
    const draw = async () => {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      return drawReadyFrame(f.renderer, { source });
    };
    if (kind === 'same-world') {
      await draw();
      composition.invalidate();
    }
    expect((await draw()).presentation).toBe('ready');
    const current = composition.entry;
    const { mesh, texture } = physical;
    assert(current && mesh?.ok && texture?.ok);
    expect(current).not.toBe(previous);
    expect(current.source === previous.source).toBe(kind === 'same-world');
    const acceptedHandle = meshData.assetHandle;
    const accepted = f.internals.gpuStore.getMeshGpuHandles(acceptedHandle, current.source);
    assert(accepted);
    const row = current.projection.slot(alias);
    assert(row);
    const currentScene = composition.gpuSceneResident;
    assert(currentScene);
    const index = currentScene.primitiveIndexForSlot(row.slot);
    expect(index).toBeDefined();
    await retire(f.candidate);
    expect(composition.gpuResidentFor(current.token)).toBe(true);
    expect(currentScene.primitiveIndexForSlot(row.slot)).toBe(index);
    expect(f.internals.gpuStore.getMeshGpuHandles(acceptedHandle, current.source)).toBe(accepted);
    if (kind === 'other-world')
      expect(f.internals.gpuStore.getMeshGpuHandles(handle, previous.source)).toBeUndefined();
    expect(accepted.vertexBuffer.isDestroyed).toBe(false);
    expect((await draw()).presentation).toBe('ready');
  } catch (cause) {
    failures.push(cause);
  } finally {
    physical.close();
    await attempt(failures, () => retire(f.candidate));
    await attempt(failures, async () => {
      const result = await f.close();
      if (!result.ok) throw result.error;
    });
    copiedAssets?.dispose();
  }
  report(failures);
});

it('settles an empty Source Data set without transferring tables or creating native resources', async () => {
  const f = await fixture(false, 0);
  const failures: unknown[] = [];
  const buffers = vi.spyOn(f.internals.device, 'createBuffer');
  const textures = vi.spyOn(f.internals.device, 'createTexture');
  const identity = f.scene.tableBindingIdentity;
  try {
    const result = await prepare(f.candidate, f.draw);
    expect(result.ok).toBe(false);
    if (result.ok) throw Error('incomplete native preparation was accepted');
    expect(result.error.detail.reason).toBe('native-preparation-incomplete');
    expect(f.candidate.inspect().render).toMatchObject({
      phase: 'resident-input',
      admitted: 0,
      resources: { phase: 'data', meshes: 0, textures: 0 },
    });
    expect(f.scene.tableBindingIdentity).toBe(identity);
    expect(buffers).not.toHaveBeenCalled();
    expect(textures).not.toHaveBeenCalled();
    await retire(f.candidate);
    expect(f.scene.live).toBe(true);
  } catch (cause) {
    failures.push(cause);
  } finally {
    buffers.mockRestore();
    textures.mockRestore();
    await attempt(failures, () => retire(f.candidate));
    await attempt(failures, async () => {
      const result = await f.close();
      if (!result.ok) throw result.error;
    });
  }
  report(failures);
});

it('prepares actual Source table capacity privately and retires it without publishing target rows', async () => {
  const f = await fixture(false, 260);
  const failures: unknown[] = [];
  const active = [
    f.scene.primitiveBuffer,
    f.scene.instanceBuffer,
    f.scene.transformBuffer,
    f.scene.materialBuffer,
  ];
  const tables = f.scene.inspect().tables;
  const create = vi.spyOn(f.internals.device, 'createBuffer');
  const writes = vi.spyOn(f.internals.device.queue, 'writeBuffer');
  const destroy = vi.spyOn(f.internals.device, 'destroyBuffer');
  const drawnAtCapacity = new Set<number>();
  try {
    let result = f.candidate.step();
    for (let steps = 0; result.ok && steps < 50000; steps++) {
      const resources = result.value.render?.resources;
      if (resources?.phase === 'preparing-bindings' && resources.inputs?.phase === 'current') break;
      if (resources?.phase === 'preparing-capacity') {
        const tableCount = resources.capacity?.tables ?? 0;
        // Observe the live route before allocating and as each private table is built.
        // Numeric row continuations can share one ordinary frame.
        if (!drawnAtCapacity.has(tableCount)) {
          expect((await f.draw()).presentation).toBe('ready');
          expect(f.scene.inspect().tables).toEqual(tables);
          drawnAtCapacity.add(tableCount);
        }
      }
      const pending = result.value.render?.pending;
      if (pending !== undefined) {
        await pending;
      }
      result = f.candidate.step();
    }
    expect(drawnAtCapacity.has(0)).toBe(true);
    expect(drawnAtCapacity.size).toBeGreaterThan(1);
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(f.candidate.inspect().render).toMatchObject({
      admitted: 0,
      resources: {
        phase: 'preparing-bindings',
        capacity: {
          phase: 'current',
        },
      },
    });
    expect(f.candidate.inspect().render?.resources?.capacity?.privateWriteBytes).toBeGreaterThan(
      260 *
        (GPU_SCENE_LAYOUTS.transform.stride +
          GPU_SCENE_LAYOUTS.instance.stride +
          GPU_SCENE_LAYOUTS.primitive.stride),
    );
    const targets = create.mock.calls.flatMap(([descriptor], index) => {
      const returned = create.mock.results[index];
      return descriptor.label?.startsWith('gpu-scene-prepared-') &&
        returned?.type === 'return' &&
        returned.value.ok
        ? [returned.value.value]
        : [];
    });
    expect(targets.length).toBeGreaterThan(0);
    for (const buffer of targets) {
      expect(active).not.toContain(buffer);
      expect(writes.mock.calls.some(([target]) => target === buffer)).toBe(true);
      expect(destroy.mock.calls.some(([target]) => target === buffer)).toBe(false);
    }
    expect([
      f.scene.primitiveBuffer,
      f.scene.instanceBuffer,
      f.scene.transformBuffer,
      f.scene.materialBuffer,
    ]).toEqual(active);
    expect(f.scene.inspect().tables).toEqual(tables);
    let finish!: () => void;
    const covered = new Promise<undefined>((resolve) => {
      finish = () => resolve(undefined);
    });
    const fence = vi
      .spyOn(f.internals.device.queue, 'onSubmittedWorkDone')
      .mockReturnValueOnce(covered);
    const submit = vi.spyOn(f.internals.device.queue, 'submit');
    try {
      const waiting = f.candidate.retireStep().unwrap();
      expect(waiting.render?.pending).toBeDefined();
      for (const buffer of targets)
        expect(destroy.mock.calls.some(([target]) => target === buffer)).toBe(false);
      finish();
      await waiting.render?.pending;
      fence.mockRestore();
      await retire(f.candidate);
      expect(submit).not.toHaveBeenCalled();
    } finally {
      finish();
      fence.mockRestore();
      submit.mockRestore();
    }

    for (const buffer of targets)
      expect(destroy.mock.calls.filter(([target]) => target === buffer)).toHaveLength(1);
    expect((await f.draw()).presentation).toBe('ready');
  } catch (cause) {
    failures.push(cause);
  } finally {
    create.mockRestore();
    writes.mockRestore();
    destroy.mockRestore();
    await attempt(failures, () => retire(f.candidate));
    await attempt(failures, async () => {
      const closed = await f.close();
      if (!closed.ok) throw closed.error;
    });
  }
  report(failures);
});

it('consumes Source binding slots before a second Source prepares, without invalidating the first Data', async () => {
  const f = await fixture(false, 260);
  const owner = f.internals.sceneComposition?.entry?.projection.sceneRows;
  assert(owner);
  const before = owner.capture();
  const originalPrepare = owner.prepareRow.bind(owner);
  const identities: import('../scene/render-scene-types').ReservedSceneRow[] = [];
  const rows = vi.spyOn(owner, 'prepareRow').mockImplementation((...args) => {
    const row = originalPrepare(...args);
    identities.push(row.row);
    return row;
  });
  const capacities: import('../gpu-scene-capacity').GpuSceneCapacityPreparation[] = [];
  const prepareRows = f.scene.prepareSourceRows.bind(f.scene);
  const capture = vi
    .spyOn(f.scene, 'prepareSourceRows')
    .mockImplementation(function* (rows, receive, current, meshes) {
      return yield* prepareRows(
        rows,
        (task) => {
          capacities.push(task);
          receive(task);
        },
        current,
        meshes,
      );
    });
  const failures: unknown[] = [];
  let second: LevelCandidate | undefined;
  try {
    const first = await prepare(f.candidate, f.draw, 50000);
    expect(first.ok).toBe(false);
    if (first.ok) throw Error('First Source unexpectedly admitted');
    if (first.error.detail.reason !== 'native-preparation-incomplete') throw first.error;
    expect(f.candidate.inspect().render?.resources?.meshes).toBeGreaterThan(0);
    second = f.createCandidate();
    const next = await prepare(second, f.draw, 50000);
    expect(next.ok).toBe(false);
    if (next.ok) throw Error('Second Source unexpectedly admitted');
    expect(next.error.detail.reason).toBe('native-preparation-incomplete');
    expect(second.inspect().render?.resources?.phase).toBe('data');
    expect(f.candidate.inspect().render?.admitted).toBe(260);
    expect(second.inspect().render?.admitted).toBe(260);
    const claims = rows.mock.results.flatMap((result) =>
      result.type === 'return' ? [result.value] : [],
    );
    expect(claims).toHaveLength(520);
    expect(new Set(identities.map((row) => row.slot)).size).toBe(520);
    expect(claims.every((claim) => !claim.isCurrent())).toBe(true);
    expect(owner.capture().length).toBe(before.length + 520);
    for (const identity of identities) {
      const current = f.internals.sceneComposition?.entry?.projection.slot(identity.entityKey);
      expect(current?.slot).toBe(identity.slot);
      expect(f.scene.primitiveIndexForSlot(identity.slot)).toBeDefined();
    }
    expect(capacities).toHaveLength(2);
    const firstData = capacities[0],
      secondData = capacities[1];
    assert(firstData && secondData);
    const stamp = vi.spyOn(PrimitiveAllocations.prototype, 'stamp');
    try {
      expect(f.scene.sourceDataCurrent(firstData)).toBe(true);
      expect(f.scene.sourceDataCurrent(secondData)).toBe(true);
      expect(stamp).not.toHaveBeenCalled();
    } finally {
      stamp.mockRestore();
    }
    await retire(f.candidate);
    expect(f.scene.sourceDataCurrent(firstData)).toBe(false);
    expect(f.scene.sourceDataCurrent(secondData)).toBe(true);
    expect(owner.capture().length).toBe(before.length + 260);
    expect((await f.draw()).presentation).toBe('ready');
  } catch (cause) {
    failures.push(cause);
  } finally {
    if (second !== undefined) await attempt(failures, () => retire(second as LevelCandidate));
    await attempt(failures, () => retire(f.candidate));
    expect(
      rows.mock.results.every((result) => result.type !== 'return' || !result.value.isCurrent()),
    ).toBe(true);
    rows.mockRestore();
    capture.mockRestore();
    await attempt(failures, async () => {
      const closed = await f.close();
      if (!closed.ok) throw closed.error;
    });
  }
  report(failures);
});

it('does not retire submitted mip resources using the earlier upload fence', async () => {
  const f = await fixture(true);
  const failures: unknown[] = [];
  const queue = f.internals.device.queue;
  const submit = queue.submit.bind(queue),
    onDone = queue.onSubmittedWorkDone.bind(queue);
  let submitted = false,
    failed = false;
  let finish!: () => void;
  const covered = new Promise<undefined>((resolve) => {
    finish = () => resolve(undefined);
  });
  const failure = Error('new mip fence acquisition failed');
  const send = vi.spyOn(queue, 'submit').mockImplementation((buffers) => {
    submitted = true;
    return submit(buffers);
  });
  const fence = vi.spyOn(queue, 'onSubmittedWorkDone').mockImplementation(() => {
    if (submitted && !failed) {
      failed = true;
      throw failure;
    }
    return failed ? covered : onDone();
  });
  const destroy = vi.spyOn(f.internals.device, 'destroyTexture');
  try {
    expect((await prepare(f.candidate)).ok).toBe(false);
    expect(submitted && failed).toBe(true);
    let pending: Promise<void> | undefined;
    for (
      let steps = 0;
      pending === undefined && f.candidate.inspect().phase !== 'retired' && steps < 1000;
      steps++
    )
      pending = f.candidate.retireStep().unwrap().render?.pending;
    expect(pending).toBeDefined();
    expect(destroy).not.toHaveBeenCalled();
    finish();
    await pending;
    await retire(f.candidate);
    expect(destroy).toHaveBeenCalled();
  } catch (cause) {
    failures.push(cause);
  } finally {
    finish();
    fence.mockRestore();
    send.mockRestore();
    destroy.mockRestore();
    await attempt(failures, () => retire(f.candidate));
    await attempt(failures, async () => {
      const closed = await f.close();
      if (!closed.ok) throw closed.error;
    });
  }
  report(failures);
});

it('releases independent Source allocations before waiting for their shared submitted frame', async () => {
  const f = await fixture(false);
  const physical = capturePhysicalSource(f.internals.gpuStore);
  let finish!: () => void;
  const submitted = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const failures: unknown[] = [];
  try {
    expect((await prepare(f.candidate)).ok).toBe(false);
    const { mesh, texture } = physical;
    assert(mesh?.ok && texture?.ok);
    mesh.value.lease.track(submitted);
    texture.value.lease.track(submitted);
    const releaseMesh = vi.spyOn(mesh.value.lease, 'release');
    const releaseTexture = vi.spyOn(texture.value.lease, 'release');
    for (let step = 0; step < 1000; step++) {
      const status = f.candidate.retireStep().unwrap();
      const pending = status.render?.pending;
      if (pending === undefined) continue;
      if (releaseMesh.mock.calls.length + releaseTexture.mock.calls.length > 0) break;
      await pending;
    }
    expect(releaseMesh).toHaveBeenCalledExactlyOnceWith(true);
    expect(releaseTexture).toHaveBeenCalledExactlyOnceWith(true);
    expect(mesh.value.entry.vertexBuffer.isDestroyed).toBe(false);
    expect(texture.value.entry.texture.isDestroyed).toBe(false);
    expect(f.candidate.inspect().phase).not.toBe('retired');
  } catch (cause) {
    failures.push(cause);
  } finally {
    finish();
    physical.close();
    await attempt(failures, () => retire(f.candidate));
    await attempt(failures, async () => {
      const closed = await f.close();
      if (!closed.ok) throw closed.error;
    });
  }
  report(failures);
});

it('retires the admitted native Source rows in the same batches as the Scene rows', async () => {
  const members = 65;
  const f = await fixture(false, members, true);
  const failures: unknown[] = [];
  const detach = vi.spyOn(f.scene, 'detachSourceData');
  const nativeRetirement = vi.spyOn(GpuSceneCapacityPreparation.prototype, 'retireStep');
  try {
    expect((await prepare(f.candidate)).ok).toBe(false);
    expect(f.candidate.inspect().render).toMatchObject({
      phase: 'resident-input',
      admitted: members,
      resources: { phase: 'data' },
    });
    await retire(f.candidate);
    expect(detach).toHaveBeenCalledTimes(3);
    expect(nativeRetirement.mock.calls.length).toBeLessThan(members);
  } catch (cause) {
    failures.push(cause);
  } finally {
    nativeRetirement.mockRestore();
    detach.mockRestore();
    await attempt(failures, () => retire(f.candidate));
    await attempt(failures, async () => {
      const closed = await f.close();
      if (!closed.ok) throw closed.error;
    });
  }
  report(failures);
}, 30_000);

it('retains a Source cleanup failure after another owner successfully destroys the same allocation', async () => {
  const f = await fixture(false);
  const failures: unknown[] = [];
  const store = f.internals.gpuStore;
  const prepareTexture = store.prepareTextureResidencyForGraph.bind(store);
  let physical: GpuTexture | undefined;
  const capture = vi
    .spyOn(store, 'prepareTextureResidencyForGraph')
    .mockImplementation((handle, asset, source, transfer, fixedRevision) =>
      prepareTexture(
        handle,
        asset,
        source,
        (value) => {
          physical = value.entry.texture;
          transfer?.(value);
        },
        fixedRevision,
      ),
    );
  const failure = new RhiError({
    code: 'webgpu-runtime-error',
    expected: 'exact texture retirement',
    hint: 'retain the failed Source receipt',
  });
  let rejected = false;
  const destroyTexture = f.internals.device.destroyTexture.bind(f.internals.device);
  const destroy = vi.spyOn(f.internals.device, 'destroyTexture').mockImplementation((handle) => {
    if (physical?.handle === handle && !rejected) {
      rejected = true;
      return err(failure);
    }
    return destroyTexture(handle);
  });
  try {
    let prepared = f.candidate.step();
    for (
      let step = 0;
      prepared.ok &&
      step < 10000 &&
      prepared.value.render?.resources?.phase !== 'preparing-capacity';
      step++
    ) {
      if (prepared.value.render?.pending !== undefined) await prepared.value.render.pending;
      prepared = f.candidate.step();
    }
    expect(prepared.ok).toBe(true);
    expect(f.candidate.inspect().render?.resources?.phase).toBe('preparing-capacity');
    assert(physical);
    let observed: ReturnType<LevelCandidate['retireStep']> | undefined;
    for (let steps = 0; !rejected && steps < 1000; steps++) {
      observed = f.candidate.retireStep();
      if (observed.ok && observed.value.render?.pending !== undefined)
        await observed.value.render.pending;
    }
    expect(rejected).toBe(true);
    physical.destroy().unwrap();
    expect(physical.isDestroyed).toBe(true);
    for (let steps = 0; observed?.ok !== false && steps < 1000; steps++)
      observed = f.candidate.retireStep();
    expect(observed?.ok).toBe(false);
    expect(f.candidate.retireStep()).toEqual(observed);
    expect(f.candidate.inspect().phase).not.toBe('retired');
    expect(f.candidate.members.some((entity) => f.world.get(entity, Entity).ok)).toBe(true);
  } catch (cause) {
    failures.push(cause);
  } finally {
    capture.mockRestore();
    destroy.mockRestore();
    await attempt(failures, () => {
      if (physical !== undefined && !physical.isDestroyed) physical.destroy().unwrap();
    });
    await attempt(failures, async () => {
      if (f.candidate.inspect().cleanupFailure === undefined) await retire(f.candidate);
    });
    await attempt(failures, async () => {
      const closed = await f.close();
      if (f.candidate.inspect().cleanupFailure !== undefined) expect(closed.ok).toBe(false);
      else if (!closed.ok) throw closed.error;
    });
  }
  report(failures);
});

it('prepares Source data without requesting current-View candidate pipelines', async () => {
  const f = await fixture(false);
  const capture = vi.spyOn(f.manager, 'prepareCandidatePipelines');
  const failures: unknown[] = [];
  try {
    const result = await prepare(f.candidate, f.draw);
    assert(!result.ok);
    expect(result.error.detail.reason).toBe('native-preparation-incomplete');
    expect(f.candidate.inspect().render?.resources?.phase).toBe('data');
    expect(capture).not.toHaveBeenCalled();
  } catch (cause) {
    failures.push(cause);
  } finally {
    capture.mockRestore();
    await attempt(failures, () => retire(f.candidate));
    await attempt(failures, async () => {
      const closed = await f.close();
      if (!closed.ok) throw closed.error;
    });
  }
  report(failures);
});

it.each([
  'complete',
  'failure',
] as const)('waits for its captured View retirement before Source unload %s without another frame', async (mode) => {
  const f = await fixture(false, 65, true);
  const failures: unknown[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const view = f.manager.currentOwner.gpuDriven.inputBindingViews(f.scene)[0];
  assert(view);
  const settle = view.settleRetirement.bind(view);
  const failure = new RhiError({
    code: 'internal-error',
    expected: 'captured View retirement refusal',
    hint: 'retain Source cleanup responsibility',
  });
  let asked = false;
  const retirement = vi.spyOn(view, 'settleRetirement').mockImplementation(async () => {
    asked = true;
    await gate;
    return mode === 'failure' ? err(failure) : settle();
  });
  try {
    const prepared = await prepare(f.candidate, f.draw);
    expect(prepared.ok).toBe(false);
    expect(f.candidate.inspect().render?.phase).toBe('resident-input');
    for (let step = 0; !asked && step < 10000; step++) {
      const status = f.candidate.retireStep().unwrap();
      if (!asked && status.render?.pending !== undefined) await status.render.pending;
    }
    expect(asked).toBe(true);
    expect(f.candidate.inspect().phase).not.toBe('retired');
    const waiting = f.candidate.retireStep().unwrap();
    assert(waiting.render?.pending);
    release();
    await waiting.render.pending;
    if (mode === 'complete') await retire(f.candidate);
    else {
      let result = f.candidate.retireStep();
      for (let step = 0; result.ok && step < 10000; step++) {
        if (result.value.render?.pending !== undefined) await result.value.render.pending;
        result = f.candidate.retireStep();
      }
      expect(result.ok).toBe(false);
      expect(f.candidate.inspect().phase).not.toBe('retired');
    }
  } catch (cause) {
    failures.push(cause);
  } finally {
    release();
    retirement.mockRestore();
    if (mode === 'complete') await attempt(failures, () => retire(f.candidate));
    await attempt(failures, async () => {
      const closed = await f.close();
      if (mode === 'complete' && !closed.ok) throw closed.error;
      if (mode === 'failure')
        expect(closed).toMatchObject({ ok: false, error: { code: 'cleanup-failed' } });
    });
  }
  report(failures);
});

it('admits first Source Data without a previously drawn Mesh and refuses incomplete execution', async () => {
  const f = await fixture(false, 260, true, false);
  const failures: unknown[] = [];
  try {
    expect(f.internals.sceneComposition?.entry?.projection.slotsSnapshot().length).toBe(0);
    expect(f.manager.currentOwner.gpuDriven.inputBindingViews(f.scene)).toHaveLength(0);
    const result = await prepare(f.candidate, f.draw, 50000);
    assert(!result.ok);
    expect(result.error.detail.reason).toBe('native-preparation-incomplete');
    expect(f.candidate.inspect().render).toMatchObject({ phase: 'resident-input', admitted: 260 });
    expect(f.manager.currentOwner.gpuDriven.inputBindingViews(f.scene)).toHaveLength(0);
  } catch (cause) {
    failures.push(cause);
  } finally {
    await attempt(failures, () => retire(f.candidate));
    await attempt(failures, async () => {
      const closed = await f.close();
      if (!closed.ok) throw closed.error;
    });
  }
  report(failures);
}, 30000);

it('bootstraps first Source native View storage through the actual Camera owner without a warm Mesh', async () => {
  const f = await levelInitialViewFixture();
  const failures: unknown[] = [];
  const composition = f.internals.sceneComposition;
  assert(composition);
  const begin = composition.beginStagedGroup.bind(composition);
  let staged: ReturnType<typeof begin> | undefined;
  const capture = vi.spyOn(composition, 'beginStagedGroup').mockImplementation((...args) => {
    staged = begin(...args);
    return staged;
  });
  const native = f.internals.device.createComputePipeline.bind(f.internals.device);
  f.internals.device.createComputePipelineAsync = (descriptor) => native(descriptor);
  const views: import('../gpu-driven/view-gpu').GpuDrivenView[] = [];
  try {
    const result = await prepare(f.candidate, f.draw);
    assert(!result.ok && staged?.ok);
    expect(result.error.detail.reason).toBe('native-preparation-incomplete');
    const source = staged.value;
    expect(source.isCurrent()).toBe(true);
    const ordinary = composition.entry?.topology.sourcePlan();
    expect(ordinary?.candidateCount).toBe(0);
    const state = f.manager.currentOwner.scene.compositionGpuDrivenState(source.group);
    expect(state?.queryExecution?.().active.candidateCount).toBe(1);
    const work = f.manager.prepareInitialSourceViews(
      source.group,
      () => source.isCurrent(),
      (view) => {
        views.push(view);
      },
    );
    let complete = false;
    for (let step = 0; step < 100; step++) {
      const next = work.next();
      if (next.done) {
        complete = true;
        break;
      }
      if (next.value instanceof Promise) await next.value;
    }
    expect(complete).toBe(true);
    expect(views).toHaveLength(1);
    expect(views[0]?.visibleBuffer).toBeDefined();
    expect(f.manager.currentOwner.gpuDriven.resourceGeneration).toBeDefined();
    expect(composition.entry?.topology.sourcePlan()).toBe(ordinary);
    expect(composition.entry?.topology.captureResidencySelection().includes(source.group)).toBe(
      false,
    );
    expect((await f.draw()).presentation).toBe('ready');
    // Native View/storage is not complete target graph, Pass or Level readiness.
    expect(f.candidate.inspect().phase).toBe('failed');
  } catch (cause) {
    failures.push(cause);
  } finally {
    capture.mockRestore();
    await attempt(failures, () => retire(f.candidate));
    await attempt(failures, async () => {
      const closed = await f.close();
      if (!closed.ok) throw closed.error;
    });
    for (const view of views)
      await attempt(failures, async () => {
        (await view.settleRetirement()).unwrap();
      });
  }
  report(failures);
}, 30000);

it.each([
  'cancel',
  'reset',
  'binding-failure',
] as const)('settles first Source native View work after %s and permits a fresh original-owner attempt', async (mode) => {
  const f = await levelInitialViewFixture();
  const failures: unknown[] = [];
  const composition = f.internals.sceneComposition;
  assert(composition);
  const begin = composition.beginStagedGroup.bind(composition);
  let staged: ReturnType<typeof begin> | undefined;
  const capture = vi.spyOn(composition, 'beginStagedGroup').mockImplementation((...args) => {
    staged = begin(...args);
    return staged;
  });
  const native = f.internals.device.createComputePipeline.bind(f.internals.device);
  f.internals.device.createComputePipelineAsync = (descriptor) => native(descriptor);
  const views: import('../gpu-driven/view-gpu').GpuDrivenView[] = [];
  const nativeBinding = f.internals.device.createBindGroup.bind(f.internals.device);
  let inject = mode === 'binding-failure';
  const bindings = vi
    .spyOn(f.internals.device, 'createBindGroup')
    .mockImplementation((descriptor) => {
      if (inject && descriptor.label === 'gpu-driven-view-bg') {
        inject = false;
        throw Error('injected first Source binding failure');
      }
      return nativeBinding(descriptor);
    });
  try {
    const result = await prepare(f.candidate, f.draw);
    assert(!result.ok && staged?.ok);
    const source = staged.value;
    const work = f.manager.prepareInitialSourceViews(
      source.group,
      () => source.isCurrent(),
      (view) => views.push(view),
    );
    if (mode === 'binding-failure') {
      let failure: unknown;
      try {
        for (let step = 0; step < 1000; step++) {
          const next = work.next();
          if (next.done) break;
          if (next.value instanceof Promise) await next.value;
        }
      } catch (cause) {
        failure = cause;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain('injected first Source binding failure');
    } else {
      for (let step = 0; step < 100; step++) {
        const next = work.next();
        assert(!next.done);
        if (next.value instanceof Promise) await next.value;
        if (views[0]?.visibleBuffer !== undefined) break;
      }
      assert(views.length === 1);
      if (mode === 'reset') {
        const owner = f.manager.currentOwner;
        f.manager.reset();
        expect(f.manager.currentOwner).toBe(owner);
        expect(() => work.next()).toThrow();
      } else work.return(undefined);
    }
    (await work.retire()).unwrap();
    expect(f.manager.currentOwner.gpuDriven.resourceGeneration).toBeUndefined();
    expect(composition.entry?.topology.captureResidencySelection().includes(source.group)).toBe(
      false,
    );
    expect((await f.draw()).presentation).toBe('ready');
    expect(source.isCurrent(), JSON.stringify(source.inspect())).toBe(true);
    const retry = f.manager.prepareInitialSourceViews(
      source.group,
      () => source.isCurrent(),
      (view) => views.push(view),
    );
    let complete = false;
    for (let step = 0; step < 1000; step++) {
      const next = retry.next();
      if (next.done) {
        complete = true;
        break;
      }
      if (next.value instanceof Promise) await next.value;
    }
    expect(complete).toBe(true);
    expect(f.manager.currentOwner.gpuDriven.resourceGeneration).toBeDefined();
  } catch (cause) {
    failures.push(cause);
  } finally {
    capture.mockRestore();
    bindings.mockRestore();
    await attempt(failures, () => retire(f.candidate));
    await attempt(failures, async () => {
      const closed = await f.close();
      if (!closed.ok) throw closed.error;
    });
    for (const view of views)
      await attempt(failures, async () => {
        (await view.settleRetirement()).unwrap();
      });
  }
  report(failures);
}, 30000);

it.each([
  'native-callback',
  'successor',
] as const)('retires the exact first Source attempt at %s without a captured View', async (mode) => {
  const f = await levelInitialViewFixture();
  const composition = f.internals.sceneComposition;
  assert(composition);
  const begin = composition.beginStagedGroup.bind(composition);
  let staged: ReturnType<typeof begin> | undefined;
  const capture = vi.spyOn(composition, 'beginStagedGroup').mockImplementation((...args) => {
    staged = begin(...args);
    return staged;
  });
  const failures: unknown[] = [];
  const tasks: SourceViewPreparation[] = [];
  const native = f.internals.device.createComputePipeline.bind(f.internals.device);
  f.internals.device.createComputePipelineAsync = (descriptor) => native(descriptor);
  try {
    assert(!(await prepare(f.candidate, f.draw)).ok && staged?.ok);
    const source = staged.value;
    const first = f.manager.prepareInitialSourceViews(source.group, () => source.isCurrent());
    tasks.push(first);
    if (mode === 'native-callback') {
      let complete: (() => void) | undefined;
      let retired: ReturnType<SourceViewPreparation['retire']> | undefined;
      const create = vi
        .spyOn(f.internals.device, 'createComputePipelineAsync')
        .mockImplementation((descriptor) => {
          retired = first.retire();
          return new Promise((resolve) => {
            complete = () => resolve(native(descriptor));
          });
        });
      try {
        for (let step = 0; complete === undefined && step < 100; step++) first.next();
        assert(complete && retired);
        let settled = false;
        void retired.then(() => {
          settled = true;
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(settled).toBe(false);
        complete();
        (await retired).unwrap();
        expect(first.retire()).toBe(retired);
        expect(first.next().done).toBe(true);
        expect(create).toHaveBeenCalledTimes(1);
        expect(f.manager.currentOwner.gpuDriven.resourceGeneration).toBeUndefined();
      } finally {
        complete?.();
        create.mockRestore();
      }
    } else {
      first.next();
      first.return(undefined);
      (await f.manager.currentOwner.gpuDriven.settleInitialViewRetirement()).unwrap();
      const successor = f.manager.prepareInitialSourceViews(source.group, () => source.isCurrent());
      tasks.push(successor);
      expect(successor.next().done).toBe(false);
      (await first.retire()).unwrap();
      // The old receipt must not wait for or close the successor's native work.
      expect(successor.next().done).toBe(false);
    }
    expect(composition.entry?.topology.captureResidencySelection().includes(source.group)).toBe(
      false,
    );
  } catch (cause) {
    failures.push(cause);
  } finally {
    capture.mockRestore();
    for (const task of tasks) await attempt(failures, async () => (await task.retire()).unwrap());
    await attempt(failures, () => retire(f.candidate));
    await attempt(failures, async () => {
      const closed = await f.close();
      if (!closed.ok) throw closed.error;
    });
  }
  report(failures);
}, 30000);

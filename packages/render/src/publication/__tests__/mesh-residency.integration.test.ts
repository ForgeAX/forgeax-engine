import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { rhi } from '@forgeax/engine-rhi-null';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { assert, expect, it, vi } from 'vitest';
import { createPublishedMeshResidencyHost } from '../../assembly/published-mesh-residency';
import { MeshFilter, MeshRenderer, Visibility, VisibilityStateValue } from '../../components';
import { GpuResidencyCache } from '../../device/gpu-residency';
import { createDynamicGeometryFrameBindings } from '../../record/dynamic-geometry-consumption';
import type { FrameReceipt } from '../../render-contract';
import { createRenderPublisher } from '../publisher';
import { RenderPublicationReceiver } from '../receiver';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing fixture value');
  return value;
}

function fixture() {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const identity = { source: 'prepared-mesh', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity);
  const receiver = new RenderPublicationReceiver(identity);
  const mesh = createBoxGeometry(1, 1, 1).unwrap();
  const meshHandle = assets.create(mesh).unwrap();
  const input = { ...identity, meshHandle, mesh: assets.read(meshHandle).unwrap(), revision: 1 };
  const packet = () => {
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: meshHandle } },
        { component: MeshRenderer, data: {} },
      )
      .unwrap();
    world.update(0).unwrap();
    return structuredClone(publisher.prepare(0).unwrap().packet);
  };
  return { world, assets, publisher, receiver, input, packet };
}

it('prepares in the accepted resource namespace without admitting the mesh or a World', async () => {
  const f = fixture();
  const prepared = f.receiver.prepareMesh(f.input).unwrap();
  expect(prepared.resources.resolveAsset(f.input.meshHandle).ok).toBe(false);
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const physical = store
    .prepareMeshResidency(f.input.meshHandle, prepared.mesh, f.input.revision, prepared.resources)
    .unwrap();
  const gpu = physical.entry;
  expect(store.getMeshGpuHandles(f.input.meshHandle, prepared.resources)).toBeUndefined();
  const accepted = f.receiver.accept(encodeRenderPublication(f.packet())).unwrap();
  expect(physical.commit()).toBe(true);
  expect(accepted.resources).toBe(prepared.resources);
  expect(accepted.resources.resolveAsset(f.input.meshHandle).unwrap()).toBe(prepared.mesh);
  expect(store.ensureResident(f.input.meshHandle, prepared.mesh, accepted.resources).unwrap()).toBe(
    gpu,
  );
  physical.lease.release(false);
  prepared.release();
  expect(prepared.isCurrent()).toBe(false);
  expect(accepted.resources.resolveAsset(f.input.meshHandle).ok).toBe(true);
  store.destroyAll();
  f.publisher.dispose();
});

it.each([
  'vertices',
  'aabb',
  'materialSlots',
] as const)('rejects a conflicting %s before changing the accepted packet', (field) => {
  const f = fixture();
  const prepared = f.receiver.prepareMesh(f.input).unwrap();
  const packet = f.packet();
  const asset = packet.assets.find((row) => row.handle === f.input.meshHandle)?.value;
  if (asset?.kind !== 'mesh') throw new Error('missing mesh');
  if (field === 'vertices') asset.vertices[0] = (asset.vertices[0] ?? 0) + 1;
  if (field === 'aabb') required(asset.aabb)[0] = -99;
  if (field === 'materialSlots')
    Object.assign(required(asset.materialSlots[0]), { slotName: 'altered' });
  expect(f.receiver.accept(encodeRenderPublication(packet))).toMatchObject({
    ok: false,
    error: { detail: { reason: 'shape' } },
  });
  expect(f.receiver.acceptedRevision).toBe(0);
  expect(prepared.resources.resolveAsset(f.input.meshHandle).ok).toBe(false);
  expect(prepared.isCurrent()).toBe(true);
  prepared.release();
  f.publisher.dispose();
});

it('fences source identity, cancellation and disposal without reviving an old lease', () => {
  const f = fixture();
  expect(f.receiver.prepareMesh({ ...f.input, epoch: 2 }).ok).toBe(false);
  const first = f.receiver.prepareMesh(f.input).unwrap();
  const second = f.receiver.prepareMesh(f.input).unwrap();
  first.release();
  expect(first.isCurrent()).toBe(false);
  expect(second.isCurrent()).toBe(true);
  second.release();
  const replacement = f.receiver.prepareMesh(f.input).unwrap();
  first.release();
  expect(replacement.isCurrent()).toBe(true);
  f.receiver.dispose();
  expect(replacement.isCurrent()).toBe(false);
  expect(f.receiver.prepareMesh(f.input).ok).toBe(false);
  f.publisher.dispose();
});

async function gpuFixture() {
  const f = fixture();
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const allocations: ReturnType<GpuResidencyCache['prepareMeshResidency']>[] = [];
  const preparePhysical = store.prepareMeshResidency.bind(store);
  vi.spyOn(store, 'prepareMeshResidency').mockImplementation((...args) => {
    const result = preparePhysical(...args);
    allocations.push(result);
    return result;
  });
  const bindings = createDynamicGeometryFrameBindings();
  let finish!: () => void;
  const upload = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let generation = 1;
  let frame = { frameId: 1, deviceGeneration: 1 } as FrameReceipt;
  const prepare = createPublishedMeshResidencyHost({
    receiver: f.receiver,
    getGpuStore: () => store,
    currentGeneration: () => generation,
    completeUploads: () => upload,
    isCurrentFrame: (candidate) => candidate === frame,
    recordStageLane: bindings.recordStageLane,
  });
  return {
    ...f,
    store,
    allocation: () => required(allocations.at(-1)).unwrap().entry,
    bindings,
    prepare,
    finish,
    frame: () => frame,
    replaceFrame: () => {
      frame = { frameId: 2, deviceGeneration: 1 } as FrameReceipt;
    },
    recover: () => {
      generation++;
    },
  };
}

it('keeps a source-committed allocation until the receiver accepts its actual Mesh packet', async () => {
  const f = await gpuFixture();
  const pending = f.prepare(f.input);
  f.finish();
  const prepared = (await pending).unwrap();
  const resourceLease = f.receiver.prepareMesh(f.input).unwrap();
  const gpu = f.allocation();
  expect(f.store.getMeshGpuHandles(f.input.meshHandle, resourceLease.resources)).toBeUndefined();
  resourceLease.release();
  const released = vi.fn();
  const transfer = prepared.release(false);
  void transfer?.then(released);
  await Promise.resolve();
  expect(prepared.isCurrent()).toBe(false);
  expect(released).not.toHaveBeenCalled();
  expect(f.store.getMeshGpuHandles(f.input.meshHandle, resourceLease.resources)).toBeUndefined();
  expect(f.receiver.prepareMesh({ ...f.input, mesh: createBoxGeometry(2, 2, 2).unwrap() }).ok).toBe(
    false,
  );
  const accepted = f.receiver.accept(encodeRenderPublication(f.packet())).unwrap();
  await transfer;
  expect(released).toHaveBeenCalledOnce();
  expect(f.store.getMeshGpuHandles(f.input.meshHandle, accepted.resources)).toBe(gpu);
  f.receiver.dispose();
  f.store.destroyAll();
  f.publisher.dispose();
});

it.each([
  'cancel',
  'dispose',
] as const)('terminates unpublished mesh transfer on %s', async (action) => {
  const f = await gpuFixture();
  const pending = f.prepare(f.input);
  f.finish();
  const prepared = (await pending).unwrap();
  const resourceLease = f.receiver.prepareMesh(f.input).unwrap();
  resourceLease.release();
  const transfer = prepared.release(false);
  if (action === 'cancel') expect(prepared.release(true)).toBe(transfer);
  else f.receiver.dispose();
  await transfer;
  expect(f.store.getMeshGpuHandles(f.input.meshHandle, resourceLease.resources)).toBeUndefined();
  f.receiver.dispose();
  f.store.destroyAll();
  f.publisher.dispose();
});

it('waits for physical upload and reads only an exact current submitted frame', async () => {
  const f = await gpuFixture();
  const ready = vi.fn();
  const pending = f.prepare(f.input).then((result) => {
    ready();
    return result;
  });
  await Promise.resolve();
  expect(ready).not.toHaveBeenCalled();
  f.finish();
  const prepared = (await pending).unwrap();
  expect(prepared.isCurrent()).toBe(true);
  const accepted = f.receiver.accept(encodeRenderPublication(f.packet())).unwrap();
  const entity = required(accepted.frame.renderables.at(0)).entityKey;
  const entry = { source: required(accepted.frame.renderables.at(0)) };
  f.bindings.begin();
  f.bindings.onRenderableDraw([accepted.resources])(entry, 'gpu');
  expect(prepared.recordStageLane(f.frame(), entity).unwrap()).toBeUndefined();
  f.bindings.commit(true);
  expect(prepared.recordStageLane(f.frame(), entity).unwrap()).toBe('gpu');
  expect(prepared.recordStageLane({ ...f.frame() }, entity).ok).toBe(false);
  const previous = f.frame();
  f.replaceFrame();
  expect(prepared.recordStageLane(previous, entity).ok).toBe(false);
  f.recover();
  expect(prepared.isCurrent()).toBe(false);
  expect(prepared.recordStageLane(f.frame(), entity).ok).toBe(false);
  prepared.release();
  f.store.destroyAll();
  f.publisher.dispose();
});

it.each([
  'dispose',
  'recover',
] as const)('rejects late upload after %s and retires its allocation', async (action) => {
  const f = await gpuFixture();
  const pending = f.prepare(f.input);
  const scope = f.receiver.prepareMesh(f.input).unwrap();
  const gpu = f.allocation();
  expect(f.store.getMeshGpuHandles(f.input.meshHandle, scope.resources)).toBeUndefined();
  let complete!: () => void;
  const submitted = new Promise<void>((resolve) => {
    complete = resolve;
  });
  f.store.trackMeshSubmission(submitted);
  const settled = vi.fn();
  void pending.then(settled);
  if (action === 'dispose') f.receiver.dispose();
  else f.recover();
  expect(gpu.vertexBuffer.isDestroyed).toBe(false);
  f.finish();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(settled).not.toHaveBeenCalled();
  complete();
  expect(await pending).toMatchObject({
    ok: false,
    error: { code: 'mesh-residency-gpu-not-ready' },
  });
  await vi.waitFor(() => expect(gpu.vertexBuffer.isDestroyed).toBe(true));
  scope.release();
  f.store.destroyAll();
  f.publisher.dispose();
});

it('fences released published mesh residency until its last submitted GPU work finishes', async () => {
  const f = await gpuFixture();
  f.finish();
  const prepared = (await f.prepare(f.input)).unwrap();
  const scope = f.receiver.prepareMesh(f.input).unwrap();
  const gpu = f.allocation();
  expect(f.store.getMeshGpuHandles(f.input.meshHandle, scope.resources)).toBeUndefined();
  let complete!: () => void;
  const frame = new Promise<void>((resolve) => {
    complete = resolve;
  });
  f.store.trackMeshSubmission(frame);
  const retired = prepared.release();
  expect(retired).toBeInstanceOf(Promise);
  expect(prepared.isCurrent()).toBe(false);
  expect(gpu.vertexBuffer.isDestroyed).toBe(false);
  complete();
  await retired;
  expect(gpu.vertexBuffer.isDestroyed).toBe(true);
  scope.release();
  f.store.destroyAll();
  f.publisher.dispose();
});

it('owns prepared bytes even when the source uses SharedArrayBuffer', () => {
  const f = fixture();
  const shared = new Float32Array(new SharedArrayBuffer(f.input.mesh.vertices.byteLength));
  shared.set(f.input.mesh.vertices);
  const input = { ...f.input, mesh: { ...f.input.mesh, vertices: shared } };
  const prepared = f.receiver.prepareMesh(input).unwrap();
  const before = required(shared[0]);
  shared[0] = before + 1;
  expect(prepared.mesh.vertices[0]).toBe(before);
  expect(prepared.mesh.vertices.buffer).toBeInstanceOf(ArrayBuffer);
  expect(f.receiver.prepareMesh(input).ok).toBe(false);
  prepared.release();
  f.publisher.dispose();
});

it('validates real Worker-cloned mesh payloads and rejects later shared-byte changes', async () => {
  const worker = new Worker(
    "const { parentPort } = require('node:worker_threads'); parentPort.on('message', value => parentPort.postMessage(value));",
    { eval: true },
  );
  const roundTrip = async <T>(value: T): Promise<T> => {
    const response = once(worker, 'message');
    worker.postMessage(value);
    return (await response)[0] as T;
  };
  const f = fixture();
  try {
    const shared = new Float32Array(new SharedArrayBuffer(f.input.mesh.vertices.byteLength));
    shared.set(f.input.mesh.vertices);
    const input = { ...f.input, mesh: { ...f.input.mesh, vertices: shared } };
    const prepared = f.receiver.prepareMesh(await roundTrip(input)).unwrap();
    const offset = shared.length - 1,
      before = required(shared[offset]);
    shared[offset] = before + 1;
    expect(prepared.mesh.vertices[offset]).toBe(before);
    expect(prepared.mesh.vertices.buffer).toBeInstanceOf(ArrayBuffer);
    expect(f.receiver.prepareMesh(await roundTrip(input)).ok).toBe(false);
    expect(f.receiver.acceptedRevision).toBe(0);
    shared[offset] = before;
    const accepted = f.receiver
      .accept(encodeRenderPublication(await roundTrip(f.packet())))
      .unwrap();
    expect(accepted.resources.resolveAsset(f.input.meshHandle).unwrap()).toBe(prepared.mesh);
    prepared.release();
  } finally {
    f.receiver.dispose();
    f.publisher.dispose();
    await worker.terminate();
  }
});

it('retains the handle payload identity until cancelled GPU work releases its allocation', async () => {
  const f = await gpuFixture();
  f.finish();
  const first = (await f.prepare(f.input)).unwrap();
  let complete!: () => void;
  const submitted = new Promise<void>((resolve) => {
    complete = resolve;
  });
  f.store.trackMeshSubmission(submitted);
  const released = first.release();
  const replacement = { ...f.input, mesh: createBoxGeometry(2, 2, 2).unwrap() };
  expect(await f.prepare(replacement)).toMatchObject({
    ok: false,
    error: { detail: { reason: 'shape' } },
  });
  complete();
  await released;
  const second = (await f.prepare(replacement)).unwrap();
  expect(second.isCurrent()).toBe(true);
  await second.release();
  f.store.destroyAll();
  f.publisher.dispose();
});

import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { encodeRenderPublication, renderPublicationTransfers } from '../record';

it.each([
  'publish',
  'cancel',
  'recover',
] as const)('keeps native received storage through physical preparation and %s', async (action) => {
  const f = await gpuFixture();
  const received = structuredClone(f.input);
  const pending = f.prepare(received, 'received');
  const peek = f.receiver.prepareMesh(received).unwrap();
  expect(peek.mesh).toBe(received.mesh);
  expect(peek.mesh.vertices.buffer).toBe(received.mesh.vertices.buffer);
  peek.release();
  if (action === 'recover') f.recover();
  f.finish();
  const prepared = await pending;
  if (action === 'recover') {
    expect(prepared.ok).toBe(false);
    expect(f.store.getMeshGpuHandles(received.meshHandle, peek.resources)).toBeUndefined();
  } else {
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw prepared.error;
    expect(prepared.value.isCurrent()).toBe(true);
    const conflicting = structuredClone(received);
    conflicting.mesh.vertices[0] = (conflicting.mesh.vertices[0] ?? 0) + 1;
    expect(f.receiver.prepareMesh(conflicting, undefined, undefined, 'received').ok).toBe(false);
    if (action === 'publish') {
      const accepted = f.receiver.accept(encodeRenderPublication(f.packet())).unwrap();
      expect(accepted.resources.resolveAsset(received.meshHandle).unwrap()).toBe(received.mesh);
      await prepared.value.release(false);
      expect(f.store.getMeshGpuHandles(received.meshHandle, accepted.resources)).toBeDefined();
    } else {
      await prepared.value.release(true);
      expect(f.store.getMeshGpuHandles(received.meshHandle, peek.resources)).toBeUndefined();
    }
  }
  f.receiver.dispose();
  f.store.destroyAll();
  f.publisher.dispose();
});

it('sends a prepared mesh revision once and adopts the receiver-held payload', () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const identity = { source: 'prepared-reference', epoch: 1 };
  const held = new Set<string>();
  const publisher = createRenderPublisher(
    world,
    assets,
    identity,
    undefined,
    [],
    undefined,
    undefined,
    2,
    (handle, revision) => held.has(`${handle}:${revision}`),
  );
  const receiver = new RenderPublicationReceiver(identity);
  const meshHandle = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const mesh = assets.read(meshHandle).unwrap();
  const prepared = receiver.prepareMesh({ ...identity, meshHandle, mesh, revision: 1 }).unwrap();
  held.add(`${meshHandle}:1`);
  world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: meshHandle } },
      { component: MeshRenderer, data: {} },
    )
    .unwrap();
  world.update(0).unwrap();
  const candidate = publisher.prepare(0).unwrap();
  const packet = structuredClone(candidate.packet);
  expect(packet.assets.some((row) => row.handle === meshHandle)).toBe(false);
  expect(packet.preparedAssets).toEqual([
    expect.objectContaining({ handle: meshHandle, revision: 1 }),
  ]);
  candidate.accept();
  const accepted = receiver.accept(encodeRenderPublication(packet)).unwrap();
  expect(accepted.resources.resolveAsset(meshHandle).unwrap()).toBe(prepared.mesh);
  prepared.release();
  publisher.dispose();
});

it('holds a new hidden renderable until its preparing mesh crosses once', () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const identity = { source: 'preparing-reference', epoch: 1 };
  const held = new Set<string>();
  const preparing = new Set<number>();
  const publisher = createRenderPublisher(
    world,
    assets,
    identity,
    undefined,
    [],
    undefined,
    undefined,
    2,
    (handle, revision) => held.has(`${handle}:${revision}`),
    (handle) => preparing.has(handle),
  );
  const receiver = new RenderPublicationReceiver(identity);
  const meshHandle = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const visibleHandle = assets.create(createBoxGeometry(2, 2, 2).unwrap()).unwrap();
  const spawn = (handle: typeof meshHandle, hidden: boolean) =>
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: handle } },
        { component: MeshRenderer, data: {} },
        ...(hidden
          ? [{ component: Visibility, data: { state: VisibilityStateValue.hidden } }]
          : []),
      )
      .unwrap();
  preparing.add(meshHandle);
  preparing.add(visibleHandle);
  spawn(meshHandle, true);
  // A visible renderable never waits: it publishes its payload as before.
  spawn(visibleHandle, false);
  world.update(0).unwrap();
  const first = publisher.prepare(0).unwrap();
  expect(first.packet.assets.some((row) => row.handle === meshHandle)).toBe(false);
  expect(first.packet.assets.some((row) => row.handle === visibleHandle)).toBe(true);
  first.accept();
  receiver.accept(encodeRenderPublication(structuredClone(first.packet))).unwrap();
  publisher.recycle(first.packet.revision, renderPublicationTransfers(first.message)).unwrap();
  // Still preparing on the next publication: still withheld.
  world.update(0).unwrap();
  const second = publisher.prepare(0).unwrap();
  expect(second.packet.assets.some((row) => row.handle === meshHandle)).toBe(false);
  second.accept();
  receiver.accept(encodeRenderPublication(structuredClone(second.packet))).unwrap();
  publisher.recycle(second.packet.revision, renderPublicationTransfers(second.message)).unwrap();
  // Ready: the receiver holds the payload, so only its identity crosses.
  const prepared = receiver
    .prepareMesh({ ...identity, meshHandle, mesh: assets.read(meshHandle).unwrap(), revision: 1 })
    .unwrap();
  preparing.delete(meshHandle);
  held.add(`${meshHandle}:1`);
  world.update(0).unwrap();
  const third = publisher.prepare(0).unwrap();
  const packet = structuredClone(third.packet);
  expect(packet.assets.some((row) => row.handle === meshHandle)).toBe(false);
  expect(packet.preparedAssets).toEqual([
    expect.objectContaining({ handle: meshHandle, revision: 1 }),
  ]);
  third.accept();
  const accepted = receiver.accept(encodeRenderPublication(packet)).unwrap();
  expect(accepted.resources.resolveAsset(meshHandle).unwrap()).toBe(prepared.mesh);
  prepared.release();
  publisher.dispose();
});

it('publishes a withheld hidden renderable normally when its preparation ends unfinished', () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const identity = { source: 'preparing-cancelled', epoch: 1 };
  const preparing = new Set<number>();
  const publisher = createRenderPublisher(
    world,
    assets,
    identity,
    undefined,
    [],
    undefined,
    undefined,
    2,
    () => false,
    (handle) => preparing.has(handle),
  );
  const receiver = new RenderPublicationReceiver(identity);
  const meshHandle = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  preparing.add(meshHandle);
  world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: meshHandle } },
      { component: MeshRenderer, data: {} },
      { component: Visibility, data: { state: VisibilityStateValue.hidden } },
    )
    .unwrap();
  world.update(0).unwrap();
  const first = publisher.prepare(0).unwrap();
  expect(first.packet.assets.some((row) => row.handle === meshHandle)).toBe(false);
  first.accept();
  receiver.accept(encodeRenderPublication(structuredClone(first.packet))).unwrap();
  publisher.recycle(first.packet.revision, renderPublicationTransfers(first.message)).unwrap();
  preparing.delete(meshHandle);
  world.update(0).unwrap();
  const second = publisher.prepare(0).unwrap();
  expect(second.packet.assets.some((row) => row.handle === meshHandle)).toBe(true);
  second.accept();
  receiver.accept(encodeRenderPublication(structuredClone(second.packet))).unwrap();
  publisher.recycle(second.packet.revision, renderPublicationTransfers(second.message)).unwrap();
  publisher.dispose();
});

it('rejects a prepared mesh reference the receiver does not hold', () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const identity = { source: 'prepared-reference-missing', epoch: 1 };
  const publisher = createRenderPublisher(
    world,
    assets,
    identity,
    undefined,
    [],
    undefined,
    undefined,
    2,
    () => true,
  );
  const receiver = new RenderPublicationReceiver(identity);
  const meshHandle = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: meshHandle } },
      { component: MeshRenderer, data: {} },
    )
    .unwrap();
  world.update(0).unwrap();
  const packet = structuredClone(publisher.prepare(0).unwrap().packet);
  const rejected = receiver.accept(encodeRenderPublication(packet));
  assert(!rejected.ok);
  expect(rejected.error.detail.reason).toBe('revision');
  publisher.dispose();
});

it('keeps a released prepared payload adoptable for a queued publication', () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const identity = { source: 'prepared-reference-released', epoch: 1 };
  const publisher = createRenderPublisher(
    world,
    assets,
    identity,
    undefined,
    [],
    undefined,
    undefined,
    2,
    () => true,
  );
  const receiver = new RenderPublicationReceiver(identity);
  const meshHandle = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const mesh = assets.read(meshHandle).unwrap();
  const prepared = receiver.prepareMesh({ ...identity, meshHandle, mesh, revision: 1 }).unwrap();
  prepared.release();
  world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: meshHandle } },
      { component: MeshRenderer, data: {} },
    )
    .unwrap();
  world.update(0).unwrap();
  const packet = structuredClone(publisher.prepare(0).unwrap().packet);
  expect(
    receiver
      .accept(encodeRenderPublication(packet))
      .unwrap()
      .resources.resolveAsset(meshHandle)
      .unwrap(),
  ).toBe(prepared.mesh);
  publisher.dispose();
});

it('adopts a referenced revision after a newer revision of the same handle was prepared', () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const identity = { source: 'prepared-reference-superseded', epoch: 1 };
  const publisher = createRenderPublisher(
    world,
    assets,
    identity,
    undefined,
    [],
    undefined,
    undefined,
    2,
    () => true,
  );
  const receiver = new RenderPublicationReceiver(identity);
  const meshHandle = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const mesh = assets.read(meshHandle).unwrap();
  const first = receiver.prepareMesh({ ...identity, meshHandle, mesh, revision: 1 }).unwrap();
  world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: meshHandle } },
      { component: MeshRenderer, data: {} },
    )
    .unwrap();
  world.update(0).unwrap();
  const packet = structuredClone(publisher.prepare(0).unwrap().packet);
  expect(packet.preparedAssets).toEqual([
    expect.objectContaining({ handle: meshHandle, revision: 1 }),
  ]);
  // The next revision's mesh-prepare is handled before the queued draw adopts revision 1.
  const next = createBoxGeometry(2, 2, 2).unwrap();
  receiver.prepareMesh({ ...identity, meshHandle, mesh: next, revision: 2 }).unwrap();
  expect(
    receiver
      .accept(encodeRenderPublication(packet))
      .unwrap()
      .resources.resolveAsset(meshHandle)
      .unwrap(),
  ).toBe(first.mesh);
  publisher.dispose();
});

it('keeps a source-held preparation adoptable after its asset row was retired', () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const identity = { source: 'prepared-reference-retired', epoch: 1 };
  // The source still holds its ready preparation; asset retirement does not reach it.
  const held = new Set<string>();
  const publisher = createRenderPublisher(
    world,
    assets,
    identity,
    undefined,
    [],
    undefined,
    undefined,
    2,
    (handle, revision) => held.has(`${handle}:${revision}`),
  );
  const receiver = new RenderPublicationReceiver(identity);
  const meshHandle = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const mesh = assets.read(meshHandle).unwrap();
  const spawn = () =>
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: meshHandle } },
        { component: MeshRenderer, data: {} },
      )
      .unwrap();
  const publish = () => {
    world.update(0).unwrap();
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet);
    candidate.accept();
    const accepted = receiver.accept(encodeRenderPublication(packet));
    publisher
      .recycle(packet.revision, renderPublicationTransfers(encodeRenderPublication(packet)))
      .unwrap();
    return { packet, accepted };
  };
  // Dust2 order: the accepted row precedes a standalone residency of the same revision.
  let entity = spawn();
  expect(publish().packet.assets.some((row) => row.handle === meshHandle)).toBe(true);
  const prepared = receiver.prepareMesh({ ...identity, meshHandle, mesh, revision: 1 }).unwrap();
  held.add(`${meshHandle}:1`);
  // The renderable leaves (for example parked rubble): the asset row is retired.
  world.despawn(entity).unwrap();
  const retired = publish();
  expect(retired.packet.retiredAssets).toContain(meshHandle);
  expect(retired.accepted.ok).toBe(true);
  // Re-entering the closure references the still-held preparation.
  entity = spawn();
  const back = publish();
  expect(back.packet.preparedAssets).toEqual([
    expect.objectContaining({ handle: meshHandle, revision: 1 }),
  ]);
  expect(back.accepted.ok).toBe(true);
  expect(back.accepted.unwrap().resources.resolveAsset(meshHandle).unwrap()).toBe(prepared.mesh);
  prepared.release();
  publisher.dispose();
});

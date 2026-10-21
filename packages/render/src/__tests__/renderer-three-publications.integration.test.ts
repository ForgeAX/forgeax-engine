import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import type { Buffer } from '@forgeax/engine-rhi';
import {
  RhiNullDevice,
  RhiNullQueue,
  RhiNullRenderPassEncoder,
  rhi,
} from '@forgeax/engine-rhi-null';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { createRenderer, exposeRenderer } from '../assembly/factory';
import { Camera, MeshFilter, MeshRenderer } from '../components';
import { ANTIALIAS_NONE, BLOOM_DISABLED } from '../components/camera';
import type { RenderFeature } from '../features/types';
import { renderPublicationTransfers } from '../publication/contract';
import { createRenderPublisher } from '../publication/publisher';
import type { FrameReceipt } from '../render-contract';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

function completionFence() {
  let resolve!: () => void;
  const promise = new Promise<undefined>((done) => {
    resolve = () => done(undefined);
  });
  return { promise, resolve };
}

it.each([
  3, 4,
] as const)('renders %i sealed mesh replacements and fences their real residency through each receipt', async (capacity) => {
  const identity = { source: 'three-publications', epoch: 1 };
  const acknowledged: { data: unknown; feedback: unknown }[] = [];
  const feature: RenderFeature<unknown> = {
    identity: 'three-publications-feature',
    extract: ({ frameNumber }) => ok(frameNumber),
    plan: (data) =>
      ok({ work: [{ scope: 'frame', resources: [], passes: [] }], sourceFeedback: data }),
    onSourceFrameSubmitted: (data, feedback) => acknowledged.push({ data, feedback }),
  };
  const host = await createRenderer(
    {
      width: 64,
      height: 64,
      getContext: () => null,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as HTMLCanvasElement,
    { rhi, publicationSource: identity, features: [feature] },
    { shaderManifestUrl: renderLifecycleManifestUrl() },
  );
  const initialized = await host.initialization;
  if (!initialized.ok) throw initialized.error;
  const renderer = exposeRenderer(host);
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const publisher = createRenderPublisher(
    world,
    assets,
    identity,
    undefined,
    [feature],
    undefined,
    undefined,
    capacity,
  );
  const meshes = Array.from({ length: capacity }, (_, index) => index + 1).map((width) => {
    const mesh = createBoxGeometry(width, 1, 1).unwrap();
    const meshHandle = assets.create(mesh).unwrap();
    return {
      ...identity,
      mesh,
      meshHandle,
      revision: runtimeAssets(assets).version(meshHandle).unwrap(),
    };
  });
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 8] } },
      {
        component: Camera,
        data: {
          fov: Math.PI / 3,
          aspect: 1,
          near: 0.1,
          far: 100,
          antialias: ANTIALIAS_NONE,
          bloom: BLOOM_DISABLED,
        },
      },
    )
    .unwrap();
  const firstMesh = meshes[0];
  if (firstMesh === undefined) throw new Error('Missing first mesh');
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: firstMesh.meshHandle } },
      { component: MeshRenderer, data: {} },
    )
    .unwrap();
  world.update(1 / 60).unwrap();
  propagateTransforms(world).unwrap();

  const vertices: Buffer[] = [];
  let preparingMesh = false;
  const createBuffer = RhiNullDevice.prototype.createBuffer;
  const allocation = vi.spyOn(RhiNullDevice.prototype, 'createBuffer').mockImplementation(function (
    this: RhiNullDevice,
    descriptor,
  ) {
    const result = createBuffer.call(this, descriptor);
    if (
      preparingMesh &&
      result.ok &&
      descriptor.label?.startsWith('mesh-') &&
      descriptor.label.endsWith('-vbo')
    )
      vertices.push(result.value);
    return result;
  });
  const destroyed = vi.spyOn(RhiNullDevice.prototype, 'destroyBuffer');
  const bindings = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'setVertexBuffer');
  const fences: ReturnType<typeof completionFence>[] = [];
  const receipts: FrameReceipt[] = [];
  let submittedFence: ReturnType<typeof completionFence> | undefined;
  const submitWork = RhiNullQueue.prototype.submit;
  // The original queue still validates and consumes the real command buffers.
  // Its observers and the Renderer receipt receive the same fence per submit.
  const submit = vi.spyOn(RhiNullQueue.prototype, 'submit').mockImplementation(function (
    this: RhiNullQueue,
    commands,
  ) {
    submittedFence = completionFence();
    fences.push(submittedFence);
    return submitWork.call(this, commands);
  });
  const queueCompletion = vi
    .spyOn(RhiNullQueue.prototype, 'onSubmittedWorkDone')
    .mockImplementation(() => submittedFence?.promise ?? Promise.resolve(undefined));
  const isDestroyed = (buffer: Buffer) =>
    destroyed.mock.calls.some(([destroyedBuffer]) => destroyedBuffer === buffer);

  try {
    // No frame has submitted yet, so the real preparation upload fences are
    // complete. All three allocations exist before any receipt is held open.
    const leases = [];
    for (const mesh of meshes) {
      preparingMesh = true;
      const prepared = await renderer.preparePublishedMeshResidency(mesh);
      preparingMesh = false;
      if (!prepared.ok) throw prepared.error;
      leases.push(prepared.value);
    }
    expect(vertices).toHaveLength(capacity);
    expect(new Set(vertices).size).toBe(capacity);

    const packets = meshes.map((mesh) => {
      world.set(entity, MeshFilter, { assetHandle: mesh.meshHandle }).unwrap();
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      const candidate = publisher.prepare(0).unwrap();
      const packet = structuredClone(candidate.packet, {
        transfer: renderPublicationTransfers(candidate.packet),
      });
      candidate.accept();
      expect(packet.assets.find(({ handle }) => handle === mesh.meshHandle)?.value).toEqual(
        mesh.mesh,
      );
      return packet;
    });
    expect(publisher.inspect().inFlightCount).toBe(capacity);
    expect(publisher.prepare(0).ok).toBe(false);
    expect(acknowledged).toEqual([]);

    for (const [index, packet] of packets.entries()) {
      const start = bindings.mock.calls.length;
      const result = await renderer.draw({
        publication: packet,
        onFeatureSourceSubmitted: (identity, feedback) => {
          publisher.acknowledgeFeatures(packet.revision, [{ identity, feedback }]).unwrap();
        },
      });
      if (!result.ok) throw result.error;
      expect(result.value.presentation).toBe('ready');
      receipts.push(result.value);
      const bound = new Set(bindings.mock.calls.slice(start).map((call) => call[1]));
      for (const [meshIndex, vertex] of vertices.entries())
        expect(bound.has(vertex)).toBe(meshIndex === index);
      expect(acknowledged).toEqual(
        packets.slice(0, index + 1).map(({ revision }) => ({ data: revision, feedback: revision })),
      );
    }
    expect(fences).toHaveLength(capacity);
    expect(receipts[0]?.frameId).toBeLessThan(receipts[1]?.frameId ?? -1);
    expect(receipts[1]?.frameId).toBeLessThan(receipts[2]?.frameId ?? -1);
    expect(publisher.inspect().inFlightCount).toBe(capacity);
    for (const vertex of vertices) expect(isDestroyed(vertex)).toBe(false);

    const released = Array.from({ length: capacity }, () => false);
    const releases = leases.map((lease, index) =>
      Promise.resolve(lease.release()).then(() => {
        released[index] = true;
      }),
    );
    await Promise.resolve();
    expect(released).toEqual(Array.from({ length: capacity }, () => false));
    for (const [index, receipt] of receipts.entries()) {
      const fence = fences[index];
      const packet = packets[index];
      if (fence === undefined || packet === undefined) throw new Error('Missing submitted frame');
      expect(released[index]).toBe(false);
      const vertex = vertices[index];
      if (vertex === undefined) throw new Error('Missing prepared vertex buffer');
      expect(isDestroyed(vertex)).toBe(false);
      fence.resolve();
      expect((await receipt.completed).ok).toBe(true);
      await releases[index];
      expect(released[index]).toBe(true);
      const transport = renderPublicationTransfers(packet);
      const returned = structuredClone(transport, { transfer: transport });
      publisher.recycle(packet.revision, returned).unwrap();
      expect(publisher.inspect().inFlightCount).toBe(capacity - index - 1);
    }
    expect((await renderer.dispose()).ok).toBe(true);
    for (const vertex of vertices) expect(isDestroyed(vertex)).toBe(true);
  } finally {
    preparingMesh = false;
    for (const fence of fences) fence.resolve();
    await Promise.all(receipts.map(({ completed }) => completed));
    await renderer.dispose();
    publisher.dispose();
    queueCompletion.mockRestore();
    submit.mockRestore();
    bindings.mockRestore();
    destroyed.mockRestore();
    allocation.mockRestore();
  }
});

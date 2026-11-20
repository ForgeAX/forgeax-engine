import { assetDataBytes, runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { defineSystem, FixedTime, FixedUpdate, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  Camera,
  createDynamicGeometryLifecycle,
  createRenderPublisher,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
  renderPublicationTransfers,
} from '@forgeax/engine-render';
import { createDynamicGeometrySourceHost } from '@forgeax/engine-render/internal';
import { rhi } from '@forgeax/engine-rhi-null';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it, vi } from 'vitest';
import { RenderMeshResidency } from '../execution/render-mesh-residency';
import type { MeshResidencyResponse } from '../execution/render-worker-protocol';
import { SourceMeshResidency } from '../execution/source-mesh-residency';

// Admit the shared test fixture before measuring transport work; keep it out of App declarations.
const { renderLifecycleManifestUrl } = await import(
  new URL('../../../render/src/__tests__/shader-manifest-fixture.ts', import.meta.url).href
);
const shaderManifestUrl = renderLifecycleManifestUrl();

it('keeps source Mesh readiness for the adopted revision until the receiver retires it', async () => {
  const identity = { source: 'app-overlapping-mesh-revisions', epoch: 1 };
  const host = await constructRuntimeRendererHost(
    { width: 64, height: 64, getContext: () => null },
    { rhi, publicationSource: identity },
    { shaderManifestUrl },
  );
  if (!host.ok) throw host.error;
  const { renderer, assets } = host.value;
  const world = new World({ assets });
  const firstMesh = createBoxGeometry(1, 1, 1).unwrap();
  const pendingMesh = createBoxGeometry(2, 1, 1).unwrap();
  const successorMesh = createBoxGeometry(3, 1, 1).unwrap();
  const meshHandle = assets.create(firstMesh).unwrap();
  const material = assets.create(Materials.unlit([1, 0, 0, 1])).unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      {
        component: Camera,
        data: perspective({ fov: Math.PI / 3, aspect: 1, near: 0.1, far: 100 }),
      },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: meshHandle } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  const channel = new MessageChannel();
  const source = new SourceMeshResidency(world, () => ({
    ...identity,
    generation: renderer.inspect().frame.deviceGeneration,
    post: (message) => channel.port1.postMessage(message),
  }));
  const receiver = new RenderMeshResidency(renderer, identity, (message) =>
    channel.port2.postMessage(message),
  );
  let transportFailure: unknown;
  let handoffStarted = false;
  channel.port1.onmessage = (event) => source.receive(event.data);
  channel.port2.onmessage = (event) => {
    if (event.data.kind === 'mesh-release' && !event.data.evict) handoffStarted = true;
    void receiver.receive(event.data).catch((cause) => {
      transportFailure = cause;
    });
  };
  const publisher = createRenderPublisher(
    world,
    assets,
    identity,
    renderer.inspect().capabilities,
    [],
    undefined,
    undefined,
    2,
    (handle, revision) => source.holdsPrepared(handle, revision),
  );
  const publish = async (revision: number) => {
    const candidate = publisher.prepare(0).unwrap();
    expect(candidate.packet.preparedAssets).toContainEqual({ handle: meshHandle, revision });
    const message = structuredClone(candidate.message);
    candidate.accept();
    const draw = renderer.draw({ publication: message });
    if (!draw.ok) throw draw.error;
    if (draw.value !== undefined) (await draw.value.completed).unwrap();
    publisher.recycle(message.revision, renderPublicationTransfers(message)).unwrap();
  };
  try {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    const firstRevision = assets.revision(meshHandle).unwrap();
    const first = (
      await source.prepare({ world, meshHandle, assetRevision: firstRevision, mesh: firstMesh })
    ).unwrap();
    await publish(firstRevision);

    const pendingRevision = runtimeAssets(assets).currentRevision + 1;
    const pending = (
      await source.prepare({ world, meshHandle, assetRevision: pendingRevision, mesh: pendingMesh })
    ).unwrap();
    expect(source.holdsPrepared(meshHandle, firstRevision)).toBe(true);
    expect(source.holdsPrepared(meshHandle, pendingRevision)).toBe(true);
    assets.create(firstMesh).unwrap();
    const nextRevision = runtimeAssets(assets).currentRevision + 1;
    const next = (
      await source.prepare({ world, meshHandle, assetRevision: nextRevision, mesh: successorMesh })
    ).unwrap();
    expect(pending.isCurrent()).toBe(false);
    expect(source.holdsPrepared(meshHandle, pendingRevision)).toBe(false);
    expect(source.holdsPrepared(meshHandle, firstRevision)).toBe(true);
    expect(first.isCurrent()).toBe(true);

    assets.replace(meshHandle, successorMesh).unwrap();
    expect(assets.revision(meshHandle).unwrap()).toBe(nextRevision);
    expect(next.isCurrent()).toBe(true);
    const admitted = next.release(false);
    expect(source.holdsPrepared(meshHandle, nextRevision)).toBe(true);
    await vi.waitFor(() => expect(handoffStarted).toBe(true));
    await publish(nextRevision);
    await admitted;
    await vi.waitFor(() => expect(first.isCurrent()).toBe(false));
    expect(source.holdsPrepared(meshHandle, firstRevision)).toBe(false);
    await Promise.all([first.release(true), pending.release(true)]);
    expect(transportFailure).toBeUndefined();
  } finally {
    publisher.dispose();
    await source.dispose();
    await receiver.dispose();
    channel.port1.close();
    channel.port2.close();
    await renderer.dispose();
  }
});

it('carries real Renderer mesh readiness and exact receipts beyond the transient request limit', async () => {
  const identity = { source: 'app-mesh-transport', epoch: 1 };
  const constructed = await constructRuntimeRendererHost(
    { width: 64, height: 64, getContext: () => null },
    { rhi, publicationSource: identity },
    { shaderManifestUrl },
  );
  if (!constructed.ok) throw constructed.error;
  const { renderer, assets } = constructed.value;
  const world = new World({ assets });
  const channel = new MessageChannel();
  const source = new SourceMeshResidency(world, () => ({
    ...identity,
    generation: renderer.inspect().frame.deviceGeneration,
    post: (message) => channel.port1.postMessage(message),
  }));
  const receiver = new RenderMeshResidency(renderer, identity, (message) =>
    channel.port2.postMessage(message),
  );
  let transportFailure: unknown;
  channel.port1.onmessage = (event) => source.receive(event.data);
  channel.port2.onmessage = (event) => {
    void receiver.receive(event.data).catch((cause) => {
      transportFailure = cause;
    });
  };
  const host = createDynamicGeometrySourceHost({
    lifecycle: createDynamicGeometryLifecycle(),
    attachedWorlds: new Set([world]),
    currentGeneration: () => renderer.inspect().frame.deviceGeneration,
    residency: source,
    isConsumedByRenderFrame: (candidate) => source.recordStageLane(candidate) !== undefined,
    recordStageLane: (candidate) => source.recordStageLane(candidate),
    publishedFixedStep: (sourceWorld) => source.publishedFixedStep(sourceWorld),
  });
  const publisher = createRenderPublisher(world, assets, identity, renderer.inspect().capabilities);
  const previous = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const mesh = createBoxGeometry(2, 2, 2).unwrap();
  const meshHandle = assets.create(mesh).unwrap();
  const material = assets.create(Materials.unlit([1, 0, 0, 1])).unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      {
        component: Camera,
        data: perspective({ fov: Math.PI / 3, aspect: 1, near: 0.1, far: 100 }),
      },
    )
    .unwrap();
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: previous } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  try {
    let candidate = (
      await host.prepareDynamicGeometry({ world, entity, meshHandle, revision: 1 })
    ).unwrap();
    expect(world.get(entity, MeshFilter).unwrap().assetHandle).toBe(previous);
    expect(mesh.vertices.byteLength).toBeGreaterThan(0);
    let accepted = false;
    const systemToken1 = defineSystem({
      name: 'source-admission',
      queries: [],
      fn: () => {
        if (accepted) return;
        candidate = host
          .acceptDynamicGeometry(candidate, {
            world,
            fixedStep: world.getResource(FixedTime).tick,
          })
          .unwrap();
        accepted = true;
      },
    });
    world.addSystem(FixedUpdate, systemToken1).unwrap();
    world.update(1 / 60).unwrap();
    expect(world.get(entity, MeshFilter).unwrap().assetHandle).toBe(meshHandle);
    const sourceFixedStep = world.getResource(FixedTime).tick;
    const publication = publisher.prepare(0).unwrap();
    const packet = structuredClone(publication.message);
    publication.accept();
    const draw = renderer.draw({ publication: packet });
    if (!draw.ok) throw draw.error;
    const receipt = draw.value;
    const proof = receiver.consumed(receipt, sourceFixedStep);
    expect(proof).toMatchObject({
      frameId: receipt.frameId,
      sourceFixedStep,
      bindings: new Float64Array([1, 0]),
    });
    world.update(1 / 60).unwrap();
    expect(world.getResource(FixedTime).tick).toBeGreaterThan(sourceFixedStep);
    const completion = await receipt.completed;
    if (!completion.ok) throw completion.error;
    publisher.recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
    source.complete(structuredClone(proof));
    host.publishDynamicGeometry(receipt, world, sourceFixedStep);
    expect(host.dynamicGeometryReceipt(candidate)).toMatchObject({
      frameId: receipt.frameId,
      publicationFixedStep: sourceFixedStep,
      recordStageLane: 'cpu',
    });
    // Published geometry stays resident until its source owner retires it.
    // Those completed transfers must not exhaust the next preparation batch.
    for (let index = 1; index < 33; index++) {
      const nextMesh = createBoxGeometry(1 + index / 100, 1, 1).unwrap();
      const nextHandle = assets.create(nextMesh).unwrap();
      const nextEntity = world
        .spawn(
          { component: Transform, data: {} },
          { component: MeshFilter, data: { assetHandle: previous } },
          { component: MeshRenderer, data: { materials: [material] } },
        )
        .unwrap();
      candidate = (
        await host.prepareDynamicGeometry({
          world,
          entity: nextEntity,
          meshHandle: nextHandle,
          revision: 1,
        })
      ).unwrap();
      accepted = false;
      world.update(1 / 60).unwrap();
      const tick = world.getResource(FixedTime).tick;
      const prepared = publisher.prepare(index).unwrap();
      const nextPacket = structuredClone(prepared.message);
      prepared.accept();
      const nextDraw = renderer.draw({ publication: nextPacket });
      if (!nextDraw.ok) throw nextDraw.error;
      const nextReceipt = nextDraw.value;
      const consumed = receiver.consumed(nextReceipt, tick);
      expect(consumed.bindings).toHaveLength((index + 1) * 2);
      const completed = await nextReceipt.completed;
      if (!completed.ok) throw completed.error;
      publisher.recycle(nextPacket.revision, renderPublicationTransfers(nextPacket)).unwrap();
      source.complete(structuredClone(consumed));
      host.publishDynamicGeometry(nextReceipt, world, tick);
      expect(host.dynamicGeometryReceipt(candidate)).toMatchObject({
        frameId: nextReceipt.frameId,
        publicationFixedStep: tick,
        recordStageLane: 'cpu',
      });
    }
    host.invalidateDynamicGeometryWorld(world);
    expect(host.isDynamicGeometryCurrent(candidate)).toBe(false);
    expect(transportFailure).toBeUndefined();
  } finally {
    await source.dispose();
    await receiver.dispose();
    channel.port1.close();
    channel.port2.close();
    publisher.dispose();
    await renderer.dispose();
  }
});

it.each([
  1, 2,
])('prepares %i competing 33-member rosters with a held standalone lease and atomic admission', async (batches) => {
  const identity = { source: 'app-mesh-batch', epoch: 1 };
  const constructed = await constructRuntimeRendererHost(
    { width: 64, height: 64, getContext: () => null },
    { rhi, publicationSource: identity },
    { shaderManifestUrl },
  );
  if (!constructed.ok) throw constructed.error;
  const { renderer, assets } = constructed.value;
  const world = new World({ assets });
  const channel = new MessageChannel();
  const occupied = new Set<number>(),
    standalone = new Set<number>();
  let peakOccupied = 0;
  const source = new SourceMeshResidency(world, () => ({
    ...identity,
    generation: renderer.inspect().frame.deviceGeneration,
    post: (message) => {
      if (message.kind === 'mesh-prepare') {
        occupied.add(message.requestId);
        if (message.entity === undefined) standalone.add(message.requestId);
        peakOccupied = Math.max(peakOccupied, occupied.size);
      }
      channel.port1.postMessage(message);
    },
  }));
  const receiver = new RenderMeshResidency(renderer, identity, (message) =>
    channel.port2.postMessage(message),
  );
  let transportFailure: unknown;
  channel.port1.onmessage = (event) => {
    const message = event.data;
    if (
      message.kind === 'mesh-released' ||
      (message.kind === 'mesh-ready' && !standalone.has(message.requestId))
    )
      occupied.delete(message.requestId);
    source.receive(message);
  };
  channel.port2.onmessage = (event) => {
    void receiver.receive(event.data).catch((cause) => {
      transportFailure = cause;
    });
  };
  const lifecycle = createDynamicGeometryLifecycle();
  const host = createDynamicGeometrySourceHost({
    lifecycle,
    attachedWorlds: new Set([world]),
    currentGeneration: () => renderer.inspect().frame.deviceGeneration,
    residency: source,
    isConsumedByRenderFrame: (candidate) => source.recordStageLane(candidate) !== undefined,
    recordStageLane: (candidate) => source.recordStageLane(candidate),
    publishedFixedStep: (sourceWorld) => source.publishedFixedStep(sourceWorld),
  });
  const publisher = createRenderPublisher(world, assets, identity, renderer.inspect().capabilities);
  const material = assets.create(Materials.unlit([0, 1, 0, 1])).unwrap();
  const previousMesh = createBoxGeometry(0.1, 0.1, 0.1).unwrap();
  const previous = assets.create(previousMesh).unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      {
        component: Camera,
        data: perspective({ fov: Math.PI / 3, aspect: 1, near: 0.1, far: 100 }),
      },
    )
    .unwrap();
  const inputs = Array.from({ length: 33 * batches }, (_, index) => {
    const mesh = createBoxGeometry(1 + index / 100, 1, 1).unwrap();
    const meshHandle = assets.create(mesh).unwrap();
    const entity = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: previous } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    return { world, entity, mesh, meshHandle, revision: 1 };
  });
  try {
    const lease = (
      await source.prepare({ world, meshHandle: previous, mesh: previousMesh, assetRevision: 1 })
    ).unwrap();
    let groups = (
      await Promise.all(
        Array.from({ length: batches }, (_, i) =>
          host.prepareDynamicGeometryCandidates(inputs.slice(i * 33, (i + 1) * 33)),
        ),
      )
    ).map((result) => result.unwrap());
    expect(peakOccupied).toBe(32);
    await lease.release(true);
    let candidates = groups.flat();
    expect(candidates).toHaveLength(33 * batches);
    expect(lifecycle.inspect()).toMatchObject({ prepared: 33 * batches, accepted: 0 });
    expect(
      inputs.every(
        (input) => world.get(input.entity, MeshFilter).unwrap().assetHandle === previous,
      ),
    ).toBe(true);
    const systemToken2 = defineSystem({
      name: 'admit-declared-mesh-batch',
      queries: [],
      fn() {
        if (candidates[0]?.state === 'accepted') return;
        const ordering = { world, fixedStep: world.getResource(FixedTime).tick };
        expect(host.acceptDynamicGeometryCandidates(candidates.slice(0, 32), ordering).ok).toBe(
          false,
        );
        groups = groups.map((group) =>
          host.acceptDynamicGeometryCandidates(group, ordering).unwrap(),
        );
        candidates = groups.flat();
      },
    });
    world.addSystem(FixedUpdate, systemToken2).unwrap();
    world.update(1 / 60).unwrap();
    expect(
      inputs.every(
        (input) => world.get(input.entity, MeshFilter).unwrap().assetHandle === input.meshHandle,
      ),
    ).toBe(true);
    const sourceFixedStep = world.getResource(FixedTime).tick;
    const publication = publisher.prepare(0).unwrap();
    const packet = structuredClone(publication.message);
    publication.accept();
    const drawn = renderer.draw({ publication: packet });
    if (!drawn.ok) throw drawn.error;
    const receipt = drawn.value;
    const proof = receiver.consumed(receipt, sourceFixedStep);
    expect(proof.bindings).toHaveLength(33 * batches * 2);
    const completed = await receipt.completed;
    if (!completed.ok) throw completed.error;
    publisher.recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
    source.complete(structuredClone(proof));
    host.publishDynamicGeometry(receipt, world, sourceFixedStep);
    expect(
      candidates.every((candidate) => host.dynamicGeometryReceipt(candidate)?.recordStageConsumed),
    ).toBe(true);
    expect(transportFailure).toBeUndefined();
  } finally {
    host.invalidateDynamicGeometryWorld(world);
    await source.dispose();
    await receiver.dispose();
    publisher.dispose();
    await renderer.dispose();
    channel.port1.close();
    channel.port2.close();
  }
});

it('defers private Mesh capture until reserving bytes and returns cancelled credit', async () => {
  const identity = { source: 'app-mesh-transfer-budget', epoch: 1 };
  const mesh = createBoxGeometry(1, 1, 1).unwrap();
  const bytes = assetDataBytes(mesh, undefined, 'receive');
  const constructed = await constructRuntimeRendererHost(
    { width: 64, height: 64, getContext: () => null },
    { rhi, publicationSource: identity, dynamicGeometryMeshBudgetBytes: bytes },
    { shaderManifestUrl },
  );
  if (!constructed.ok) throw constructed.error;
  const { renderer, assets } = constructed.value;
  const world = new World({ assets });
  const firstHandle = assets.create(mesh).unwrap();
  const secondHandle = assets.create(mesh).unwrap();
  const abort = new AbortController();
  const channel = new MessageChannel();
  const messages: string[] = [];
  const source = new SourceMeshResidency(world, () => ({
    ...identity,
    generation: renderer.inspect({ fields: ['frame'] }).frame.deviceGeneration,
    post: (message, transfers) => {
      messages.push(message.kind);
      channel.port1.postMessage(message, transfers === undefined ? [] : [...transfers]);
    },
  }));
  const receiver = new RenderMeshResidency(renderer, identity, (message) =>
    channel.port2.postMessage(message),
  );
  const transferFailures: unknown[] = [];
  channel.port1.onmessage = (event: MessageEvent<MeshResidencyResponse>) => {
    const message = event.data;
    // Delay the first positive ACK until cancellation. Its held quota must
    // prevent a concurrent move, even before any input reaches the Receiver.
    if (message.requestId !== 1 || message.kind !== 'mesh-reserved') source.receive(message);
  };
  channel.port2.onmessage = (event) => {
    void receiver.receive(event.data).catch((cause) => transferFailures.push(cause));
  };
  const capture = vi.fn(() => structuredClone(mesh));
  const deferredMesh = { bytes, capture };
  const secondInput = { world, meshHandle: secondHandle, assetRevision: 1, deferredMesh };
  try {
    const first = source.prepare(
      { world, meshHandle: firstHandle, assetRevision: 1, deferredMesh },
      { signal: abort.signal },
    );
    const inspect = () => renderer.inspect({ fields: ['meshResidency'] }).meshResidency;
    const refused = await source.prepare(secondInput);
    expect(refused).toMatchObject({
      ok: false,
      error: { code: 'dynamic-geometry-budget-exceeded' },
    });
    expect(inspect()).toEqual({
      publication: {
        preparedBytes: 0,
        reservedTransferBytes: bytes,
        peakBudgetBytes: bytes,
        limitBytes: bytes,
      },
      gpuBuffers: { activeBytes: 0, retiringBytes: 0 },
    });
    expect(messages).toEqual(['mesh-reserve', 'mesh-reserve', 'mesh-release']);
    expect(capture).not.toHaveBeenCalled();
    abort.abort();
    expect((await first).ok).toBe(false);
    expect(capture).not.toHaveBeenCalled();
    expect(inspect()?.publication?.reservedTransferBytes).toBe(0);
    const accepted = (await source.prepare(secondInput)).unwrap();
    expect(capture).toHaveBeenCalledTimes(1);
    expect(accepted.isCurrent()).toBe(true);
    expect(inspect()).toMatchObject({
      publication: {
        preparedBytes: bytes,
        reservedTransferBytes: 0,
        peakBudgetBytes: bytes,
        limitBytes: bytes,
      },
      gpuBuffers: {
        activeBytes: mesh.vertices.byteLength + Math.ceil((mesh.indices?.byteLength ?? 0) / 4) * 4,
        retiringBytes: 0,
      },
    });
    expect(capture.mock.results[0]?.value.vertices.byteLength).toBe(0);
    expect(mesh.vertices.byteLength).toBeGreaterThan(0);
    await accepted.release(true);
    expect(transferFailures).toEqual([]);
  } finally {
    abort.abort();
    await source.dispose();
    await receiver.dispose();
    channel.port1.close();
    channel.port2.close();
    await renderer.dispose();
  }
});

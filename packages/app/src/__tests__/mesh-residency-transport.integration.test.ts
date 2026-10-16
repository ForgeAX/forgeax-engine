import { FixedTime, FixedUpdate, World } from '@forgeax/engine-ecs';
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
import { Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { RenderMeshResidency } from '../execution/render-mesh-residency';
import { SourceMeshResidency } from '../execution/source-mesh-residency';

it('carries real Renderer mesh readiness and exact receipts beyond the transient request limit', async () => {
  // Reuse Render's test-only fixture without adding it to App declarations.
  const { renderLifecycleManifestUrl } = await import(
    new URL('../../../render/src/__tests__/shader-manifest-fixture.ts', import.meta.url).href
  );
  const identity = { source: 'app-mesh-transport', epoch: 1 };
  const constructed = await constructRuntimeRendererHost(
    { width: 64, height: 64, getContext: () => null },
    { rhi, publicationSource: identity },
    { shaderManifestUrl: renderLifecycleManifestUrl() },
  );
  if (!constructed.ok) throw constructed.error;
  const { renderer, assets } = constructed.value;
  const world = new World();
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
  const previous = world.allocSharedRef('MeshAsset', createBoxGeometry(1, 1, 1).unwrap());
  const mesh = createBoxGeometry(2, 2, 2).unwrap();
  const meshHandle = world.allocSharedRef('MeshAsset', mesh);
  const material = world.allocSharedRef('MaterialAsset', Materials.unlit([1, 0, 0, 1]));
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
      await host.prepareDynamicGeometry({ world, entity, mesh, meshHandle, revision: 1 })
    ).unwrap();
    expect(world.get(entity, MeshFilter).unwrap().assetHandle).toBe(previous);
    expect(mesh.vertices.byteLength).toBeGreaterThan(0);
    let accepted = false;
    world
      .addSystem(FixedUpdate, {
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
      })
      .unwrap();
    world.update(1 / 60).unwrap();
    expect(world.get(entity, MeshFilter).unwrap().assetHandle).toBe(meshHandle);
    const sourceFixedStep = world.getResource(FixedTime).tick;
    const publication = publisher.prepare(0).unwrap();
    const packet = structuredClone(publication.packet);
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
    host.publishDynamicGeometry(receipt, [world], sourceFixedStep);
    expect(host.dynamicGeometryReceipt(candidate)).toMatchObject({
      frameId: receipt.frameId,
      publicationFixedStep: sourceFixedStep,
      recordStageLane: 'cpu',
    });
    // Published geometry stays resident until its source owner retires it.
    // Those completed transfers must not exhaust the next preparation batch.
    for (let index = 1; index < 33; index++) {
      const nextMesh = createBoxGeometry(1 + index / 100, 1, 1).unwrap();
      const nextHandle = world.allocSharedRef('MeshAsset', nextMesh);
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
          mesh: nextMesh,
          meshHandle: nextHandle,
          revision: 1,
        })
      ).unwrap();
      accepted = false;
      world.update(1 / 60).unwrap();
      const tick = world.getResource(FixedTime).tick;
      const prepared = publisher.prepare(index).unwrap();
      const nextPacket = structuredClone(prepared.packet);
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
      host.publishDynamicGeometry(nextReceipt, [world], tick);
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
  const { renderLifecycleManifestUrl } = await import(
    new URL('../../../render/src/__tests__/shader-manifest-fixture.ts', import.meta.url).href
  );
  const identity = { source: 'app-mesh-batch', epoch: 1 };
  const constructed = await constructRuntimeRendererHost(
    { width: 64, height: 64, getContext: () => null },
    { rhi, publicationSource: identity },
    { shaderManifestUrl: renderLifecycleManifestUrl() },
  );
  if (!constructed.ok) throw constructed.error;
  const { renderer, assets } = constructed.value;
  const world = new World();
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
  const material = world.allocSharedRef('MaterialAsset', Materials.unlit([0, 1, 0, 1]));
  const previousMesh = createBoxGeometry(0.1, 0.1, 0.1).unwrap();
  const previous = world.allocSharedRef('MeshAsset', previousMesh);
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
    const meshHandle = world.allocSharedRef('MeshAsset', mesh);
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
      await source.prepare({ world, meshHandle: previous, mesh: previousMesh })
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
    world
      .addSystem(FixedUpdate, {
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
      })
      .unwrap();
    world.update(1 / 60).unwrap();
    expect(
      inputs.every(
        (input) => world.get(input.entity, MeshFilter).unwrap().assetHandle === input.meshHandle,
      ),
    ).toBe(true);
    const sourceFixedStep = world.getResource(FixedTime).tick;
    const publication = publisher.prepare(0).unwrap();
    const packet = structuredClone(publication.packet);
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
    host.publishDynamicGeometry(receipt, [world], sourceFixedStep);
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

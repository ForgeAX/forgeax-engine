import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { assetDataBytes, runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { meshAssetOutputProducer } from '@forgeax/engine-import';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import { MESH_BIN_HEADER_BYTES } from '@forgeax/engine-pack/mesh-bin-contract';
import {
  ANTIALIAS_NONE,
  BLOOM_DISABLED,
  Camera,
  createRenderPublisher,
  editorAssistance,
  Materials,
  MeshFilter,
  MeshRenderer,
  renderPublicationAssetTransfers,
  renderPublicationTransfers,
} from '@forgeax/engine-render';
import { createRenderer } from '@forgeax/engine-runtime';
import { stagePublicationShaders } from '@forgeax/engine-runtime/internal/shader-publication';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { type AssetHandle, err, ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { createAssetRuntimeAssembly } from '../src/assets-runtime-assembly';
import { RenderMeshResidency } from '../src/execution/render-mesh-residency';
import { SourceMeshResidency } from '../src/execution/source-mesh-residency';
import { assembleRuntimePacks } from '../src/runtime-packs';

function value<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
): T {
  if (!result.ok) throw result.error;
  return result.value;
}

function spawnBoxScene(world: World, assets: AssetRegistry, handle: AssetHandle<'mesh'>) {
  const material = assets.create(Materials.unlit([1, 0, 0, 1])).unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      {
        component: Camera,
        data: {
          fov: Math.PI / 3,
          aspect: 1,
          near: 0.1,
          far: 20,
          antialias: ANTIALIAS_NONE,
          bloom: BLOOM_DISABLED,
          tonemap: 0,
          clearColor: [0, 0, 0, 1],
        },
      },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: handle } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
}

function litPixels(bytes: Uint8Array): number {
  return bytes.filter((byte, index) => index % 4 < 3 && byte > 100).length;
}

function greenPixels(bytes: Uint8Array): number {
  return bytes.filter((byte, index) => index % 4 === 1 && byte > 100).length;
}

async function openReceiver(name: string, world: World, assets: AssetRegistry) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  document.body.append(canvas);
  const identity = { source: name, epoch: 1 };
  const created = await createRenderer(
    canvas,
    { publicationSource: identity, renderBackend: 'webgpu' },
    { shaderManifestUrl: '/shaders/manifest.json' },
  );
  if (!created.ok) {
    canvas.remove();
    throw created.error;
  }
  const renderer = created.value;
  const errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const channel = new MessageChannel();
  const meshTransfers = new Map<string, Uint8Array>();
  const source = new SourceMeshResidency(world, () => ({
    ...identity,
    generation: renderer.inspect({ fields: ['frame'] }).frame.deviceGeneration,
    post: (message, transfers) => {
      if (message.kind === 'mesh-prepare' && message.input.mesh.attributeStorage === 'static-streams') {
        const { mesh, meshHandle, revision } = message.input;
        if (transfers?.some((buffer) => buffer === mesh.vertices.buffer)) {
          meshTransfers.set(
            `${meshHandle}:${revision}`,
            new Uint8Array(mesh.vertices.buffer, mesh.vertices.byteOffset, mesh.vertices.byteLength).slice(),
          );
        }
      }
      channel.port1.postMessage(message, [...(transfers ?? [])]);
    },
  }));
  const receiver = new RenderMeshResidency(renderer, identity, (message) =>
    channel.port2.postMessage(message),
  );
  channel.port1.onmessage = (event) => source.receive(event.data);
  channel.port2.onmessage = (event) => {
    void receiver.receive(event.data).catch((cause: unknown) => {
      errors.push(cause);
      source.clear(cause);
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
  const unbind = runtimeAssets(assets).bindMeshPresenter(async (handle, revision, deferredMesh, signal) => {
    const prepared = await source.prepare(
      { world, meshHandle: handle, assetRevision: revision, deferredMesh },
      {
        ...(signal === undefined ? {} : { signal }),
        recoverable: true,
      },
    );
    if (!prepared.ok) {
      errors.push(prepared.error);
      return err('render-preparation-failed');
    }
    const lease = prepared.value;
    return ok({
      isCurrent: lease.isCurrent,
      release: () => {
        void lease.release(true)?.catch((cause: unknown) => errors.push(cause));
      },
    });
  }, { confirmsTransfer: true });
  let frame = 0;
  const preparedReferences = new Set<string>();
  const fixedPreparedReferences = new Set<string>();
  const draw = async () => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    const publication = publisher.prepare(++frame / 60).unwrap();
    for (const row of publication.packet.preparedAssets ?? [])
      preparedReferences.add(`${row.handle}:${row.revision}`);
    for (const row of publication.packet.assetVersions ?? []) {
      if (row.preparedRevision !== undefined)
        fixedPreparedReferences.add(`${row.handle}:${row.preparedRevision}`);
    }
    const packet = structuredClone(publication.message, {
      transfer: [
        ...renderPublicationTransfers(publication.message),
        ...renderPublicationAssetTransfers(publication.message),
      ],
    });
    publication.accept();
    const receipt = value(renderer.draw({ publication: packet }));
    value(await receipt.completed);
    const transfers = renderPublicationTransfers(packet);
    publisher
      .recycle(packet.revision, structuredClone(transfers, { transfer: transfers }))
      .unwrap();
    return receipt;
  };
  return {
    prepareMesh: source.prepare,
    meshTransfers,
    holdsPrepared: (handle: number, revision: number) => source.holdsPrepared(handle, revision),
    referencedPreparedMesh: (handle: number, revision: number) =>
      preparedReferences.has(`${handle}:${revision}`),
    referencedFixedPreparedMesh: (handle: number, revision: number) =>
      fixedPreparedReferences.has(`${handle}:${revision}`),
    async captureReady() {
      if (!renderer.requestObservation) throw new Error('Final-display observation unavailable');
      let completedFrames = 0;
      for (let attempt = 0; attempt < 240; attempt++) {
        if (completedFrames === 59) value(renderer.requestObservation(['final-display']));
        const receipt = await draw();
        if (receipt.presentation !== 'ready') {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          continue;
        }
        if (++completedFrames < 60) continue;
        const observation = value(
          await renderer.observe(receipt, { include: ['final-display'] }),
        ).observations?.find((image) => image.domain === 'final-display');
        if (observation?.domain !== 'final-display') throw new Error('Final-display data missing');
        expect(errors).toEqual([]);
        return observation.bytes.slice();
      }
      throw new Error(
        `Renderer ${name} did not complete 60 presentable frames: ${JSON.stringify(errors)}`,
      );
    },
    async dispose() {
      unbind();
      unsubscribe();
      publisher.dispose();
      try {
        await source.dispose();
      } finally {
        try {
          await receiver.dispose();
          value(await renderer.dispose());
        } finally {
          channel.port1.close();
          channel.port2.close();
          canvas.remove();
        }
      }
    },
  };
}

it('draws the same pinned Runtime Pack Mesh in two WebGPU Renderers after its source is replaced', {
  timeout: 120_000,
}, async () => {
  const assets = new AssetRegistry({ shaderRegistry: await stagePublicationShaders().ready });
  const world = new World({ assets });
  const context = await createWorldContext(world, []);
  const assembly = createAssetRuntimeAssembly(assets, {
    catalogSource: createCatalogSource({ entries: [] }),
  }).unwrap();
  const runtime = assembleRuntimePacks(context, assembly, { scopeId: 'two-renderers' });
  assets.setCatalogSource(runtime.catalog, runtime.fetcher);
  const packageId = '01900000-0000-7000-8000-000000000901';
  const initialMesh = createBoxGeometry(2, 1, 1).unwrap();
  const content = async (mesh: typeof initialMesh) => {
    const guid = AssetGuid.format(AssetGuid.derive(definePackageId(packageId), 'mesh'));
    const product = (await meshAssetOutputProducer.produce({ guid, sourceKey: 'mesh', asset: mesh })).unwrap();
    const body = product.artifacts.body;
    if (body === undefined) throw new Error('Cook did not produce a mesh body');
    expect(body.assetCodec).toEqual({ name: 'mesh-binary', version: '7' });
    const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(body.bytes));
    const digest = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
    return {
      source: {
        schemaVersion: '3.0.0' as const,
        packageId,
        assets: { mesh: {
          kind: 'mesh',
          payload: { kind: 'mesh' },
            refs: product.refs.map(({ guid }) => guid),
          artifacts: { body: {
            path: 'mesh.bin',
            mediaType: body.mediaType,
            byteLength: body.bytes.byteLength,
            contentEncoding: 'identity',
            integrity: { algorithm: 'sha256', digest: `sha256:${digest}` },
            assetCodec: body.assetCodec,
          } },
        } },
      },
      blobs: { 'mesh.bin': body.bytes },
    };
  };
  let primary: Awaited<ReturnType<typeof openReceiver>> | undefined;
  let secondary: Awaited<ReturnType<typeof openReceiver>> | undefined;
  try {
    const initial = await content(initialMesh);
    const receipt = (await runtime.producer.admit(initial)).unwrap();
    const row = receipt.rows[0];
    const published = receipt.publication;
    if (row === undefined || published === undefined) throw new Error('Missing mesh publication');
    primary = await openReceiver('primary', world, assets);
    const handle = (await assets.load(row.guid, 'mesh', { usage: 'render' })).unwrap();
    const revision = assets.revision(handle).unwrap();
    expect(assets.meshCpuResidency(handle).unwrap()).toMatchObject({ mode: 'render', revision });
    const cookedVertices = initial.blobs['mesh.bin'].subarray(
      MESH_BIN_HEADER_BYTES,
      MESH_BIN_HEADER_BYTES + initialMesh.vertices.byteLength,
    );
    expect(primary.meshTransfers.get(`${handle}:${revision}`)).toEqual(cookedVertices);
    expect(assets.read(handle)).toMatchObject({
      ok: false,
      error: { code: 'asset-cpu-data-unavailable' },
    });
    spawnBoxScene(world, assets, handle);
    const before = await primary.captureReady();
    expect(litPixels(before)).toBeGreaterThan(100);

    const replacement = (
      await runtime.producer.replace(await content(createBoxGeometry(4, 1, 1).unwrap()), published)
    ).unwrap();
    expect(replacement.rows[0]?.guid).toBe(row.guid);
    expect(replacement.publication?.generation).not.toBe(receipt.publication?.generation);
    expect((await assets.readMeshGeometry(row.guid)).unwrap().vertices).not.toEqual(
      initialMesh.vertices,
    );
    assets.clearCatalogSource();

    await primary.dispose();
    primary = undefined;
    primary = await openReceiver('restarted', world, assets);
    await assets.recoverMeshPresentations();
    expect(assets.meshCpuResidency(handle).unwrap()).toMatchObject({ mode: 'render', revision });
    expect(primary.meshTransfers.get(`${handle}:${revision}`)).toEqual(cookedVertices);

    secondary = await openReceiver('secondary', world, assets);
    await assets.recoverMeshPresentations();
    expect(assets.meshCpuResidency(handle).unwrap()).toMatchObject({
      mode: 'cpu',
      revision,
      cpuRetentionReason: 'multiple-render-receivers',
    });
    expect(assets.read(handle).unwrap().vertices).toEqual(initialMesh.vertices);
    expect(await secondary.captureReady()).toEqual(before);
    expect(await primary.captureReady()).toEqual(before);
  } finally {
    try {
      await Promise.all([secondary?.dispose(), primary?.dispose()]);
    } finally {
      assets.clearCatalogSource();
      await context.fiber.dispose();
      assembly.dispose();
      assets.dispose();
    }
  }
});

it('keeps the WebGPU picture while cancelling a prepared replacement of the same Mesh handle', {
  timeout: 120_000,
}, async () => {
  const assets = new AssetRegistry({ shaderRegistry: await stagePublicationShaders().ready });
  const world = new World({ assets });
  const narrow = createBoxGeometry(2, 1, 1).unwrap();
  const wide = createBoxGeometry(4, 1, 1).unwrap();
  const meshHandle = assets.create(narrow).unwrap();
  spawnBoxScene(world, assets, meshHandle);
  const overlay = editorAssistance(world);
  const overlayOwner = {};
  overlay.configure({ enabled: true, depth: 'always' }).unwrap();
  overlay
    .contribute(overlayOwner, [
      {
        kind: 'mesh',
        mesh: meshHandle,
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.2, 0, 1],
        color: [0, 1, 0, 1],
        depth: 'always',
      },
    ])
    .unwrap();
  const firstRevision = assets.revision(meshHandle).unwrap();
  const nextRevision = runtimeAssets(assets).currentRevision + 1;
  const renderer = await openReceiver('same-handle', world, assets);
  const prepare = (mesh: typeof narrow, assetRevision: number) =>
    renderer.prepareMesh({
      world,
      meshHandle,
      assetRevision,
      deferredMesh: {
        bytes: assetDataBytes(mesh, undefined, 'receive'),
        capture: () => structuredClone(mesh),
      },
    });

  try {
    const first = (await prepare(narrow, firstRevision)).unwrap();
    const before = await renderer.captureReady();
    expect(litPixels(before)).toBeGreaterThan(100);
    expect(greenPixels(before)).toBeGreaterThan(10);
    expect(renderer.referencedFixedPreparedMesh(meshHandle, firstRevision)).toBe(true);

    const cancelled = (await prepare(wide, nextRevision)).unwrap();
    expect(renderer.holdsPrepared(meshHandle, firstRevision)).toBe(true);
    expect(renderer.holdsPrepared(meshHandle, nextRevision)).toBe(true);
    expect(await renderer.captureReady()).toEqual(before);
    await cancelled.release(true);
    expect(await renderer.captureReady()).toEqual(before);

    const ready = (await prepare(wide, nextRevision)).unwrap();
    assets.replace(meshHandle, wide).unwrap();
    expect(assets.revision(meshHandle).unwrap()).toBe(nextRevision);
    const after = await renderer.captureReady();
    expect(renderer.holdsPrepared(meshHandle, firstRevision)).toBe(false);
    expect(renderer.referencedPreparedMesh(meshHandle, nextRevision)).toBe(true);
    expect(greenPixels(after)).toBe(greenPixels(before));
    expect(litPixels(after) - greenPixels(after)).toBeGreaterThan(
      1.6 * (litPixels(before) - greenPixels(before)),
    );
    await first.release(true);
    await ready.release(true);
  } finally {
    try {
      await renderer.dispose();
    } finally {
      overlay.release(overlayOwner);
      assets.dispose();
    }
  }
});

import { AssetRegistry, type MaterialRenderProjection } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { Transform } from '@forgeax/engine-scene';
import { createMaterialProgramArtifactReceipt, ShaderRegistry } from '@forgeax/engine-shader';
import { type MeshAsset, ok } from '@forgeax/engine-types';
import { WATER_SYSTEM_RESOURCE, WaterSystem } from '@forgeax/engine-water';
import { expect, it } from 'vitest';
import { publishRuntimeAssets } from '../../../../assets-runtime/src/__tests__/fixtures/runtime-publication';
import { runSingleViewFeatureFrame } from '../../__tests__/single-view-feature-fixture';
import { MeshFilter, MeshRenderer } from '../../components';
import { createFullscreenRenderFeature } from '../../features/fullscreen';
import { createRenderFeatureHost } from '../../features/host';
import type { RenderFeature } from '../../features/types';
import {
  captureMaterialSource,
  materialSourceReferences,
  materialSourceScope,
} from '../../material-source';
import { Materials } from '../../materials';
import { createRenderPublisher } from '../publisher';
import { RenderPublicationReceiver } from '../receiver';
import {
  encodeRenderPublication,
  renderPublicationAssetTransfers,
  renderPublicationTransfers,
} from '../record';
import { worldRenderResources } from '../resource-scope';

const BUILTIN_CUBE = createPrimitiveMesh('cube').unwrap();

it('resends retained exact material bytes and its old program to a new receiver epoch', () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const key = 'game::retained-material-epoch';
  const shader = '@vertex fn vs_main() -> @builtin(position) vec4f { return vec4f(0); }';
  assets.shaderRegistry.installMaterialArtifact(key, {
    source: shader,
    paramSchema: [],
    receipt: createMaterialProgramArtifactReceipt({
      schema: [],
      directEntry: 'vs_main',
      vertexInputs: [],
    }),
  });
  const handle = assets.create(Materials.unlit([0.2, 0.4, 0.8, 1])).unwrap();
  const value = runtimeAssets(assets).resolveAsset(handle).unwrap();
  const projection: MaterialRenderProjection = {
    materialGuid: '00000000-0000-7000-8000-00000000000f',
    publicationGeneration: 1,
    specializationKey: 'publication/retained-epoch',
    artifactHash: 'retained-epoch',
    runtimeValues: { baseColor: [0.2, 0.4, 0.8, 1] },
    staticSelection: [],
    passes: [
      {
        name: 'forward',
        module: key,
        programs: [
          {
            specializationKey: key,
            artifactHash: 'retained-epoch',
            context: {
              backend: 'webgpu',
              capability: 'storage-buffer',
              pipeline: 'forward',
              geometry: 'mesh',
              pass: 'forward',
              profile: 'forgeax-material-wgsl-v1',
              toolchain: 'naga-oil',
              instrumentation: 'none',
            },
          },
        ],
      },
    ],
  };
  assets.materialPayloadProjections.set(value, projection);
  const source = captureMaterialSource(worldRenderResources(world), handle);
  if (source === undefined) throw new Error('retained epoch fixture requires a source');
  const references = materialSourceReferences(source);
  const feature: RenderFeature<typeof references> = {
    identity: 'retained-material-epoch',
    extract: (context) => {
      for (const asset of source.assets) {
        if (asset.value === undefined) throw new Error('retained source payload is missing');
        context.referenceAssetVersion?.({
          handle: asset.handle,
          revision: asset.revision,
          value: asset.value,
        });
      }
      return ok(references);
    },
    plan: () => ok({ work: [{ scope: 'frame', resources: [], passes: [] }] }),
  };
  try {
    for (const epoch of [1, 2]) {
      const identity = { source: 'retained-material-epoch', epoch };
      const publisher = createRenderPublisher(world, assets, identity, undefined, [feature]);
      const receiver = new RenderPublicationReceiver(identity);
      const receivedAssets = new AssetRegistry({
        shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
      });
      try {
        const candidate = publisher.prepare(0).unwrap();
        expect(candidate.packet.assets).toEqual([]);
        expect(candidate.packet.assetVersions).toMatchObject([
          {
            handle,
            revision: source.revision,
            value: { values: { baseColor: [0.2, 0.4, 0.8, 1] } },
          },
        ]);
        expect(candidate.packet.programs.map((program) => program.key)).toEqual([key]);
        const message = structuredClone(candidate.message, {
          transfer: renderPublicationTransfers(candidate.message),
        });
        candidate.accept();
        const accepted = receiver.accept(message, receivedAssets).unwrap();
        expect(accepted.resources.resolveAsset(handle).ok).toBe(false);
        expect(
          materialSourceScope(accepted.resources, references).resolveAsset(handle).unwrap(),
        ).toMatchObject({ values: { baseColor: [0.2, 0.4, 0.8, 1] } });
        expect(receivedAssets.shaderRegistry.findMaterialArtifact(key).unwrap().source).toBe(
          shader,
        );
        publisher.recycle(message.revision, renderPublicationTransfers(message)).unwrap();
        const quiet = publisher.prepare(1).unwrap();
        expect(quiet.packet.assetVersions).toEqual([]);
        expect(quiet.packet.programs).toEqual([]);
        receiver.accept(quiet.message, receivedAssets).unwrap();
        quiet.discard();
      } finally {
        publisher.dispose();
        receiver.dispose();
        receivedAssets.dispose();
      }
      if (epoch === 1) assets.replace(handle, Materials.unlit([0.9, 0.1, 0.3, 1])).unwrap();
    }
  } finally {
    assets.dispose();
  }
});

it('admits feature references only for the current owner borrow and canonical handle', () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const handle = assets.create(BUILTIN_CUBE).unwrap();
  const mesh = runtimeAssets(world.assets).resolveAsset<MeshAsset>(handle).unwrap();
  const foreignAssets = new AssetRegistry();
  const foreignHandle = foreignAssets.create(BUILTIN_CUBE).unwrap();
  let captured = mesh;
  const feature: RenderFeature<{ handle: number | undefined }> = {
    identity: 'captured-mesh',
    extract: (context) => {
      const reference = context.referenceAsset;
      if (reference === undefined) throw new Error('Expected publication admission');
      expect(reference(foreignHandle, captured)).toBeUndefined();
      expect(reference('missing-mesh', captured)).toBeUndefined();
      expect(reference(handle, { ...captured })).toBeUndefined();
      return ok({ handle: reference(handle, captured) });
    },
    assetDependencies: (data) => (data.handle === undefined ? [] : [data.handle]),
    plan: () => ok({ work: [{ scope: 'frame', resources: [], passes: [] }] }),
  };
  const publisher = createRenderPublisher(
    world,
    assets,
    { source: 'admission', epoch: 1 },
    undefined,
    [feature],
  );
  const prepare = () => {
    const candidate = publisher.prepare(0).unwrap();
    const data = candidate.packet.features.find((row) => row.identity === feature.identity)?.data;
    candidate.discard();
    return data;
  };
  try {
    expect(prepare()).toEqual({ handle });
    assets.replace(handle, { ...BUILTIN_CUBE, materialSlots: [{ slotName: 'changed' }] }).unwrap();
    captured = runtimeAssets(world.assets).resolveAsset<MeshAsset>(handle).unwrap();
    expect(captured.materialSlots).toEqual([{ slotName: 'changed' }]);
    expect(prepare()).toEqual({ handle });
    assets.replace(handle, BUILTIN_CUBE).unwrap();
    captured = runtimeAssets(world.assets).resolveAsset<MeshAsset>(handle).unwrap();
    expect(prepare()).toEqual({ handle });
  } finally {
    publisher.dispose();
    foreignAssets.dispose();
  }
});

it('acknowledges only submitted source data, rejecting stale and duplicate receipts atomically', () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const consumed: unknown[] = [];
  let value = 1;
  const feature: RenderFeature<unknown> = {
    identity: 'source-events',
    extract: () => ok({ value }),
    plan: () => ok({ work: [{ scope: 'frame', resources: [], passes: [] }] }),
    onSourceFrameSubmitted: (data, feedback) => consumed.push({ data, feedback }),
  };
  const publisher = createRenderPublisher(world, assets, { source: 'ack', epoch: 1 }, undefined, [
    feature,
  ]);
  const candidate = publisher.prepare(0).unwrap();
  const packet = structuredClone(candidate.packet, {
    transfer: renderPublicationTransfers(candidate.message),
  });
  candidate.accept();
  value = 2;
  expect(consumed).toEqual([]);
  expect(publisher.acknowledgeFeatures(0, [{ identity: feature.identity, feedback: 1 }]).ok).toBe(
    false,
  );
  expect(
    publisher.acknowledgeFeatures(1, [
      { identity: feature.identity, feedback: 1 },
      { identity: 'unknown', feedback: 1 },
    ]).ok,
  ).toBe(false);
  expect(consumed).toEqual([]);
  publisher.acknowledgeFeatures(1, [{ identity: feature.identity, feedback: 1 }]).unwrap();
  expect(consumed).toEqual([{ data: { value: 1 }, feedback: 1 }]);
  expect(publisher.acknowledgeFeatures(1, [{ identity: feature.identity, feedback: 1 }]).ok).toBe(
    false,
  );
  publisher.recycle(1, renderPublicationTransfers(encodeRenderPublication(packet))).unwrap();
  const next = publisher.prepare(1).unwrap();
  next.discard();
  expect(consumed).toHaveLength(1);
  publisher.dispose();
});

it('completes only submitted feature flights in order with their original data and actual receipt facts', () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  let value = 1;
  const completed: unknown[] = [];
  const feature: RenderFeature<unknown> = {
    identity: 'completed-source',
    extract: () => ok({ value }),
    plan: () => ok({ work: [] }),
    onSourceFrameCompleted: (data, completion, feedback, submission) =>
      completed.push({ data, completion, feedback, submission }),
  };
  const publisher = createRenderPublisher(
    world,
    assets,
    { source: 'complete', epoch: 1 },
    undefined,
    [feature],
  );
  const first = publisher.prepare(0).unwrap();
  const firstPacket = structuredClone(first.packet, {
    transfer: renderPublicationTransfers(first.message),
  });
  first.accept();
  value = 2;
  const second = publisher.prepare(1).unwrap();
  const secondPacket = structuredClone(second.packet, {
    transfer: renderPublicationTransfers(second.message),
  });
  second.accept();
  const completion = { frameId: 101, deviceGeneration: 7, graphGeneration: 19 };
  expect(publisher.completeFeatures(1, completion).ok).toBe(false);
  const receipts = [
    { identity: feature.identity, feedback: { accepted: true }, submission: { works: [] } },
  ];
  publisher.acknowledgeFeatures(1, receipts).unwrap();
  publisher.acknowledgeFeatures(2, receipts).unwrap();
  expect(publisher.completeFeatures(2, completion).ok).toBe(false);
  for (const key of ['frameId', 'deviceGeneration', 'graphGeneration'] as const)
    expect(publisher.completeFeatures(1, { ...completion, [key]: Number.NaN }).ok).toBe(false);
  expect(completed).toEqual([]);
  publisher.completeFeatures(1, completion).unwrap();
  expect(completed).toEqual([
    { data: { value: 1 }, completion, feedback: { accepted: true }, submission: { works: [] } },
  ]);
  expect(publisher.completeFeatures(1, completion).ok).toBe(false);
  expect(publisher.acknowledgeFeatures(1, receipts).ok).toBe(false);
  publisher.recycle(1, renderPublicationTransfers(encodeRenderPublication(firstPacket))).unwrap();
  publisher.completeFeatures(2, { ...completion, frameId: 102 }).unwrap();
  expect(completed).toHaveLength(2);
  expect(completed[1]).toMatchObject({ data: { value: 2 }, completion: { frameId: 102 } });
  publisher.recycle(2, renderPublicationTransfers(encodeRenderPublication(secondPacket))).unwrap();
  publisher.dispose();
  expect(publisher.completeFeatures(2, completion).ok).toBe(false);
});

it('publishes feature-only GUID resources and retires them when the producer drops the root', async () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const guid = '12345678-1234-1234-1234-123456789abc';
  const mesh = BUILTIN_CUBE;
  publishRuntimeAssets(assets, [{ guid, asset: mesh }]);
  const loaded = (await assets.load(guid, 'mesh')).unwrap();
  let roots = [guid];
  const feature: RenderFeature<unknown> = {
    identity: 'guid-consumer',
    extract: () => ok({}),
    assetDependencies: () => roots,
    plan: () => ok({ work: [{ scope: 'frame', resources: [], passes: [] }] }),
  };
  const identity = { source: 'feature-assets', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity, undefined, [feature]);
  const receiver = new RenderPublicationReceiver(identity);
  const first = publisher.prepare(0).unwrap();
  const packet = structuredClone(first.packet);
  first.accept();
  const accepted = receiver.accept(encodeRenderPublication(packet)).unwrap();
  expect(accepted.resources.lookupAsset(guid)).toEqual(
    runtimeAssets(assets).resolveAsset(loaded).unwrap(),
  );
  expect(packet.assets.filter((row) => row.guid === guid)).toHaveLength(1);
  publisher.recycle(1, renderPublicationTransfers(encodeRenderPublication(packet))).unwrap();
  roots = [];
  const next = publisher.prepare(1).unwrap();
  expect(next.packet.retiredAssets).toContain(accepted.resources.handleForGuid(guid));
  receiver.accept(next.message).unwrap();
  expect(accepted.resources.lookupAsset(guid)).toBeUndefined();
  next.discard();
  publisher.dispose();
});

it('publishes LOD GUID dependencies and rejects a missing lower-detail asset before acceptance', async () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const guid = '12345678-1234-1234-1234-123456789abc';
  const mesh = BUILTIN_CUBE;
  publishRuntimeAssets(assets, [{ guid, asset: mesh }]);
  (await assets.load(guid, 'mesh')).unwrap();
  const parsed = AssetGuid.parse(guid);
  if (!parsed.ok) throw parsed.error;
  const assetHandle = assets
    .create({
      ...mesh,
      lods: [{ mesh: parsed.value, screenCoverage: 0.5 }],
    })
    .unwrap();
  world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle } },
      { component: MeshRenderer, data: {} },
    )
    .unwrap();
  const identity = { source: 'lod-assets', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity);
  const receiver = new RenderPublicationReceiver(identity);
  const candidate = publisher.prepare(0).unwrap();
  expect(candidate.packet.assets.some((row) => row.guid === guid)).toBe(true);
  const missing = {
    ...candidate.packet,
    assets: candidate.packet.assets.filter((row) => row.guid !== guid),
  };
  expect(receiver.accept(encodeRenderPublication(missing)).ok).toBe(false);
  expect(receiver.acceptedRevision).toBe(0);
  expect(receiver.accept(encodeRenderPublication(structuredClone(candidate.packet))).ok).toBe(true);
  candidate.discard();
  publisher.dispose();
});

it('keeps two sealed publications and their feedback independent of later source mutation', async () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  let value = 1;
  const consumed: unknown[] = [];
  const feature: RenderFeature<unknown> = {
    identity: 'sealed-events',
    extract: () => ok({ value }),
    plan: () => ok({ work: [{ scope: 'frame', resources: [], passes: [] }] }),
    onSourceFrameSubmitted: (data) => consumed.push(data),
  };
  const publisher = createRenderPublisher(
    world,
    assets,
    { source: 'sealed', epoch: 1 },
    undefined,
    [feature],
  );
  const seal = () => {
    const candidate = publisher.prepare(value).unwrap();
    const packet = structuredClone(candidate.packet, {
      transfer: renderPublicationTransfers(candidate.message),
    });
    candidate.accept();
    return packet;
  };
  try {
    const first = seal();
    value = 2;
    const second = seal();
    await Promise.resolve();
    value = 99;
    expect(second.features.find((row) => row.identity === feature.identity)?.data).toEqual({
      value: 2,
    });
    expect(publisher.prepare(3).ok).toBe(false);
    expect(
      publisher.recycle(2, renderPublicationTransfers(encodeRenderPublication(second))).ok,
    ).toBe(false);
    publisher.acknowledgeFeatures(1, [{ identity: feature.identity, feedback: null }]).unwrap();
    publisher.recycle(1, renderPublicationTransfers(encodeRenderPublication(first))).unwrap();
    expect(
      publisher.acknowledgeFeatures(1, [{ identity: feature.identity, feedback: null }]).ok,
    ).toBe(false);
    publisher.acknowledgeFeatures(2, [{ identity: feature.identity, feedback: null }]).unwrap();
    expect(consumed).toEqual([{ value: 1 }, { value: 2 }]);
    publisher.recycle(2, renderPublicationTransfers(encodeRenderPublication(second))).unwrap();
    const third = seal();
    expect(third.base).toBe(2);
    expect(third.features.find((row) => row.identity === feature.identity)?.data).toEqual({
      value: 99,
    });
  } finally {
    publisher.dispose();
  }
});

it('publishes a late fullscreen declaration once and retains only per-frame enable data', () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  world.insertResource(WATER_SYSTEM_RESOURCE, new WaterSystem(() => undefined));
  let enabled = false;
  const features: RenderFeature<unknown>[] = [];
  const feature = createFullscreenRenderFeature({
    identity: 'game::late-fullscreen',
    source: 'fn fs_main() {}',
    enabled: () => enabled,
  });
  const publisher = createRenderPublisher(
    world,
    assets,
    { source: 'fullscreen', epoch: 1 },
    undefined,
    features,
  );
  const seal = () => {
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet, {
      transfer: renderPublicationTransfers(candidate.message),
    });
    candidate.accept();
    publisher
      .recycle(packet.revision, renderPublicationTransfers(encodeRenderPublication(packet)))
      .unwrap();
    return packet;
  };
  try {
    const builtins = seal().features;
    expect(builtins.map((row) => row.identity)).toEqual([
      'water-info-producer',
      'water-gpu-mesh',
      'water-advanced-producer',
      'water-fluid-simulation',
      'water-underwater-post-process',
    ]);
    features.push(feature);
    const discarded = publisher.prepare(0).unwrap();
    expect(
      discarded.packet.features.find((row) => row.identity === feature.identity),
    ).toHaveProperty('fullscreen');
    discarded.discard();
    const first = seal().features.find((row) => row.identity === feature.identity);
    expect(first).toMatchObject({
      identity: feature.identity,
      data: false,
      fullscreen: { identity: feature.identity },
    });
    enabled = true;
    expect(seal().features.filter((row) => row.identity === feature.identity)).toEqual([
      { identity: feature.identity, data: true },
    ]);
    features.pop();
    expect(seal().features.map((row) => row.identity)).toEqual(builtins.map((row) => row.identity));
    features.push(feature);
    expect(seal().features.filter((row) => row.identity === feature.identity)).toEqual([
      { identity: feature.identity, data: true },
    ]);
  } finally {
    publisher.dispose();
  }
});

it('transports source hidden reports without World routing and rejects malformed handles before admission', () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const identity = { source: 'hidden-reports', epoch: 1 };
  const feature: RenderFeature<undefined> = {
    identity: 'hidden-reports',
    inactiveSourceData: undefined,
    extract(context) {
      context.reportHiddenEntity?.({ entity: 7 as never });
      context.reportHiddenEntity?.({ entity: 7 as never });
      context.reportHiddenEntity?.({ entity: 1048583 as never });
      return ok(undefined);
    },
    plan: () => ok({ work: [] }),
  };
  const publisher = createRenderPublisher(world, assets, identity, undefined, [feature]);
  const receiver = new RenderPublicationReceiver(identity);
  try {
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet);
    candidate.accept();
    const row = packet.features.find((row) => row.identity === feature.identity);
    expect(row?.hiddenEntities).toEqual([{ entity: 7 }, { entity: 1048583 }]);
    const malformed = structuredClone(packet);
    const invalid = malformed.features.find((row) => row.identity === feature.identity);
    if (!invalid) throw new Error('Expected the published feature');
    Object.assign(invalid, { hiddenEntities: [{ entity: -1 }] });
    expect(receiver.accept(encodeRenderPublication(malformed)).ok).toBe(false);
    expect(receiver.acceptedRevision).toBe(0);
    const accepted = receiver.accept(encodeRenderPublication(packet)).unwrap();
    expect(
      accepted.packet.features.find((row) => row.identity === feature.identity)?.hiddenEntities,
    ).toEqual(row?.hiddenEntities);
  } finally {
    publisher.dispose();
    assets.dispose();
  }
});

it.each([
  false,
  true,
])('delivers an optional source failure (non-cloneable cause=%s) and recovers without re-extraction', (nonCloneable) => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const identity = { source: 'optional-feature-failure', epoch: 1 };
  let failed = true,
    extracts = 0,
    plans = 0,
    submitted = 0,
    discarded = 0;
  const feature: RenderFeature<string> = {
    identity: 'optional-feature-failure',
    extract() {
      extracts++;
      if (failed) {
        const cause: Record<string, unknown> = { code: 'source-refused', retry: () => {} };
        cause.self = cause;
        throw nonCloneable ? new Error('source refused', { cause }) : new Error('source refused');
      }
      return ok('recovered');
    },
    plan() {
      plans++;
      return ok({ work: [] });
    },
    onSourceFrameSubmitted() {
      submitted++;
    },
    onSourceFrameDiscarded() {
      discarded++;
    },
  };
  const publisher = createRenderPublisher(world, assets, identity, undefined, [feature]);
  const receiver = new RenderPublicationReceiver(identity);
  const host = createRenderFeatureHost([feature]).unwrap();
  try {
    const first = publisher.prepare(0).unwrap();
    const packet = structuredClone(first.packet);
    first.accept();
    const malformed = structuredClone(packet);
    const rejectedRow = malformed.features.find((row) => row.identity === feature.identity);
    if (!rejectedRow?.failure) throw new Error('The failed source result is required');
    Object.assign(rejectedRow.failure, { detail: undefined });
    expect(receiver.accept(encodeRenderPublication(malformed)).ok).toBe(false);
    expect(receiver.acceptedRevision).toBe(0);
    const accepted = receiver.accept(encodeRenderPublication(packet)).unwrap();
    const frame = runSingleViewFeatureFrame(host, {
      world: undefined,
      publishedFeatures: accepted.packet.features,
      frameNumber: 1,
      caps: {} as never,
    });
    expect(frame.errors.map((error) => error.code)).toEqual(['render-feature-stage-failed']);
    if (nonCloneable) {
      const failure = frame.errors[0];
      if (failure?.code !== 'render-feature-stage-failed')
        throw new Error('Missing extract diagnostic');
      expect(failure.detail.cause).toMatchObject({
        message: 'source refused',
        cause: { code: 'source-refused', retry: '[Function]', self: '[Circular]' },
      });
    }
    expect(extracts).toBe(1);
    expect(plans).toBe(0);
    expect(
      publisher.acknowledgeFeatures(first.packet.revision, [
        { identity: feature.identity, feedback: undefined },
      ]).ok,
    ).toBe(false);
    expect(publisher.acknowledgeFeatures(first.packet.revision, []).ok).toBe(true);
    expect(submitted).toBe(0);
    failed = false;
    const next = publisher.prepare(1).unwrap();
    const nextPacket = structuredClone(next.packet);
    next.accept();
    const recovered = receiver.accept(encodeRenderPublication(nextPacket)).unwrap();
    const nextFrame = runSingleViewFeatureFrame(host, {
      world: undefined,
      publishedFeatures: recovered.packet.features,
      frameNumber: 2,
      caps: {} as never,
    });
    expect(nextFrame.errors).toEqual([]);
    expect(extracts).toBe(2);
    expect(plans).toBe(1);
    expect(
      publisher.acknowledgeFeatures(next.packet.revision, [
        { identity: feature.identity, feedback: undefined },
      ]).ok,
    ).toBe(true);
    expect(submitted).toBe(1);
    expect(discarded).toBe(0);
  } finally {
    host.dispose();
    publisher.dispose();
    assets.dispose();
  }
});

it('preserves fixed mesh numeric views independently of the current version and source buffers', () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const geometry = structuredClone(BUILTIN_CUBE);
  const position = geometry.attributes.position;
  if (!(position instanceof Float32Array)) throw new Error('The fixture requires float positions');
  const backing = new Float32Array(position.length + 6);
  backing.set(position, 3);
  const handle = assets
    .create({
      ...geometry,
      attributes: { ...geometry.attributes, position: backing.subarray(3, 3 + position.length) },
    })
    .unwrap();
  const fixed = runtimeAssets(assets).pin<MeshAsset>(handle).unwrap();
  const fixedPosition = fixed.value.attributes.position;
  if (!(fixedPosition instanceof Float32Array)) throw new Error('The fixed positions are required');
  const expected = Array.from(fixedPosition);
  const expectedVertex = fixed.value.vertices[0];
  assets
    .replace(handle, {
      ...structuredClone(geometry),
      aabb: new Float32Array([-2, -2, -2, 2, 2, 2]),
    })
    .unwrap();
  const identity = { source: 'fixed-mesh-views', epoch: 1 };
  const feature: RenderFeature<unknown> = {
    identity: 'fixed-mesh-views',
    extract(context) {
      context.referenceAssetVersion?.(fixed);
      return ok(undefined);
    },
    assetDependencies: () => [handle],
    plan: () => ok({ work: [] }),
  };
  const publisher = createRenderPublisher(world, assets, identity, undefined, [feature]);
  const receiver = new RenderPublicationReceiver(identity);
  try {
    const candidate = publisher.prepare(0).unwrap();
    const outgoing = candidate.message.side?.assetVersions?.[0]?.value;
    if (outgoing?.kind !== 'mesh') throw new Error('The fixed mesh must be published');
    const fixedBuffer = outgoing.vertices.buffer as ArrayBuffer;
    const assetBuffers = renderPublicationAssetTransfers(candidate.message);
    expect(assetBuffers).toContain(fixedBuffer);
    expect(fixedBuffer).not.toBe(fixed.value.vertices.buffer);
    const message = structuredClone(candidate.message, {
      transfer: [...renderPublicationTransfers(candidate.message), ...assetBuffers],
    });
    expect(fixedBuffer.byteLength).toBe(0);
    expect(fixed.value.vertices.byteLength).toBeGreaterThan(0);
    const received = message.side?.assetVersions?.[0]?.value;
    if (received?.kind !== 'mesh') throw new Error('The receiver must get the fixed mesh');
    candidate.accept();
    const accepted = receiver.accept(message).unwrap();
    const mesh = accepted.resources.resolveAsset<MeshAsset>(handle, fixed.revision).unwrap();
    expect(mesh.vertices.buffer).toBe(received.vertices.buffer);
    expect(mesh.attributes.position).toBeInstanceOf(Float32Array);
    expect(mesh.vertices).toBeInstanceOf(Float32Array);
    expect(mesh.indices?.constructor).toBe(geometry.indices?.constructor);
    expect(Array.from(mesh.attributes.position as Float32Array)).toEqual(expected);
    expect(mesh.aabb).toEqual(geometry.aabb);
    expect(accepted.resources.resolveAsset<MeshAsset>(handle).unwrap().aabb).toEqual(
      new Float32Array([-2, -2, -2, 2, 2, 2]),
    );
    fixed.value.vertices[0] = 123;
    expect(mesh.vertices[0]).toBe(expectedVertex);
  } finally {
    fixed.dispose();
    publisher.dispose();
    assets.dispose();
  }
});

it('keeps a prepared Mesh for fixed consumers without sending its payload again', () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const handle = assets.create(BUILTIN_CUBE).unwrap();
  const contentRevision = assets.revision(handle).unwrap();
  assets.create(Materials.unlit([1, 1, 1, 1])).unwrap();
  const fixed = runtimeAssets(assets).pin<MeshAsset>(handle).unwrap();
  expect(fixed.revision).toBeGreaterThan(contentRevision);
  let showFixed = true;
  const identity = { source: 'fixed-prepared-mesh', epoch: 1 };
  const receiver = new RenderPublicationReceiver(identity);
  const prepared = receiver
    .prepareMesh({ ...identity, meshHandle: handle, revision: contentRevision, mesh: fixed.value })
    .unwrap();
  const feature: RenderFeature<unknown> = {
    identity: 'fixed-prepared-mesh',
    extract(context) {
      if (showFixed) context.referenceAssetVersion?.(fixed);
      return ok(undefined);
    },
    assetDependencies: () => [handle],
    plan: () => ok({ work: [] }),
  };
  const publisher = createRenderPublisher(
    world,
    assets,
    identity,
    undefined,
    [feature],
    undefined,
    undefined,
    2,
    (candidate, revision) =>
      candidate === handle && revision === contentRevision && prepared.isCurrent(),
  );
  const publish = (candidate = publisher.prepare(0).unwrap()) => {
    const outgoing = candidate.message;
    const packet = structuredClone(outgoing, {
      transfer: [
        ...renderPublicationTransfers(outgoing),
        ...renderPublicationAssetTransfers(outgoing),
      ],
    });
    candidate.accept();
    const accepted = receiver.accept(packet).unwrap();
    publisher.recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
    return accepted.resources;
  };
  try {
    const admitted = publisher.prepare(0).unwrap();
    expect(admitted.message.side?.assetVersions).toEqual([
      { handle, revision: fixed.revision, preparedRevision: contentRevision },
    ]);
    expect(renderPublicationAssetTransfers(admitted.message)).toEqual([]);
    expect(
      receiver.accept(
        encodeRenderPublication({
          ...admitted.packet,
          assetVersions: [{ handle, revision: fixed.revision, preparedRevision: fixed.revision }],
        }),
      ),
    ).toMatchObject({ ok: false, error: { detail: { reason: 'revision' } } });
    const resources = publish(admitted);
    expect(resources.resolveAsset(handle).unwrap()).toBe(prepared.mesh);
    const original = resources.resolveAsset<MeshAsset>(handle, fixed.revision).unwrap();
    expect(original.vertices.buffer).toBe(prepared.mesh.vertices.buffer);
    const before = receiver.inspectMeshStorage().preparedBytes;
    expect(before).toBeGreaterThan(0);

    prepared.release();
    const originalVertices = original.vertices.slice();
    const changedPosition = originalVertices.slice(0, 3);
    changedPosition[0] += 0.125;
    assets
      .writeRange(handle, { attribute: 'position', first: 0, values: changedPosition })
      .unwrap();
    const patch = publisher.prepare(0).unwrap();
    expect(patch.packet.assetPatches).toHaveLength(1);
    publish(patch);
    expect(original.vertices).toEqual(originalVertices);
    expect(resources.resolveAsset<MeshAsset>(handle).unwrap().vertices).not.toEqual(
      originalVertices,
    );
    assets
      .replace(handle, { ...BUILTIN_CUBE, aabb: new Float32Array([-2, -2, -2, 2, 2, 2]) })
      .unwrap();
    for (let frame = 0; frame < 12; frame++) publish();
    expect(resources.resolveAsset(handle, fixed.revision).unwrap()).toBe(original);
    expect(resources.resolveAsset<MeshAsset>(handle).unwrap().aabb).toEqual(
      assets.read(handle).unwrap().aabb,
    );
    expect(original.aabb).toEqual(BUILTIN_CUBE.aabb);
    expect(receiver.inspectMeshStorage().preparedBytes).toBe(before);

    showFixed = false;
    publish();
    expect(resources.resolveAsset(handle, fixed.revision).ok).toBe(false);
    expect(receiver.inspectMeshStorage().preparedBytes).toBe(0);
  } finally {
    prepared.release();
    fixed.dispose();
    publisher.dispose();
    receiver.dispose();
    assets.dispose();
  }
});

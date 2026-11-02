import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { FixedTime, World } from '@forgeax/engine-ecs';
import { createBoxGeometry, createMeshBuilder } from '@forgeax/engine-geometry';
import { mat4 } from '@forgeax/engine-math';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack';
import type { Buffer, RenderPipelineDescriptor } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { propagateTransforms, registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import {
  type AssetHandle,
  type MaterialAsset,
  type MaterialPass,
  ok,
  unpackSlot,
} from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { publishRuntimeAssets } from '../../../assets-runtime/src/__tests__/fixtures/runtime-publication';
import { createMaterialPackCooker } from '../../../shader-compiler/src/material/pack-cooker';
import { createDynamicGeometrySourceHost } from '../assembly/dynamic-geometry-host';
import { createRenderer, exposeRenderer } from '../assembly/factory';
import { createAsyncDynamicGeometryHost } from '../async-dynamic-geometry';
import {
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  Visibility,
  VisibilityStateValue,
} from '../components';
import { ANTIALIAS_NONE, BLOOM_DISABLED } from '../components/camera';
import { createDynamicGeometryLifecycle } from '../dynamic-geometry';
import { Materials } from '../materials';
import { captureMeshPipelinePreparation } from '../publication/mesh-pipeline-preparation';
import { createRenderPublisher } from '../publication/publisher';
import { encodeRenderPublication, renderPublicationTransfers } from '../publication/record';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

const guid = '019f0000-0000-7000-8000-0000000009a1';
const sourceBase = Materials.standard({ baseColor: [0.6, 0.4, 0.2, 1], roughness: 0.7 });
const standardPasses = sourceBase.passes;
if (standardPasses === undefined)
  throw new Error('Standard material factory must provide its passes');
function skinPass(pass: MaterialPass): MaterialPass {
  const tags = pass.renderState?.tags;
  return typeof tags === 'object' &&
    tags !== null &&
    'LightMode' in tags &&
    tags.LightMode === 'ShadowCaster'
    ? pass
    : { ...pass, program: { ...pass.program, module: 'forgeax::pbr-skin' } };
}
const source: MaterialAsset = {
  ...sourceBase,
  passes: [skinPass(standardPasses[0]), ...standardPasses.slice(1).map(skinPass)],
};
let cooked: ReturnType<ReturnType<typeof createMaterialPackCooker>['cook']> | undefined;

function geometry(size: number, colored = false) {
  const base = createBoxGeometry(size, size, size).unwrap();
  const position = base.attributes.position;
  if (!(position instanceof Float32Array) || base.indices === undefined)
    throw new Error('Missing public box geometry');
  const count = position.length / 3;
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  for (let vertex = 0; vertex < count; vertex++) {
    skinIndex[vertex * 4] = vertex % 2;
    skinWeight[vertex * 4] = 1;
  }
  return createMeshBuilder({
    attributes: {
      ...base.attributes,
      skinIndex,
      skinWeight,
      ...(colored ? { color: new Float32Array(count * 4).fill(1) } : {}),
    },
    indices: base.indices,
    submeshes: base.submeshes,
    materialSlots: base.materialSlots,
  })
    .build()
    .unwrap();
}

async function finishPreparation<T>(draw: () => Promise<unknown>, pending: Promise<T>): Promise<T> {
  let settled: { value: T } | { error: unknown } | undefined;
  void pending.then(
    (value) => {
      settled = { value };
    },
    (error) => {
      settled = { error };
    },
  );
  for (let frame = 0; frame < 60 && settled === undefined; frame++) await draw();
  if (settled === undefined)
    throw new Error('Candidate did not settle through 60 ordinary draw passes');
  if ('error' in settled) throw settled.error;
  return settled.value;
}

async function fixture(storageBuffer: boolean, published = false) {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  let loseDevice!: () => void;
  const lost = new Promise<{ reason: 'unknown'; message: string }>((resolve) => {
    loseDevice = () =>
      resolve({ reason: 'unknown', message: 'controlled candidate device retirement' });
  });
  const loss = vi.spyOn(device, 'lost', 'get').mockReturnValue(lost);
  let deviceRequests = 0;
  const identity = { source: 'skin-candidate-source', epoch: 1 };
  if (!storageBuffer)
    Object.defineProperty(device, 'caps', { value: { ...device.caps, storageBuffer: false } });
  const labels = new Map<Buffer, string>();
  const allocations = device.createBuffer.bind(device);
  const createdBuffers = vi.spyOn(device, 'createBuffer').mockImplementation((descriptor) => {
    const result = allocations(descriptor);
    if (result.ok) labels.set(result.value, descriptor.label ?? '');
    return result;
  });
  const uploads: { label: string; offset: number; values: number[] }[] = [];
  const originalWrite = device.queue.writeBuffer.bind(device.queue);
  const writes = vi
    .spyOn(device.queue, 'writeBuffer')
    .mockImplementation((buffer, offset, data, dataOffset, size) => {
      const label = labels.get(buffer);
      if (label?.startsWith('skin-task-') && data instanceof ArrayBuffer) {
        const copied = data.slice(dataOffset ?? 0, (dataOffset ?? 0) + (size ?? data.byteLength));
        uploads.push({ label, offset, values: Array.from(new Float32Array(copied)) });
      }
      return originalWrite(buffer, offset, data, dataOffset, size);
    });
  let hold = false;
  let phase = 'baseline';
  const pipelineCalls: object[] = [];
  const resourceIds = new WeakMap<object, number>();
  let nextResource = 0;
  const resourceId = (value: unknown) => {
    if (value === null || typeof value !== 'object') return null;
    let id = resourceIds.get(value);
    if (id === undefined) {
      id = ++nextResource;
      resourceIds.set(value, id);
    }
    return id;
  };
  const held: RenderPipelineDescriptor[] = [];
  const releases: (() => void)[] = [];
  const createPipeline = device.createRenderPipeline.bind(device);
  device.createRenderPipelineAsync = async (descriptor) => {
    pipelineCalls.push({
      phase,
      label: descriptor.label,
      vertexEntry: descriptor.vertex.entryPoint,
      fragmentEntry: descriptor.fragment?.entryPoint,
      vertexModule: resourceId(descriptor.vertex.module),
      fragmentModule: resourceId(descriptor.fragment?.module),
      layout: resourceId(descriptor.layout),
      buffers: Array.from(descriptor.vertex.buffers ?? []).map((buffer) =>
        buffer === null
          ? null
          : {
              arrayStride: buffer.arrayStride,
              stepMode: buffer.stepMode,
              attributes: Array.from(buffer.attributes),
            },
      ),
      constants: Reflect.get(descriptor, 'constants') ?? null,
      vertexConstants: Reflect.get(descriptor, 'vertexConstants') ?? null,
      primitive: descriptor.primitive,
      depthStencil: descriptor.depthStencil,
      multisample: descriptor.multisample,
    });
    const result = createPipeline(descriptor);
    if (hold) {
      held.push(descriptor);
      await new Promise<void>((resolve) => releases.push(resolve));
    }
    return result;
  };
  const release = () => {
    hold = false;
    for (const done of releases.splice(0)) done();
  };
  const host = await createRenderer(
    { width: 64, height: 64, getContext: () => null },
    {
      ...(published ? { publicationSource: identity } : {}),
      rhi: {
        ...rhi,
        requestAdapter: async () =>
          ok({
            features: new Set<GPUFeatureName>(),
            limits: {},
            requestDevice: async () =>
              deviceRequests++ === 0
                ? ok(device)
                : await (await rhi.requestAdapter()).unwrap().requestDevice(),
          }),
      },
    },
    { shaderManifestUrl: renderLifecycleManifestUrl() },
  );
  expect((await host.initialization).ok).toBe(true);
  loss.mockRestore();
  const renderer = exposeRenderer(host);
  const assets = host.assetRegistry;
  cooked ??= createMaterialPackCooker().cook({ guid, source });
  const record = validateCookedMaterialRecord(
    ((await cooked).payload as { cooked: unknown }).cooked,
  ).unwrap();
  expect(
    record.programs.some((program) =>
      program.selections.some((selection) => selection.context.geometry === 'skinned'),
    ),
  ).toBe(true);
  const payload = { ...source, cooked: record };
  publishRuntimeAssets(assets, [{ guid, asset: payload }]);
  const material = (await assets.load(guid, 'material')).unwrap();
  const world = new World({ assets });
  registerPropagateTransforms(world);
  const previous = assets.create(geometry(1)).unwrap();
  const nextMesh = geometry(1.25, true);
  const next = assets.create(nextMesh).unwrap();
  const inverseBindMatrices = new Float32Array(32);
  inverseBindMatrices.set(mat4.identity(mat4.create()), 0);
  inverseBindMatrices.set(mat4.identity(mat4.create()), 16);
  const skeleton = assets.create({ kind: 'skeleton', jointCount: 2, inverseBindMatrices }).unwrap();
  const firstJoint = world.spawn({ component: Transform, data: {} }).unwrap();
  const joints = [
    firstJoint,
    world.spawn({ component: Transform, data: { pos: [1, 0, 0] } }).unwrap(),
  ];
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: previous } },
      { component: MeshRenderer, data: { materials: [material] } },
      { component: Skin, data: { skeleton, joints } },
    )
    .unwrap();
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
  world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [-0.5, -0.9, -0.7],
        intensity: 3,
        castShadow: true,
        cascadeCount: 1,
        mapSize: 64,
      },
    })
    .unwrap();
  world.update(1 / 60).unwrap();
  propagateTransforms(world).unwrap();
  const attached = published ? undefined : renderer.attach(world);
  if (attached !== undefined && !attached.ok) throw attached.error;
  const lease = attached?.ok ? attached.value : undefined;
  const publisher = published
    ? createRenderPublisher(world, assets, identity, device.caps)
    : undefined;
  let recycle: (() => void) | undefined;
  const errors: unknown[] = [];
  host.onError((error) => errors.push(error));
  const submit = () => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    const publication = publisher?.prepare(0).unwrap();
    const packet =
      publication === undefined
        ? undefined
        : structuredClone(publication.packet, {
            transfer: renderPublicationTransfers(publication.message),
          });
    publication?.accept();
    const request =
      packet !== undefined
        ? { publication: encodeRenderPublication(packet), geometryLane: 'direct' as const }
        : undefined;
    let result: ReturnType<typeof renderer.draw>;
    if (request !== undefined) result = renderer.draw(request);
    else {
      if (lease === undefined) throw new Error('Missing local Source read lease');
      result = renderer.draw({
        leases: [lease],
        camera: { lease },
        environment: { lease },
        geometryLane: 'direct',
      });
    }
    if (!result.ok)
      throw new Error(
        JSON.stringify({ error: result.error, errors, pipelineCalls }, (_key, value) =>
          value instanceof Error
            ? { ...value, name: value.name, message: value.message, stack: value.stack }
            : value,
        ),
      );
    if (packet !== undefined)
      recycle = () => {
        const buffers = renderPublicationTransfers(encodeRenderPublication(packet));
        publisher
          ?.recycle(packet.revision, structuredClone(buffers, { transfer: buffers }))
          .unwrap();
      };
    return result.value;
  };
  const draw = async () => {
    const receipt = submit();
    expect((await receipt.completed).ok, JSON.stringify(errors)).toBe(true);
    recycle?.();
    recycle = undefined;
    await new Promise<void>((resolve) => setImmediate(resolve));
    return receipt;
  };
  let initialReady = false;
  for (let frame = 0; frame < 30; frame++) {
    if ((await draw()).presentation === 'ready') {
      initialReady = true;
      break;
    }
  }
  expect(initialReady, JSON.stringify(errors)).toBe(true);
  expect(
    uploads.some((row) => row.values.length === 32),
    'Ordinary baseline must actually request the two-joint Skin palette',
  ).toBe(true);
  return {
    renderer,
    assets,
    world,
    entity,
    joints,
    firstJoint,
    skeleton,
    previous,
    next,
    nextMesh,
    uploads,
    held,
    pipelineCalls,
    device,
    material,
    submit,
    identity,
    loseDevice,
    phase: (value: string) => {
      phase = value;
    },
    hold: () => {
      hold = true;
    },
    release,
    asyncHost: createAsyncDynamicGeometryHost(renderer),
    draw,
    errors,
    input: { world, entity, meshHandle: next, revision: 1 },
    dispose: async () => {
      release();
      try {
        return await renderer.dispose();
      } finally {
        createdBuffers.mockRestore();
        writes.mockRestore();
        publisher?.dispose();
      }
    },
  };
}

it.each([
  true,
  false,
])('prepares a real cooked Skin candidate through RenderHost (storage=%s)', async (storage) => {
  const f = await fixture(storage);
  try {
    f.phase('prepare');
    const prepared = await finishPreparation(f.draw, f.asyncHost.prepareDynamicGeometry(f.input));
    expect(prepared.ok, prepared.ok ? undefined : JSON.stringify(prepared.error)).toBe(true);
    if (!prepared.ok) throw prepared.error;
    expect(f.renderer.isDynamicGeometryCurrent(prepared.value)).toBe(true);
    expect(f.renderer.dynamicGeometryReceipt(prepared.value)).toBeUndefined();
    expect(f.world.get(f.entity, MeshFilter).unwrap().assetHandle).toBe(f.previous);
    f.renderer.cancelDynamicGeometry(prepared.value).unwrap();
    expect(f.errors).toEqual([]);
  } finally {
    await f.dispose();
  }
}, 30000);

it('refuses buffer-only Skin admission until the same candidate completes its real PSOs', async () => {
  const f = await fixture(true);
  try {
    const candidate = f.renderer.prepareDynamicGeometry(f.input).unwrap();
    const ordering = () => ({ world: f.world, fixedStep: f.world.getResource(FixedTime).tick });
    expect(f.renderer.isDynamicGeometryCurrent(candidate)).toBe(true);
    expect(f.renderer.acceptDynamicGeometry(candidate, ordering()).ok).toBe(false);
    expect(f.world.get(f.entity, MeshFilter).unwrap().assetHandle).toBe(f.previous);
    expect(
      (await finishPreparation(f.draw, f.renderer.prepareDynamicGeometryPipelines([candidate]))).ok,
    ).toBe(true);
    expect(f.renderer.acceptDynamicGeometry(candidate, ordering()).ok).toBe(true);
    expect(f.renderer.dynamicGeometryReceipt(candidate)).toBeUndefined();
  } finally {
    await f.dispose();
  }
}, 30000);

it('preserves dormant Skin zero rigid sync admission but rejects activation under its old absence proof', async () => {
  const f = await fixture(true);
  try {
    f.world.set(f.entity, Skin, { skeleton: 0 as AssetHandle<'skeleton'>, joints: [] }).unwrap();
    const rigid = f.renderer.prepareDynamicGeometry(f.input).unwrap();
    expect(f.renderer.isDynamicGeometryCurrent(rigid)).toBe(true);
    const ordering = () => ({ world: f.world, fixedStep: f.world.getResource(FixedTime).tick });
    const acceptedRigid = f.renderer.acceptDynamicGeometry(rigid, ordering()).unwrap();
    f.renderer.cancelDynamicGeometry(acceptedRigid).unwrap();
    const next = f.renderer.prepareDynamicGeometry({ ...f.input, revision: 2 }).unwrap();
    expect(f.renderer.isDynamicGeometryCurrent(next)).toBe(true);
    f.world.set(f.entity, Skin, { skeleton: f.skeleton, joints: f.joints }).unwrap();
    expect(f.renderer.isDynamicGeometryCurrent(next)).toBe(false);
    expect(f.renderer.acceptDynamicGeometry(next, ordering()).ok).toBe(false);
    expect(f.renderer.dynamicGeometryReceipt(next)).toBeUndefined();
    f.renderer.cancelDynamicGeometry(next).unwrap();
  } finally {
    await f.dispose();
  }
}, 30000);

it.each([
  'ordered-joints',
  'inverse-bind-version',
  'skeleton-handle',
  'Skin-removal',
  'joint-generation',
] as const)('invalidates the prepared static Skin contract after %s', async (edit) => {
  const f = await fixture(true);
  try {
    const candidate = (
      await finishPreparation(f.draw, f.asyncHost.prepareDynamicGeometry(f.input))
    ).unwrap();
    if (edit === 'ordered-joints')
      f.world.set(f.entity, Skin, { joints: [...f.joints].reverse() }).unwrap();
    else if (edit === 'inverse-bind-version') {
      const matrices = new Float32Array(f.assets.read(f.skeleton).unwrap().inverseBindMatrices);
      matrices[12] = 0.5;
      f.assets.update(f.skeleton, { inverseBindMatrices: matrices }).unwrap();
    } else if (edit === 'skeleton-handle') {
      const replacement = f.assets.create(f.assets.read(f.skeleton).unwrap()).unwrap();
      f.world.set(f.entity, Skin, { skeleton: replacement }).unwrap();
      f.assets.release(replacement).unwrap();
    } else if (edit === 'Skin-removal') f.world.removeComponent(f.entity, Skin).unwrap();
    else {
      const old = f.firstJoint;
      f.world.despawn(old).unwrap();
      const replacement = f.world.spawn({ component: Transform, data: {} }).unwrap();
      expect(unpackSlot(replacement)).toBe(unpackSlot(old));
      expect(replacement).not.toBe(old);
    }
    expect(f.renderer.isDynamicGeometryCurrent(candidate)).toBe(false);
    expect(
      f.renderer.acceptDynamicGeometry(candidate, {
        world: f.world,
        fixedStep: f.world.getResource(FixedTime).tick,
      }).ok,
    ).toBe(false);
    expect(f.world.get(f.entity, MeshFilter).unwrap().assetHandle).toBe(f.previous);
    f.renderer.cancelDynamicGeometry(candidate).unwrap();
  } finally {
    await f.dispose();
  }
}, 30000);

it('changes the Source-host collective token for Skin/structure but not numeric joint motion', async () => {
  const f = await fixture(true);
  const residencyToken = Object.freeze({});
  const prepare = vi.fn(async () => {
    throw new Error('Token observation must not request physical preparation');
  });
  const sourceHost = createDynamicGeometrySourceHost({
    lifecycle: createDynamicGeometryLifecycle(),
    attachedWorlds: new Set([f.world]),
    currentGeneration: () => 1,
    residency: { maxConcurrentPreparations: 1, currentnessToken: () => residencyToken, prepare },
    isConsumedByRenderFrame: () => false,
  });
  try {
    const before = sourceHost.dynamicGeometryCurrentness?.(f.world);
    expect(before).toBeDefined();
    f.world.set(f.firstJoint, Transform, { pos: [3, 0, 0] }).unwrap();
    f.world.update(0).unwrap();
    propagateTransforms(f.world).unwrap();
    expect(sourceHost.dynamicGeometryCurrentness?.(f.world)).toBe(before);
    f.world.set(f.entity, Skin, { joints: [...f.joints].reverse() }).unwrap();
    const skinChanged = sourceHost.dynamicGeometryCurrentness?.(f.world);
    expect(skinChanged).not.toBe(before);
    f.world.set(f.entity, Skin, { skeleton: 0 as AssetHandle<'skeleton'>, joints: [] }).unwrap();
    const dormant = sourceHost.dynamicGeometryCurrentness?.(f.world);
    expect(dormant).not.toBe(skinChanged);
    f.world.set(f.entity, Skin, { skeleton: f.skeleton, joints: f.joints }).unwrap();
    const active = sourceHost.dynamicGeometryCurrentness?.(f.world);
    expect(active).not.toBe(dormant);
    f.world.spawn().unwrap();
    expect(sourceHost.dynamicGeometryCurrentness?.(f.world)).not.toBe(active);
    expect(prepare).not.toHaveBeenCalled();
  } finally {
    sourceHost.invalidateDynamicGeometryWorld(f.world);
    await f.dispose();
  }
}, 30000);

it.each([
  false,
  true,
])('keeps moving poses current during real delayed native PSOs (cancel=%s)', async (cancel) => {
  const f = await fixture(true),
    controller = new AbortController();
  try {
    f.hold();
    let settled = false;
    const pending = f.asyncHost
      .prepareDynamicGeometry(f.input, { signal: controller.signal })
      .then((result) => {
        settled = true;
        return result;
      });
    for (let frame = 0; frame < 30 && f.held.length === 0 && !settled; frame++) await f.draw();
    expect(f.held.length).toBeGreaterThan(0);
    expect(settled).toBe(false);
    f.world.set(f.firstJoint, Transform, { pos: [3, 0, 0] }).unwrap();
    expect((await f.draw()).presentation).toBe('ready');
    expect(f.world.get(f.entity, MeshFilter).unwrap().assetHandle).toBe(f.previous);
    if (cancel) controller.abort();
    f.release();
    const result = await finishPreparation(f.draw, pending);
    expect(result.ok).toBe(!cancel);
    if (result.ok) {
      expect(f.renderer.isDynamicGeometryCurrent(result.value)).toBe(true);
      f.renderer.cancelDynamicGeometry(result.value).unwrap();
    }
    expect(f.renderer.inspect().dynamicGeometry?.published).toBe(0);
  } finally {
    controller.abort();
    f.release();
    await f.dispose();
  }
}, 30000);

it('retains two in-flight Skeleton guards until the real submitted completion fence settles', async () => {
  const f = await fixture(true);
  let finish!: () => void;
  const held = new Promise<undefined>((resolve) => {
    finish = () => resolve(undefined);
  });
  const completion = vi.spyOn(f.device.queue, 'onSubmittedWorkDone').mockReturnValue(held);
  try {
    const other = f.world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: f.previous } },
        { component: MeshRenderer, data: { materials: [f.material] } },
        { component: Skin, data: { skeleton: f.skeleton, joints: f.joints } },
      )
      .unwrap();
    const initial = runtimeAssets(f.assets).refcount(f.skeleton);
    const first = f.renderer.prepareDynamicGeometry(f.input).unwrap();
    const second = f.renderer.prepareDynamicGeometry({ ...f.input, entity: other }).unwrap();
    expect(runtimeAssets(f.assets).refcount(f.skeleton)).toBeGreaterThanOrEqual(initial + 2);
    const frame = f.submit();
    f.renderer.cancelDynamicGeometry(first).unwrap();
    f.renderer.cancelDynamicGeometry(second).unwrap();
    expect(runtimeAssets(f.assets).refcount(f.skeleton)).toBeGreaterThanOrEqual(initial + 2);
    finish();
    expect((await frame.completed).ok).toBe(true);
    for (let turn = 0; turn < 32; turn++) await Promise.resolve();
    expect(runtimeAssets(f.assets).refcount(f.skeleton)).toBe(initial);
  } finally {
    finish();
    completion.mockRestore();
    await f.dispose();
  }
}, 30000);

it('cancels the old candidate generation when its actual device retires during native PSO preparation', async () => {
  const f = await fixture(true);
  try {
    f.hold();
    let settled = false;
    const pending = f.asyncHost.prepareDynamicGeometry(f.input).then((result) => {
      settled = true;
      return result;
    });
    for (let frame = 0; frame < 30 && !f.held.length && !settled; frame++) await f.draw();
    expect(f.held.length).toBeGreaterThan(0);
    f.loseDevice();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.renderer.state()).toBe('device-lost');
    const recovering = f.renderer.recover();
    f.release();
    expect((await recovering).ok).toBe(true);
    expect((await finishPreparation(f.draw, pending)).ok).toBe(false);
    expect(f.world.get(f.entity, MeshFilter).unwrap().assetHandle).toBe(f.previous);
    expect(f.renderer.inspect().dynamicGeometry?.published).toBe(0);
  } finally {
    f.release();
    await f.dispose();
  }
}, 30000);

it('roundtrips owned Worker mesh buffers/static Skin facts and records only the exact Source namespace', async () => {
  const f = await fixture(true, true);
  try {
    const preparation = captureMeshPipelinePreparation({
      ...f.input,
      mesh: f.nextMesh,
      assets: f.assets,
      capabilities: f.device.caps,
    }).unwrap();
    const owned = structuredClone({
      ...f.identity,
      meshHandle: f.next,
      revision: runtimeAssets(f.assets).version(f.next).unwrap(),
      mesh: f.assets.read(f.next).unwrap(),
      pipelinePreparation: preparation,
    });
    const buffers = new Set<ArrayBuffer>();
    for (const array of [
      owned.mesh.vertices,
      owned.mesh.indices,
      owned.mesh.aabb,
      ...Object.values(owned.mesh.attributes),
    ])
      if (array?.buffer instanceof ArrayBuffer) buffers.add(array.buffer);
    const transferred = structuredClone(owned, { transfer: [...buffers] });
    expect(owned.mesh.vertices.byteLength).toBe(0);
    expect(f.nextMesh.vertices.byteLength).toBeGreaterThan(0);
    expect(transferred.pipelinePreparation.template.snapshot.skinBinding).toEqual({
      skeleton: f.skeleton,
      joints: f.joints,
    });
    expect(
      (
        await f.renderer.preparePublishedMeshResidency(
          { ...transferred, source: 'different-world-source' },
          'received',
        )
      ).ok,
    ).toBe(false);
    const prepared = (
      await finishPreparation(
        f.draw,
        f.renderer.preparePublishedMeshResidency(transferred, 'received'),
      )
    ).unwrap();
    expect(prepared.isCurrent()).toBe(true);
    const before = await f.draw();
    expect(prepared.recordStageLane(before, f.entity).unwrap()).toBeUndefined();
    f.world.set(f.entity, MeshFilter, { assetHandle: f.next }).unwrap();
    f.world.set(f.firstJoint, Transform, { pos: [4, 0, 0] }).unwrap();
    f.uploads.length = 0;
    const after = await f.draw();
    expect(prepared.recordStageLane(after, f.entity).unwrap()).toBeDefined();
    expect(
      f.uploads.some(
        (row) => row.label === 'skin-task-data' && row.values.length === 32 && row.values[12] === 4,
      ),
    ).toBe(true);
    expect(prepared.recordStageLane(before, f.entity).ok).toBe(false);
    await prepared.release();
    expect(prepared.isCurrent()).toBe(false);
  } finally {
    await f.dispose();
  }
}, 30000);

it.each([
  false,
  true,
])('keeps moving joint poses current and publishes only after actual Skin recording (hidden=%s)', async (hidden) => {
  const f = await fixture(true);
  try {
    f.phase('prepare');
    const prepared = (
      await finishPreparation(f.draw, f.asyncHost.prepareDynamicGeometry(f.input))
    ).unwrap();
    f.world.set(f.firstJoint, Transform, { pos: [2, 0, 0] }).unwrap();
    f.world.update(1 / 60).unwrap();
    propagateTransforms(f.world).unwrap();
    expect(f.renderer.isDynamicGeometryCurrent(prepared)).toBe(true);
    expect(f.renderer.dynamicGeometryReceipt(prepared)).toBeUndefined();
    const accepted = f.renderer
      .acceptDynamicGeometry(prepared, {
        world: f.world,
        fixedStep: f.world.getResource(FixedTime).tick,
      })
      .unwrap();
    if (hidden) {
      f.phase('hidden');
      f.world
        .addComponent(f.entity, {
          component: Visibility,
          data: { state: VisibilityStateValue.hidden },
        })
        .unwrap();
      await f.draw();
      expect(f.renderer.dynamicGeometryReceipt(accepted)).toBeUndefined();
      f.world.set(f.entity, Visibility, { state: VisibilityStateValue.visible }).unwrap();
    }
    f.phase('visible');
    f.world.set(f.firstJoint, Transform, { pos: [4, 0, 0] }).unwrap();
    f.uploads.length = 0;
    const frame = await f.draw();
    expect(f.renderer.dynamicGeometryReceipt(accepted)).toMatchObject({
      frameId: frame.frameId,
      deviceGeneration: frame.deviceGeneration,
      recordStageConsumed: true,
    });
    expect(
      f.uploads.some(
        (row) => row.label === 'skin-task-data' && row.values.length === 32 && row.values[12] === 4,
      ),
    ).toBe(true);
  } finally {
    await f.dispose();
  }
}, 30000);

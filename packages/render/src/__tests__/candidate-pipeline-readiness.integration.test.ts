import { RuntimeMaterialValue } from '@forgeax/engine-assets-runtime';
import { FixedTime, World } from '@forgeax/engine-ecs';
import { createBoxGeometry, createMeshBuilder } from '@forgeax/engine-geometry';
import {
  type RenderPipeline,
  type RenderPipelineDescriptor,
  type RhiDevice,
  RhiError,
} from '@forgeax/engine-rhi';
import { RhiNullRenderPassEncoder, rhi } from '@forgeax/engine-rhi-null';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import {
  createStandardPbrArtifactReceipt,
  STANDARD_PIPELINE_PARAM_SCHEMA,
} from '@forgeax/engine-shader';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { createRenderer, exposeRenderer } from '../assembly/factory';
import { createAsyncDynamicGeometryHost } from '../async-dynamic-geometry';
import {
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  PointLight,
  PointLightShadow,
  SpotLight,
  Visibility,
  VisibilityStateValue,
} from '../components';
import { ANTIALIAS_NONE, BLOOM_DISABLED } from '../components/camera';
import { Materials } from '../materials';
import { renderPublicationTransfers } from '../publication/contract';
import { captureMeshPipelinePreparation } from '../publication/mesh-pipeline-preparation';
import { createRenderPublisher } from '../publication/publisher';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

type HeldPass = 'color' | 'shadow';

function newLayout(descriptor: RenderPipelineDescriptor): boolean {
  return Array.from(descriptor.vertex.buffers ?? []).some((buffer) => buffer?.arrayStride === 64);
}

// RHI-null still consumes shader entry/input declarations when choosing the
// real vertex layout and Deferred pass. Marker-only WGSL erases that layout.
const rasterDeclarations = `
struct CandidateVertex { @location(0) position: vec3<f32> }
@vertex fn vs_main(input: CandidateVertex) -> @builtin(position) vec4<f32> {
  return vec4<f32>(input.position, 1.0);
}
@vertex fn vs_scene_index(input: CandidateVertex) -> @builtin(position) vec4<f32> {
  return vec4<f32>(input.position, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }
@fragment fn fs_opaque() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }
@fragment fn fs_gbuffer() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }
`;

async function fixture(pass: HeldPass, published = false, pointShadow = false, unlit = false) {
  const identity = { source: 'candidate-pipeline', epoch: 1 };
  const device: RhiDevice = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  let hold = false;
  let rejected = false;
  const failure = new RhiError({
    code: 'webgpu-runtime-error',
    expected: 'candidate test native pipeline compilation completes',
    hint: 'deliberate candidate pipeline rejection',
  });
  const releases: (() => void)[] = [];
  const held: RenderPipelineDescriptor[] = [];
  const created = new Map<RenderPipelineDescriptor, RenderPipeline>();
  const create = device.createRenderPipeline.bind(device);
  const compile = (descriptor: RenderPipelineDescriptor) => {
    const result = create(descriptor);
    if (result.ok) created.set(descriptor, result.value);
    return result;
  };
  device.createRenderPipeline = compile;
  // This controls completion of the real RHI-null PSO, not the renderer's
  // readiness answer. Native WGSL validation has a separate browser gate.
  const asyncPipelines = vi.fn(async (descriptor: RenderPipelineDescriptor) => {
    const selected =
      pass === 'color'
        ? descriptor.fragment?.entryPoint === 'fs_gbuffer'
        : descriptor.label?.includes('default-shadow-caster');
    const result = compile(descriptor);
    if (hold && newLayout(descriptor) && selected) {
      held.push(descriptor);
      await new Promise<void>((resolve) => releases.push(resolve));
      if (rejected) throw failure;
    }
    return result;
  });
  device.createRenderPipelineAsync = asyncPipelines;
  const source = renderLifecycleManifestUrl();
  const manifest = JSON.parse(decodeURIComponent(source.slice(source.indexOf(',') + 1)));
  for (const entry of manifest.materialShaders) {
    if (
      entry.identifier === 'forgeax::default-standard-pbr' ||
      entry.identifier === 'forgeax::default-shadow-caster'
    ) {
      entry.composedWgsl += rasterDeclarations;
      for (const variant of entry.variants) variant.composedWgsl += rasterDeclarations;
    }
    if (entry.identifier === 'forgeax::default-standard-pbr') {
      entry.receipt = createStandardPbrArtifactReceipt(false, false);
      for (const variant of entry.variants)
        variant.receipt = createStandardPbrArtifactReceipt(
          false,
          variant.defines.VERTEX_COLOR_AVAILABLE === true,
        );
    }
    if (entry.identifier === 'forgeax::default-shadow-caster') {
      const standard = manifest.materialShaders.find(
        (row: { readonly identifier: string }) =>
          row.identifier === 'forgeax::default-standard-pbr',
      );
      entry.paramSchema = standard.paramSchema;
      entry.uvSetCount = standard.uvSetCount;
      entry.receipt = createStandardPbrArtifactReceipt(false, false);
      entry.variants = entry.variants.flatMap(
        (variant: { readonly defines: Record<string, boolean> }) =>
          [false, true].map((vertexColor) => {
            const defines = { ...variant.defines, VERTEX_COLOR_AVAILABLE: vertexColor };
            const sorted = Object.entries(defines).sort(([left], [right]) =>
              left.localeCompare(right),
            );
            return {
              ...variant,
              defines,
              receipt: createStandardPbrArtifactReceipt(false, vertexColor),
              definesKey: sorted.every(([, enabled]) => enabled)
                ? ''
                : sorted.map(([key, enabled]) => `${key}=${enabled}`).join('+'),
            };
          }),
      );
    }
  }
  const host = await createRenderer(
    {
      width: 64,
      height: 64,
      getContext: () => null,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as HTMLCanvasElement,
    {
      ...(published ? { publicationSource: identity } : {}),
      rhi: {
        ...rhi,
        requestAdapter: async () =>
          ok({
            features: new Set<GPUFeatureName>(),
            limits: {},
            requestDevice: async () => ok(device),
          }),
      },
    },
    { shaderManifestUrl: `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}` },
  );
  expect((await host.initialization).ok).toBe(true);
  const renderer = exposeRenderer(host);
  expect(
    renderer.setProfile({ ...renderer.inspect().profile, renderPath: 'deferred', ssao: false }).ok,
  ).toBe(true);
  const world = new World();
  const mesh = createBoxGeometry(1, 1, 1).unwrap();
  const positions = mesh.attributes.position;
  if (!(positions instanceof Float32Array) || mesh.indices === undefined)
    throw new Error('Missing indexed box fixture');
  const color = new Float32Array((positions.length / 3) * 4).fill(1);
  const candidateMesh = createMeshBuilder({
    attributes: { ...mesh.attributes, color },
    indices: mesh.indices,
    submeshes: mesh.submeshes,
    materialSlots: mesh.materialSlots,
  })
    .build()
    .unwrap();
  const previous = world.allocSharedRef('MeshAsset', mesh);
  const next = world.allocSharedRef('MeshAsset', candidateMesh);
  const materialAsset = unlit
    ? Materials.unlit([0.8, 0.5, 0.2, 1])
    : Materials.standard({
        baseColor: [0.8, 0.5, 0.2, 1],
        roughness: 0.6,
        metallic: 0.1,
      });
  const material = world.allocSharedRef('MaterialAsset', materialAsset);
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: previous } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  const camera = world
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
  if (pointShadow)
    world
      .spawn(
        { component: Transform, data: { pos: [2, 3, 4] } },
        { component: PointLight, data: { intensity: 8, range: 15 } },
        { component: PointLightShadow, data: { mapSize: 64, farPlane: 15 } },
      )
      .unwrap();
  else
    world
      .spawn({
        component: DirectionalLight,
        data: {
          direction: [-0.5, -0.9, -0.7],
          intensity: 3,
          mapSize: 64,
          cascadeCount: 1,
          castShadow: true,
        },
      })
      .unwrap();
  world.update(1 / 60).unwrap();
  propagateTransforms(world).unwrap();
  const attached = published ? undefined : renderer.attach(world);
  if (attached !== undefined && !attached.ok) throw attached.error;
  const lease = attached?.value;
  const publisher = published
    ? createRenderPublisher(world, host.assetRegistry, identity, device.caps)
    : undefined;
  const draw = async () => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    const candidate = publisher?.prepare(0).unwrap();
    const packet =
      candidate === undefined
        ? undefined
        : structuredClone(candidate.packet, {
            transfer: renderPublicationTransfers(candidate.packet),
          });
    candidate?.accept();
    const request =
      packet !== undefined
        ? { publication: packet }
        : lease === undefined
          ? undefined
          : { leases: [lease], camera: { lease }, environment: { lease } };
    if (request === undefined) throw new Error('missing frame owner');
    const drawn = renderer.draw(pointShadow ? { ...request, geometryLane: 'direct' } : request);
    if (!drawn.ok) throw drawn.error;
    const receipt = drawn.value;
    expect((await receipt.completed).ok).toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (packet !== undefined) {
      const transfer = renderPublicationTransfers(packet);
      publisher?.recycle(packet.revision, structuredClone(transfer, { transfer })).unwrap();
    }
    return receipt;
  };
  let firstReady = false;
  for (let frame = 0; frame < 30; frame++) {
    if ((await draw()).presentation === 'ready') {
      firstReady = true;
      break;
    }
  }
  expect(firstReady).toBe(true);
  expect(asyncPipelines.mock.calls.some(([descriptor]) => newLayout(descriptor))).toBe(false);
  hold = true;
  const release = () => {
    hold = false;
    for (const resolve of releases.splice(0)) resolve();
  };
  return {
    renderer,
    assets: host.assetRegistry,
    world,
    entity,
    camera,
    material,
    previous,
    next,
    lease,
    draw,
    held,
    created,
    asyncPipelines,
    release,
    reject: () => {
      rejected = true;
    },
    asyncHost: createAsyncDynamicGeometryHost(renderer),
    input: { world, entity, mesh: candidateMesh, meshHandle: next, revision: 1 },
    publishedInput: (candidateEntity = entity) => ({
      ...identity,
      meshHandle: next,
      mesh: candidateMesh,
      pipelinePreparation: captureMeshPipelinePreparation({
        world,
        entity: candidateEntity,
        meshHandle: next,
        mesh: candidateMesh,
        assets: host.assetRegistry,
        capabilities: device.caps,
      }).unwrap(),
    }),
    dispose: async () => {
      release();
      await renderer.dispose();
      publisher?.dispose();
    },
  };
}

async function drawUntil(f: Awaited<ReturnType<typeof fixture>>, condition: () => boolean) {
  for (let frame = 0; frame < 60 && !condition(); frame++)
    expect((await f.draw()).presentation).toBe('ready');
  expect(condition()).toBe(true);
}

async function finish<T>(f: Awaited<ReturnType<typeof fixture>>, pending: Promise<T>) {
  let settled = false;
  const result = pending.then((value) => {
    settled = true;
    return value;
  });
  await drawUntil(f, () => settled);
  return result;
}

async function compilationStarted(
  f: Awaited<ReturnType<typeof fixture>>,
  pending: Promise<{ readonly ok: boolean; readonly error?: unknown }>,
) {
  let settled: { readonly ok: boolean; readonly error?: unknown } | undefined;
  void pending.then((result) => {
    settled = result;
  });
  await drawUntil(f, () => f.held.length > 0 || settled !== undefined);
  if (settled !== undefined) {
    if (!settled.ok) throw settled.error;
    throw new Error('candidate became ready without preparing the new layout');
  }
  expect(f.held.length).toBeGreaterThan(0);
}

it('presents overflow spot lights after all four admitted shadow tiles are prepared', async () => {
  const f = await fixture('shadow');
  try {
    expect(f.renderer.setProfile({ ...f.renderer.inspect().profile, lightCount: 256 }).ok).toBe(
      true,
    );
    for (let light = 0; light < 5; light++)
      f.world
        .spawn(
          { component: Transform, data: { pos: [light - 2, 3, 4] } },
          {
            component: SpotLight,
            data: { direction: [0, -0.5, -1], mapSize: 64, castShadow: true },
          },
        )
        .unwrap();
    let receipt = await f.draw();
    for (let frame = 0; frame < 30 && receipt.presentation !== 'ready'; frame++)
      receipt = await f.draw();
    expect(receipt.presentationPendingReason).toBeUndefined();
    expect(receipt.presentation).toBe('ready');
    expect(
      f.renderer.inspect().perFramePassNames.filter((name) => /^spot-shadow-\d$/.test(name)),
    ).toEqual(['spot-shadow-0', 'spot-shadow-1', 'spot-shadow-2', 'spot-shadow-3']);
  } finally {
    await f.dispose();
  }
});

it.each([
  'color',
  'shadow',
] as const)('waits for new-layout %s PSOs while old geometry keeps producing ready frames', async (pass) => {
  const f = await fixture(pass);
  const bindings = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'setPipeline');
  try {
    let settled = false;
    const pending = f.asyncHost.prepareDynamicGeometry(f.input).then((result) => {
      settled = true;
      return result;
    });
    await compilationStarted(f, pending);
    expect(settled).toBe(false);
    expect(f.world.get(f.entity, MeshFilter).unwrap().assetHandle).toBe(f.previous);
    const heldPipelines = f.held.map((descriptor) => f.created.get(descriptor));
    expect(heldPipelines.every((pipeline) => pipeline !== undefined)).toBe(true);
    const first = await f.draw();
    f.world.set(f.camera, Transform, { pos: [0.1, 0, 8] }).unwrap();
    f.world.update(1 / 60).unwrap();
    const second = await f.draw();
    expect([first.presentation, second.presentation]).toEqual(['ready', 'ready']);
    expect(second.frameId).toBeGreaterThan(first.frameId);
    expect(settled).toBe(false);
    expect(bindings.mock.calls.some(([pipeline]) => heldPipelines.includes(pipeline))).toBe(false);
    expect(f.renderer.inspect().dynamicGeometry?.published).toBe(0);
    f.release();
    const candidate = (await finish(f, pending)).unwrap();
    const compileCount = f.asyncPipelines.mock.calls.length;
    expect(f.renderer.dynamicGeometryReceipt(candidate)).toBeUndefined();
    const accepted = f.asyncHost
      .acceptDynamicGeometry(candidate, {
        world: f.world,
        fixedStep: f.world.getResource(FixedTime).tick,
      })
      .unwrap();
    const receipt = await f.draw();
    expect(receipt.presentation).toBe('ready');
    expect(f.world.get(f.entity, MeshFilter).unwrap().assetHandle).toBe(f.next);
    expect(f.renderer.dynamicGeometryReceipt(accepted)).toMatchObject({
      frameId: receipt.frameId,
      recordStageConsumed: true,
    });
    expect(f.asyncPipelines).toHaveBeenCalledTimes(compileCount);
    const preparedPipelines = [...f.created].filter(([descriptor]) => newLayout(descriptor));
    expect(preparedPipelines.length).toBeGreaterThan(0);
    expect(
      preparedPipelines.map(([descriptor, pipeline]) => ({
        vertex: descriptor.vertex.entryPoint,
        fragment: descriptor.fragment?.entryPoint,
        bound: bindings.mock.calls.some(([actual]) => actual === pipeline),
      })),
    ).toEqual(
      expect.arrayContaining(
        preparedPipelines.map(([descriptor]) => ({
          vertex: descriptor.vertex.entryPoint,
          fragment: descriptor.fragment?.entryPoint,
          bound: true,
        })),
      ),
    );
    expect(bindings.mock.calls.some(([pipeline]) => heldPipelines.includes(pipeline))).toBe(true);
  } finally {
    bindings.mockRestore();
    await f.dispose();
  }
});

it('prepares the first visible caster against the actual light and cascade demand', async () => {
  const f = await fixture('color');
  try {
    f.world
      .addComponent(f.entity, {
        component: Visibility,
        data: { state: VisibilityStateValue.hidden },
      })
      .unwrap();
    for (let frame = 0; frame < 4; frame++) expect((await f.draw()).presentation).toBe('ready');
    const pending = f.asyncHost.prepareDynamicGeometry(f.input);
    await compilationStarted(f, pending);
    f.release();
    const candidate = (await finish(f, pending)).unwrap();
    const compileCount = f.asyncPipelines.mock.calls.length;
    const accepted = f.asyncHost
      .acceptDynamicGeometry(candidate, {
        world: f.world,
        fixedStep: f.world.getResource(FixedTime).tick,
      })
      .unwrap();
    f.world.set(f.entity, Visibility, { state: VisibilityStateValue.visible }).unwrap();
    const receipt = await f.draw();
    expect(receipt.presentation).toBe('ready');
    expect(f.asyncPipelines).toHaveBeenCalledTimes(compileCount);
    expect(f.renderer.dynamicGeometryReceipt(accepted)).toMatchObject({
      frameId: receipt.frameId,
      recordStageConsumed: true,
    });
  } finally {
    await f.dispose();
  }
});

it('prepares the reflected CPU point-shadow layout before accepting replacement geometry', async () => {
  const f = await fixture('shadow', false, true);
  const bindings = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'setPipeline');
  try {
    const oldShadow = [...f.created.keys()].find(
      (descriptor) => descriptor.label?.includes('default-shadow-caster') && !newLayout(descriptor),
    );
    expect(oldShadow).toBeDefined();
    const pending = f.asyncHost.prepareDynamicGeometry(f.input);
    await compilationStarted(f, pending);
    expect(
      f.held.every(
        (descriptor) => descriptor.primitive?.frontFace === oldShadow?.primitive?.frontFace,
      ),
    ).toBe(true);
    f.release();
    const candidate = (await finish(f, pending)).unwrap();
    const compileCount = f.asyncPipelines.mock.calls.length;
    const accepted = f.asyncHost
      .acceptDynamicGeometry(candidate, {
        world: f.world,
        fixedStep: f.world.getResource(FixedTime).tick,
      })
      .unwrap();
    const receipt = await f.draw();
    expect(receipt.presentation).toBe('ready');
    expect(f.asyncPipelines).toHaveBeenCalledTimes(compileCount);
    expect(f.renderer.dynamicGeometryReceipt(accepted)).toMatchObject({
      frameId: receipt.frameId,
      recordStageConsumed: true,
      recordStageLane: 'cpu',
    });
    expect(
      f.held.map((descriptor) => ({
        vertex: descriptor.vertex.entryPoint,
        fragment: descriptor.fragment?.entryPoint,
        frontFace: descriptor.primitive?.frontFace,
        bound: bindings.mock.calls.some(([pipeline]) => pipeline === f.created.get(descriptor)),
      })),
    ).toEqual(
      f.held.map((descriptor) => ({
        vertex: descriptor.vertex.entryPoint,
        fragment: descriptor.fragment?.entryPoint,
        frontFace: descriptor.primitive?.frontFace,
        bound: true,
      })),
    );
  } finally {
    bindings.mockRestore();
    await f.dispose();
  }
});

it('prepares the first published GPU material while the current scene remains unlit', async () => {
  const f = await fixture('color', true, false, true);
  try {
    expect(
      f.asyncPipelines.mock.calls.filter(
        ([descriptor]) => descriptor.vertex.entryPoint === 'vs_scene_index',
      ),
    ).toEqual([]);
    const standard = f.world.allocSharedRef(
      'MaterialAsset',
      Materials.standard({
        baseColor: [1, 1, 1, 1],
        roughness: 0.6,
        metallic: 0.1,
      }),
    );
    f.world.set(f.entity, MeshRenderer, { materials: [standard] }).unwrap();
    f.world.update(1 / 60).unwrap();
    const input = structuredClone(f.publishedInput());
    f.world.set(f.entity, MeshRenderer, { materials: [f.material] }).unwrap();
    f.world.update(1 / 60).unwrap();
    const pending = f.renderer.preparePublishedMeshResidency(input, 'received');
    await compilationStarted(f, pending);
    f.release();
    const prepared = (await finish(f, pending)).unwrap();
    const compileCount = f.asyncPipelines.mock.calls.length;
    f.world.set(f.entity, MeshRenderer, { materials: [standard] }).unwrap();
    f.world.set(f.entity, MeshFilter, { assetHandle: f.next }).unwrap();
    const receipt = await f.draw();
    expect(receipt.presentation).toBe('ready');
    expect(f.asyncPipelines).toHaveBeenCalledTimes(compileCount);
    expect(prepared.recordStageLane(receipt, f.entity).unwrap()).toBe('gpu');
    await prepared.release();
  } finally {
    await f.dispose();
  }
});

it.each([
  'cancel',
  'detach',
] as const)('does not publish a late new-layout PSO after candidate %s', async (action) => {
  const f = await fixture('color');
  try {
    const controller = new AbortController();
    const pending = f.asyncHost.prepareDynamicGeometry(f.input, { signal: controller.signal });
    await compilationStarted(f, pending);
    if (action === 'cancel') controller.abort();
    else f.lease?.dispose();
    f.release();
    expect((await pending).ok).toBe(false);
    expect(f.world.get(f.entity, MeshFilter).unwrap().assetHandle).toBe(f.previous);
    expect(f.renderer.inspect().dynamicGeometry?.published).toBe(0);
    expect(f.renderer.inspect().dynamicGeometry?.accepted).toBe(0);
  } finally {
    await f.dispose();
  }
});

it('prepares published candidate programs without accepting a scene packet or replacing source bindings', async () => {
  const f = await fixture('color', true);
  try {
    let settled = false;
    const pending = f.renderer
      .preparePublishedMeshResidency(structuredClone(f.publishedInput()), 'received')
      .then((result) => {
        settled = true;
        return result;
      });
    await compilationStarted(f, pending);
    expect(settled).toBe(false);
    expect(f.world.get(f.entity, MeshFilter).unwrap().assetHandle).toBe(f.previous);
    expect((await f.draw()).presentation).toBe('ready');
    f.release();
    const prepared = (await finish(f, pending)).unwrap();
    expect(prepared.isCurrent()).toBe(true);
    expect(f.world.get(f.entity, MeshFilter).unwrap().assetHandle).toBe(f.previous);
    const compileCount = f.asyncPipelines.mock.calls.length;
    f.world.set(f.entity, MeshFilter, { assetHandle: f.next }).unwrap();
    f.world.update(1 / 60).unwrap();
    const receipt = await f.draw();
    expect(receipt.presentation).toBe('ready');
    expect(prepared.recordStageLane(receipt, f.entity).unwrap()).toBeDefined();
    expect(f.asyncPipelines).toHaveBeenCalledTimes(compileCount);
    await prepared.release();
  } finally {
    await f.dispose();
  }
});

it('keeps ordinary published hidden chunks out of raster demand until their candidate is prepared', async () => {
  const f = await fixture('color', true);
  const bindings = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'setPipeline');
  try {
    const shader = 'game::new-hidden-chunk';
    f.assets.shaderRegistry.installMaterialArtifact(shader, {
      source: `${rasterDeclarations}\n// newly staged chunk`,
      paramSchema: STANDARD_PIPELINE_PARAM_SCHEMA,
      receipt: createStandardPbrArtifactReceipt(false, true),
    });
    const original = Materials.standard({ baseColor: [0.2, 0.6, 0.8, 1] });
    if (original.passes === undefined) throw new Error('missing Standard material passes');
    const material = f.world.allocSharedRef('MaterialAsset', {
      ...original,
      passes: original.passes.map((pass) =>
        pass.name === 'forward' ? { ...pass, program: { module: shader } } : pass,
      ),
    });
    const chunk = f.world
      .spawn(
        { component: Transform, data: { pos: [2, 0, 0] } },
        { component: MeshFilter, data: { assetHandle: f.next } },
        { component: MeshRenderer, data: { materials: [material] } },
        { component: Visibility, data: { state: VisibilityStateValue.hidden } },
      )
      .unwrap();
    const records = f.renderer.inspect().renderScene.projectionRecords;
    const compileCountBeforePublication = f.asyncPipelines.mock.calls.length;
    // Voxel publishes newly staged entities before its explicit candidate
    // request. This must advance the real scene without requesting their PSOs.
    expect((await f.draw()).presentation).toBe('ready');
    expect(f.renderer.inspect().renderScene.projectionRecords).toBe(records + 1);
    expect(f.asyncPipelines).toHaveBeenCalledTimes(compileCountBeforePublication);
    let settled = false;
    const pending = f.renderer
      .preparePublishedMeshResidency(structuredClone(f.publishedInput(chunk)), 'received')
      .then((result) => {
        settled = true;
        return result;
      });
    await compilationStarted(f, pending);
    const heldPipelines = f.held.map((descriptor) => f.created.get(descriptor));
    const first = await f.draw();
    f.world.set(f.camera, Transform, { pos: [0.1, 0, 8] }).unwrap();
    const second = await f.draw();
    expect([first.presentation, second.presentation]).toEqual(['ready', 'ready']);
    expect(second.frameId).toBeGreaterThan(first.frameId);
    expect(settled).toBe(false);
    expect(bindings.mock.calls.some(([pipeline]) => heldPipelines.includes(pipeline))).toBe(false);
    f.release();
    const prepared = (await finish(f, pending)).unwrap();
    expect(prepared.recordStageLane(await f.draw(), chunk).unwrap()).toBeUndefined();
    const compileCount = f.asyncPipelines.mock.calls.length;
    f.world.removeComponent(chunk, Visibility).unwrap();
    const receipt = await f.draw();
    expect(receipt.presentation).toBe('ready');
    expect(prepared.recordStageLane(receipt, chunk).unwrap()).toBe('gpu');
    expect(f.renderer.inspect().renderScene.projectionRecords).toBe(records + 1);
    expect(f.asyncPipelines).toHaveBeenCalledTimes(compileCount);
    expect(bindings.mock.calls.some(([pipeline]) => heldPipelines.includes(pipeline))).toBe(true);
    // Repeated author visibility edits must update ordinary membership without
    // losing the persistent entity or the prepared native pipeline.
    f.world
      .addComponent(chunk, {
        component: Visibility,
        data: { state: VisibilityStateValue.hidden },
      })
      .unwrap();
    bindings.mockClear();
    expect(prepared.recordStageLane(await f.draw(), chunk).unwrap()).toBeUndefined();
    expect(bindings.mock.calls.some(([pipeline]) => heldPipelines.includes(pipeline))).toBe(false);
    f.world.set(chunk, Visibility, { state: VisibilityStateValue.visible }).unwrap();
    const visibleAgain = await f.draw();
    expect(visibleAgain.presentation).toBe('ready');
    expect(prepared.recordStageLane(visibleAgain, chunk).unwrap()).toBe('gpu');
    expect(f.renderer.inspect().renderScene.projectionRecords).toBe(records + 1);
    expect(f.asyncPipelines).toHaveBeenCalledTimes(compileCount);
    expect(bindings.mock.calls.some(([pipeline]) => heldPipelines.includes(pipeline))).toBe(true);
    await prepared.release();
  } finally {
    bindings.mockRestore();
    await f.dispose();
  }
});

it('rejects a published candidate whose renderer is retired before native preparation completes', async () => {
  const f = await fixture('color', true);
  try {
    const pending = f.renderer.preparePublishedMeshResidency(
      structuredClone(f.publishedInput()),
      'received',
    );
    await compilationStarted(f, pending);
    const disposing = f.renderer.dispose();
    f.release();
    expect((await pending).ok).toBe(false);
    expect((await disposing).ok).toBe(true);
    expect(f.world.get(f.entity, MeshFilter).unwrap().assetHandle).toBe(f.previous);
  } finally {
    await f.dispose();
  }
});

it('returns a rejected asynchronous pipeline to the candidate without failing the submitted scene', async () => {
  const f = await fixture('color');
  const errors: unknown[] = [];
  const unsubscribe = f.renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  try {
    const pending = f.asyncHost.prepareDynamicGeometry(f.input);
    await compilationStarted(f, pending);
    f.reject();
    f.release();
    const result = await finish(f, pending);
    expect(result.ok).toBe(false);
    expect(f.world.get(f.entity, MeshFilter).unwrap().assetHandle).toBe(f.previous);
    expect((await f.draw()).presentation).toBe('ready');
    expect(f.renderer.inspect().dynamicGeometry?.accepted).toBe(0);
    expect(f.renderer.inspect().dynamicGeometry?.published).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    unsubscribe();
    await f.dispose();
  }
});

it.each([
  'uniform',
  'alpha-mask',
] as const)('rechecks %s edits on the same material handle before synchronous admission', async (edit) => {
  const f = await fixture('color');
  try {
    const pending = f.asyncHost.prepareDynamicGeometry(f.input);
    await compilationStarted(f, pending);
    f.release();
    const candidate = (await finish(f, pending)).unwrap();
    const compileCount = f.asyncPipelines.mock.calls.length;
    if (edit === 'uniform') {
      f.world
        .spawn({
          component: RuntimeMaterialValue,
          data: {
            asset: f.material,
            parameter: 'baseColor',
            kind: 2,
            value: [0.1, 0.4, 0.8, 1],
          },
        })
        .unwrap();
    } else {
      f.world
        .spawn({
          component: RuntimeMaterialValue,
          data: {
            asset: f.material,
            parameter: 'alphaHash',
            kind: 0,
            value: [1],
          },
        })
        .unwrap();
    }
    f.world.update(1 / 60).unwrap();
    if (edit === 'alpha-mask')
      expect(
        f.publishedInput().pipelinePreparation.template.snapshot.material.paramSnapshot?.alphaHash,
      ).toBe(1);
    expect(Array.from(f.world.get(f.entity, MeshRenderer).unwrap().materials)).toEqual([
      f.material,
    ]);
    expect(f.asyncHost.isDynamicGeometryCurrent(candidate)).toBe(edit === 'uniform');
    const accepted = f.asyncHost.acceptDynamicGeometry(candidate, {
      world: f.world,
      fixedStep: f.world.getResource(FixedTime).tick,
    });
    expect(accepted.ok).toBe(edit === 'uniform');
    expect(f.world.get(f.entity, MeshFilter).unwrap().assetHandle).toBe(
      edit === 'uniform' ? f.next : f.previous,
    );
    if (edit === 'uniform') {
      expect((await f.draw()).presentation).toBe('ready');
      expect(f.asyncPipelines).toHaveBeenCalledTimes(compileCount);
    } else {
      expect(f.renderer.dynamicGeometryReceipt(candidate)).toBeUndefined();
    }
  } finally {
    await f.dispose();
  }
});

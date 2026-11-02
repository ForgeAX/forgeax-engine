import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { FixedTime, World } from '@forgeax/engine-ecs';
import { createBoxGeometry, createMeshBuilder } from '@forgeax/engine-geometry';
import { equirectContribution } from '@forgeax/engine-image';
import {
  type RenderPipelineDescriptor,
  type RhiDevice,
  RhiError,
  type RenderPipeline as RhiRenderPipeline,
} from '@forgeax/engine-rhi';
import {
  RhiNullCanvasContext,
  type RhiNullQueue,
  RhiNullRenderPassEncoder,
  rhi,
} from '@forgeax/engine-rhi-null';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import {
  createStandardPbrArtifactReceipt,
  STANDARD_PIPELINE_PARAM_SCHEMA,
} from '@forgeax/engine-shader';
import { err, ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import {
  createDynamicGeometrySourceHost,
  type DynamicGeometryResidencyPort,
} from '../assembly/dynamic-geometry-host';
import { createRenderer, exposeRenderer } from '../assembly/factory';
import { createAsyncDynamicGeometryHost } from '../async-dynamic-geometry';
import {
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  PointLight,
  PointLightShadow,
  Skylight,
  SpotLight,
  Visibility,
  VisibilityStateValue,
} from '../components';
import { ANTIALIAS_FXAA, ANTIALIAS_NONE, BLOOM_DISABLED } from '../components/camera';
import { GpuResidencyCache } from '../device/gpu-residency';
import { createDynamicGeometryLifecycle } from '../dynamic-geometry';
import type { RenderFeature } from '../features/types';
import { Materials } from '../materials';
import { standardPipeline } from '../pipeline/standard-pipeline';
import { captureMeshPipelinePreparation } from '../publication/mesh-pipeline-preparation';
import { createRenderPublisher } from '../publication/publisher';
import { encodeRenderPublication, renderPublicationTransfers } from '../publication/record';
import type { RenderPipeline as EngineRenderPipeline } from '../render-pipeline';
import { STANDARD_CLUSTER_TEST_REFLECTION } from './cluster-test-abi';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

type HeldPass = 'color' | 'shadow' | 'transmission';

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

const reflectedClusterAbi = {
  ...STANDARD_CLUSTER_TEST_REFLECTION,
  boundGlobals: STANDARD_CLUSTER_TEST_REFLECTION.boundGlobals.map((global) => ({
    ...global,
    ...(global.resourceKind === 'storage-buffer'
      ? { span: global.elementStride ?? global.span }
      : {}),
    elementType: global.resourceKind === 'storage-buffer' ? 'LightData' : 'struct',
  })),
};

function candidateShaderManifestUrl(): string {
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
      entry.reflection = structuredClone(reflectedClusterAbi);
      for (const variant of entry.variants) {
        variant.hash = 'cafe1234';
        variant.sourceDigest = 'a'.repeat(64);
        variant.compilerProfile = {
          id: 'forgeax-material-wgsl-v1',
          language: 'wgsl',
          profileVersion: '1',
          adapterVersion: '1',
          compilerVersion: '1',
          nagaVersion: '30.0.1',
        };
        variant.receipt = createStandardPbrArtifactReceipt(
          false,
          variant.defines.VERTEX_COLOR_AVAILABLE === true,
        );
        variant.reflection = structuredClone(reflectedClusterAbi);
      }
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
  return `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;
}

async function fixture(
  pass: HeldPass,
  published = false,
  pointShadow = false,
  unlit = false,
  asyncModules = false,
  features: readonly RenderFeature<unknown>[] = [],
  pipeline?: EngineRenderPipeline,
) {
  const identity = { source: 'candidate-pipeline', epoch: 1 };
  const device: RhiDevice = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const queue = device.queue as RhiNullQueue;
  let holdModules = false;
  const moduleReleases: (() => void)[] = [];
  const heldModules: string[] = [];
  const releaseModules = () => {
    holdModules = false;
    for (const resolve of moduleReleases.splice(0)) resolve();
  };
  let hold = false;
  let rejected = false;
  const failure = new RhiError({
    code: 'webgpu-runtime-error',
    expected: 'candidate test native pipeline compilation completes',
    hint: 'deliberate candidate pipeline rejection',
  });
  const releases: (() => void)[] = [];
  const held: RenderPipelineDescriptor[] = [];
  const created = new Map<RenderPipelineDescriptor, RhiRenderPipeline>();
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
      pipeline !== undefined && pipeline !== standardPipeline
        ? descriptor.fragment?.entryPoint === 'fs_main'
        : pass === 'color'
          ? descriptor.fragment?.entryPoint === 'fs_gbuffer'
          : pass === 'transmission'
            ? ['fs_main', 'fs_opaque'].includes(descriptor.fragment?.entryPoint ?? '')
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
  const shaderManifestUrl = candidateShaderManifestUrl();
  const canvas = {
    width: 64,
    height: 64,
    getContext: () => null,
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLCanvasElement;
  const host = await createRenderer(
    canvas,
    {
      ...(published ? { publicationSource: identity } : {}),
      ...(pipeline === undefined ? {} : { pipeline }),
      features,
      rhi: {
        ...rhi,
        ...(asyncModules
          ? {
              createShaderModuleImmediate: undefined,
              createShaderModule: async (...args: Parameters<typeof rhi.createShaderModule>) => {
                if (holdModules) {
                  heldModules.push(args[1].label ?? 'unlabeled');
                  await new Promise<void>((resolve) => moduleReleases.push(resolve));
                }
                return rhi.createShaderModule(...args);
              },
            }
          : {}),
        requestAdapter: async () =>
          ok({
            features: new Set<GPUFeatureName>(),
            limits: {},
            requestDevice: async () => ok(device),
          }),
      },
    },
    { shaderManifestUrl },
  );
  const initialized = await host.initialization;
  if (!initialized.ok)
    throw new Error(`renderer initialization failed: ${String(initialized.error)}`);
  const errors: unknown[] = [];
  host.onError((error) => errors.push(error));
  const renderer = exposeRenderer(host);
  expect(
    renderer.setProfile({ ...renderer.inspect().profile, renderPath: 'deferred', ssao: false }).ok,
  ).toBe(true);
  const assets = host.assetRegistry;
  const world = new World({ assets });
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
  const previous = assets.create(mesh).unwrap();
  const next = assets.create(candidateMesh).unwrap();
  const materialAsset = unlit
    ? Materials.unlit([0.8, 0.5, 0.2, 1])
    : Materials.standard({
        baseColor: [0.8, 0.5, 0.2, 1],
        roughness: 0.6,
        metallic: 0.1,
      });
  const material = assets.create(materialAsset).unwrap();
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
  const submit = async () => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    const candidate = publisher?.prepare(0).unwrap();
    const packet =
      candidate === undefined
        ? undefined
        : structuredClone(candidate.packet, {
            transfer: renderPublicationTransfers(candidate.message),
          });
    candidate?.accept();
    const request =
      packet !== undefined
        ? { publication: encodeRenderPublication(packet) }
        : lease === undefined
          ? undefined
          : { leases: [lease], camera: { lease }, environment: { lease } };
    if (request === undefined) throw new Error('missing frame owner');
    const drawn = renderer.draw(pointShadow ? { ...request, geometryLane: 'direct' } : request);
    if (!drawn.ok)
      throw new Error(
        `renderer draw failed: ${String(drawn.error)}; errors=${JSON.stringify(errors)}`,
      );
    const receipt = drawn.value;
    return {
      receipt,
      recycle: () => {
        if (packet === undefined) return;
        const transfer = renderPublicationTransfers(encodeRenderPublication(packet));
        publisher?.recycle(packet.revision, structuredClone(transfer, { transfer })).unwrap();
      },
    };
  };
  const draw = async () => {
    const submitted = await submit();
    expect((await submitted.receipt.completed).ok).toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    submitted.recycle();
    return submitted.receipt;
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
    host,
    errors,
    canvas,
    assets: host.assetRegistry,
    world,
    entity,
    camera,
    queue,
    material,
    previous,
    next,
    candidateMesh,
    lease,
    submit,
    draw,
    held,
    created,
    asyncPipelines,
    heldModules,
    holdModules: () => {
      holdModules = true;
    },
    releaseModules,
    release,
    reject: () => {
      rejected = true;
    },
    asyncHost: createAsyncDynamicGeometryHost(renderer),
    input: { world, entity, meshHandle: next, revision: 1 },
    publishedInput: (
      candidateEntity = entity,
      candidateHandle = next,
      candidateAsset = candidateMesh,
    ) => ({
      ...identity,
      meshHandle: candidateHandle,
      revision: runtimeAssets(assets).version(candidateHandle).unwrap(),
      mesh: candidateAsset,
      pipelinePreparation: captureMeshPipelinePreparation({
        world,
        entity: candidateEntity,
        meshHandle: candidateHandle,
        mesh: candidateAsset,
        assets: host.assetRegistry,
        capabilities: device.caps,
      }).unwrap(),
    }),
    dispose: async () => {
      releaseModules();
      release();
      await renderer.dispose();
      publisher?.dispose();
    },
  };
}

it('keeps the accepted graph when a real custom scene pipeline waits for its PSO', async () => {
  const f = await fixture('color', false, false, false, false, [], standardPipeline);
  const renderer = f.renderer;
  const draws = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'drawIndexed');
  const indirectDraws = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'drawIndexedIndirect');
  const acquire = vi.spyOn(RhiNullCanvasContext.prototype, 'getCurrentTexture');
  let releaseBarrierFence: (() => void) | undefined;
  let releaseCandidateFence: (() => void) | undefined;
  let restoreQueueSubmit: (() => void) | undefined;
  const acceptedGraph = () => renderer.inspect().recoveryEvidence.graph;
  const acceptedPublications = () => {
    const inspection = renderer.inspect();
    return {
      temporal: inspection.temporal,
      reflectionProbes: inspection.reflectionProbes,
      output: {
        graphPassNames: inspection.output.graphPassNames,
        standardOutputColor: inspection.output.standardOutputColor,
        surfaceStorage: inspection.output.surfaceStorage,
        endpoint: inspection.output.endpoint,
      },
      observation: {
        passNames: inspection.observation.passNames,
        standardOutputColor: inspection.observation.standardOutputColor,
        resourceStats: inspection.observation.resourceStats,
      },
    };
  };
  try {
    const before = acceptedGraph();
    if (!before.ready) throw new Error('custom scene graph has no active generation');
    const graphGenerationBefore = before.generation;
    const allocationsBefore = renderer.inspect().renderGraphGenerationAllocation;
    const observationBefore = renderer.inspect().observation;
    const publicationsBefore = acceptedPublications();
    const frameCountersBefore = {
      submissions: renderer.inspect().recoveryEvidence.submissions,
      receipts: renderer.inspect().recoveryEvidence.receipts,
    };
    const encodedBefore = draws.mock.calls.length + indirectDraws.mock.calls.length;
    const acquiredBefore = acquire.mock.calls.length;
    const widthBefore = f.canvas.width;
    f.canvas.width = widthBefore + 8;
    f.canvas.height += 4;
    f.world.set(f.entity, MeshFilter, { assetHandle: f.next }).unwrap();
    const queueSubmit = vi.spyOn(f.queue, 'submit').mockImplementationOnce(() =>
      err(
        new RhiError({
          code: 'queue-submit-failed',
          expected: 'the actual RhiNull pipeline-barrier submission is accepted',
          hint: 'retry after the one-shot queue submission failure is removed',
        }),
      ),
    );
    restoreQueueSubmit = () => queueSubmit.mockRestore();
    let rejectedSubmission: unknown;
    try {
      await f.submit();
    } catch (cause) {
      rejectedSubmission = cause;
    }
    expect(queueSubmit).toHaveBeenCalledTimes(1);
    restoreQueueSubmit();
    restoreQueueSubmit = undefined;
    expect(rejectedSubmission).toBeDefined();
    expect(f.errors).toContainEqual(expect.objectContaining({ code: 'queue-submit-failed' }));
    expect(acceptedGraph()).toEqual(before);
    expect(acceptedPublications()).toEqual(publicationsBefore);
    expect({
      submissions: renderer.inspect().recoveryEvidence.submissions,
      receipts: renderer.inspect().recoveryEvidence.receipts,
    }).toEqual(frameCountersBefore);
    expect(
      renderer
        .inspect()
        .renderGraphGenerationAllocation?.entries.find(
          (entry) => entry.generation === graphGenerationBefore,
        ),
    ).toEqual(
      allocationsBefore?.entries.find((entry) => entry.generation === graphGenerationBefore),
    );
    expect(acquire).toHaveBeenCalledTimes(acquiredBefore);
    expect(draws.mock.calls.length + indirectDraws.mock.calls.length).toBe(encodedBefore);

    releaseBarrierFence = f.queue.holdCompletions();
    const barrier = await f.submit();
    const pending = barrier.receipt;
    expect(pending.presentation).toBe('pending');
    expect(pending.presentationPendingReason?.code).toBe('scene-pipeline-preparation');
    expect(f.held.some((descriptor) => newLayout(descriptor))).toBe(true);
    expect(acceptedGraph()).toEqual(before);
    expect(
      renderer
        .inspect()
        .renderGraphGenerationAllocation?.entries.find(
          (entry) => entry.generation === graphGenerationBefore,
        ),
    ).toEqual(
      allocationsBefore?.entries.find((entry) => entry.generation === graphGenerationBefore),
    );
    expect(renderer.inspect().observation.frameId).toBe(pending.frameId);
    expect(renderer.inspect().observation.frameId).toBeGreaterThan(observationBefore.frameId);
    expect(renderer.inspect().observation.passNames).toEqual(observationBefore.passNames);
    expect(acceptedPublications()).toEqual(publicationsBefore);
    expect(renderer.inspect().perFramePassNames).toEqual([]);
    expect(acquire).toHaveBeenCalledTimes(acquiredBefore);
    expect(draws.mock.calls.length + indirectDraws.mock.calls.length).toBe(encodedBefore);
    expect(acceptedGraph()).toEqual(before);
    let barrierCompleted = false;
    void pending.completed.then(() => {
      barrierCompleted = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(barrierCompleted).toBe(false);
    releaseBarrierFence();
    releaseBarrierFence = undefined;
    expect((await pending.completed).ok).toBe(true);
    barrier.recycle();

    f.release();
    releaseCandidateFence = f.queue.holdCompletions();
    const recoverySubmissions: Awaited<ReturnType<typeof f.submit>>[] = [];
    let ready: Awaited<ReturnType<typeof f.submit>> | undefined;
    for (let frame = 0; frame < 60 && ready === undefined; frame++) {
      const submitted = await f.submit();
      recoverySubmissions.push(submitted);
      if (submitted.receipt.presentation === 'ready') ready = submitted;
      else
        expect(submitted.receipt.presentationPendingReason?.code).toBe(
          'scene-pipeline-preparation',
        );
    }
    if (ready === undefined) throw new Error('candidate pipeline did not recover within 60 draws');
    expect(draws.mock.calls.length + indirectDraws.mock.calls.length).toBeGreaterThan(
      encodedBefore,
    );
    const replacement = acceptedGraph();
    if (!replacement.ready || replacement.generation === graphGenerationBefore)
      throw new Error('ready scene graph did not promote its candidate generation');
    const retiring = renderer
      .inspect()
      .renderGraphGenerationAllocation?.entries.find(
        (entry) => entry.roles.includes('retiring') && entry.generation === graphGenerationBefore,
      );
    expect(retiring?.retirement).toBe('pending');
    let readyCompleted = false;
    void ready.receipt.completed.then(() => {
      readyCompleted = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(readyCompleted).toBe(false);
    expect(
      renderer
        .inspect()
        .renderGraphGenerationAllocation?.entries.some(
          (entry) => entry.generation === graphGenerationBefore,
        ),
    ).toBe(true);
    releaseCandidateFence();
    releaseCandidateFence = undefined;
    for (const submitted of recoverySubmissions) {
      expect((await submitted.receipt.completed).ok).toBe(true);
      submitted.recycle();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      renderer
        .inspect()
        .renderGraphGenerationAllocation?.entries.some(
          (entry) => entry.generation === graphGenerationBefore,
        ),
    ).toBe(false);
  } finally {
    restoreQueueSubmit?.();
    releaseBarrierFence?.();
    releaseCandidateFence?.();
    acquire.mockRestore();
    draws.mockRestore();
    indirectDraws.mockRestore();
    f.release();
    await f.dispose();
  }
});

it('retains the accepted picture while a real equirect producer is pending', async () => {
  const f = await fixture('color');
  const draws = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'drawIndexed');
  const indirectDraws = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'drawIndexedIndirect');
  const acquire = vi.spyOn(RhiNullCanvasContext.prototype, 'getCurrentTexture');
  const upload = vi.spyOn(GpuResidencyCache.prototype, '_uploadCubemapFromEquirect');
  const status = vi.spyOn(GpuResidencyCache.prototype, 'getCubemapStatus');
  let releaseFence: (() => void) | undefined;
  const acceptedPublications = () => {
    const inspection = f.renderer.inspect();
    return {
      temporal: inspection.temporal,
      reflectionProbes: inspection.reflectionProbes,
      output: {
        graphPassNames: inspection.output.graphPassNames,
        standardOutputColor: inspection.output.standardOutputColor,
        surfaceStorage: inspection.output.surfaceStorage,
        endpoint: inspection.output.endpoint,
      },
      observation: {
        passNames: inspection.observation.passNames,
        standardOutputColor: inspection.observation.standardOutputColor,
        resourceStats: inspection.observation.resourceStats,
      },
    };
  };
  try {
    const acceptedGraph = f.renderer.inspect().recoveryEvidence.graph;
    const acceptedAllocations = f.renderer.inspect().renderGraphGenerationAllocation;
    const previousObservation = f.renderer.inspect().observation;
    const previousPublications = acceptedPublications();
    const previousDrawCount = draws.mock.calls.length + indirectDraws.mock.calls.length;
    const previousAcquisitions = acquire.mock.calls.length;
    expect(acceptedGraph.ready).toBe(true);
    expect(f.renderer.inspect().barrelDistortion.extent).toEqual({
      width: f.canvas.width,
      height: f.canvas.height,
    });
    f.assets.installDecoder(equirectContribution.kind, equirectContribution.decoder);
    const source = f.assets
      .create({
        kind: 'equirect',
        width: 4,
        height: 2,
        format: 'rgba16float',
        colorSpace: 'linear',
        data: new Uint8Array(64),
      })
      .unwrap();
    f.world.spawn({ component: Skylight, data: { equirect: source } }).unwrap();
    releaseFence = f.queue.holdCompletions();

    const barrier = await f.submit();
    const pending = barrier.receipt;
    expect(pending.presentation).toBe('pending');
    expect(upload).toHaveBeenCalledTimes(1);
    expect(Number(upload.mock.calls[0]?.[1])).toBe(Number(source));
    expect(status.mock.results.some((result) => result.value === 'pending')).toBe(true);
    expect(f.renderer.inspect().recoveryEvidence.graph).toEqual(acceptedGraph);
    expect(acceptedPublications()).toEqual(previousPublications);
    expect(
      f.renderer
        .inspect()
        .renderGraphGenerationAllocation?.entries.find(
          (entry) => entry.generation === acceptedGraph.generation,
        ),
    ).toEqual(
      acceptedAllocations?.entries.find((entry) => entry.generation === acceptedGraph.generation),
    );
    expect(f.renderer.inspect().perFramePassNames).toEqual([]);
    expect(f.renderer.inspect().observation.passNames).toEqual(previousObservation.passNames);
    expect(acquire).toHaveBeenCalledTimes(previousAcquisitions);
    expect(draws.mock.calls.length + indirectDraws.mock.calls.length).toBe(previousDrawCount);
    let barrierCompleted = false;
    void pending.completed.then(() => {
      barrierCompleted = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(barrierCompleted).toBe(false);

    const projection = upload.mock.results[0]?.value;
    if (projection === undefined) throw new Error('equirect projection did not return its promise');
    releaseFence();
    releaseFence = undefined;
    expect((await pending.completed).ok).toBe(true);
    barrier.recycle();
    expect((await projection).ok).toBe(true);
    const resumed = await f.draw();
    expect(resumed.presentation).toBe('ready');
    expect(status.mock.results.some((result) => result.value === 'ready')).toBe(true);
    expect(f.renderer.inspect().recoveryEvidence.graph.ready).toBe(true);
    expect(f.renderer.inspect().perFramePassNames.length).toBeGreaterThan(0);
    expect(draws.mock.calls.length + indirectDraws.mock.calls.length).toBeGreaterThan(
      previousDrawCount,
    );
    expect(f.errors).toEqual([]);
  } finally {
    releaseFence?.();
    status.mockRestore();
    upload.mockRestore();
    acquire.mockRestore();
    draws.mockRestore();
    indirectDraws.mockRestore();
    await f.dispose();
  }
});

it('keeps preparation-barrier production state identical with Cluster conformance off or on', async () => {
  const run = async (conformanceEnabled: boolean) => {
    const f = await fixture('color', false, false, false, false, [], standardPipeline);
    let releaseFence: (() => void) | undefined;
    try {
      f.host.setClusterWorkObservationForConformance(conformanceEnabled);
      const productionFacts = () => {
        const inspection = f.renderer.inspect();
        return {
          graph: inspection.recoveryEvidence.graph,
          temporal: inspection.temporal,
          reflectionProbes: inspection.reflectionProbes,
          output: {
            graphPassNames: inspection.output.graphPassNames,
            standardOutputColor: inspection.output.standardOutputColor,
            surfaceStorage: inspection.output.surfaceStorage,
            endpoint: inspection.output.endpoint,
          },
          observation: {
            passNames: inspection.observation.passNames,
            standardOutputColor: inspection.observation.standardOutputColor,
            resourceStats: inspection.observation.resourceStats,
          },
        };
      };
      const before = productionFacts();
      const previousGeneration = before.graph.generation;
      f.canvas.width += 8;
      f.canvas.height += 4;
      f.world.set(f.entity, MeshFilter, { assetHandle: f.next }).unwrap();
      releaseFence = f.queue.holdCompletions();
      const barrier = await f.submit();
      expect(barrier.receipt.presentation).toBe('pending');
      expect(barrier.receipt.presentationPendingReason?.code).toBe('scene-pipeline-preparation');
      expect(productionFacts()).toEqual(before);
      releaseFence();
      releaseFence = undefined;
      expect((await barrier.receipt.completed).ok).toBe(true);
      barrier.recycle();
      f.release();

      let ready: Awaited<ReturnType<typeof f.submit>> | undefined;
      for (let frame = 0; frame < 60 && ready === undefined; frame++) {
        const submitted = await f.submit();
        expect((await submitted.receipt.completed).ok).toBe(true);
        if (submitted.receipt.presentation === 'ready') ready = submitted;
        else {
          expect(submitted.receipt.presentationPendingReason?.code).toBe(
            'scene-pipeline-preparation',
          );
          submitted.recycle();
        }
      }
      if (ready === undefined) throw new Error('pipeline barrier did not recover within 60 draws');
      expect(ready.receipt.presentation).toBe('ready');
      const after = productionFacts();
      expect(after.graph.ready).toBe(true);
      expect(after.graph.generation).toBeGreaterThan(previousGeneration);
      if (conformanceEnabled) expect(f.host.clusterWorkObservationForConformance()).toBeDefined();
      else expect(f.host.clusterWorkObservationForConformance()).toBeUndefined();
      ready.recycle();
      return after;
    } finally {
      releaseFence?.();
      f.release();
      await f.dispose();
    }
  };

  const withoutConformance = await run(false);
  const withConformance = await run(true);
  expect(withConformance).toEqual(withoutConformance);
});

async function drawUntil(f: Awaited<ReturnType<typeof fixture>>, condition: () => boolean) {
  for (let frame = 0; frame < 60 && !condition(); frame++)
    expect((await f.draw()).presentation).toBe('ready');
  expect(condition()).toBe(true);
}

it.each([
  false,
  true,
])('prepares a hidden mesh-owned material before its first visible weapon selection (publication: %s)', async (published) => {
  const f = await fixture('color', published);
  try {
    f.release();
    const mesh = f.assets
      .create({
        ...f.candidateMesh,
        materialSlots: [{ slotName: 'secondary', defaultMaterial: f.material }],
      })
      .unwrap();
    const secondary = f.world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [], preparePipelines: true } },
        { component: Visibility, data: { state: VisibilityStateValue.hidden } },
      )
      .unwrap();
    for (let frame = 0; frame < 12; frame++) await f.draw();
    expect(
      f.asyncPipelines.mock.calls.some(
        ([d]) => newLayout(d) && d.fragment?.entryPoint === 'fs_gbuffer',
      ),
    ).toBe(true);
    f.world.set(secondary, MeshRenderer, { preparePipelines: false }).unwrap();
    f.world
      .addComponent(f.entity, {
        component: Visibility,
        data: { state: VisibilityStateValue.hidden },
      })
      .unwrap();
    f.world.set(secondary, Visibility, { state: VisibilityStateValue.visible }).unwrap();
    f.asyncPipelines.mockClear();
    expect((await f.draw()).presentation).toBe('ready');
    expect(f.asyncPipelines).not.toHaveBeenCalled();
  } finally {
    await f.dispose();
  }
});

it.each([
  false,
  true,
])('retains an accepted mesh material when a visible rig becomes hidden preparation (publication: %s)', async (published) => {
  const f = await fixture('color', published);
  try {
    f.release();
    const mesh = f.assets
      .create({
        ...f.candidateMesh,
        materialSlots: [{ slotName: 'role', defaultMaterial: f.material }],
      })
      .unwrap();
    const rig = f.world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [] } },
        { component: Visibility, data: { state: VisibilityStateValue.visible } },
      )
      .unwrap();
    for (let frame = 0; frame < 12; frame++) await f.draw();
    f.world.set(rig, MeshRenderer, { preparePipelines: true }).unwrap();
    f.world.set(rig, Visibility, { state: VisibilityStateValue.hidden }).unwrap();
    let ready = false;
    for (let frame = 0; frame < 30 && !ready; frame++)
      ready = (await f.draw()).presentation === 'ready';
    expect(ready).toBe(true);
    f.world.set(rig, MeshRenderer, { preparePipelines: false }).unwrap();
    expect((await f.draw()).presentation).toBe('ready');
    f.world.despawn(rig).unwrap();
    expect((await f.draw()).presentation).toBe('ready');
  } finally {
    await f.dispose();
  }
});

it.each([
  'color',
  'shadow',
] as const)('retains the displayed surface while a newly visible %s pipeline compiles', async (pass) => {
  const f = await fixture(pass);
  const acquire = vi.spyOn(RhiNullCanvasContext.prototype, 'getCurrentTexture');
  try {
    f.world.set(f.entity, MeshFilter, { assetHandle: f.next }).unwrap();
    for (let frame = 0; frame < 3; frame++) {
      const pending = await f.draw();
      expect(f.held.length).toBeGreaterThan(0);
      expect(pending.presentation).toBe('pending');
      expect(['scene-pipeline-preparation', 'shadow-pipeline-preparation']).toContain(
        pending.presentationPendingReason?.code,
      );
      expect(acquire).not.toHaveBeenCalled();
    }
    f.release();
    let ready = false;
    for (let frame = 0; frame < 60 && !ready; frame++) {
      const receipt = await f.draw();
      ready = receipt.presentation === 'ready';
      if (!ready) expect(acquire).not.toHaveBeenCalled();
    }
    expect(ready).toBe(true);
    expect(acquire).toHaveBeenCalled();
  } finally {
    acquire.mockRestore();
    await f.dispose();
  }
});

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
    const standard = f.assets
      .create(
        Materials.standard({
          baseColor: [1, 1, 1, 1],
          roughness: 0.6,
          metallic: 0.1,
        }),
      )
      .unwrap();
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
    const [firstPass, ...remainingPasses] = original.passes.map((pass) =>
      pass.name === 'forward' ? { ...pass, program: { module: shader } } : pass,
    );
    if (firstPass === undefined) throw new Error('missing Standard material pass');
    const material = f.assets
      .create({
        ...original,
        passes: [firstPass, ...remainingPasses],
      })
      .unwrap();
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
  'asset',
  'binding',
] as const)('reads pending candidate currentness without scanning after %s changes', async (edit) => {
  const f = await fixture('color');
  const replacement = f.assets.create(Materials.unlit([1, 0, 0, 1])).unwrap();
  const capture = vi.fn(() => ok(f.publishedInput().pipelinePreparation));
  const residencyToken = Object.freeze({});
  let complete!: (result: Awaited<ReturnType<DynamicGeometryResidencyPort['prepare']>>) => void;
  const host = createDynamicGeometrySourceHost({
    lifecycle: createDynamicGeometryLifecycle(),
    attachedWorlds: new Set([f.world]),
    currentGeneration: () => 1,
    isConsumedByRenderFrame: () => false,
    capturePipelinePreparation: capture,
    residency: {
      maxConcurrentPreparations: 1,
      currentnessToken: () => residencyToken,
      prepare: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    },
  });
  const reads = vi.spyOn(f.world, 'get');
  try {
    const pending = host.prepareDynamicGeometry(f.input);
    await Promise.resolve();
    expect(capture).toHaveBeenCalledTimes(1);
    const before = host.dynamicGeometryCurrentness?.(f.world);
    expect(before).toBeDefined();
    if (edit === 'asset')
      f.assets.update(f.material, { values: { baseColor: [0.1, 0.4, 0.8, 1] } }).unwrap();
    else f.world.set(f.entity, MeshRenderer, { materials: [replacement] }).unwrap();
    reads.mockClear();
    capture.mockClear();
    const current = host.dynamicGeometryCurrentness?.(f.world);
    expect(current).not.toBe(before);
    for (let repeat = 0; repeat < 64; repeat++)
      expect(host.dynamicGeometryCurrentness?.(f.world)).toBe(current);
    expect(reads).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    complete(ok({ isCurrent: () => true, release: () => undefined }));
    const candidate = await pending;
    // The actual candidate checks its own material proof on completion: a
    // numeric edit keeps it valid, while a changed binding rejects adoption.
    expect(candidate.ok).toBe(edit === 'asset');
    expect(reads).toHaveBeenCalled();
    if (candidate.ok) host.cancelDynamicGeometry(candidate.value).unwrap();
  } finally {
    reads.mockRestore();
    complete(ok({ isCurrent: () => true, release: () => undefined }));
    host.invalidateDynamicGeometryWorld(f.world);
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
    f.assets
      .update(f.material, {
        values: edit === 'uniform' ? { baseColor: [0.1, 0.4, 0.8, 1] } : { alphaHash: 1 },
      })
      .unwrap();
    f.world.update(1 / 60).unwrap();
    if (edit === 'alpha-mask') {
      const preparation = f.publishedInput().pipelinePreparation;
      expect(
        preparation.materials.find(({ id }) => id === preparation.template.snapshot.material)?.value
          .paramSnapshot?.alphaHash,
      ).toBe(1);
    }
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

function hiddenTransmissionCandidate(f: Awaited<ReturnType<typeof fixture>>) {
  const material = f.assets
    .create(
      Materials.standard({
        baseColor: [0.2, 0.6, 0.8, 1],
        transmission: 0.25,
        roughness: 0.6,
      }),
    )
    .unwrap();
  const mesh = {
    ...f.candidateMesh,
    materialSlots: f.candidateMesh.materialSlots.map((slot) => ({
      ...slot,
      defaultMaterial: material,
    })),
  };
  const handle = f.assets.create(mesh).unwrap();
  const entity = f.world
    .spawn(
      { component: Transform, data: { pos: [2, 0, 0] } },
      { component: MeshFilter, data: { assetHandle: handle } },
      { component: MeshRenderer, data: {} },
      { component: Visibility, data: { state: VisibilityStateValue.hidden } },
    )
    .unwrap();
  return { entity, input: () => structuredClone(f.publishedInput(entity, handle, mesh)) };
}

it('prepares a hidden first transmission candidate before its scene publication creates backdrop demand', async () => {
  const f = await fixture('transmission', true);
  try {
    const material = f.assets
      .create(
        Materials.standard({
          baseColor: [0.2, 0.6, 0.8, 1],
          transmission: 0.25,
          roughness: 0.6,
        }),
      )
      .unwrap();
    const chunk = f.world
      .spawn(
        { component: Transform, data: { pos: [2, 0, 0] } },
        { component: MeshFilter, data: { assetHandle: f.next } },
        { component: MeshRenderer, data: { materials: [material] } },
        { component: Visibility, data: { state: VisibilityStateValue.hidden } },
      )
      .unwrap();
    expect((await f.draw()).presentation).toBe('ready');
    expect(f.renderer.inspect().perFramePassNames).not.toContain('transmission-forward');
    let settled: Awaited<ReturnType<typeof f.renderer.preparePublishedMeshResidency>> | undefined;
    const pending = f.renderer
      .preparePublishedMeshResidency(structuredClone(f.publishedInput(chunk)), 'received')
      .then((result) => {
        settled = result;
        return result;
      });
    for (let frame = 0; frame < 60 && f.held.length === 0 && settled === undefined; frame++)
      await f.draw();
    if (settled !== undefined && !settled.ok) throw settled.error;
    expect(f.held.length).toBeGreaterThan(0);
    expect(settled).toBeUndefined();
    expect(f.world.get(chunk, Visibility).unwrap().state).toBe(VisibilityStateValue.hidden);
    f.release();
    for (let frame = 0; frame < 60 && settled === undefined; frame++) await f.draw();
    const prepared = (await pending).unwrap();
    expect(prepared.isCurrent()).toBe(true);
    expect(prepared.recordStageLane(await f.draw(), chunk).unwrap()).toBeUndefined();
    f.world.removeComponent(chunk, Visibility).unwrap();
    let visible = await f.draw();
    for (let frame = 0; frame < 60 && visible.presentation !== 'ready'; frame++)
      visible = await f.draw();
    expect(visible.presentation).toBe('ready');
    expect(f.renderer.inspect().perFramePassNames).toContain('transmission-forward');
    expect(prepared.recordStageLane(visible, chunk).unwrap()).toBeDefined();
    await prepared.release();
  } finally {
    await f.dispose();
  }
});

it('retains only live candidate topology demand across cancellation, preparation and release', async () => {
  const f = await fixture('transmission', true);
  try {
    const first = hiddenTransmissionCandidate(f),
      second = hiddenTransmissionCandidate(f);
    expect((await f.draw()).presentation).toBe('ready');
    const controller = new AbortController();
    const cancelled = f.renderer.preparePublishedMeshResidency(first.input(), 'received', {
      signal: controller.signal,
    });
    let settled: Awaited<ReturnType<typeof f.renderer.preparePublishedMeshResidency>> | undefined;
    const pending = f.renderer
      .preparePublishedMeshResidency(second.input(), 'received')
      .then((result) => {
        settled = result;
        return result;
      });
    for (let frame = 0; frame < 60 && f.held.length === 0 && settled === undefined; frame++)
      await f.draw();
    expect(f.held.length).toBeGreaterThan(0);
    controller.abort();
    expect((await cancelled).ok).toBe(false);
    f.release();
    for (let frame = 0; frame < 60 && settled === undefined; frame++) await f.draw();
    const prepared = (await pending).unwrap();
    expect(prepared.isCurrent()).toBe(true);
    for (let frame = 0; frame < 3; frame++) await f.draw();
    expect(f.renderer.inspect().perFramePassNames).toContain('transmission-forward');
    expect(prepared.isCurrent()).toBe(true);
    expect(prepared.recordStageLane(await f.draw(), second.entity).unwrap()).toBeUndefined();
    await prepared.release();
    expect(prepared.isCurrent()).toBe(false);
    await f.draw();
    expect(f.renderer.inspect().perFramePassNames).not.toContain('transmission-forward');
  } finally {
    await f.dispose();
  }
});

it('invalidates prepared candidate raster credentials when the actual graph is replaced', async () => {
  const f = await fixture('transmission', true);
  try {
    const candidate = hiddenTransmissionCandidate(f);
    await f.draw();
    f.release();
    let settled = false;
    const pending = f.renderer
      .preparePublishedMeshResidency(candidate.input(), 'received')
      .then((result) => {
        settled = true;
        return result;
      });
    for (let frame = 0; frame < 60 && !settled; frame++) await f.draw();
    const prepared = (await pending).unwrap();
    expect(prepared.isCurrent()).toBe(true);
    f.world.set(f.camera, Camera, { antialias: ANTIALIAS_FXAA }).unwrap();
    for (let frame = 0; frame < 30 && prepared.isCurrent(); frame++) await f.draw();
    expect(f.renderer.inspect().perFramePassNames).toContain('fxaa');
    expect(prepared.isCurrent()).toBe(false);
    await prepared.release();
  } finally {
    await f.dispose();
  }
});

it('keeps a published candidate pending while its validated shader module is compiling', async () => {
  const f = await fixture('color', true, false, false, true);
  try {
    f.release();
    const shader = 'game::pending-candidate-module';
    f.assets.shaderRegistry.installMaterialArtifact(shader, {
      source: `${rasterDeclarations}\n// candidate async module`,
      paramSchema: STANDARD_PIPELINE_PARAM_SCHEMA,
      receipt: createStandardPbrArtifactReceipt(false, true),
    });
    const original = Materials.standard({ baseColor: [0.2, 0.6, 0.8, 1] });
    if (original.passes === undefined) throw Error('Missing Standard passes');
    const passes = original.passes.map((pass) =>
      pass.name === 'forward' ? { ...pass, program: { module: shader } } : pass,
    );
    const firstPass = passes[0];
    if (firstPass === undefined) throw Error('Missing Standard passes');
    const material = f.assets
      .create({ ...original, passes: [firstPass, ...passes.slice(1)] })
      .unwrap();
    const chunk = f.world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: f.next } },
        { component: MeshRenderer, data: { materials: [material] } },
        { component: Visibility, data: { state: VisibilityStateValue.hidden } },
      )
      .unwrap();
    expect((await f.draw()).presentation).toBe('ready');
    f.holdModules();
    let settled = false;
    const pending = f.renderer
      .preparePublishedMeshResidency(structuredClone(f.publishedInput(chunk)), 'received')
      .then((result) => {
        settled = true;
        return result;
      });
    for (let frame = 0; frame < 4; frame++) expect((await f.draw()).presentation).toBe('ready');
    expect(f.heldModules.length).toBeGreaterThan(0);
    expect(settled).toBe(false);
    f.releaseModules();
    const prepared = (await finish(f, pending)).unwrap();
    expect(prepared.isCurrent()).toBe(true);
    await prepared.release();
  } finally {
    await f.dispose();
  }
});

it('does not acknowledge view Feature work when a native PSO submits only a preparation barrier', async () => {
  const submitted = vi.fn();
  const feature: RenderFeature<unknown> = {
    identity: 'view-barrier-receipt',
    extract: () => ok(undefined),
    plan: (_value, { views }) =>
      ok({
        work: views.map((view) => ({
          scope: { view: view.identity },
          resources: [],
          passes: [],
        })),
      }),
    onFrameSubmitted: submitted,
  };
  const f = await fixture('color', false, false, false, false, [feature]);
  try {
    expect(submitted).toHaveBeenCalled();
    submitted.mockClear();
    f.world.set(f.entity, MeshFilter, { assetHandle: f.next }).unwrap();
    const pending = await f.draw();
    expect(f.held.length).toBeGreaterThan(0);
    expect(pending.presentation).toBe('pending');
    expect(submitted).not.toHaveBeenCalled();
    f.release();
    let ready = false;
    for (let frame = 0; frame < 10 && !ready; frame++)
      ready = (await f.draw()).presentation === 'ready';
    expect(ready).toBe(true);
    expect(submitted).toHaveBeenCalledTimes(1);
  } finally {
    await f.dispose();
  }
});

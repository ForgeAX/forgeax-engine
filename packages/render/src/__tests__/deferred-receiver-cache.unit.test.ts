import { vec3 } from '@forgeax/engine-math';
import { type RasterGraphPass, RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { type Buffer, RhiError } from '@forgeax/engine-rhi';
import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-null';
import { err, ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { DeviceScope } from '../device/device-scope';
import { getOrCreateHdrpBuffers, resetHdrpBuffers } from '../hdrp-buffers';
import { MaterialResource } from '../material-resource';
import { addStandardDeferredLighting } from '../pipeline/standard-deferred-lighting';
import { buildPerFrameBindGroups, buildViewBindGroup } from '../record/frame-lighting';
import { prepareMaterialSkylight } from '../record/main-pass-material';
import type {
  _InternalRenderPipelineContext,
  RenderSystemInternals,
} from '../record/render-context';
import type { RenderPipelineFrame } from '../render-pipeline';
import { resetSsaoResources } from '../ssao-buffers';
import { createStandardSceneSurfaceAdmission } from '../temporal/standard-scene-data-admission';
import { STANDARD_CLUSTER_TEST_ABI } from './cluster-test-abi';

vi.mock('../record/frame-lighting', () => ({
  buildPerFrameBindGroups: vi.fn(),
  buildViewBindGroup: vi.fn(),
}));
vi.mock('../record/main-pass-material', () => ({ prepareMaterialSkylight: vi.fn() }));

async function fixture(options: { readonly clustered?: boolean } = {}) {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const texture = device
    .createTexture({ size: { width: 1, height: 1 }, format: 'r32uint', usage: 4 })
    .unwrap();
  const stable = device.createTextureView(texture, {}).unwrap();
  const replacement = device.createTextureView(texture, {}).unwrap();
  const buffer = device.createBuffer({ size: 256, usage: 0x40 | 0x80 }).unwrap();
  const sampler = device.createSampler({}).unwrap();
  const layout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const group = device.createBindGroup({ layout, entries: [] }).unwrap();
  vi.mocked(buildPerFrameBindGroups).mockReturnValue({ viewBindGroup: group } as ReturnType<
    typeof buildPerFrameBindGroups
  >);
  vi.mocked(buildViewBindGroup).mockImplementation(
    (runtime, state, pipeline, counts, targets) =>
      buildPerFrameBindGroups(runtime, state, pipeline, true, counts, targets).viewBindGroup,
  );
  vi.mocked(prepareMaterialSkylight).mockReturnValue({
    skylightResources: {
      irradianceView: stable,
      prefilterView: stable,
      brdfLutView: stable,
      irradianceSampler: sampler,
      prefilterSampler: sampler,
      intensityBuffer: buffer,
    },
  } as ReturnType<typeof prepareMaterialSkylight>);
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const raster = vi.spyOn(graph, 'addRasterPass');
  const target = (name: string) => {
    const texture = graph
      .createTexture(name, { size: { width: 1, height: 1 }, format: 'r32uint' })
      .unwrap();
    return {
      texture,
      view: graph.view(texture, {}).unwrap(),
      format: 'r32uint' as const,
      sampleCount: 1 as const,
    };
  };
  const receiver = target('receiver');
  const surface = target('surface');
  let clusterIndex = 0;
  const clusterBuffer = () =>
    graph.createBuffer(`cluster-${clusterIndex++}`, { size: 256 }).unwrap();
  const cluster = options.clustered
    ? {
        kind: 'storage' as const,
        lightData: clusterBuffer(),
        clusterGrid: clusterBuffer(),
        lightIndexList: clusterBuffer(),
        clusterUniform: clusterBuffer(),
        lightBounds: clusterBuffer(),
      }
    : null;
  addStandardDeferredLighting(graph, {
    color: surface,
    gbuffer: [surface, surface, surface, surface],
    receiverGeometry: receiver,
    depth: surface.view,
    spotShadow: surface,
    cluster,
    extraAccesses: [],
    size: { width: 1, height: 1 },
  }).unwrap();
  const encode = raster.mock.calls.find(([name]) => name === 'lighting')?.[1].encodeDirect;
  expect(encode).toBeDefined();
  const frameState = {};
  const frame = {
    runtime: {
      device,
      deviceScope: DeviceScope.create(1, 'deferred-lut-test'),
      standardSceneShaders: {
        deferred: {
          unclustered: '',
          unclusteredLut: 'lut',
          clustered: 'cluster',
          clusteredLut: 'cluster-lut',
        },
      },
      shaderModuleFactory: {
        createShaderModule: (desc: Parameters<typeof createShaderModuleImmediate>[1]) =>
          createShaderModuleImmediate(device, desc),
      },
    },
    frameState,
    validatedOrdered: [],
    pipelineState: { viewBindGroupLayout: layout, defaultWhiteTextureView: stable },
    bindGroupCounts: { createBindGroup: 0, keys: [] },
  } as unknown as RenderPipelineFrame;
  const createGroup = vi.spyOn(device, 'createBindGroup');
  let receiverView = stable;
  let lightingView = stable;
  let passBuffer = buffer;
  const context = {
    frame,
    resources: {
      textureView: (ref: typeof receiver.view) =>
        ok(ref === receiver.view ? receiverView : lightingView),
      buffer: () => ok(passBuffer),
    },
    pass: { setPipeline: vi.fn(), setBindGroup: vi.fn(), draw: vi.fn() },
  } as unknown as Parameters<NonNullable<RasterGraphPass<RenderPipelineFrame>['encode']>>[0];
  return {
    device,
    frame,
    frameState,
    createGroup,
    context,
    encode,
    stable,
    replacement,
    buffer,
    sampler,
    layout,
    replaceReceiver: () => {
      receiverView = replacement;
    },
    replaceLightingView: () => {
      lightingView = replacement;
    },
    replacePassBuffer: (next: Buffer) => {
      passBuffer = next;
    },
    dispose: () => {
      device.destroyBuffer(buffer).unwrap();
      device.destroyTexture(texture).unwrap();
    },
  };
}

it('rebinds Deferred geometry when only the receiver texture view changes', async () => {
  const { createGroup, context, encode, replacement, replaceReceiver, dispose } = await fixture();
  encode?.(context.pass, context.frame, context.resources);
  const groups = () =>
    createGroup.mock.calls.filter(([desc]) =>
      Array.from(desc.entries).some((entry) => entry.binding === 15),
    );
  expect(groups()).toHaveLength(1);
  encode?.(context.pass, context.frame, context.resources);
  expect(groups()).toHaveLength(1);
  replaceReceiver();
  encode?.(context.pass, context.frame, context.resources);
  expect(groups()).toHaveLength(2);
  expect(
    Array.from(groups()[1]?.[0].entries ?? []).find((entry) => entry.binding === 15)?.resource,
  ).toEqual({
    kind: 'textureView',
    value: replacement,
  });
  expect(context.pass.setBindGroup).toHaveBeenCalledTimes(12);
  dispose();
});

it('retains the attachment pass but creates no lighting pipeline for a proven empty GBuffer', async () => {
  const { device, frameState, context, encode, dispose } = await fixture();
  const makePipeline = vi.spyOn(device, 'createRenderPipeline');
  const admission = createStandardSceneSurfaceAdmission({
    viewIdentity: 'main',
    generation: 1,
    deviceGeneration: 1,
    standardPipeline: true,
    cameraAvailable: true,
    lane: 'clustered',
    renderPath: 'deferred',
    contributors: [],
  });
  Object.assign(frameState, { standardSceneSurfaceAdmission: admission });
  encode?.(context.pass, context.frame, context.resources);
  expect(makePipeline).not.toHaveBeenCalled();
  expect(context.pass.draw).not.toHaveBeenCalled();
  // A cached graph must immediately resume lighting when current-view proof
  // is absent, or when an empty proof belongs to an older device generation.
  Object.assign(frameState, {
    standardSceneSurfaceAdmission: { ...admission, deviceGeneration: 0 },
  });
  encode?.(context.pass, context.frame, context.resources);
  expect(makePipeline).toHaveBeenCalledTimes(1);
  expect(context.pass.draw).toHaveBeenCalledTimes(1);
  Object.assign(frameState, { standardSceneSurfaceAdmission: undefined });
  encode?.(context.pass, context.frame, context.resources);
  expect(context.pass.draw).toHaveBeenCalledTimes(2);
  dispose();
});

it('switches fit → mixed LUT → fit without changing the fitted layout or reallocating the shared table', async () => {
  const { device, frame, context, encode, createGroup, dispose } = await fixture();
  const mutable = frame as unknown as {
    runtime: { deviceScope: DeviceScope };
    validatedOrdered: {
      source: { materials: MaterialResource[] };
    }[];
  };
  const upload = vi.spyOn(device.queue, 'writeTexture');
  const makePipeline = vi.spyOn(device, 'createRenderPipeline');
  encode?.(context.pass, context.frame, context.resources);
  expect(upload).not.toHaveBeenCalled();
  const fitPipeline = vi.mocked(context.pass.setPipeline).mock.calls.at(-1)?.[0];
  mutable.validatedOrdered = [
    {
      source: {
        materials: [
          new MaterialResource({
            baseColor: vec3.create(1, 1, 1),
            metallic: 0,
            roughness: 1,
            passes: [],
            materialParamSchema: [],
          }),
          new MaterialResource({
            baseColor: vec3.create(1, 1, 1),
            metallic: 0,
            roughness: 1,
            passes: [],
            materialParamSchema: [{ name: 'directMultiscatteringLut', type: 'u32' }],
          }),
        ],
      },
    },
  ];
  encode?.(context.pass, context.frame, context.resources);
  const lutPipeline = vi.mocked(context.pass.setPipeline).mock.calls.at(-1)?.[0];
  expect(lutPipeline).not.toBe(fitPipeline);
  expect(upload).toHaveBeenCalledTimes(1);
  const lutGroups = () =>
    createGroup.mock.calls.filter(([desc]) =>
      Array.from(desc.entries).some((entry) => entry.binding === 16),
    );
  expect(lutGroups()).toHaveLength(1);
  const lutView = Array.from(lutGroups()[0]?.[0].entries ?? []).find(
    (entry) => entry.binding === 16,
  )?.resource;
  expect(lutView).toMatchObject({ kind: 'textureView' });
  mutable.validatedOrdered = [];
  encode?.(context.pass, context.frame, context.resources);
  expect(vi.mocked(context.pass.setPipeline).mock.calls.at(-1)?.[0]).toBe(fitPipeline);
  expect(makePipeline).toHaveBeenCalledTimes(2);
  mutable.validatedOrdered = [
    {
      source: {
        materials: [
          new MaterialResource({
            baseColor: vec3.create(1, 1, 1),
            metallic: 0,
            roughness: 1,
            passes: [],
            materialParamSchema: [{ name: 'directMultiscatteringLut', type: 'u32' }],
          }),
        ],
      },
    },
  ];
  // Skylight can change while the same immutable direct-light table remains shared.
  const resources = prepareMaterialSkylight(frame as never).skylightResources;
  const alternateIntensity = device.createBuffer({ size: 64, usage: 64 | 8 }).unwrap();
  vi.mocked(prepareMaterialSkylight).mockReturnValue({
    skylightResources: {
      ...resources,
      intensityBuffer: alternateIntensity,
    },
  } as never);
  encode?.(context.pass, context.frame, context.resources);
  expect(upload).toHaveBeenCalledTimes(1);
  expect(lutGroups()).toHaveLength(2);
  expect(
    Array.from(lutGroups()[1]?.[0].entries ?? []).find((entry) => entry.binding === 16)?.resource,
  ).toEqual(lutView);
  mutable.runtime.deviceScope.dispose();
  device.destroyBuffer(alternateIntensity).unwrap();
  dispose();
});

/** Reuse the real deferred encode fixture with the production binding owner. */
async function actualBindingFixture() {
  const f = await fixture({ clustered: true });
  const actual = await vi.importActual<typeof import('../record/frame-lighting')>(
    '../record/frame-lighting',
  );
  vi.mocked(buildPerFrameBindGroups).mockImplementation(actual.buildPerFrameBindGroups);
  // The baseline has no View-only entry; its encode still invokes the original full owner.
  if (typeof actual.buildViewBindGroup === 'function')
    vi.mocked(buildViewBindGroup).mockImplementation(actual.buildViewBindGroup);
  const frame = f.frame as unknown as _InternalRenderPipelineContext;
  const error = vi.fn();
  const meshStorage = { buffer: f.buffer, sizeInBytes: 256 };
  const meshReads = vi.fn(() => meshStorage);
  const membershipReads = vi.fn(() => undefined);
  const abiReads = vi.fn(() => STANDARD_CLUSTER_TEST_ABI);
  Object.assign(frame.runtime, { errorRegistry: { fire: error } });
  Object.defineProperty(frame.runtime, 'standardClusterAbi', { configurable: true, get: abiReads });
  Object.assign(frame.frameState, {
    viewBindGroupCache: new WeakMap(),
    meshBindGroupCache: new WeakMap(),
  });
  Object.defineProperty(frame.frameState, 'hdrpClusterMembership', { get: membershipReads });
  Object.assign(frame.pipelineState, {
    perPassResources: { shadowSampler: f.sampler },
    viewUniformBuffer: f.buffer,
    shadowArrayFallbackTextureView: f.stable,
    shadowAtlasFallbackTextureView: f.stable,
    shadowParamsBuffer: f.buffer,
    shadowCasterCascadeBuffer: f.buffer,
    meshBindGroupLayout: f.layout,
    hdrpClusterMembershipBindGroupLayout: null,
    defaultSampler: f.sampler,
    extendedLightingAvailable: false,
    projectorAvailable: false,
  });
  Object.defineProperty(frame.pipelineState, 'meshStorageBuffer', { get: meshReads });
  Object.assign(frame, { standardLighting: { kind: 'clustered' } });
  const full = (hasValidated: boolean, includeView: boolean) =>
    actual.buildPerFrameBindGroups(
      frame.runtime as RenderSystemInternals,
      frame.frameState,
      frame.pipelineState,
      hasValidated,
      frame.bindGroupCounts,
      undefined,
      includeView,
      frame.standardLighting,
    );
  const dispose = () => {
    resetHdrpBuffers(frame.runtime);
    resetSsaoResources(frame.runtime);
    f.dispose();
  };
  return { ...f, frame, error, meshReads, membershipReads, abiReads, full, dispose };
}

it('does not resolve unused mesh, membership or unified groups in the real Deferred fullscreen encode', async () => {
  const f = await actualBindingFixture();
  try {
    // The unchanged full preparation owns cold HDRP allocation even without raster rows.
    const prepared = f.full(false, false);
    expect(prepared.viewBindGroup).toBeNull();
    expect(getOrCreateHdrpBuffers(f.frame.runtime)).not.toBeNull();
    f.abiReads.mockClear();
    f.membershipReads.mockClear();
    f.meshReads.mockClear();
    f.createGroup.mockClear();
    f.encode?.(f.context.pass, f.context.frame, f.context.resources);
    expect(f.context.pass.draw).toHaveBeenCalledOnce();
    expect(f.meshReads).not.toHaveBeenCalled();
    expect(f.membershipReads).not.toHaveBeenCalled();
    expect(f.abiReads).not.toHaveBeenCalled();
    const labels = f.createGroup.mock.calls.map(([descriptor]) => descriptor.label);
    expect(labels).toContain('pbr-view-bg');
    expect(labels).not.toContain('pbr-mesh-bg');
    expect(labels).not.toContain('hdrp-unified-bg-group2');
    expect(f.error).not.toHaveBeenCalled();
  } finally {
    f.dispose();
  }
});

it('keeps full geometry preparation flags and View failure ordering', async () => {
  const f = await actualBindingFixture();
  try {
    Object.assign(f.frame.pipelineState.perPassResources, { shadowSampler: null });
    const noRows = f.full(false, true);
    expect(noRows.viewBindGroup).toBeNull();
    expect(f.abiReads).toHaveBeenCalled();
    expect(f.meshReads).not.toHaveBeenCalled();
    const failedView = f.full(true, true);
    expect(failedView.viewBindGroup).toBeNull();
    expect(failedView.meshBindGroup).toBeNull();
    expect(f.meshReads).not.toHaveBeenCalled();
    const noView = f.full(true, false);
    expect(noView.viewBindGroup).toBeNull();
    expect(noView.meshBindGroup).not.toBeNull();
    expect(noView.hdrpClusterBindGroup).not.toBeNull();
  } finally {
    f.dispose();
  }
});

it.each([
  'shadow-sampler',
  'extended-lighting',
] as const)('preserves Deferred View rejection for missing %s', async (missing) => {
  const f = await actualBindingFixture();
  try {
    f.full(false, false);
    if (missing === 'shadow-sampler')
      Object.assign(f.frame.pipelineState.perPassResources, { shadowSampler: null });
    else Object.assign(f.frame.pipelineState, { extendedLightingAvailable: true });
    expect(() => f.encode?.(f.context.pass, f.context.frame, f.context.resources)).toThrow(
      'Standard view/shadow resources',
    );
    expect(f.context.pass.draw).not.toHaveBeenCalled();
    expect(f.meshReads).not.toHaveBeenCalled();
  } finally {
    f.dispose();
  }
});

it('keeps cold HDRP allocation failure and recovery in full preparation', async () => {
  const f = await actualBindingFixture();
  try {
    const failure = new RhiError({
      code: 'rhi-not-available',
      expected: 'fixture buffer',
      hint: 'retry',
    });
    const create = vi.spyOn(f.device, 'createBuffer').mockReturnValueOnce(err(failure));
    expect(f.full(false, false).viewBindGroup).toBeNull();
    expect(f.error).toHaveBeenCalledOnce();
    expect(f.error).toHaveBeenCalledWith(failure);
    expect(f.meshReads).not.toHaveBeenCalled();
    expect(f.full(false, false).viewBindGroup).toBeNull();
    expect(getOrCreateHdrpBuffers(f.frame.runtime)).not.toBeNull();
    expect(create.mock.calls.length).toBeGreaterThan(1);
    expect(f.error).toHaveBeenCalledTimes(1);
  } finally {
    f.dispose();
  }
});

it('rebinds actual Deferred View and buffer groups on current physical replacement', async () => {
  const f = await actualBindingFixture();
  const next = f.device.createBuffer({ size: 256, usage: 0x40 | 0x80 }).unwrap();
  try {
    f.full(false, false);
    const views = () =>
      f.createGroup.mock.calls.filter(([descriptor]) => descriptor.label === 'pbr-view-bg');
    f.encode?.(f.context.pass, f.context.frame, f.context.resources);
    f.encode?.(f.context.pass, f.context.frame, f.context.resources);
    expect(views()).toHaveLength(1);
    f.replaceLightingView();
    f.replacePassBuffer(next);
    f.encode?.(f.context.pass, f.context.frame, f.context.resources);
    expect(views()).toHaveLength(2);
    expect(
      Array.from(views()[1]?.[0].entries ?? []).find((entry) => entry.binding === 8)?.resource,
    ).toEqual({ kind: 'textureView', value: f.replacement });
    const bound = vi.mocked(f.context.pass.setBindGroup).mock.calls.filter(([slot]) => slot === 3);
    expect(bound[2]?.[1]).not.toBe(bound[1]?.[1]);
    expect(f.context.pass.draw).toHaveBeenCalledTimes(3);
    expect(f.error).not.toHaveBeenCalled();
  } finally {
    f.dispose();
    f.device.destroyBuffer(next).unwrap();
  }
});

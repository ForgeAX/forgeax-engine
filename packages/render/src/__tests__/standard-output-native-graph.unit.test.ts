import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { DeviceScope } from '../device/device-scope';
import { createRenderFeatureTarget } from '../features/targets';
import { GPU_TEXTURE_USAGE_COPY_SRC } from '../gpu-texture-usage';
import { importAutoExposureGraphResources } from '../pipeline/standard-output/auto-exposure/gpu';
import { createStandardLutState } from '../pipeline/standard-output/lut-state';
import {
  addNativeOutputParameters,
  addNativeOutputPass,
} from '../pipeline/standard-output/native-gpu';
import {
  disposeStandardOutput,
  ensureStandardOutputParameters,
  resetStandardOutputForDeviceLoss,
} from '../pipeline/standard-output/resources';
import { addStandardPost, inspectStandardBloomGraph } from '../pipeline/standard-post';
import { currentOutputDither } from '../record/display-ports';
import type { RenderFrameState } from '../record/frame-snapshot';
import { standardAfterTonemapOutput } from '../record/standard-feature-contribution';
import {
  createRenderPipelineTarget,
  type OutputDither,
  type RenderPipelineBuildContext,
  type RenderPipelineFrame,
  type RenderPipelineTopology,
} from '../render-pipeline';

async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const scope = DeviceScope.create(1, 'native-output-test');
  const module = rhi
    .createShaderModuleImmediate(device, { code: 'native-kernel-fixture' })
    .unwrap();
  const factory = { createShaderModule: () => ok(module) };
  const pipelines = vi.spyOn(device, 'createRenderPipeline');
  const groups = vi.spyOn(device, 'createBindGroup');
  const writes = vi.spyOn(device.queue, 'writeBuffer');
  const textures = vi.spyOn(device, 'createTexture');
  function build(dither: OutputDither = false) {
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const target = (name: string, format: 'rgba16float' | 'rgba8unorm' = 'rgba8unorm') =>
      createRenderPipelineTarget(graph, name, { size: 'surface', format }).unwrap();
    const scene = target('scene', 'rgba16float'),
      grade = target('grade'),
      output = target('output');
    graph
      .addRasterPass('scene', {
        accesses: [{ resource: scene.view, usage: 'color-attachment' }],
        colorAttachments: [{ view: scene.view, loadOp: 'clear', storeOp: 'store' }],
        encode() {},
      })
      .unwrap();
    const parameters = addNativeOutputParameters(graph, {
      bloomIntensity: 0,
      sharpen: 0,
      dither,
      finishInGrade: false,
    }).unwrap();
    addNativeOutputPass(graph, 'native-grade', scene, grade, parameters, {
      kind: 'grade',
    }).unwrap();
    addNativeOutputPass(graph, 'native-final', grade, output, parameters, {
      kind: 'final',
      fxaa: true,
    }).unwrap();
    return graph.compile({ device, surfaceSize: { width: 8, height: 8 } }).unwrap();
  }
  function frame(exposure: number, frameState: object = {}) {
    return {
      frameState,
      camera: { exposure, whitePoint: 3, tonemap: 'aces-filmic' },
      runtime: {
        device,
        deviceScope: scope,
        immediateShaderModuleFactory: factory,
        lookupPostProcess: () => ({ source: 'native-kernel-fixture' }),
      },
    } as unknown as RenderPipelineFrame;
  }
  return { device, scope, pipelines, groups, writes, textures, build, frame };
}

it('owns independent view uploads while retaining warm PSOs and bindings', async () => {
  const f = await fixture(),
    a = f.build(currentOutputDither),
    b = f.build(false);
  const config = { outputDither: true };
  const states = new Map([
    [a, { installedPipelineConfig: config }],
    [b, { installedPipelineConfig: config }],
  ]);
  const execute = (graph: typeof a, exposure: number) => {
    const encoder = f.device.createCommandEncoder().unwrap();
    graph.execute({ ...f.frame(exposure, states.get(graph)), encoder }).unwrap();
    f.device.queue.submit([encoder.finish().unwrap()]).unwrap();
  };
  try {
    execute(a, 0.5);
    execute(b, 2);
    expect(f.pipelines).toHaveBeenCalledTimes(2);
    expect(f.groups).toHaveBeenCalledTimes(4);
    const uploads = f.writes.mock.calls;
    expect(uploads).toHaveLength(2);
    expect(uploads[0]?.[0]).not.toBe(uploads[1]?.[0]);
    const uniform = (data: ArrayBuffer | ArrayBufferView | undefined) => {
      if (data === undefined) throw Error('Missing native upload');
      return ArrayBuffer.isView(data)
        ? new DataView(data.buffer, data.byteOffset, data.byteLength)
        : new DataView(data);
    };
    expect(uniform(uploads[0]?.[2]).getFloat32(4, true)).toBe(0.5);
    expect(uniform(uploads[1]?.[2]).getFloat32(4, true)).toBe(2);
    expect(uniform(uploads[0]?.[2]).getUint32(38 * 4, true)).toBe(1);
    expect(uniform(uploads[1]?.[2]).getUint32(38 * 4, true)).toBe(0);
    config.outputDither = false;
    execute(a, 0.75);
    expect(uniform(uploads[2]?.[2]).getUint32(38 * 4, true)).toBe(0);
    config.outputDither = true;
    execute(a, 0.5);
    expect(uniform(uploads[3]?.[2]).getUint32(38 * 4, true)).toBe(1);
    expect(f.pipelines).toHaveBeenCalledTimes(2);
    expect(f.groups).toHaveBeenCalledTimes(4);
    expect(a.inspect().passes.map(({ name }) => name)).toEqual([
      'scene',
      'standard-output-prepare',
      'native-grade',
      'native-final',
    ]);
  } finally {
    await f.device.queue.onSubmittedWorkDone();
    (await a.retire()).unwrap();
    (await b.retire()).unwrap();
    for (const state of states.values()) disposeStandardOutput(state as RenderFrameState);
    f.scope.dispose();
  }
});

it.each([
  'compute',
  'fragment',
] as const)('imports %s AE candidates for a direct same-frame Grade uniform read', async (execution) => {
  const f = await fixture(),
    graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const resources = importAutoExposureGraphResources(graph, execution).unwrap();
  graph
    .addRasterPass('candidate-consumer', {
      accesses: [{ resource: resources.candidate, usage: 'uniform-read' }],
      colorAttachments: [],
      encode() {},
    })
    .unwrap();
  const compiled = graph
    .compile({ device: f.device, surfaceSize: { width: 8, height: 8 } })
    .unwrap();
  try {
    const candidate = compiled
      .inspect()
      .resources.find((r) => r.label === 'standard-auto-exposure-candidate');
    expect(candidate?.descriptor).toMatchObject({ kind: 'buffer', size: 32 });
    expect(compiled.inspect().passes).toHaveLength(1);
  } finally {
    (await compiled.retire()).unwrap();
    f.scope.dispose();
  }
});

it('rejects unresolved MSAA inputs and incomplete Bloom at graph declaration', async () => {
  const f = await fixture(),
    graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const a = createRenderPipelineTarget(graph, 'a', {
    format: 'rgba16float',
    size: 'surface',
    sampleCount: 4,
  }).unwrap();
  const b = createRenderPipelineTarget(graph, 'b', {
    format: 'rgba8unorm',
    size: 'surface',
  }).unwrap();
  const parameters = graph.createBuffer('params', { size: 160 }).unwrap();
  expect(
    addNativeOutputPass(graph, 'invalid-msaa', a, b, parameters, { kind: 'grade' }),
  ).toMatchObject({ ok: false, error: { code: 'resource-descriptor-invalid' } });
  expect(
    addNativeOutputPass(graph, 'invalid-bloom', b, b, parameters, { kind: 'grade', bloom: a }),
  ).toMatchObject({ ok: false, error: { code: 'resource-descriptor-invalid' } });
  f.scope.dispose();
});

async function standardGraph(
  options: {
    native?: boolean;
    fxaa?: boolean;
    bloom?: boolean;
    packedBloom?: boolean;
    computeBloom?: boolean;
    bloomQuality?: 3 | 4 | 5;
    prefilter?: boolean;
    outline?: boolean;
    chromaticAberration?: boolean;
    smaa?: boolean;
    observation?: boolean;
    lensFlare?: boolean;
    lensEffects?: boolean;
    highPrecision?: boolean;
    afterTonemap?: boolean;
    directOverlay?: boolean;
    postEffects?: readonly string[];
    hdrOutputEffects?: readonly string[];
  } = {},
) {
  const f = await fixture(),
    graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const scene = createRenderPipelineTarget(graph, 'scene', {
    size: 'surface',
    format: 'rgba16float',
    domain: 'linear-hdr',
  }).unwrap();
  const depth = createRenderPipelineTarget(graph, 'depth', {
    size: 'surface',
    format: 'depth32float',
  }).unwrap();
  const output = createRenderPipelineTarget(graph, 'output', {
    size: 'surface',
    format: options.highPrecision ? 'rgba16float' : 'bgra8unorm',
    domain: 'display-encoded',
  }).unwrap();
  graph
    .addRasterPass('scene', {
      accesses: [
        { resource: scene.view, usage: 'color-attachment' },
        { resource: depth.view, usage: 'depth-stencil-write' },
      ],
      colorAttachments: [{ view: scene.view, loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: {
        view: depth.view,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        depthClearValue: 0,
      },
      encode() {},
    })
    .unwrap();
  const placements: string[] = [];
  const result = addStandardPost(
    {
      graph,
      capabilities: {
        rgba16floatRenderable: true,
        rg11b10ufloatRenderable: options.packedBloom === true,
      },
      observationCaptureDomains: options.observation ? ['linear-ldr'] : undefined,
      ...(options.directOverlay
        ? {
            afterTonemapOutput: {
              needsIntermediate: options.afterTonemap === true,
              needsOutputDepth: false,
              endpointFeatures: ['test.overlay'],
            },
          }
        : {}),
      hasFeatureWork: (_name: unknown, placement: string) =>
        options.afterTonemap === true && placement === 'after-tonemap',
      contributeFeatures: (
        request: Parameters<
          RenderPipelineBuildContext<RenderPipelineFrame>['contributeFeatures']
        >[0],
      ) => {
        if (request.placement !== undefined) placements.push(request.placement);
        if (request.include?.includes('test.overlay')) {
          const endpoint = request.targets.find(({ name }) => name === 'swapchain');
          if (endpoint === undefined) throw new Error('Missing final attachment');
          return graph.addRasterPass('test-overlay', {
            accesses: [{ resource: endpoint.view, usage: 'color-attachment' }],
            colorAttachments: [{ view: endpoint.view, loadOp: 'load', storeOp: 'store' }],
            encode() {},
          });
        }
        return ok(undefined);
      },
    } as unknown as RenderPipelineBuildContext<RenderPipelineFrame>,
    {
      config: {
        ...(options.native === false ? {} : { outputContract: 'standard-output-v2' }),
        postEffects: options.postEffects,
      },
      hdrOutputEffects: options.hdrOutputEffects,
      camera: {
        tonemap: 'aces-filmic',
        antialias: options.smaa ? 'smaa' : options.fxaa === false ? 'none' : 'msaa-fxaa',
        bloom: options.bloom ? 'on' : 'off',
        bloomIntensity: 1,
        bloomQuality: options.bloomQuality,
        ...(options.prefilter ? { bloomPrefilter: true } : {}),
        outline: options.outline === true,
        chromaticAberration: options.chromaticAberration === true,
        lensFlare: options.lensFlare === true,
        lensEffects: options.lensEffects === true,
      },
      surface: {
        width: 1280,
        height: 720,
        storageFormat: options.highPrecision ? 'rgba16float' : 'bgra8unorm',
        viewFormat: options.highPrecision ? 'rgba16float' : 'bgra8unorm-srgb',
      },
      lane: { compute: true, storageBuffer: true, storageTexture: options.computeBloom === true },
    } as unknown as RenderPipelineTopology,
    scene,
    depth,
    { storage: output },
  );
  return { ...f, graph, result, placements };
}

it('declares two physical output draws with FXAA and one draw without spatial finishing', async () => {
  for (const fxaa of [true, false]) {
    const f = await standardGraph({ fxaa });
    f.result.unwrap();
    const compiled = f.graph
      .compile({ device: f.device, surfaceSize: { width: 1280, height: 720 } })
      .unwrap();
    try {
      const info = compiled.inspect();
      expect(
        info.passes
          .filter((p) => p.name === 'standard-grade' || p.name === 'standard-final')
          .map((p) => p.name),
      ).toEqual(fxaa ? ['standard-grade', 'standard-final'] : ['standard-grade']);
      expect(info.resources.some((r) => r.label === 'standard-grade-output')).toBe(fxaa);
      if (fxaa)
        expect(info.resources.find((r) => r.label === 'standard-grade-output')).toMatchObject({
          descriptor: {
            format: 'rgba8unorm',
            domain: 'display-encoded',
          },
        });
      if (fxaa) {
        const descriptor = f.textures.mock.calls.find(
          ([value]) => value.label === 'standard-grade-output',
        )?.[0];
        expect((descriptor?.usage ?? 0) & GPU_TEXTURE_USAGE_COPY_SRC).toBe(
          GPU_TEXTURE_USAGE_COPY_SRC,
        );
      }
      expect(
        info.passes.some((p) =>
          [
            'fxaa',
            'standard-exposure-white-balance',
            'standard-output-encoding',
            'chromatic-aberration',
            'lens-effects',
          ].includes(p.name),
        ),
      ).toBe(false);
    } finally {
      (await compiled.retire()).unwrap();
      f.scope.dispose();
    }
  }
});

it('feeds native Grade from the accumulated Bloom image without a full-resolution composite', async () => {
  const cases = [];
  for (const native of [false, true]) {
    const f = await standardGraph({ native, bloom: true });
    f.result.unwrap();
    const compiled = f.graph
      .compile({ device: f.device, surfaceSize: { width: 1280, height: 720 } })
      .unwrap();
    try {
      const info = compiled.inspect(),
        bloom = inspectStandardBloomGraph(info);
      expect(bloom.status).toBe('valid');
      expect(bloom.passCount).toBe(native ? 14 : 15);
      expect(bloom.targetCount).toBe(native ? 14 : 15);
      expect(info.resources.some((r) => r.label === 'bloom-composited')).toBe(!native);
      cases.push(bloom);
      if (native) {
        const grade = info.passes.find((p) => p.name === 'standard-grade');
        expect(
          grade?.accesses.filter((a) => a.usage === 'sampled-read').map((a) => a.resource),
        ).toEqual(['scene', 'bloom-vertical-0']);
      } else expect(info.passes.some((p) => p.name === 'standard-grade')).toBe(false);
    } finally {
      (await compiled.retire()).unwrap();
      f.scope.dispose();
    }
  }
  expect((cases[0]?.targetBytes ?? 0) - (cases[1]?.targetBytes ?? 0)).toBe(1280 * 720 * 8);
});

it.each([
  false,
  true,
])('packs only RGB Bloom raster filters (compute reduction=%s)', async (computeBloom) => {
  const extents = { width: 1280, height: 720 };
  const measuredBytes = [];
  for (const packedBloom of [false, true]) {
    const f = await standardGraph({ bloom: true, prefilter: true, packedBloom, computeBloom });
    f.result.unwrap();
    const compiled = f.graph.compile({ device: f.device, surfaceSize: extents }).unwrap();
    try {
      const info = compiled.inspect();
      const bloom = inspectStandardBloomGraph(info);
      expect(bloom.status).toBe('valid');
      measuredBytes.push(bloom.targetBytes);
      for (const resource of info.resources.filter(({ label }) => label.startsWith('bloom-'))) {
        const filter = /^bloom-(horizontal|vertical)-/.test(resource.label);
        expect(resource.descriptor).toMatchObject({
          format: packedBloom && filter ? 'rg11b10ufloat' : 'rgba16float',
        });
        if (filter) {
          expect(resource.derivedUsage).toBe(0x10 | 0x04);
        }
      }
      expect(info.resources.find(({ label }) => label === 'scene')?.descriptor).toMatchObject({
        format: 'rgba16float',
      });
      expect(info.resources.find(({ label }) => label === 'output')?.descriptor).toMatchObject({
        format: 'bgra8unorm',
      });
    } finally {
      (await compiled.retire()).unwrap();
      f.scope.dispose();
    }
  }
  // Four fewer physical bytes per texel across two filter levels at each scale.
  const texels = [1, 2, 3, 4, 5].reduce(
    (sum, lod) => sum + Math.ceil(extents.width / 2 ** lod) * Math.ceil(extents.height / 2 ** lod),
    0,
  );
  expect((measuredBytes[0] ?? 0) - (measuredBytes[1] ?? 0)).toBe(texels * 8);
});

it.each([
  3, 4, 5,
] as const)('builds %s Bloom levels and thresholds before the reduction chain', async (quality) => {
  const f = await standardGraph({ bloom: true, bloomQuality: quality, prefilter: true });
  f.result.unwrap();
  const compiled = f.graph
    .compile({ device: f.device, surfaceSize: { width: 1280, height: 720 } })
    .unwrap();
  try {
    const info = compiled.inspect();
    expect(inspectStandardBloomGraph(info)).toMatchObject({
      status: 'valid',
      levelCount: quality,
      passCount: 3 * quality,
    });
    for (const name of ['bloom-horizontal-0', 'bloom-downsample-1'])
      expect(info.passes.find((pass) => pass.name === name)?.accesses[0]).toEqual({
        resource: 'bloom-prefilter',
        usage: 'sampled-read',
      });
    const accumulated = info.passes.find((pass) => pass.name === 'bloom-vertical-0');
    expect(accumulated?.accesses).toContainEqual({
      resource: 'bloom-vertical-1',
      usage: 'sampled-read',
    });
    expect(info.passes.some((pass) => pass.name === `bloom-vertical-${quality}`)).toBe(false);
  } finally {
    (await compiled.retire()).unwrap();
    f.scope.dispose();
  }
});

it('keeps native Grade and a linear-LDR outline seam before encoded FXAA', async () => {
  const f = await standardGraph({ outline: true });
  expect(f.result.ok, f.result.ok ? '' : String(f.result.error)).toBe(true);
  const compiled = f.graph
    .compile({ device: f.device, surfaceSize: { width: 1280, height: 720 } })
    .unwrap();
  const info = compiled.inspect(),
    names = info.passes.map((p) => p.name);
  expect(names).toContain('standard-grade');
  expect(names).toContain('standard-encode');
  expect(names).toContain('standard-final');
  expect(names.some((name) => name.startsWith('outline-'))).toBe(true);
  expect(names).not.toContain('standard-tone');
  expect(names).not.toContain('fxaa');
  expect(info.resources.find((r) => r.label === 'standard-grade-linear')).toMatchObject({
    descriptor: { format: 'rgba16float' },
  });
  expect(info.resources.find((r) => r.label === 'standard-grade-output')).toMatchObject({
    descriptor: { format: 'rgba8unorm' },
  });
  const descriptor = f.textures.mock.calls.find(
    ([value]) => value.label === 'standard-grade-output',
  )?.[0];
  expect((descriptor?.usage ?? 0) & GPU_TEXTURE_USAGE_COPY_SRC).toBe(GPU_TEXTURE_USAGE_COPY_SRC);
  (await compiled.retire()).unwrap();
  f.scope.dispose();
});

it.each([
  { lensEffects: true },
  { highPrecision: true },
  { afterTonemap: true },
])('preserves encoded float precision before FXAA for %j', async (options) => {
  const f = await standardGraph(options);
  f.result.unwrap();
  const compiled = f.graph
    .compile({ device: f.device, surfaceSize: { width: 1280, height: 720 } })
    .unwrap();
  try {
    expect(
      compiled.inspect().resources.find((r) => r.label === 'standard-grade-output'),
    ).toMatchObject({ descriptor: { format: 'rgba16float', domain: 'display-encoded' } });
  } finally {
    (await compiled.retire()).unwrap();
    f.scope.dispose();
  }
});

it.each([
  'smaa',
  'observation',
  'lensFlare',
] as const)('retains the native %s seam without reverting the output contract', async (feature) => {
  const f = await standardGraph({ [feature]: true, bloom: feature === 'lensFlare' });
  f.result.unwrap();
  const compiled = f.graph
    .compile({ device: f.device, surfaceSize: { width: 1280, height: 720 } })
    .unwrap();
  try {
    const names = compiled.inspect().passes.map((p) => p.name);
    expect(names).toContain('standard-grade');
    expect(names).not.toContain('standard-tone');
    if (feature === 'observation') expect(names).toContain('standard-encode');
    if (feature === 'observation') expect(names).toContain('linear-ldr-observation');
    if (feature === 'smaa') {
      expect(names).toContain('smaa-blend');
      expect(names).not.toContain('standard-encode');
      expect(compiled.inspect().resources.some((item) => item.label === 'smaa-color')).toBe(false);
    }
    if (feature === 'lensFlare')
      expect(names.some((name) => name.includes('lens-flare'))).toBe(true);
  } finally {
    (await compiled.retire()).unwrap();
    f.scope.dispose();
  }
});

it.each([
  { native: false, observation: false },
  { native: false, observation: true },
  { native: true, observation: false },
  { native: true, observation: true },
])('binds both SMAA color domains and retains only observed linear output (%j)', async (options) => {
  const f = await standardGraph({ ...options, smaa: true });
  f.result.unwrap();
  const compiled = f.graph
    .compile({ device: f.device, surfaceSize: { width: 1280, height: 720 } })
    .unwrap();
  try {
    const info = compiled.inspect();
    const pass = (name: string) => info.passes.find((item) => item.name === name);
    expect(pass('smaa-edges')?.accesses).toContainEqual({
      resource: 'scene',
      usage: 'sampled-read',
    });
    expect(pass('smaa-edges')?.accesses).toContainEqual({
      resource: 'smaa-stencil',
      usage: 'depth-stencil-write',
    });
    expect(pass('smaa-weights')?.accesses).toContainEqual({
      resource: 'smaa-stencil',
      usage: 'depth-stencil-read',
    });
    expect(pass('smaa-blend')?.accesses).toContainEqual({
      resource: options.native ? 'standard-grade-linear' : 'standard-tone-output',
      usage: 'sampled-read',
    });
    expect(pass('smaa-blend')?.accesses).toContainEqual({
      resource: options.observation ? 'smaa-color' : 'output',
      usage: 'color-attachment',
    });
    expect(info.resources.some(({ label }) => label === 'smaa-color')).toBe(options.observation);
    expect(
      pass(options.native ? 'standard-encode' : 'standard-output-encoding') !== undefined,
    ).toBe(options.observation);
  } finally {
    (await compiled.retire()).unwrap();
    f.scope.dispose();
  }
});

it.each([
  false,
  true,
])('downsamples the HDR effect output for Bloom and Flare (native=%s)', async (native) => {
  const effects = ['test.hdr'];
  const f = await standardGraph({
    native,
    bloom: true,
    prefilter: true,
    lensFlare: true,
    postEffects: effects,
    hdrOutputEffects: effects,
  });
  f.result.unwrap();
  const compiled = f.graph
    .compile({ device: f.device, surfaceSize: { width: 1280, height: 720 } })
    .unwrap();
  try {
    const info = compiled.inspect();
    const sampled = (name: string) =>
      info.passes
        .find((pass) => pass.name === name)
        ?.accesses.filter(({ usage }) => usage === 'sampled-read')
        .map(({ resource }) => resource);
    expect(sampled('hdr-output-effect-0')).toEqual(['scene']);
    expect(sampled('post-scene-color-half-lens')).toEqual(['hdr-output-effect-0-color']);
    expect(sampled('bloom-prefilter')).toEqual(['post-scene-color-half-lens']);
    expect(sampled('standard-lens-flare-prefilter')).toEqual(['post-scene-color-half-lens']);
    expect(info.passes.some(({ name }) => name === 'post-scene-color-half')).toBe(false);
    expect(info.passes.some(({ name }) => name.startsWith('post-effect-'))).toBe(false);
    expect(inspectStandardBloomGraph(info)).toMatchObject({ status: 'valid', levelCount: 5 });
  } finally {
    (await compiled.retire()).unwrap();
    f.scope.dispose();
  }
});

it.each([
  false,
  true,
])('shares the half scene and combines Bloom with Flare at half resolution (native=%s)', async (native) => {
  const f = await standardGraph({
    native,
    bloom: true,
    prefilter: true,
    lensFlare: true,
    chromaticAberration: true,
  });
  f.result.unwrap();
  const compiled = f.graph
    .compile({ device: f.device, surfaceSize: { width: 1280, height: 720 } })
    .unwrap();
  try {
    const info = compiled.inspect();
    const pass = (name: string) => info.passes.find((item) => item.name === name);
    const sampled = (name: string) =>
      pass(name)
        ?.accesses.filter((access) => access.usage === 'sampled-read')
        .map((access) => access.resource);
    expect(sampled('standard-lens-flare-prefilter')).toEqual(['post-scene-color-half']);
    expect(sampled('bloom-prefilter')).toEqual(['post-scene-color-half']);
    expect(sampled('standard-lens-flare')).toEqual([
      'standard-lens-flare-bokeh',
      'bloom-vertical-0',
    ]);
    expect(info.resources.find((item) => item.label === 'standard-lens-flare')).toMatchObject({
      descriptor: { width: 640, height: 360, format: 'rgba16float' },
    });
    expect(pass('bloom-composite')).toBeUndefined();
    expect(inspectStandardBloomGraph(info)).toMatchObject({ status: 'valid', levelCount: 5 });
    if (native) {
      expect(sampled('standard-grade')).toEqual(['scene', 'standard-lens-flare']);
      expect(pass('standard-lens-flare-apply')).toBeUndefined();
      expect(pass('chromatic-aberration')).toBeUndefined();
    } else {
      expect(sampled('chromatic-aberration')).toEqual(['scene']);
      expect(pass('standard-lens-flare-apply')).toBeUndefined();
      expect(sampled('output-transform')).toEqual([
        'standard-chromatic-aberration',
        'standard-lens-flare',
      ]);
    }
  } finally {
    (await compiled.retire()).unwrap();
    f.scope.dispose();
  }
});

it.each([
  false,
  true,
])('preserves after-tonemap feature work and its final output copy (native=%s)', async (native) => {
  const f = await standardGraph({ native, afterTonemap: true });
  f.result.unwrap();
  const compiled = f.graph
    .compile({ device: f.device, surfaceSize: { width: 1280, height: 720 } })
    .unwrap();
  try {
    expect(f.placements.filter((stage) => stage === 'after-tonemap')).toEqual(['after-tonemap']);
    const passes = compiled.inspect().passes;
    const output = passes.find((pass) => pass.name === 'standard-current-output-present');
    expect(output).toBeDefined();
    expect(output?.accesses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resource: 'standard-current-output', usage: 'sampled-read' }),
        expect.objectContaining({ resource: 'output', usage: 'color-attachment' }),
      ]),
    );
    const writers = passes.filter((pass) =>
      pass.accesses.some(
        (access) =>
          access.resource === 'standard-current-output' && access.usage === 'color-attachment',
      ),
    );
    expect(writers.length).toBeGreaterThan(0);
    expect(output?.executionIndex).toBeGreaterThan(
      Math.max(...writers.map((pass) => pass.executionIndex)),
    );
  } finally {
    (await compiled.retire()).unwrap();
    f.scope.dispose();
  }
});

it.each([
  { producer: 'standard-grade', fxaa: false, smaa: false },
  { producer: 'standard-final', fxaa: true, smaa: false },
  { producer: 'smaa-blend', fxaa: false, smaa: true },
])('chains effects from $producer through after-tonemap work', async ({ producer, fxaa, smaa }) => {
  const f = await standardGraph({
    fxaa,
    smaa,
    afterTonemap: true,
    postEffects: ['test.first', 'test.second'],
  });
  f.result.unwrap();
  const compiled = f.graph
    .compile({ device: f.device, surfaceSize: { width: 1280, height: 720 } })
    .unwrap();
  try {
    const info = compiled.inspect();
    const pass = (name: string) => info.passes.find((item) => item.name === name);
    expect(pass(producer)?.accesses).toContainEqual({
      resource: 'standard-post-effects-input',
      usage: 'color-attachment',
    });
    expect(
      info.resources.find(({ label }) => label === 'standard-post-effects-input')?.descriptor,
    ).toMatchObject({ format: 'rgba16float', domain: 'display-encoded' });
    expect(pass('post-effect-0')?.accesses).toContainEqual({
      resource: 'standard-post-effects-input',
      usage: 'sampled-read',
    });
    expect(pass('post-effect-1')?.accesses).toContainEqual({
      resource: 'standard-current-output',
      usage: 'color-attachment',
    });
    expect(pass('standard-current-output-present')?.dependencies).toContain('post-effect-1');
  } finally {
    (await compiled.retire()).unwrap();
    f.scope.dispose();
  }
});

it.each([
  { fxaa: false, producer: 'standard-grade', custom: false },
  { fxaa: true, producer: 'standard-final', custom: false },
  { fxaa: false, producer: 'post-effect-1', custom: true },
])('routes $producer and the terminal overlay to one output attachment', async ({
  fxaa,
  producer,
  custom,
}) => {
  const f = await standardGraph({
    fxaa,
    directOverlay: true,
    postEffects: custom ? ['test.first', 'test.second'] : undefined,
  });
  f.result.unwrap();
  const compiled = f.graph
    .compile({ device: f.device, surfaceSize: { width: 1280, height: 720 } })
    .unwrap();
  try {
    const { passes, resources } = compiled.inspect();
    const pass = (name: string) => passes.find((item) => item.name === name);
    expect(pass('standard-current-output-present')).toBeUndefined();
    expect(resources.some(({ label }) => label === 'standard-current-output')).toBe(false);
    expect(pass(producer)?.accesses).toContainEqual({
      resource: 'output',
      usage: 'color-attachment',
    });
    expect(pass('test-overlay')?.dependencies).toContain(producer);
    expect(pass('test-overlay')?.accesses).toEqual([
      { resource: 'output', usage: 'color-attachment' },
    ]);
  } finally {
    (await compiled.retire()).unwrap();
    f.scope.dispose();
  }
});

it.each([
  {
    kind: 'scene-depth',
    format: 'depth32float',
    name: 'depth',
    needsIntermediate: false,
    needsOutputDepth: false,
  },
  {
    kind: 'scene-depth',
    format: 'depth32float',
    name: 'output-depth',
    needsIntermediate: false,
    needsOutputDepth: true,
  },
  {
    kind: 'scene-color',
    format: 'rgba16float',
    name: undefined,
    needsIntermediate: true,
    needsOutputDepth: false,
  },
] as const)('allocates output according to a typed $kind/$name read', (input) => {
  const resource = createRenderFeatureTarget({
    kind: input.kind,
    format: input.format,
    sampleCount: 1,
    ...(input.name === undefined ? {} : { name: input.name }),
  });
  const result = standardAfterTonemapOutput(
    [
      {
        placement: 'after-tonemap',
        featureIdentity: 'test.reader',
        order: 0,
        passes: [
          {
            name: 'reader',
            featureIdentity: 'test.reader',
            order: 0,
            graphics: {
              attachments: { colors: [] },
              sampledTargets: [resource],
              draws: [],
            },
          },
        ],
      },
    ],
    new Set(),
    'bgra8unorm',
  );
  expect(result).toMatchObject({
    needsIntermediate: input.needsIntermediate,
    needsOutputDepth: input.needsOutputDepth,
  });
});

it('retains one output parameter allocation when a view replaces its graph', async () => {
  const f = await fixture();
  const state = {};
  const first = f.build(),
    replacement = f.build();
  const allocations = vi.spyOn(f.device, 'createBuffer');
  try {
    const draw = (graph: typeof first, exposure: number) => {
      const encoder = f.device.createCommandEncoder().unwrap();
      graph.execute({ ...f.frame(exposure, state), encoder }).unwrap();
      f.device.queue.submit([encoder.finish().unwrap()]).unwrap();
    };
    draw(first, 1);
    const original = f.writes.mock.calls.at(-1)?.[0];
    draw(replacement, 2);
    expect(f.writes.mock.calls.at(-1)?.[0]).toBe(original);
    expect(allocations).toHaveBeenCalledTimes(1);
  } finally {
    await f.device.queue.onSubmittedWorkDone();
    (await first.retire()).unwrap();
    (await replacement.retire()).unwrap();
    disposeStandardOutput(state as RenderFrameState);
    f.scope.dispose();
  }
});

it('drops lost output buffers and disposes the replacement with its view', async () => {
  const f = await fixture();
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const state = {
    standardLutState: createStandardLutState({ targetGeneration: 0, deviceEpoch: 0 }),
  } as RenderFrameState;
  const oldDestroyed = vi.spyOn(f.device, 'destroyBuffer');
  const newDestroyed = vi.spyOn(device, 'destroyBuffer');
  const first = ensureStandardOutputParameters(state, f.device).unwrap();
  expect(ensureStandardOutputParameters(state, f.device).unwrap()).toBe(first);
  expect(ensureStandardOutputParameters(state, device).ok).toBe(false);
  resetStandardOutputForDeviceLoss(state, 1);
  expect(oldDestroyed).not.toHaveBeenCalled();
  const next = ensureStandardOutputParameters(state, device).unwrap();
  expect(next).not.toBe(first);
  disposeStandardOutput(state);
  disposeStandardOutput(state);
  expect(newDestroyed).toHaveBeenCalledExactlyOnceWith(next);
  f.scope.dispose();
});

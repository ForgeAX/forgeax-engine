import { vec3 } from '@forgeax/engine-math';
import { type RasterGraphPass, RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { RhiError, type TextureFormat } from '@forgeax/engine-rhi';
import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-null';
import { err, ok, type ShaderReflection, ShaderSource } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { makeShaderDeviceAdapter } from '../assembly/material-shader-policy';
import { DeviceScope } from '../device/device-scope';
import { MaterialResource } from '../material-resource';
import { buildPbrViewBglEntries } from '../pbr-pipeline';
import { DEFERRED_REFLECTION_TABLE_BYTES } from '../pipeline/deferred-reflection-coverage';
import { addStandardDeferredLighting } from '../pipeline/standard-deferred-lighting';
import { buildPerFrameBindGroups, buildViewBindGroup } from '../record/frame-lighting';
import { prepareMaterialSkylight } from '../record/main-pass-material';
import type { ReflectionProbeRecordState } from '../record/render-context';
import { scenePipelinePreparations } from '../record/scene-pipeline-preparation';
import { buildReflectionProbeTable, type ReflectionProbeTableRow } from '../reflection/gpu-table';
import type { RenderPipelineFrame } from '../render-pipeline';

vi.mock('../record/frame-lighting', () => ({
  resolveReflectionProbeBinding: vi.fn((selection, table) => ({
    probeIndex: table?.cpuIndexByPrimitive(String(selection.entityKey)),
    useSkylight: selection.kind === 'skylight',
  })),
  buildPerFrameBindGroups: vi.fn(),
  buildViewBindGroup: vi.fn(),
}));
vi.mock('../record/main-pass-material', () => ({ prepareMaterialSkylight: vi.fn() }));

async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const texture = device
    .createTexture({
      size: { width: 1, height: 1 },
      format: 'r32uint',
      usage: 4,
      textureBindingViewDimension: undefined,
    })
    .unwrap();
  const view = device.createTextureView(texture, {}).unwrap();
  const buffer = device
    .createBuffer({ size: DEFERRED_REFLECTION_TABLE_BYTES, usage: 0x40 | 0x80 })
    .unwrap();
  const sampler = device.createSampler({}).unwrap();
  const layout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const group = device.createBindGroup({ layout, entries: [] }).unwrap();
  vi.mocked(buildPerFrameBindGroups).mockReturnValue({ viewBindGroup: group } as ReturnType<
    typeof buildPerFrameBindGroups
  >);
  vi.mocked(buildViewBindGroup).mockImplementation(() => group);
  vi.mocked(prepareMaterialSkylight).mockReturnValue({
    skylightResources: {
      irradianceView: view,
      prefilterView: view,
      brdfLutView: view,
      irradianceSampler: sampler,
      prefilterSampler: sampler,
      intensityBuffer: buffer,
    },
  } as ReturnType<typeof prepareMaterialSkylight>);
  const frame = {
    runtime: {
      device,
      deviceScope: DeviceScope.create(1, 'deferred-program-owner'),
      standardSceneShaders: {
        gbuffer: 'standard-gbuffer/2',
        deferredReflections: new Map<ShaderSource, ShaderReflection>(),
        deferred: {
          unclustered: 'fit' as string | ShaderSource,
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
    camera: {},
    frameState: {},
    reflectionProbes: undefined as ReflectionProbeRecordState | undefined,
    validatedOrdered: [] as {
      source: { materials: MaterialResource[] };
    }[],
    pipelineState: { device, viewBindGroupLayout: layout, defaultWhiteTextureView: view },
    bindGroupCounts: { createBindGroup: 0, keys: [] as string[] },
  };
  const context = {
    frame: frame as unknown as RenderPipelineFrame,
    resources: { textureView: () => ok(view), buffer: () => ok(buffer) },
    pass: { setPipeline: vi.fn(), setBindGroup: vi.fn(), draw: vi.fn() },
  } as unknown as Parameters<NonNullable<RasterGraphPass<RenderPipelineFrame>['encode']>>[0];
  const build = (
    options: {
      format?: TextureFormat;
      clustered?: boolean;
      reflection?: boolean;
      diffuse?: boolean;
      projectedDirectionalPcf?: true;
      width?: number;
    } = {},
  ) => {
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const raster = vi.spyOn(graph, 'addRasterPass');
    const copy = vi.spyOn(graph, 'addCopyPass');
    const target = (name: string) => {
      const texture = graph
        .createTexture(name, {
          size: { width: options.width ?? 1, height: 1 },
          format: options.format ?? 'rgba16float',
        })
        .unwrap();
      return {
        texture,
        view: graph.view(texture, {}).unwrap(),
        format: options.format ?? ('rgba16float' as const),
        sampleCount: 1 as const,
      };
    };
    const surface = target('surface'),
      receiver = target('receiver');
    let clusterIndex = 0;
    const clusterBuffer = () =>
      graph.createBuffer(`cluster-${clusterIndex++}`, { size: 256 }).unwrap();
    addStandardDeferredLighting(graph, {
      color: surface,
      localProbes: true,
      gbuffer: [surface, surface, surface, surface],
      receiverGeometry: receiver,
      ...(options.projectedDirectionalPcf === true ? { projectedDirectionalPcf: true } : {}),
      depth: surface.view,
      spotShadow: surface,
      ...(options.reflection
        ? { reflectionFallback: target('reflection'), response: target('specular-response') }
        : {}),
      ...(options.diffuse ? { diffuse: target('diffuse') } : {}),
      cluster: options.clustered
        ? {
            kind: 'storage',
            lightData: clusterBuffer(),
            clusterGrid: clusterBuffer(),
            lightIndexList: clusterBuffer(),
            clusterUniform: clusterBuffer(),
            lightBounds: clusterBuffer(),
          }
        : null,
      extraAccesses: [],
      size: { width: options.width ?? 1, height: 1 },
    }).unwrap();
    const encode = raster.mock.calls.find(([name]) => name === 'lighting')?.[1].encodeDirect;
    expect(encode).toBeDefined();
    const render = () => {
      encode?.(context.pass, context.frame, context.resources);
      return vi.mocked(context.pass.setPipeline).mock.calls.at(-1)?.[0];
    };
    return Object.assign(render, {
      upload: () => {
        const prepare = copy.mock.calls.find(([name]) => name === 'deferred-lighting-prepare')?.[1];
        prepare?.encodeDirect?.(
          { clearBuffer: vi.fn() } as never,
          context.frame,
          context.resources,
        );
      },
      prepareSource: () => {
        for (const prepare of scenePipelinePreparations(graph)) {
          prepare.prepareSource?.(context.frame as never);
        }
      },
      prepare: () => {
        for (const prepare of scenePipelinePreparations(graph)) {
          prepare(context.frame as never, new Map());
        }
      },
    });
  };
  return {
    device,
    frame,
    context,
    build,
    view,
    sampler,
    buffer,
    texture,
    makePipeline: vi.spyOn(device, 'createRenderPipeline'),
    dispose: () => {
      frame.runtime.deviceScope.dispose();
      device.destroyBuffer(buffer).unwrap();
      device.destroyTexture(texture).unwrap();
    },
  };
}

it('waits for CPU source preparation before reading the selected shader or creating its pipeline', async () => {
  const f = await fixture();
  const prepareDeferredLighting = vi.fn(() => false);
  const read = vi.fn(() => 'fit');
  const sources = f.frame.runtime.standardSceneShaders;
  Object.assign(sources, { prepareDeferredLighting });
  Object.defineProperty(sources.deferred, 'unclustered', { get: read });
  try {
    const render = f.build();
    render.prepareSource();
    expect(prepareDeferredLighting).toHaveBeenCalledExactlyOnceWith(false, false);
    expect(read).not.toHaveBeenCalled();
    expect(f.makePipeline).not.toHaveBeenCalled();
    render.prepare();
    expect(f.frame.frameState).toMatchObject({ pipelinePreparationPending: true });
    expect(read).not.toHaveBeenCalled();
    expect(f.makePipeline).not.toHaveBeenCalled();
    expect(render()).toBeUndefined();
    expect(f.context.pass.draw).not.toHaveBeenCalled();
    prepareDeferredLighting.mockReturnValue(true);
    Object.assign(f.frame.frameState, { pipelinePreparationPending: false });
    render.prepare();
    expect(render()).toBeDefined();
    expect(f.makePipeline).toHaveBeenCalledOnce();
  } finally {
    f.dispose();
  }
});

it('holds the frame while its selected Deferred shader module is validated', async () => {
  const f = await fixture();
  const compile = vi.fn(
    async (device: typeof f.device, desc: Parameters<typeof createShaderModuleImmediate>[1]) =>
      createShaderModuleImmediate(device, desc),
  );
  const adapter = makeShaderDeviceAdapter(f.device, { fire: vi.fn() } as never, compile, undefined);
  Object.assign(f.frame.runtime, { shaderModuleFactory: adapter });
  try {
    const render = f.build();
    render.prepare();
    render.prepare();
    expect(compile).toHaveBeenCalledOnce();
    expect(compile.mock.calls[0]?.[1]).toMatchObject({
      label: 'standard_deferred_false_false',
      code: 'fit',
    });
    expect(f.frame.frameState).toMatchObject({ pipelinePreparationPending: true });
    expect(f.makePipeline).not.toHaveBeenCalled();
    expect(render()).toBeUndefined();
    expect(f.context.pass.draw).not.toHaveBeenCalled();
    await adapter.pendingCompletion();
    Object.assign(f.frame.frameState, { pipelinePreparationPending: false });
    render.prepare();
    expect(render()).toBeDefined();
    expect(f.frame.frameState).toMatchObject({ pipelinePreparationPending: false });
    expect(f.makePipeline).toHaveBeenCalledOnce();
    expect(compile).toHaveBeenCalledOnce();
  } finally {
    adapter.dispose();
    f.dispose();
  }
});

it('prepares the exact deferred PSO before encode and preserves its native completion barrier', async () => {
  const f = await fixture();
  let finish!: (value: ReturnType<typeof f.device.createRenderPipeline>) => void;
  const create = vi.fn(
    (_descriptor: Parameters<typeof f.device.createRenderPipeline>[0]) =>
      new Promise<ReturnType<typeof f.device.createRenderPipeline>>((resolve) => {
        finish = resolve;
      }),
  );
  Object.assign(f.device, { createRenderPipelineAsync: create });
  try {
    const render = f.build({ reflection: true });
    render.prepare();
    expect(create).toHaveBeenCalledOnce();
    expect(f.makePipeline).not.toHaveBeenCalled();
    expect(f.frame.frameState).toMatchObject({ pipelinePreparationPending: true });
    expect(render()).toBeUndefined();
    expect(f.context.pass.draw).not.toHaveBeenCalled();
    const descriptor = create.mock.calls[0]?.[0];
    if (descriptor === undefined) throw new Error('Missing exact deferred descriptor');
    const pipeline = f.device.createRenderPipeline(descriptor);
    f.makePipeline.mockClear();
    finish(pipeline);
    await Promise.resolve();
    Object.assign(f.frame.frameState, { pipelinePreparationPending: false });
    render.prepare();
    expect(render()).toBe(pipeline.unwrap());
    expect(f.makePipeline).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
  } finally {
    f.dispose();
  }
});

it('retains only immutable lighting programs across graph/extent changes and rebinds graph resources', async () => {
  const f = await fixture();
  try {
    const first = f.build()();
    const groups = vi.mocked(f.context.pass.setBindGroup).mock.calls.map(([, group]) => group);
    expect(f.build({ width: 1280 })()).toBe(first);
    expect(f.makePipeline).toHaveBeenCalledOnce();
    const next = vi
      .mocked(f.context.pass.setBindGroup)
      .mock.calls.slice(4)
      .map(([, group]) => group);
    expect(next[0]).toBe(groups[0]);
    expect(next[1]).not.toBe(groups[1]);
    expect(next[2]).not.toBe(groups[2]);
    expect(next[3]).not.toBe(groups[3]);
    expect(f.context.pass.draw).toHaveBeenCalledTimes(2);
  } finally {
    f.dispose();
  }
});

it('rejects failed native completion and retries without accepting a partial deferred program', async () => {
  const f = await fixture();
  const failure = new RhiError({
    code: 'shader-compile-failed',
    expected: 'native deferred fixture',
    hint: 'rejected program',
  });
  const create = vi
    .fn()
    .mockRejectedValueOnce(failure)
    .mockImplementation((descriptor: Parameters<typeof f.device.createRenderPipeline>[0]) =>
      f.device.createRenderPipeline(descriptor),
    );
  Object.assign(f.device, { createRenderPipelineAsync: create });
  try {
    const render = f.build();
    render.prepare();
    expect(render()).toBeUndefined();
    await Promise.resolve();
    expect(render.prepare).toThrow(RhiError);
    expect(f.context.pass.draw).not.toHaveBeenCalled();
    Object.assign(f.frame.frameState, { pipelinePreparationPending: false });
    render.prepare();
    expect(render()).toBeDefined();
    expect(f.context.pass.draw).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledTimes(2);
  } finally {
    f.dispose();
  }
});

it('never accepts an old pending source as the current deferred program', async () => {
  const f = await fixture();
  const completions: (() => void)[] = [];
  const pipelines: ReturnType<typeof f.device.createRenderPipeline>[] = [];
  const create = vi.fn(
    (descriptor: Parameters<typeof f.device.createRenderPipeline>[0]) =>
      new Promise<ReturnType<typeof f.device.createRenderPipeline>>((resolve) => {
        completions.push(() => {
          const pipeline = f.device.createRenderPipeline(descriptor);
          pipelines.push(pipeline);
          resolve(pipeline);
        });
      }),
  );
  Object.assign(f.device, { createRenderPipelineAsync: create });
  try {
    const render = f.build();
    render.prepare();
    f.frame.runtime.standardSceneShaders.deferred.unclustered = 'replacement';
    render.prepare();
    completions[0]?.();
    await Promise.resolve();
    expect(render()).toBeUndefined();
    expect(f.context.pass.draw).not.toHaveBeenCalled();
    completions[1]?.();
    await Promise.resolve();
    render.prepare();
    expect(render()).toBe(pipelines[1]?.unwrap());
    expect(create).toHaveBeenCalledTimes(2);
  } finally {
    f.dispose();
  }
});

it('separates target formats, fragment entries, cluster/LUT contracts and current cooked source', async () => {
  const f = await fixture();
  try {
    const base = f.build()();
    const distinct = [
      f.build({ format: 'rgba8unorm' })(),
      f.build({ diffuse: true })(),
      f.build({ reflection: true })(),
      f.build({ clustered: true })(),
    ];
    f.frame.validatedOrdered = [
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
    distinct.push(f.build()());
    f.frame.validatedOrdered = [];
    f.frame.runtime.standardSceneShaders.deferred.unclustered = 'replacement';
    distinct.push(f.build()());
    expect(new Set([base, ...distinct]).size).toBe(7);
    f.frame.runtime.standardSceneShaders.deferred.unclustered = 'fit';
    expect(f.build()()).toBe(base);
    expect(f.makePipeline).toHaveBeenCalledTimes(7);
  } finally {
    f.dispose();
  }
});

it('qualifies projected PCF independently in the diffuse entry', async () => {
  const f = await fixture();
  try {
    const baseline = f.build({ diffuse: true })();
    const projected = f.build({ diffuse: true, projectedDirectionalPcf: true })();
    expect(projected).not.toBe(baseline);
    expect(f.build({ diffuse: true, projectedDirectionalPcf: true, width: 1280 })()).toBe(
      projected,
    );
    expect(f.makePipeline.mock.calls.map(([descriptor]) => descriptor.fragment?.constants)).toEqual(
      [{ '64004': 1 }, { '64004': 1, '64005': 1 }],
    );
  } finally {
    f.dispose();
  }
});

it('does not reuse a different view layout, recovered generation or retired scope even on the same graph', async () => {
  const f = await fixture();
  try {
    const render = f.build(),
      base = render();
    const originalLayout = f.frame.pipelineState.viewBindGroupLayout;
    f.frame.pipelineState.viewBindGroupLayout = f.device
      .createBindGroupLayout({ entries: [] })
      .unwrap();
    expect(render()).not.toBe(base);
    f.frame.pipelineState.viewBindGroupLayout = originalLayout;
    expect(render()).toBe(base);
    f.frame.runtime.deviceScope.retire();
    expect(render).toThrow(RhiError);
    f.frame.runtime.deviceScope = DeviceScope.create(2, 'deferred-program-owner');
    expect(render()).not.toBe(base);
    expect(f.makePipeline).toHaveBeenCalledTimes(3);
  } finally {
    f.dispose();
  }
});

it('keeps creation failures retryable without caching a partial program', async () => {
  const f = await fixture();
  try {
    const render = f.build();
    f.makePipeline.mockReturnValueOnce(
      err(
        new RhiError({ code: 'shader-compile-failed', expected: 'retry fixture', hint: 'retry' }),
      ),
    );
    expect(render).toThrow(RhiError);
    const accepted = render();
    expect(f.build()()).toBe(accepted);
    expect(f.makePipeline).toHaveBeenCalledTimes(2);
  } finally {
    f.dispose();
  }
});

it.each([
  { classes: [0, 0], textureLimit: 32, mixedGeneration: false, expectedArrays: 1, draws: 1 },
  { classes: [0, 1], textureLimit: 32, mixedGeneration: false, expectedArrays: 2, draws: 1 },
  { classes: [0, 1], textureLimit: 16, mixedGeneration: false, expectedArrays: 0, draws: 3 },
  {
    classes: [0, 1, 1],
    textureLimit: 'one-class',
    mixedGeneration: false,
    expectedArrays: 1,
    draws: 2,
  },
  { classes: [0, 1, 2, 2], textureLimit: 32, mixedGeneration: false, expectedArrays: 2, draws: 2 },
  { classes: [0, 0], textureLimit: 32, mixedGeneration: true, expectedArrays: 0, draws: 3 },
])('records the resource-admitted probe coverage ($classes, $textureLimit, $mixedGeneration)', async ({
  classes,
  textureLimit,
  mixedGeneration,
  expectedArrays,
  draws,
}) => {
  const f = await fixture();
  try {
    Object.assign(f.device.limits, {
      maxSampledTexturesPerShaderStage:
        textureLimit === 'one-class'
          ? 11 +
            buildPbrViewBglEntries({ storageBuffer: f.device.caps.storageBuffer }).filter(
              (entry) => (entry.visibility & 2) !== 0 && entry.texture !== undefined,
            ).length
          : textureLimit,
      maxUniformBuffersPerShaderStage: 12,
      maxUniformBufferBindingSize: 65536,
    });
    const source = new ShaderSource(['fixture']);
    f.frame.runtime.standardSceneShaders.deferred.unclustered = source;
    f.frame.runtime.standardSceneShaders.deferredReflections.set(source, {
      schemaVersion: 'shader-reflection/3',
      uvSetCount: 0,
      boundGlobals: [
        {
          group: 3,
          binding: 3,
          addressSpace: 'uniform',
          resourceKind: 'buffer',
          visibility: 2,
          span: DEFERRED_REFLECTION_TABLE_BYTES,
        },
        ...[1, 2].map((binding) => ({
          group: 3,
          binding,
          addressSpace: 'handle',
          resourceKind: 'texture',
          visibility: 2,
          textureClass: 'sampled' as const,
          viewDimension: '2d-array' as const,
        })),
      ],
      entryPoints: [
        {
          name: 'vs_standard_deferred_reflection_overflow',
          stage: 'vertex',
          bindings: [{ group: 3, binding: 3 }],
        },
        {
          name: 'fs_standard_deferred_reflections_overflow',
          stage: 'fragment',
          bindings: [
            { group: 3, binding: 1 },
            { group: 3, binding: 3 },
          ],
        },
        ...[1, 2].map((count) => ({
          name: `fs_standard_deferred_reflections_array_${count === 1 ? 'single' : 'dual'}`,
          stage: 'fragment' as const,
          bindings: (count === 1 ? [0, 1, 3] : [0, 1, 2, 3]).map((binding) => ({
            group: 3,
            binding,
          })),
        })),
      ],
    });
    const views = [0, 1, 2].map(() => f.device.createTextureView(f.texture, {}).unwrap());
    const rows = classes.map((slot, i): ReflectionProbeTableRow => {
      const view = views[slot];
      if (view === undefined) throw new Error('Missing test array view');
      return {
        primitiveKey: String(100 + i),
        index: i * 2,
        entityKey: 100 + i,
        center: [i, 2, 3],
        halfExtents: [4, 5, 6],
        intensity: 1,
        generation: 1,
        filteredView: f.view,
        sampler: f.sampler,
        uniformBuffer: f.buffer,
        pmremArray: {
          key: String(slot),
          view,
          layer: i + 2,
          capacity: 8,
          generation: mixedGeneration === true ? i + 1 : 1,
          size: 64 << slot,
          format: 'rgba16float',
          diffusePayload: [0.5, 1, 2, i * 2 + 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 2, 3, 1],
        },
      };
    });
    f.frame.reflectionProbes = {
      table: buildReflectionProbeTable(rows),
      selections: new Map(
        rows.map((row) => [
          String(row.entityKey),
          { kind: 'probe', entityKey: row.entityKey, normalizedDistance: 0 },
        ]),
      ),
    } as ReflectionProbeRecordState;
    const upload = vi.spyOn(f.device.queue, 'writeBuffer');
    const render = f.build({ reflection: true, diffuse: true });
    const hasOverflow = expectedArrays > 0 && new Set(classes).size > expectedArrays;
    if (hasOverflow) {
      let completeOverflow: (() => void) | undefined;
      Object.assign(f.device, {
        createRenderPipelineAsync: (
          descriptor: Parameters<typeof f.device.createRenderPipeline>[0],
        ) => {
          if (descriptor.label !== 'standard-deferred-reflection-overflow')
            return Promise.resolve(f.device.createRenderPipeline(descriptor));
          return new Promise((resolve) => {
            completeOverflow = () => resolve(f.device.createRenderPipeline(descriptor));
          });
        },
      });
      render.prepare();
      await Promise.resolve();
      render.prepare();
      // An available base pipeline is insufficient to publish partial lighting.
      expect(render()).toBeUndefined();
      expect(f.context.pass.draw).not.toHaveBeenCalled();
      expect(completeOverflow).toBeDefined();
      completeOverflow?.();
      await Promise.resolve();
    }
    render.prepare();
    render.upload();
    render();
    expect(f.makePipeline.mock.calls[0]?.[0].fragment?.entryPoint).toBe(
      expectedArrays === 0
        ? 'fs_standard_deferred_reflections'
        : `fs_standard_deferred_reflections_array_${expectedArrays === 1 ? 'single' : 'dual'}`,
    );
    expect(f.context.pass.draw).toHaveBeenCalledTimes(draws);
    if (hasOverflow) {
      expect(f.context.pass.draw).toHaveBeenNthCalledWith(1, 3);
      for (let index = 1; index < draws; index++) {
        expect(f.context.pass.draw).toHaveBeenNthCalledWith(
          index + 1,
          6,
          1,
          0,
          expectedArrays + index - 1,
        );
      }
      const pipeline = f.makePipeline.mock.calls[1]?.[0];
      expect(pipeline?.vertex.entryPoint).toBe('vs_standard_deferred_reflection_overflow');
      expect(pipeline?.fragment?.entryPoint).toBe('fs_standard_deferred_reflections_overflow');
      expect(pipeline?.fragment?.targets.map((target) => target?.writeMask)).toEqual([
        undefined,
        undefined,
        0,
        0,
      ]);
      expect(pipeline?.layout).toBe(f.makePipeline.mock.calls[0]?.[0].layout);
    } else {
      expect(f.makePipeline).toHaveBeenCalledOnce();
    }
    const table = upload.mock.calls.find(
      ([, , data]) => data.byteLength === DEFERRED_REFLECTION_TABLE_BYTES,
    )?.[2];
    if (expectedArrays === 0) {
      expect(table).toBeUndefined();
    } else {
      expect(table).toBeInstanceOf(Float32Array);
      const floats = table as Float32Array;
      expect([...floats.slice(16, 24)]).toEqual([0, 2, 3, -2, 4, 5, 6, 64]);
      expect([...floats.slice(24, 32)]).toEqual(Array(8).fill(0));
      expect([...floats.slice(32, 40)]).toEqual([
        1,
        2,
        3,
        -2,
        4,
        5,
        6,
        96 + (classes[1] === 1 ? 2 : 0),
      ]);
    }
  } finally {
    f.dispose();
  }
});

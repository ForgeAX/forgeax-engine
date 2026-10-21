import { vec3 } from '@forgeax/engine-math';
import { type RasterGraphPass, RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { RhiError, type TextureFormat } from '@forgeax/engine-rhi';
import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-null';
import { err, ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { DeviceScope } from '../device/device-scope';
import { MaterialResource } from '../material-resource';
import { addStandardDeferredLighting } from '../pipeline/standard-deferred-lighting';
import { buildPerFrameBindGroups } from '../record/frame-lighting';
import { prepareMaterialSkylight } from '../record/main-pass-material';
import type { RenderPipelineFrame } from '../render-pipeline';

vi.mock('../record/frame-lighting', () => ({ buildPerFrameBindGroups: vi.fn() }));
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
  const buffer = device.createBuffer({ size: 256, usage: 0x40 | 0x80 }).unwrap();
  const sampler = device.createSampler({}).unwrap();
  const layout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const group = device.createBindGroup({ layout, entries: [] }).unwrap();
  vi.mocked(buildPerFrameBindGroups).mockReturnValue({ viewBindGroup: group } as ReturnType<
    typeof buildPerFrameBindGroups
  >);
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
      standardDeferredShaders: {
        unclustered: 'fit',
        unclusteredLut: 'lut',
        clustered: 'cluster',
        clusteredLut: 'cluster-lut',
      },
      shaderModuleFactory: {
        createShaderModule: (desc: Parameters<typeof createShaderModuleImmediate>[1]) =>
          createShaderModuleImmediate(device, desc),
      },
    },
    frameState: {},
    validatedOrdered: [] as {
      source: { materials: MaterialResource[] };
    }[],
    pipelineState: { viewBindGroupLayout: layout, defaultWhiteTextureView: view },
    bindGroupCounts: { createBindGroup: 0, keys: [] as string[] },
  };
  const context = {
    frame: frame as unknown as RenderPipelineFrame,
    resources: { textureView: () => ok(view), buffer: () => ok(buffer) },
    pass: { setPipeline: vi.fn(), setBindGroup: vi.fn(), draw: vi.fn() },
  } as unknown as Parameters<RasterGraphPass<RenderPipelineFrame>['encode']>[0];
  const build = (
    options: {
      format?: TextureFormat;
      clustered?: boolean;
      reflection?: boolean;
      diffuse?: boolean;
      width?: number;
    } = {},
  ) => {
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const raster = vi.spyOn(graph, 'addRasterPass');
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
      gbuffer: [surface, surface, surface, surface],
      receiverGeometry: receiver,
      depth: surface.view,
      spotShadow: surface,
      ...(options.reflection ? { reflectionFallback: target('reflection') } : {}),
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
    const encode = raster.mock.calls.find(([name]) => name === 'lighting')?.[1].encode;
    expect(encode).toBeDefined();
    return () => {
      encode?.(context);
      return vi.mocked(context.pass.setPipeline).mock.calls.at(-1)?.[0];
    };
  };
  return {
    device,
    frame,
    context,
    build,
    makePipeline: vi.spyOn(device, 'createRenderPipeline'),
    dispose: () => {
      frame.runtime.deviceScope.dispose();
      device.destroyBuffer(buffer).unwrap();
      device.destroyTexture(texture).unwrap();
    },
  };
}

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
    f.frame.runtime.standardDeferredShaders.unclustered = 'replacement';
    distinct.push(f.build()());
    expect(new Set([base, ...distinct]).size).toBe(7);
    f.frame.runtime.standardDeferredShaders.unclustered = 'fit';
    expect(f.build()()).toBe(base);
    expect(f.makePipeline).toHaveBeenCalledTimes(7);
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

import { mat4, vec3 } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_DEPTH_OF_FIELD_PARAMS,
  type DepthOfFieldParams,
} from '../features/depth-of-field/depth-of-field-params';
import type { RenderExtent } from '../pipeline/render-extent';
import { prepareStandardLighting } from '../pipeline/standard-lighting/prepare';
import { deriveStandardTopologyInput } from '../pipeline/standard-lighting/topology';
import { selectStandardClusterTransport } from '../pipeline/standard-lighting/transport';
import { standardPipeline } from '../pipeline/standard-pipeline';
import { DEFAULT_STANDARD_PROFILE, STANDARD_PIPELINE_ID } from '../pipeline/standard-profile';
import type { RenderPipelineFrame, RenderPipelineTopology } from '../render-pipeline';

let device: RhiDevice;

beforeAll(async () => {
  const adapter = await rhi.requestAdapter();
  if (!adapter.ok) throw adapter.error;
  const result = await adapter.value.requestDevice();
  if (!result.ok) throw result.error;
  device = result.value;
});

function topology(
  bloom: 'off' | 'on',
  options: {
    readonly antialias?: 'fxaa' | 'taa';
    readonly depthOfField?: boolean;
    readonly extent?: RenderExtent;
  } = {},
): RenderPipelineTopology {
  return {
    pipelineId: STANDARD_PIPELINE_ID,
    standardProfile: DEFAULT_STANDARD_PROFILE,
    config: { ssao: { enabled: false } },
    surface: {
      width: 640,
      height: 360,
      storageFormat: 'bgra8unorm',
      viewFormat: 'bgra8unorm-srgb',
    },
    ...(options.extent === undefined ? {} : { extent: options.extent }),
    temporal: { taa: options.antialias === 'taa', motionBlur: false },
    camera: {
      tonemap: 'aces-filmic',
      antialias: options.antialias ?? 'fxaa',
      bloom,
      bloomIntensity: 1,
      ...(options.depthOfField === true
        ? { depthOfField: { blurSide: 'both' as const, useNear: true, useFar: true } }
        : {}),
    },
    shadow: {
      directional: { mapSize: 64, cascadeCount: 1 },
      spotMapSize: 64,
      pointCount: 0,
      pointFaceSize: 64,
      spotCount: 0,
    },
    lane: {
      compute: true,
      storageBuffer: true,
      multisample: false,
      maxColorAttachments: 8,
    },
    featureTopologySignature: 'none',
    gpuDrivenTopologySignature: '',
  };
}

function clusteredStandardLighting() {
  const prepared = prepareStandardLighting({
    directional: undefined,
    local: [{ kind: 'point' as const, shadowed: false, position: vec3.create(0, 0, -4), range: 2 }],
    view: mat4.lookAt(mat4.create(), [0, 0, 0], [0, 0, -1], [0, 1, 0]),
    projection: mat4.perspective(mat4.create(), Math.PI / 3, 1, 0.1, 100),
    near: 0.1,
    far: 100,
    grid: { x: 4, y: 3, z: 4 },
    lightCount: DEFAULT_STANDARD_PROFILE.lightCount,
    renderPath: 'forward',
  });
  if (!prepared.ok) throw prepared.error;
  const transport = selectStandardClusterTransport(
    { compute: true, storageBuffer: true, membershipPipelineReady: true },
    prepared.value,
  );
  if (!transport.ok) throw transport.error;
  const lighting = deriveStandardTopologyInput({
    kind: 'clustered',
    prepared: prepared.value,
    transport: transport.value,
  });
  if (!lighting.ok) throw lighting.error;
  return lighting.value;
}

function importedTaaHistory(graph: RenderGraphBuilder<RenderPipelineFrame>) {
  const target = (label: string, format: 'rgba16float' | 'r8unorm' = 'rgba16float') => {
    const texture = graph.importTexture(
      label,
      { format, size: 'surface', usage: 0x17 },
      (frame) => frame.currentTexture,
    );
    if (!texture.ok) throw texture.error;
    const view = graph.importView(texture.value, { label: `${label}.view` }, (frame) => frame.view);
    if (!view.ok) throw view.error;
    return { texture: texture.value, view: view.value, format, sampleCount: 1 as const };
  };
  return {
    currentColor: target('taa-history-current-color'),
    previousColor: target('taa-history-previous-color'),
    currentTemporal: target('taa-history-current-temporal'),
    previousTemporal: target('taa-history-previous-temporal'),
    currentStability: target('taa-history-current-stability', 'r8unorm'),
    previousStability: target('taa-history-previous-stability', 'r8unorm'),
  };
}

function inspect(
  fog: boolean,
  options: {
    readonly antialias?: 'fxaa' | 'taa';
    readonly depthOfField?: boolean;
    readonly extent?: RenderExtent;
  } = {},
) {
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const taaHistory = options.antialias === 'taa' ? importedTaaHistory(graph) : undefined;
  const built = standardPipeline.build(
    {
      graph,
      standardLighting: clusteredStandardLighting(),
      capabilities: { rgba16floatRenderable: true },
      ...(taaHistory === undefined ? {} : { taaHistory }),
      ...(options.depthOfField === true
        ? {
            camera: {
              depthOfField: DEFAULT_DEPTH_OF_FIELD_PARAMS satisfies DepthOfFieldParams,
            },
          }
        : {}),
      projectGpuDriven: () => ok(undefined),
      contributeFeatures: () => ok(undefined),
    },
    { ...topology('on', options), analyticFog: fog },
  );
  if (!built.ok) throw built.error;
  const compiled = graph.compile({ device, surfaceSize: { width: 640, height: 360 } });
  if (!compiled.ok) throw compiled.error;
  return compiled.value.inspect();
}

describe('analytic distance and height fog graph', () => {
  it('is absent when disabled, with no fog target or volume history', () => {
    const info = inspect(false);
    expect(info.passes.some((p) => p.name === 'analytic-fog')).toBe(false);
    expect(info.resources.filter((r) => r.label.startsWith('analytic-fog'))).toHaveLength(0);
  });
  it('fogs the opaque scene in place after opaque shading and before translucency', () => {
    const info = inspect(true);
    const names = info.passes.map((p) => p.name);
    expect(names.filter((n) => n === 'analytic-fog')).toHaveLength(1);
    expect(names.indexOf('analytic-fog')).toBeGreaterThan(names.indexOf('main'));
    expect(names.indexOf('analytic-fog')).toBeLessThan(names.indexOf('transparent'));
    expect(names.indexOf('analytic-fog')).toBeLessThan(names.indexOf('bloom-downsample-0'));
    expect(names.some((n) => n.startsWith('volume-'))).toBe(false);
    const fog = info.passes.find((p) => p.name === 'analytic-fog');
    expect(fog?.accesses).toEqual([
      { resource: 'scene-depth', usage: 'sampled-read' },
      { resource: 'analytic-fog-view', usage: 'uniform-read' },
      { resource: 'scene-color', usage: 'color-attachment' },
    ]);
    expect(info.resources.some((r) => r.label === 'analytic-fog-color')).toBe(false);
  });

  it('keeps fog on the internal lattice before TAA and DoF', () => {
    const extent: RenderExtent = {
      outputWidth: 640,
      outputHeight: 360,
      internalWidth: 320,
      internalHeight: 176,
      scale: 0.5,
      generation: 1,
    };
    for (const antialias of ['taa', 'fxaa'] as const) {
      const info = inspect(true, { antialias, depthOfField: true, extent });
      const names = info.passes.map((p) => p.name);
      const color = info.resources.find((resource) => resource.label === 'scene-color');
      const depth = info.resources.find((resource) => resource.label === 'scene-depth');
      expect(color?.descriptor).toEqual(expect.objectContaining({ width: 320, height: 176 }));
      expect(depth?.descriptor).toEqual(expect.objectContaining({ width: 320, height: 176 }));
      const resolve = names.indexOf(antialias === 'taa' ? 'taa-resolve' : 'fxaa');
      if (resolve >= 0) expect(names.indexOf('analytic-fog')).toBeLessThan(resolve);
    }
  });
});

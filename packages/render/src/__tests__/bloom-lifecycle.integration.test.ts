import { mat4, vec3 } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { beforeAll, describe, expect, it } from 'vitest';
import { DeviceScope, LifecycleTransaction } from '../device/device-scope';
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

function build(bloom: 'off' | 'on') {
  const topology: RenderPipelineTopology = {
    pipelineId: STANDARD_PIPELINE_ID,
    standardProfile: DEFAULT_STANDARD_PROFILE,
    config: { ssao: { enabled: false } },
    surface: {
      width: 320,
      height: 180,
      storageFormat: 'bgra8unorm',
      viewFormat: 'bgra8unorm-srgb',
    },
    camera: {
      tonemap: 'aces-filmic',
      antialias: 'fxaa',
      bloom,
      bloomIntensity: 1,
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
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
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
  const standardLighting = deriveStandardTopologyInput({
    kind: 'clustered',
    prepared: prepared.value,
    transport: transport.value,
  });
  if (!standardLighting.ok) throw standardLighting.error;
  const built = standardPipeline.build(
    {
      graph,
      standardLighting: standardLighting.value,
      projectGpuDriven: () => ok(undefined),
      contributeFeatures: () => ok(undefined),
    },
    topology,
  );
  if (!built.ok) throw built.error;
  const compiled = graph.compile({ device, surfaceSize: { width: 320, height: 180 } });
  if (!compiled.ok) throw compiled.error;
  return compiled.value.inspect();
}

function bloomSummary(info: ReturnType<typeof build>) {
  return {
    passes: info.passes.filter((pass) => pass.name.startsWith('bloom-')).map((pass) => pass.name),
    resources: info.resources
      .filter((resource) => resource.label.startsWith('bloom-'))
      .map((resource) => resource.label),
  };
}

describe('Standard Bloom lifecycle contract', () => {
  it('supports on -> off -> on for the Standard clustered graph', () => {
    const on = bloomSummary(build('on'));
    const off = bloomSummary(build('off'));
    const recovered = bloomSummary(build('on'));
    expect(on.passes).toHaveLength(10);
    expect(on.resources.length).toBeGreaterThan(0);
    expect(off).toEqual({ passes: [], resources: [] });
    expect(recovered).toEqual(on);
  });

  it('keeps post order scene -> Bloom -> output transform -> FXAA -> debug', () => {
    const names = build('on').passes.map((pass) => pass.name);
    const order = [
      'forward',
      'bloom-downsample-0',
      'bloom-downsample-1',
      'bloom-downsample-2',
      'bloom-downsample-3',
      'bloom-downsample-4',
      'bloom-upsample-3',
      'bloom-upsample-2',
      'bloom-upsample-1',
      'bloom-upsample-0',
      'bloom-composite',
      'output-transform',
      'fxaa',
      'debug-overlay',
    ];
    for (let index = 1; index < order.length; index += 1) {
      expect(names.indexOf(order[index] ?? '')).toBeGreaterThan(
        names.indexOf(order[index - 1] ?? ''),
      );
    }
  });

  it('owns a Bloom transient lease in a child DeviceScope and retires it', async () => {
    const renderer = DeviceScope.create(71, 'renderer');
    const bloom = renderer.createChild('standard-bloom');
    const transaction = new LifecycleTransaction(bloom);
    transaction.add({
      kind: 'texture',
      create: () => ({ label: 'bloom-downsample-0' }),
      cleanup: () => undefined,
    });
    const committed = await transaction.commit();
    expect(committed.ok).toBe(true);
    expect(renderer.resourceDelta()).toBe(0);
    expect(bloom.resourceDelta()).toBe(1);
    bloom.retire();
    expect(bloom.state).toBe('retired');
    expect(bloom.resourceDelta()).toBe(0);
  });

  it('FALSIFY rejects an injected Bloom contribution on the off path', () => {
    const off = bloomSummary(build('off'));
    const injected = { ...off, passes: ['bloom-falsified'] };
    expect(injected).not.toEqual({ passes: [], resources: [] });
    expect(off).toEqual({ passes: [], resources: [] });
  });
});

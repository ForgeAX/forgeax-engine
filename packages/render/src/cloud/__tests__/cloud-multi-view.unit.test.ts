import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { projectRendererFeatureInspection } from '../../assembly/renderer-feature-inspection';
import { createRenderFeatureHost, runRenderFeatureFrame } from '../../features/host';
import type { RenderFeaturePlan } from '../../features/plan';
import { createRenderFeatureGpuWorkOwner } from '../../features/prepared-gpu-work';
import type { RenderFeatureExtractView } from '../../features/types';
import { createSceneDataCatalog } from '../../temporal/scene-data-catalog';
import { CLOUD_DENSITY_COMPUTE_WGSL, createCloudLayerFeature } from '../feature';
import { validateCloudLayer } from '../parameters';

const params = validateCloudLayer({ quality: 'low' }).unwrap();
function view(identity: string, timeSeconds: number, render = true): RenderFeatureExtractView {
  return {
    identity,
    render,
    frame: {
      cloudLayer: {
        status: 'available',
        entityKey: 1 as never,
        revision: 1,
        params,
        sourceKey: 'cloud',
        worldTimeSeconds: timeSeconds,
        sunDirection: [0, -1, 0],
        sunRadiance: [1, 1, 1],
      },
      view: {
        identity,
        width: 64,
        height: 32,
        cameraRevision: 0,
        deviceGeneration: 0,
        cameraPosition: [0, 3, 0],
      },
    },
  };
}

function temporalParams(plan: RenderFeaturePlan, identity: string): Float32Array {
  const work = plan.work.find((work) => work.scope !== 'frame' && work.scope.view === identity);
  const program = work?.resources.find(
    (resource) => resource.kind === 'fullscreen-program' && resource.name === 'cloud-layer-view',
  );
  if (program?.kind !== 'fullscreen-program' || program.params === undefined)
    throw new Error('cloud view parameters missing');
  const bytes = program.params.defaultValue;
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

describe('cloud frame roster', () => {
  it.each([
    'local',
    'published',
  ] as const)('keeps %s histories at the receiver through holds, rejection, reorder and removal', (mode) => {
    const source = createCloudLayerFeature();
    const feature = mode === 'local' ? source : createCloudLayerFeature();
    const world = new World();
    const frame = (views: readonly RenderFeatureExtractView[]) => {
      const extracted = source
        .extract({ worlds: [world], owner: 0, frameNumber: 1, views })
        .unwrap();
      const data = mode === 'local' ? extracted : structuredClone(extracted);
      const plan = feature
        .plan(data, {
          caps: { compute: true, storageBuffer: true, rgba16floatRenderable: true } as never,
          frame: { frameNumber: 1 },
          generation: 0,
          views: views.map(({ identity, render }) => ({
            identity,
            render,
            frame: { frameNumber: 1 },
            targets: [],
            sceneData: createSceneDataCatalog({
              featureIdentity: feature.identity,
              generation: 0,
              planIdentity: identity,
              rgba16floatRenderable: true,
            }),
          })),
        })
        .unwrap();
      return { data, plan };
    };
    const initial = frame([view('left', 0), view('right', 0)]);
    expect(initial.data.views.left?.cache).toBe(initial.data.views.right?.cache);
    expect(initial.plan.work.filter((work) => work.scope === 'frame')).toHaveLength(1);
    expect(
      initial.plan.work.flatMap((work) => work.passes).filter((pass) => pass.kind === 'compute'),
    ).toHaveLength(1);
    expect(
      initial.plan.work.filter((work) => work.scope !== 'frame').map((work) => work.scope),
    ).toEqual([{ view: 'left' }, { view: 'right' }]);
    expect(temporalParams(initial.plan, 'left')[41]).toBe(1);
    expect(initial.data.inspection.left?.temporalResets).toBe(1);
    expect(temporalParams(initial.plan, 'right')[41]).toBe(1);
    feature.onFrameSubmitted?.(initial.data, {
      works: [
        { scope: { view: 'left' }, passes: [{ name: 'cloud-layer-transport' }] },
        { scope: { view: 'right' }, passes: [{ name: 'cloud-layer-density' }] },
      ],
    });
    expect(initial.data.inspection.left?.resourceStage).toBe('accepted');
    const held = frame([view('right', 0.1), view('left', 0.1, false)]);
    expect(held.data.inspection.left?.resourceStage).toBe('accepted');
    expect(held.data.views.left).toBeUndefined();
    expect(temporalParams(held.plan, 'right')[41]).toBe(1);
    const resumed = frame([view('right', 0.2), view('left', 0.2)]);
    expect(temporalParams(resumed.plan, 'left')[41]).toBe(0);
    expect(resumed.data.inspection.left?.temporalResets).toBe(1);
    expect(resumed.data.inspection.right?.temporalResets).toBe(1);
    expect(temporalParams(resumed.plan, 'left')[43]).toBe(0);
    expect(temporalParams(resumed.plan, 'right')[41]).toBe(1);
    feature.onFrameSubmitted?.(resumed.data, {
      works: [{ scope: { view: 'right' }, passes: [{ name: 'cloud-layer-transport' }] }],
    });
    expect(temporalParams(frame([view('right', 0.3)]).plan, 'right')[41]).toBe(0);
    expect(temporalParams(frame([view('left', 0.4), view('right', 0.4)]).plan, 'left')[41]).toBe(1);
  });
});

it.each([
  'local',
  'published',
] as const)('publishes receiver cloud inspection by view through the %s host path', async (mode) => {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const shader = (
    await rhi.createShaderModule(device, { code: CLOUD_DENSITY_COMPUTE_WGSL })
  ).unwrap();
  const owner = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
  });
  const feature = createCloudLayerFeature(),
    source = createCloudLayerFeature();
  const host = createRenderFeatureHost([feature]).unwrap();
  const world = new World();
  try {
    const views = [view('left', 0), view('right', 0)];
    const data = source
      .extract({ worlds: [world], owner: 0, frameNumber: 1, views, caps: device.caps })
      .unwrap();
    expect(data.inspection.left?.temporalResets).toBe(0);
    const batch = runRenderFeatureFrame(
      host,
      views.map((view) => ({
        ...view,
        worlds: [world],
        owner: 0,
        frameNumber: 1,
        caps: device.caps,
        gpuWork: owner,
        ...(mode === 'published'
          ? { publishedFeatures: [{ identity: feature.identity, data: structuredClone(data) }] }
          : {}),
      })),
    );
    expect(batch.frame.errors).toEqual([]);
    const projected = projectRendererFeatureInspection(host);
    expect(Object.keys(projected.cloudLayer ?? {})).toEqual(['left', 'right']);
    expect(projected.cloudLayer?.left).toMatchObject({
      status: 'available',
      resourceStage: 'candidate',
      temporalResets: 1,
      lastTemporalReset: 'history-missing',
    });
    expect(projected.cloudLayer?.right?.resourceFacts?.declaredHistoryBytes).toBeGreaterThan(0);
    batch.onAborted();
    const disabled = runRenderFeatureFrame(host, [
      {
        identity: 'left',
        render: true,
        worlds: [world],
        owner: 0,
        frameNumber: 2,
        caps: device.caps,
        gpuWork: owner,
        frame: {},
      },
    ]);
    disabled.views.get('left')?.onSubmitted();
    disabled.onSubmitted();
    expect(projectRendererFeatureInspection(host).cloudLayer).toMatchObject({
      left: { status: 'off', resourceStage: 'none' },
    });
    expect(projectRendererFeatureInspection(host).cloudLayer).not.toHaveProperty('right');
  } finally {
    host.dispose();
    owner.dispose();
  }
});

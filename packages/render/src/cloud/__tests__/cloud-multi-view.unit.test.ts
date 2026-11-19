import { World } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it, vi } from 'vitest';
import {
  abortFeatureFrame,
  prepareFeatureFrame,
  submitFeatureFrame,
} from '../../__tests__/feature-frame-driver';
import { projectRendererFeatureInspection } from '../../assembly/renderer-feature-inspection';
import { withBuiltinRenderFeatures } from '../../features/builtins';
import { createRenderFeatureHost } from '../../features/host';
import type { RenderFeaturePlan, RenderFeaturePlanContext } from '../../features/plan';
import type { RenderFeatureExtractView } from '../../features/types';
import { resolveFeatureTargets } from '../../render-system-record-attempt';
import { createSceneDataCatalog } from '../../temporal/scene-data-catalog';
import type { ExtractedProgramCloudLayer } from '../extract';
import { createMode0CloudFeature } from '../reconstruction/feature';

const layer = {
  status: 'analytic' as const,
  bottomMeters: 5000,
  thicknessMeters: 10000,
  entryLimitMeters: 350000,
  traceLimitMeters: 200000,
  sample: {
    extinctionPerMeter: 0.001,
    albedo: [1, 1, 1] as const,
    emissivePerMeter: [0, 0, 0] as const,
    materialAO: 1,
  },
};
function builtin() {
  const feature = withBuiltinRenderFeatures([]).find((f) => f.identity === 'forgeax.cloud-layer');
  if (!feature) throw new Error('Missing cloud builtin');
  return feature as ReturnType<typeof createMode0CloudFeature>;
}
function view(identity: string, render = true): RenderFeatureExtractView {
  return {
    identity,
    render,
    frame: {
      cloudLayer: layer,
      view: {
        identity,
        width: 64,
        height: 32,
        cameraRevision: 0,
        deviceGeneration: 0,
        cameraPosition: [0, 0, 0],
      },
    },
  };
}
function context(views: readonly RenderFeatureExtractView[]): RenderFeaturePlanContext {
  return {
    caps: { compute: true, storageBuffer: true, rgba16floatRenderable: true } as never,
    frame: { frameNumber: 1 },
    generation: 0,
    getFeatureShaderSource: () => '// shader',
    views: views.map((v) => ({
      identity: v.identity,
      render: v.render,
      frame: { frameNumber: 1, width: 64, height: 32 },
      targets: [
        { name: 'motion-output', kind: 'color', format: 'rgba16float', sampleCount: 1 },
        { name: 'depth', kind: 'depth', format: 'depth32float', sampleCount: 1 },
      ],
      sceneData: createSceneDataCatalog({
        featureIdentity: 'forgeax.cloud-layer',
        generation: 0,
        planIdentity: v.identity,
        rgba16floatRenderable: true,
      }),
    })),
  };
}
function history(plan: RenderFeaturePlan, identity: string) {
  const work = plan.work.find(
    (w) =>
      w.scope !== 'frame' &&
      w.scope.view === identity &&
      w.resources.some(
        (r) => r.kind === 'fullscreen-program' && r.name === 'cloud-layer-transport',
      ),
  );
  const program = work?.resources.find(
    (r) => r.kind === 'fullscreen-program' && r.name === 'cloud-layer-transport',
  );
  if (program?.kind !== 'fullscreen-program' || !program.params)
    throw new Error('Missing Mode0 history params');
  const b = program.params.defaultValue;
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4)[20];
}
const receipt = (identity: string) => ({
  scope: { view: identity },
  passes: ['cloud-analytic-trace', 'cloud-layer-transport', 'cloud-layer-resolve'].map((name) => ({
    name,
    graphics: { draws: [{ kind: 'draw' as const }] },
  })),
});

it('captures adopted settings only from the accepted cloud transport and does not reset history for a request stamp', () => {
  const record = vi.fn();
  const feature = createMode0CloudFeature(record);
  const world = new World();
  const frame = (requestRevision: number, frameNumber: number) => {
    const original = view('left');
    const tracked = {
      ...original,
      frame: {
        ...original.frame,
        cloudSun: { direction: vec3.create(-1, 0, 0), intensity: 17000 },
        cloudLayer: {
          ...layer,
          adoption: {
            requestRevision,
            worldIdentity: world.identity,
            entity: 9 as never,
            cookIdentity: 'cook',
          },
        },
      },
    };
    const data = feature.extract({ world, frameNumber, views: [tracked] }).unwrap();
    const plan = feature.plan(data, { ...context([tracked]), frame: { frameNumber } }).unwrap();
    return { data, plan };
  };
  const aborted = frame(1, 1);
  feature.onFrameAborted?.(aborted.data);
  expect(record).not.toHaveBeenCalled();
  const partial = frame(2, 2);
  const accepted = receipt('left');
  feature.onFrameSubmitted?.(partial.data, {
    works: [{ ...accepted, passes: accepted.passes.slice(0, 2) }],
  });
  expect(record).not.toHaveBeenCalled();
  const first = frame(3, 3);
  feature.onFrameSubmitted?.(first.data, { works: [accepted] });
  expect(record).toHaveBeenCalledExactlyOnceWith(
    3,
    'left',
    expect.objectContaining({
      requestRevision: 3,
      values: expect.objectContaining({
        thicknessMeters: 10000,
        sunDirectionToLight: [1, -0, -0],
        sunIlluminanceLux: 17000,
      }),
      unavailableFields: expect.objectContaining({
        useDetail: 'unsupported',
        exposure: 'unsupported',
      }),
    }),
  );
  const unchanged = frame(4, 4);
  expect(history(unchanged.plan, 'left')).toBe(1);
  feature.onFrameAborted?.(unchanged.data);
});

describe('Mode0 receiver view roster', () => {
  it.each([
    'local',
    'published',
  ] as const)('keeps %s accepted histories through holds, abort, reorder and removal', (mode) => {
    const source = builtin(),
      feature = mode === 'local' ? source : builtin(),
      world = new World();
    const frame = (views: readonly RenderFeatureExtractView[]) => {
      const extracted = source.extract({ world: world, frameNumber: 1, views }).unwrap();
      const data = mode === 'local' ? extracted : structuredClone(extracted);
      return { data, plan: feature.plan(data, context(views)).unwrap() };
    };
    const first = frame([view('left'), view('right')]);
    expect(history(first.plan, 'left')).toBe(0);
    expect(history(first.plan, 'right')).toBe(0);
    feature.onFrameSubmitted?.(first.data, { works: [receipt('left')] });
    expect(first.data.inspection.left?.mode0?.acceptedFrame).toBe(1);
    const held = frame([view('right'), view('left', false)]);
    expect(history(held.plan, 'right')).toBe(0);
    feature.onFrameAborted?.(held.data);
    const frameLessHold = frame([view('right'), { identity: 'left', render: false }]);
    expect(history(frameLessHold.plan, 'right')).toBe(0);
    feature.onFrameAborted?.(frameLessHold.data);
    const resumed = frame([view('right'), view('left')]);
    expect(history(resumed.plan, 'left')).toBe(1);
    expect(history(resumed.plan, 'right')).toBe(0);
    feature.onFrameSubmitted?.(resumed.data, { works: [receipt('right')] });
    const removed = frame([view('right')]);
    expect(history(removed.plan, 'right')).toBe(1);
    feature.onFrameAborted?.(removed.data);
    const restored = frame([view('left'), view('right')]);
    expect(history(restored.plan, 'left')).toBe(0);
    expect(history(restored.plan, 'right')).toBe(1);
    feature.onFrameAborted?.(restored.data);
  });
});

it.each([
  'local',
  'published',
] as const)('publishes per-view candidate inspection through the %s receiver host and removes vanished views', async (mode) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const feature = builtin(),
    source = builtin(),
    world = new World();
  const host = createRenderFeatureHost([feature]).unwrap();
  const targets = resolveFeatureTargets(
    { device },
    { colorAttachmentFormat: 'rgba16float' },
    { tonemap: 'none', antialias: 'none' },
    layer,
  );
  try {
    const views = [view('left'), view('right')];
    const extracted = source.extract({ world, frameNumber: 1, views }).unwrap();
    expect(extracted.inspection).toEqual({});
    const batch = prepareFeatureFrame(
      host,
      views.map((value) => ({
        ...value,
        world,
        frameNumber: 1,
        caps: device.caps,
        targets,
        getFeatureShaderSource: () => '//null-rhi-source',
        ...(mode === 'published'
          ? {
              publishedFeatures: [{ identity: feature.identity, data: structuredClone(extracted) }],
            }
          : {}),
      })),
    );
    expect(batch.frame.errors).toEqual([]);
    const inspection = projectRendererFeatureInspection(host).cloudLayer;
    expect(Object.keys(inspection ?? {})).toEqual(['left', 'right']);
    expect(inspection?.left).toMatchObject({
      status: 'available',
      resourceStage: 'candidate',
      mode0: { historyValid: false, resetReasons: ['history-missing'] },
    });
    expect(inspection?.right?.mode0?.viewId).toBe('right');
    expect(inspection?.left?.budget.measured).toBe(false);
    abortFeatureFrame(host);
    prepareFeatureFrame(host, [
      {
        identity: 'left',
        render: true,
        world: world,
        frameNumber: 2,
        caps: device.caps,
        frame: {},
        targets,
        getFeatureShaderSource: () => '//null-rhi-source',
      },
    ]);
    submitFeatureFrame(host);
    expect(projectRendererFeatureInspection(host).cloudLayer ?? {}).toEqual({});
  } finally {
    abortFeatureFrame(host);
    host.dispose();
  }
});

it.each([
  'local',
  'published',
] as const)('rejects %s stale, partial and retired-generation receipts without contaminating another view', (mode) => {
  const feature = builtin(),
    source = mode === 'local' ? feature : builtin(),
    world = new World();
  const frame = (views: readonly RenderFeatureExtractView[]) => {
    const value = source.extract({ world, frameNumber: 1, views }).unwrap();
    const data = mode === 'local' ? value : structuredClone(value);
    return { data, plan: feature.plan(data, context(views)).unwrap() };
  };
  const first = frame([view('left'), view('right')]);
  feature.onFrameSubmitted?.(first.data, { works: [receipt('left'), receipt('right')] });
  const stale = frame([view('left'), view('right')]);
  const replacement = frame([view('left'), view('right')]);
  feature.onFrameSubmitted?.(stale.data, { works: [receipt('left')] });
  expect(stale.data.inspection.left?.resourceStage).toBe('candidate');
  feature.onFrameSubmitted?.(replacement.data, {
    works: [
      {
        scope: { view: 'left' },
        passes: [{ name: 'cloud-layer-resolve', graphics: { draws: [{ kind: 'draw' }] } }],
      },
      receipt('right'),
    ],
  });
  const recoveredView = view('left');
  if (!recoveredView.frame?.view) throw new Error('Missing recovery view fixture');
  const recovered = {
    ...recoveredView,
    frame: {
      cloudLayer: layer,
      view: {
        ...recoveredView.frame?.view,
        identity: 'left',
        width: 64,
        height: 32,
        deviceGeneration: 1,
        recovery: true,
      },
    },
  };
  const recovering = frame([recovered, view('right')]);
  expect(history(recovering.plan, 'left')).toBe(0);
  expect(history(recovering.plan, 'right')).toBe(1);
  expect(recovering.data.inspection.left?.mode0?.resetReasons).toEqual(
    expect.arrayContaining(['device-generation', 'camera-cut']),
  );
  feature.onFrameSubmitted?.(stale.data, { works: [receipt('left')] });
  expect(history(frame([recovered, view('right')]).plan, 'left')).toBe(0);
});

it('retains submitted program history during continuous wind and resets only on explicit initialization', () => {
  const feature = builtin(),
    world = new World();
  const program: ExtractedProgramCloudLayer = {
    ...layer,
    status: 'program',
    materialGuid: 'material',
    cookIdentity: 'cook',
    programIdentity: 'program',
    rendererSource: '//null-rhi-program',
    materialParameters: new Float32Array(0),
    windOffsetMeters: [0, 0, 0],
    viewSampleCountScale: 1,
    stopTransmittance: 0.005,
    diagnostic: [0, 0, 0],
  };
  const frame = (offset: readonly [number, number, number], initializationRevision = 0) => {
    const views = [
      {
        ...view('camera'),
        frame: {
          ...view('camera').frame,
          cloudLayer: { ...program, windOffsetMeters: offset, initializationRevision },
        },
      },
    ];
    const data = feature.extract({ world, frameNumber: 1, views }).unwrap();
    return { data, plan: feature.plan(data, context(views)).unwrap() };
  };
  const first = frame([0, 0, 0]);
  feature.onFrameSubmitted?.(first.data, {
    works: [
      {
        scope: { view: 'camera' },
        passes: ['cloud-sampled-trace', 'cloud-layer-transport', 'cloud-layer-resolve'].map(
          (name) => ({ name, graphics: { draws: [{ kind: 'draw' }] } }),
        ),
      },
    ],
  });
  const moving = frame([100, 200, 300]);
  expect(history(moving.plan, 'camera')).toBe(1);
  expect(moving.data.inspection.camera?.mode0?.resetReasons).toEqual([]);
  feature.onFrameAborted?.(moving.data);
  const initialized = frame([100, 200, 300], 1);
  expect(history(initialized.plan, 'camera')).toBe(0);
  expect(initialized.data.inspection.camera?.mode0?.resetReasons).toContain('initialization');
  feature.onFrameAborted?.(initialized.data);
});

it.each([
  'local',
  'published',
] as const)('distinguishes a %s frameless hold from an explicitly cloud-free held view', (mode) => {
  const source = builtin(),
    feature = mode === 'local' ? source : builtin(),
    world = new World();
  const frame = (views: readonly RenderFeatureExtractView[]) => {
    const extracted = source.extract({ world, frameNumber: 1, views }).unwrap();
    const data = mode === 'local' ? extracted : structuredClone(extracted);
    return { data, plan: feature.plan(data, context(views)).unwrap() };
  };
  const initial = frame([view('left'), view('right')]);
  feature.onFrameSubmitted?.(initial.data, { works: [receipt('left'), receipt('right')] });
  const held = frame([{ identity: 'left', render: false }, view('right')]);
  feature.onFrameAborted?.(held.data);
  const resumed = frame([view('left'), view('right')]);
  expect(history(resumed.plan, 'left')).toBe(1);
  expect(history(resumed.plan, 'right')).toBe(1);
  feature.onFrameAborted?.(resumed.data);
  const cloudFree = frame([{ identity: 'left', render: false, frame: {} }, view('right')]);
  feature.onFrameAborted?.(cloudFree.data);
  const restored = frame([view('left'), view('right')]);
  expect(history(restored.plan, 'left')).toBe(0);
  expect(history(restored.plan, 'right')).toBe(1);
  feature.onFrameAborted?.(restored.data);
});

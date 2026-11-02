import type { EntityHandle } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { createRenderFeatureHost } from '../../features/host';
import {
  RENDER_FEATURE_VIEWS_SYSTEM,
  RENDER_MOTION_BLUR_PLAN_SYSTEM,
  ViewFeatureInput,
  type ViewFeatureInputState,
} from '../feature-systems';
import { registerFeatureViewsSystem } from '../feature-view-systems';
import { RenderViewInput, ViewRecorder } from '../render-views';
import { beginRenderFrame, RenderPrepare } from '../render-world';
import { ViewFrame, type ViewFrameState } from '../view-frame-systems';
import { withInertTemporal } from './temporal-owner-fixture';

/** An owner-only recorder: the Feature view systems read its owner bag, never a RenderSystem. */
function ownedRecorder() {
  return withInertTemporal(
    {},
    {
      internals: {
        canvas: { width: 64, height: 32 },
        deviceScope: { generation: 1 },
        captureView: undefined,
        featureHost: undefined,
        getPipelineState: () => null,
      },
    },
  );
}

function setup(options: { readonly resolved: boolean; readonly source?: boolean }) {
  const host = createRenderFeatureHost([]).unwrap();
  const world = host.world;
  if (options.source !== false)
    world.insertResource(RenderViewInput, { worlds: [], leases: undefined });
  registerFeatureViewsSystem(world);
  const frame = {
    frame: 0,
    mode: true,
    opts: { cameraOwner: 0, resourceOwner: 0 },
    publication: undefined,
    result: options.resolved
      ? { ok: true, value: { cameras: [], cubeCameras: [], auxiliaryCameras: [] } }
      : { ok: false, cause: new Error('frame failed') },
  } as unknown as ViewFrameState;
  const entity: EntityHandle = world
    .spawn(
      {
        component: ViewRecorder,
        data: { state: world.allocUniqueRef('ViewRecorder', ownedRecorder()) },
      },
      { component: ViewFrame, data: { state: world.allocUniqueRef('ViewFrame', frame) } },
    )
    .unwrap();
  const prepare = (frameNumber: number) => {
    frame.frame = frameNumber;
    beginRenderFrame(world, frameNumber);
  };
  const input = () =>
    world
      .resolveUniqueRef<ViewFeatureInputState>(world.get(entity, ViewFeatureInput).unwrap().state)
      .unwrap();
  return { host, world, entity, prepare, input };
}

describe('render-feature-views', () => {
  it('declares its reads and stores the input as data', () => {
    const { world, host } = setup({ resolved: true });
    const system = world
      .scheduleData()
      .find((data) => data.name === 'RenderPrepare')
      ?.systems.find((data) => data.name === RENDER_FEATURE_VIEWS_SYSTEM);
    expect(system?.queries[0]?.read).toEqual(['ViewRecorder', 'ViewFrame']);
    expect(system?.queries[0]?.optional).toEqual(['ViewFeatureInput']);
    host.dispose();
  });

  it('stores an unresolved view frame as unavailable data from an owner-only recorder', () => {
    const f = setup({ resolved: false });
    expect(() => f.prepare(1)).not.toThrow();
    const outcome = f.input().outcome;
    expect(outcome.kind === 'unavailable' && outcome.error.detail.reason).toBe('view-frame-failed');
    f.host.dispose();
  });

  it('stores an unexpected derivation failure as data without throwing', () => {
    // No staged view source: deriving the view inputs throws inside the system.
    const f = setup({ resolved: true, source: false });
    expect(() => f.prepare(1)).not.toThrow();
    expect(f.input().outcome.kind).toBe('failed');
    f.host.dispose();
  });
});

describe('render-motion-blur-plan', () => {
  it('plans a prepared view from its owner and keeps the Feature input', () => {
    const f = setup({ resolved: true });
    f.world.removeSystem(RenderPrepare, RENDER_FEATURE_VIEWS_SYSTEM).unwrap();
    const state: ViewFeatureInputState = {
      frame: 1,
      outcome: {
        kind: 'prepared',
        value: {
          input: {
            identity: 'v',
            render: true,
            worlds: [],
            owner: 0,
            frameNumber: 0,
            caps: {} as never,
          },
          skylight: undefined,
        },
      },
      motionBlur: undefined,
    };
    f.world
      .addComponent(f.entity, {
        component: ViewFeatureInput,
        data: { state: f.world.allocUniqueRef('ViewFeatureInput', state) },
      })
      .unwrap();
    expect(() => f.prepare(1)).not.toThrow();
    expect(f.input().motionBlur).toEqual({ frame: 1, input: undefined });
    expect(f.input().outcome.kind).toBe('prepared');
    expect(RENDER_MOTION_BLUR_PLAN_SYSTEM).toBe('render-motion-blur-plan');
    f.host.dispose();
  });
});

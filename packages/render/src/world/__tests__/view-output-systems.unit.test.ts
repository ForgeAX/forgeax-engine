import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { describe, expect, it, vi } from 'vitest';
import type { CameraSnapshot } from '../../render-contract';
import type { RenderTarget } from '../../targets/contracts';
import {
  RenderView,
  RenderViewFrameSource,
  RenderViewInput,
  RenderViews,
  recordViewSubmission,
  ViewRecorder,
} from '../render-views';
import {
  beginRenderFrame,
  createRenderWorld,
  endRenderFrame,
  publishRenderSubmission,
} from '../render-world';
import { viewFrameOf } from '../view-frame-systems';
import {
  RENDER_VIEW_OUTPUT_SETTLE_SYSTEM,
  RENDER_VIEW_OUTPUTS_SYSTEM,
  RENDER_VIEW_OWNER_SYSTEM,
  registerViewOutputSystems,
  registerViewRecorderSystem,
  throwViewFailure,
  type ViewRecorderFactory,
  type ViewRecorderState,
  viewComposition,
} from '../view-output-systems';
import { withInertTemporal } from './temporal-owner-fixture';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function camera(entityKey: number, target?: RenderTarget, updateInterval = 1) {
  return {
    entityKey,
    historyVersion: 1,
    world: IDENTITY,
    fov: 1,
    aspect: 1,
    ...(target === undefined ? {} : { target }),
    view: {
      viewport: new Float32Array([0, 0, 1, 1]),
      order: 0,
      resolutionScale: 1,
      maxRenderShortSide: 0,
      updateInterval,
      enabled: true,
    },
  } as unknown as CameraSnapshot;
}

interface FixtureOptions {
  readonly target?: RenderTarget;
  readonly resident?: boolean;
  readonly updateInterval?: number;
  /** Register `render-view-recorders`; false proves a test depends on it. */
  readonly recorders?: boolean;
  readonly probePlacement?: boolean;
  readonly cameraCount?: number;
}

function fixture(options: FixtureOptions = {}) {
  const world = createRenderWorld();
  const views = new RenderViews(world);
  const created: { label: string; width: number }[] = [];
  const destroyed: unknown[] = [];
  const marked: unknown[] = [];
  const device = {
    queue: { onSubmittedWorkDone: () => Promise.resolve() },
    createTexture: vi.fn((descriptor: { label: string; size: { width: number } }) => {
      const texture = { label: descriptor.label };
      created.push({ label: descriptor.label, width: descriptor.size.width });
      return { ok: true as const, value: texture };
    }),
    destroyTexture: vi.fn((texture: unknown) => destroyed.push(texture)),
  };
  const host = {
    device,
    deviceScope: { generation: 1 },
    canvas: { width: 64, height: 32 },
    viewEntity: undefined as EntityHandle | undefined,
    standardProfile: options.probePlacement === true ? { probePlacement: {} } : undefined,
    getPipelineState: () => ({ format: 'rgba8unorm', colorAttachmentFormat: 'rgba8unorm' }),
    getRenderTargetPhysical: (target: RenderTarget) =>
      options.resident === false
        ? undefined
        : {
            target,
            descriptor: { shape: '2d', sampleCount: 1, mipLevels: 1, width: 16, height: 8 },
          },
    markRenderTargetSubmitted: (target: unknown) => marked.push(target),
  };
  const compositors: { disposed: number }[] = [];
  const owner = registerViewOutputSystems(world, views, host as never, () => {
    const compositor = { disposed: 0, generation: 0, encode: () => true };
    compositors.push(compositor);
    return Object.assign(compositor, {
      dispose: () => {
        compositor.disposed += 1;
      },
    }) as never;
  });
  const plan = viewComposition(world);
  const recorders: ViewRecorderState[] = [];
  const createRecorder: ViewRecorderFactory = (entity, facts, target, viewport) => {
    const state = withInertTemporal({
      entity,
      key: String(recorders.length),
      camera: facts.camera,
      eye: undefined,
      device,
      target,
      output: undefined,
      viewport,
      captureSize: { width: 1, height: 1 },
      picture: { texture: undefined, viewport, channels: 'all' },
      renderedFrames: 0,
      lastFrame: Number.NEGATIVE_INFINITY,
      rendered: false,
      retired: false,
      capture: facts.capture ? { work: [] } : undefined,
    } as unknown as ViewRecorderState);
    recorders.push(state);
    const ref = world.allocUniqueRef('ViewRecorder', state, () => {
      state.retired = true;
    });
    world.addComponent(entity, { component: ViewRecorder, data: { state: ref } }).unwrap();
    return state;
  };
  const primary = (withInertTemporal({}) as unknown as { owner: unknown }).owner;
  (host as { viewOwner?: unknown }).viewOwner = primary;
  if (options.recorders !== false)
    registerViewRecorderSystem(world, views, {
      internals: host as never,
      createRecorder,
    });
  const source = new RenderViewFrameSource(host as never);
  world.insertResource(RenderViewInput, source);
  let frame = 0;
  let sourceWorld = new World();
  const begin = (width = 64, opts: { temporalReset?: boolean } = {}) => {
    host.canvas.width = width;
    const cameras = Array.from({ length: options.cameraCount ?? 1 }, (_, index) =>
      camera(index + 1, options.target, options.updateInterval),
    );
    source.stage(
      cameras,
      [],
      [sourceWorld],
      { cameraOwner: 0, resourceOwner: 0, ...opts },
      undefined,
      undefined,
    );
    beginRenderFrame(world, ++frame);
  };
  /** The next frame's cameras come from another source World. */
  const replaceSource = () => {
    sourceWorld = new World();
  };
  const end = () => endRenderFrame(world);
  /** Publish the frame's outcome and each recorded view's accepted attempt. */
  const submit = (accepted: boolean) => {
    for (const view of plan.recorded)
      recordViewSubmission(world, view.entity, {
        accepted,
        attempt: frame,
        scene: accepted,
        temporal: false,
      });
    publishRenderSubmission(world, {
      accepted,
      completion: accepted ? Promise.resolve() : undefined,
      creditCompletion: undefined,
      generation: 1,
    });
  };
  return {
    world,
    views,
    host,
    owner,
    plan,
    recorders,
    compositors,
    primary,
    created,
    destroyed,
    marked,
    begin,
    replaceSource,
    submit,
    end,
  };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('view output systems', () => {
  it('registers outputs in Prepare after the view frame and the settlement in Commit', () => {
    const { world } = fixture();
    const schedule = (name: string) =>
      world.scheduleData().find((data) => data.name === name)?.systems ?? [];
    expect(schedule('RenderPrepare').map((system) => system.name)).toContain(
      RENDER_VIEW_OUTPUTS_SYSTEM,
    );
    expect(schedule('RenderCommit').map((system) => system.name)).toContain(
      RENDER_VIEW_OUTPUT_SETTLE_SYSTEM,
    );
  });

  it('sizes the recording view output and lists its picture in RenderPrepare', () => {
    const { plan, recorders, created, begin } = fixture();
    begin();
    const [view] = recorders;
    expect(created).toEqual([{ label: 'camera:0:output', width: 64 }]);
    expect(view?.output).toMatchObject({ width: 64, height: 32 });
    expect(plan.recorded).toEqual([view]);
    expect(plan.pictures).toEqual([view?.picture]);
    expect(plan.replaced).toHaveLength(1);
    expect(plan.blocked).toBe(false);
  });

  it('retires the previous output after a submitted frame and keeps the new one', async () => {
    const { recorders, destroyed, begin, submit, end } = fixture();
    begin();
    const [view] = recorders;
    const first = view?.output?.texture;
    submit(true);
    end();
    await settled();
    expect(destroyed).toEqual([]);
    expect(view?.output?.texture).toBe(first);
    // A resize replaces the output; the submitted frame retires the old texture.
    begin(48);
    const second = view?.output?.texture;
    expect(second).not.toBe(first);
    submit(true);
    end();
    await settled();
    expect(destroyed).toEqual([first]);
    expect(view?.output?.texture).toBe(second);
  });

  it('restores the previous output and retires the new one when the frame is not submitted', async () => {
    const { recorders, destroyed, begin, submit, end } = fixture();
    begin();
    submit(true);
    end();
    const [view] = recorders;
    const first = view?.output?.texture;
    begin(48);
    const second = view?.output?.texture;
    expect(second).not.toBe(first);
    submit(false);
    end();
    await settled();
    expect(view?.output?.texture).toBe(first);
    expect(view?.picture.texture).toBe(first);
    expect(destroyed).toEqual([second]);
  });

  it('blocks the frame while a declared output target is not resident', () => {
    const target = {} as RenderTarget;
    const { plan, begin, created } = fixture({ target, resident: false });
    begin();
    expect(plan.blocked).toBe(true);
    expect(created).toEqual([]);
    expect(plan.recorded).toEqual([]);
  });

  it('marks only submitted RenderTarget views as submitted in RenderCommit', () => {
    const target = {} as RenderTarget;
    const { begin, submit, end, marked, plan } = fixture({ target });
    begin();
    expect(plan.pictures).toEqual([]);
    submit(false);
    end();
    expect(marked).toEqual([]);
    begin();
    submit(true);
    end();
    expect(marked).toEqual([target]);
  });

  it('remembers the shared capture only for a submitted composed frame', () => {
    const { plan, begin, submit, end } = fixture();
    begin();
    plan.captureDemand = true;
    submit(true);
    end();
    expect(plan.captureRecorded).toBe(true);
    begin();
    plan.captureDemand = true;
    submit(false);
    end();
    expect(plan.captureRecorded).toBe(false);
  });
  it('adopts a recorder and stages the frame of every recording view in RenderExtract', () => {
    const { world, views, recorders, plan, primary, host, begin } = fixture({ cameraCount: 2 });
    const extract = world.scheduleData().find((data) => data.name === 'RenderExtract');
    expect(extract?.systems.map((system) => system.name)).toEqual(
      expect.arrayContaining([RENDER_VIEW_OWNER_SYSTEM, 'render-view-recorders']),
    );
    begin();
    expect(plan.active).toBe(true);
    expect(recorders.map((recorder) => recorder.entity)).toEqual(views.ordered);
    for (const entity of views.ordered) expect(viewFrameOf(world, entity)?.mode).toBe(true);
    // The primary view is the shared capture view: it carries the primary owner bag.
    const shared = views.primary as EntityHandle;
    expect(world.get(shared, RenderView).unwrap().capture).toBe(true);
    const payload = world
      .resolveUniqueRef<Record<string, unknown>>(world.get(shared, ViewRecorder).unwrap().state)
      .unwrap();
    // The recorder holds ECS data only: the owner bag, no RenderSystem object.
    expect(Object.keys(payload)).toEqual(['owner']);
    expect(payload.owner).toBe(primary);
    expect(host.viewEntity).toBe(shared);
    expect(plan.recorded).toHaveLength(2);
  });

  it('records nothing without render-view-recorders', () => {
    const { world, views, recorders, plan, created, begin } = fixture({ recorders: false });
    begin();
    expect(recorders).toEqual([]);
    expect(views.ordered).toHaveLength(1);
    expect(viewFrameOf(world, views.ordered[0])).toBeUndefined();
    expect(plan.recorded).toEqual([]);
    expect(created).toEqual([]);
  });

  it('holds a view between its update intervals and re-renders it on temporal reset', () => {
    const { world, views, begin, submit, end } = fixture({ updateInterval: 2 });
    const mode = () => viewFrameOf(world, views.ordered[0])?.mode;
    begin();
    expect(mode()).toBe(true);
    submit(true);
    end();
    begin();
    expect(mode()).toBe(false);
    submit(true);
    end();
    begin();
    expect(mode()).toBe(true);
    submit(true);
    end();
    begin(64, { temporalReset: true });
    expect(mode()).toBe(true);
  });

  it('retires every view and replaces the compositor when the source World or device changes', () => {
    const { owner, recorders, compositors, host, begin, replaceSource, submit, end } = fixture();
    begin();
    submit(true);
    end();
    const [first] = recorders;
    expect(compositors).toHaveLength(2);
    begin();
    submit(true);
    end();
    expect(recorders).toHaveLength(1);
    expect(compositors).toHaveLength(2);
    replaceSource();
    begin();
    expect(first?.retired).toBe(true);
    expect(recorders).toHaveLength(2);
    expect(compositors[1]?.disposed).toBeGreaterThan(0);
    expect(owner.compositor).toBe(compositors[2]);
    submit(true);
    end();
    host.deviceScope.generation = 2;
    begin();
    expect(recorders).toHaveLength(3);
    expect(owner.generation).toBe(2);
  });

  it('reports probe placement over several views as the frame failure, not a system throw', () => {
    const { world, begin, end } = fixture({ probePlacement: true, cameraCount: 2 });
    expect(() => begin()).not.toThrow();
    expect(() => throwViewFailure(world)).toThrow(/probe placement/);
    // The failure is rethrown once.
    expect(() => throwViewFailure(world)).not.toThrow();
    end();
  });
});

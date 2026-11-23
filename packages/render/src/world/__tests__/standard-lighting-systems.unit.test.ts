import { defineSystem, World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import type { SystemOrderReference } from '../../../../ecs/src/schedule';
import { registeredSystem } from '../../__tests__/registered-system.fixture';
import { RendererOperationError } from '../../errors/render';
import { MaterialResource } from '../../material-resource';
import { DEFAULT_STANDARD_PROFILE, type StandardProfile } from '../../pipeline/standard-profile';
import type { RenderFrameState } from '../../record/frame-snapshot';
import type { PipelineState, RenderSystemInternals } from '../../record/render-context';
import { defaultMaterialSnapshot, type ExtractedFrame } from '../../render-system-extract';

import { MaterialFrame } from '../../scene/material-dispatch';
import type { PersistentShadowCasterProjection } from '../../scene/render-scene';
import {
  RenderCascadeFitOrder,
  RenderEnvironmentAdmitOrder,
  RenderStandardLightingOrder,
  RenderViewFrameOrder,
} from '../../system-order';
import { VIEW_ENVIRONMENT_ADMIT_SYSTEM } from '../environment-systems';
import { RENDER_CASCADE_FIT_SYSTEM } from '../light-systems';
import { createViewRecord, ViewCascadeFit, type ViewLights } from '../render-lights';
import { RenderViewFrameSource, RenderViewInput, ViewRecorder } from '../render-views';
import {
  beginRenderFrame,
  createRenderWorld,
  endRenderFrame,
  RenderExtract,
  RenderPrepare,
} from '../render-world';
import {
  admitViewStandardLighting,
  consumeViewStandardLighting,
  type FrameLighting,
  RENDER_STANDARD_LIGHTING_SYSTEM,
  registerStandardLightingSystem,
  storeViewStandardLighting,
  type ViewStandardLightingOutcome,
  viewStandardLightingOf,
} from '../standard-lighting-systems';
import {
  RENDER_VIEW_FRAME_SYSTEM,
  RENDER_VIEW_RECORDERS_SYSTEM,
  stageViewFrame,
} from '../view-frame-systems';
import { registerViewFrameStub, withInertTemporal } from './temporal-owner-fixture';

const opts = {} as const;
const pipelineState = {} as PipelineState;
const lighting = { ok: true, value: { totalLightCount: 0 } } as unknown as FrameLighting;
const fence = { pipelineState, pipelineHandle: 2, deviceGeneration: 5 } as const;

/**
 * A staged and a held view whose frames resolve. `prepare` stands in for
 * `render-standard-lighting` (storing the staged view's outcome) unless
 * `owner` is given: the real system then prepares from the view's own owner
 * bag and fitted lights.
 */
function setup(
  prepare: () => ViewStandardLightingOutcome,
  owner?: Record<string, unknown>,
  lights: ViewLights | null = {} as ViewLights,
  frame = { renderables: [], cameras: [] } as unknown as ExtractedFrame,
) {
  const world = createRenderWorld();
  world.insertResource(
    RenderViewInput,
    Object.assign(new RenderViewFrameSource({ canvas: { width: 8, height: 8 } }), {
      world: new World(),
    }),
  );
  const order: string[] = [];
  // Registered first so only `after` can order the lighting behind its inputs.
  const staged = world.spawn().unwrap();
  const held = world.spawn().unwrap();
  const forwardOrder1: SystemOrderReference[] = [];
  const systemToken1 = defineSystem({
    sets: [RenderStandardLightingOrder],
    name: RENDER_STANDARD_LIGHTING_SYSTEM,
    after: forwardOrder1,
    queries: [],
    fn: (world) => {
      order.push(RENDER_STANDARD_LIGHTING_SYSTEM);
      storeViewStandardLighting(world, staged, prepare());
    },
  });
  if (owner !== undefined) registerStandardLightingSystem(world);
  else world.addSystem(RenderPrepare, systemToken1).unwrap();
  registerViewFrameStub(world, () => {
    order.push(RENDER_VIEW_FRAME_SYSTEM);
    return { ok: true, value: frame };
  });
  const systemToken2 = defineSystem({
    sets: [RenderCascadeFitOrder],
    name: RENDER_CASCADE_FIT_SYSTEM,
    queries: [],
    fn: () => void order.push(RENDER_CASCADE_FIT_SYSTEM),
  });
  world.addSystem(RenderPrepare, systemToken2).unwrap();
  const systemToken3 = defineSystem({
    sets: [RenderEnvironmentAdmitOrder],
    name: VIEW_ENVIRONMENT_ADMIT_SYSTEM,
    after: [RenderViewFrameOrder],
    queries: [],
    fn: () => {
      order.push(VIEW_ENVIRONMENT_ADMIT_SYSTEM);
    },
  });
  forwardOrder1.push(RenderViewFrameOrder, systemToken2, systemToken3);
  world.addSystem(RenderPrepare, systemToken3).unwrap();
  for (const entity of [staged, held]) {
    const state = world.allocUniqueRef('ViewRecorder', withInertTemporal({}, owner));
    world.addComponent(entity, { component: ViewRecorder, data: { state } }).unwrap();
    const record = createViewRecord(entity);
    if (lights !== null) record.lights = lights;
    world
      .addComponent(entity, {
        component: ViewCascadeFit,
        data: { fit: world.allocUniqueRef('ViewCascadeFit', record) },
      })
      .unwrap();
  }
  const systemToken4 = defineSystem({
    name: RENDER_VIEW_RECORDERS_SYSTEM,
    queries: [],
    fn: (world) => stageViewFrame(world, staged, opts),
  });
  world.addSystem(RenderExtract, systemToken4).unwrap();
  const internals = {
    renderWorld: world,
    viewEntity: staged,
    deviceScope: { generation: 5 },
  } as unknown as RenderSystemInternals;
  return { world, order, staged, held, internals };
}

const frameState = (installedPipelineHandle: number) =>
  ({ installedPipelineHandle }) as RenderFrameState;

const unprepared = (): FrameLighting => {
  throw new Error('a Render World view never prepares lighting while recording');
};

/** A view owner bag whose camera admission runs and whose pipeline state read fails. */
function viewOwner() {
  const cause = new Error('pipeline state unavailable');
  const frameState = {
    installedPipelineHandle: 4,
    standardInstall: { configured: undefined, built: 4, cameraSignature: '', cameraFailure: '' },
  } as unknown as RenderFrameState & Record<string, unknown>;
  const internals = {
    device: {
      caps: { storageBuffer: true },
      limits: { maxColorAttachments: 8, maxColorAttachmentBytesPerSample: 72 },
    },
    deviceScope: { generation: 5 },
    standardProfile: undefined as StandardProfile | undefined,
    errorRegistry: { fire: () => undefined },
    getPipelineState: () => {
      throw cause;
    },
  };
  return {
    owner: {
      frameState,
      internals,
      scene: {
        materialFrame: () => new MaterialFrame(undefined),
        shadowCasterProjection: (): PersistentShadowCasterProjection | undefined => undefined,
      },
    },
    frameState,
    cause,
  };
}

describe('render-standard-lighting system', () => {
  it.each([
    { source: 'scene', renderPath: 'forward' },
    { source: 'scene', renderPath: 'deferred' },
    { source: 'candidate', renderPath: 'forward' },
    { source: 'candidate', renderPath: 'deferred' },
  ] as const)('retains $renderPath with $source SLW demand', ({ source, renderPath }) => {
    const { owner, frameState } = viewOwner();
    const profile = { ...DEFAULT_STANDARD_PROFILE, renderPath };
    owner.internals.standardProfile = profile;
    const resource = new MaterialResource({
      ...defaultMaterialSnapshot(),
      surfaceModel: 'single-layer-water',
    });
    let materials = new MaterialFrame(undefined).with(resource);
    if (source === 'scene')
      owner.scene.shadowCasterProjection = () =>
        ({
          content: { materials },
          renderables: [],
        }) as unknown as PersistentShadowCasterProjection;
    else
      frameState.candidatePipelinePreparations = {
        get materials() {
          return materials;
        },
      } as unknown as NonNullable<RenderFrameState['candidatePipelinePreparations']>;
    const frame = {
      renderables: [],
      cameras: [{ antialias: 'none' }],
    } as unknown as ExtractedFrame;
    const { world } = setup(() => ({ kind: 'not-admitted' }), owner, {} as ViewLights, frame);
    beginRenderFrame(world, 1);
    expect(frameState.cameraStandardProfile).toBe(profile);
    endRenderFrame(world);
    materials = materials.with(resource, 0);
    beginRenderFrame(world, 2);
    expect(frameState.cameraStandardProfile).toBe(profile);
    endRenderFrame(world);
  });
  it('ignores unselected shared SLW materials when the view projection has no Water', () => {
    const { owner, frameState } = viewOwner();
    owner.internals.standardProfile = DEFAULT_STANDARD_PROFILE;
    owner.scene.materialFrame = () =>
      new MaterialFrame(undefined).with(
        new MaterialResource({
          ...defaultMaterialSnapshot(),
          surfaceModel: 'single-layer-water',
        }),
      );
    owner.scene.shadowCasterProjection = () =>
      ({
        content: { materials: new MaterialFrame(undefined) },
        renderables: [],
      }) as unknown as PersistentShadowCasterProjection;
    const frame = {
      renderables: [],
      cameras: [{ antialias: 'none' }],
    } as unknown as ExtractedFrame;
    const { world } = setup(() => ({ kind: 'not-admitted' }), owner, {} as ViewLights, frame);
    beginRenderFrame(world, 1);
    expect(frameState.cameraStandardProfile).toBe(DEFAULT_STANDARD_PROFILE);
    endRenderFrame(world);
  });
  it('admits the camera configuration and prepares from the view owner, never throwing', () => {
    const { owner, frameState, cause } = viewOwner();
    const { world, staged, held } = setup(() => ({ kind: 'not-admitted' }), owner);
    beginRenderFrame(world, 1);
    // A changed camera signature brands a new installed pipeline and retires its graph state.
    expect(frameState.installedPipelineHandle).toBe(5);
    expect(frameState.standardInstall).toMatchObject({
      built: 5,
      cameraSignature: JSON.stringify([undefined, undefined]),
    });
    expect(viewStandardLightingOf(world, staged)).toEqual({ kind: 'failed', cause });
    expect(viewStandardLightingOf(world, held)).toBeUndefined();
    endRenderFrame(world);
    // The same camera signature keeps the installed pipeline on the next frame.
    beginRenderFrame(world, 2);
    expect(frameState.installedPipelineHandle).toBe(5);
    endRenderFrame(world);
  });

  it('does not admit a staged view without fitted lights', () => {
    const { owner, frameState } = viewOwner();
    const { world, staged } = setup(() => ({ kind: 'not-admitted' }), owner, null);
    beginRenderFrame(world, 1);
    expect(viewStandardLightingOf(world, staged)).toEqual({ kind: 'not-admitted' });
    expect(frameState.installedPipelineHandle).toBe(4);
    endRenderFrame(world);
  });

  it('prepares each staged view after its frame and fitted lights', () => {
    const { world, order, staged, held, internals } = setup(() => ({
      kind: 'prepared',
      lighting,
      fence,
    }));
    beginRenderFrame(world, 1);
    expect(order).toEqual([
      RENDER_VIEW_FRAME_SYSTEM,
      RENDER_CASCADE_FIT_SYSTEM,
      VIEW_ENVIRONMENT_ADMIT_SYSTEM,
      RENDER_STANDARD_LIGHTING_SYSTEM,
    ]);
    expect(viewStandardLightingOf(world, staged)).toEqual({ kind: 'prepared', lighting, fence });
    expect(viewStandardLightingOf(world, held)).toBeUndefined();
    expect(admitViewStandardLighting(internals)).toBe(true);
    expect(consumeViewStandardLighting(internals, frameState(2), pipelineState, unprepared)).toBe(
      lighting,
    );
    endRenderFrame(world);
  });

  it('leaves the recorded view without admission once the system is removed', () => {
    const { world, staged, internals } = setup(() => ({ kind: 'prepared', lighting, fence }));
    beginRenderFrame(world, 1);
    endRenderFrame(world);
    world
      .removeSystem(
        RenderPrepare,
        registeredSystem(world, RenderPrepare, 'render-standard-lighting'),
      )
      .unwrap();
    beginRenderFrame(world, 2);
    // The stored lighting is the previous frame's only.
    expect(viewStandardLightingOf(world, staged)).toBeUndefined();
    expect(() => admitViewStandardLighting(internals)).toThrow(RENDER_STANDARD_LIGHTING_SYSTEM);
    expect(() =>
      consumeViewStandardLighting(internals, frameState(2), pipelineState, unprepared),
    ).toThrow(RENDER_STANDARD_LIGHTING_SYSTEM);
    endRenderFrame(world);
  });

  it('records nothing for a view whose camera configuration was not admitted', () => {
    const { world, internals } = setup(() => ({ kind: 'not-admitted' }));
    beginRenderFrame(world, 1);
    expect(admitViewStandardLighting(internals)).toBe(false);
    endRenderFrame(world);
  });

  it('stores a preparation failure for the recording to rethrow', () => {
    const cause = new Error('cluster transport');
    const { world, internals } = setup(() => ({ kind: 'failed', cause }));
    beginRenderFrame(world, 1);
    expect(() => admitViewStandardLighting(internals)).toThrow(cause);
    expect(() =>
      consumeViewStandardLighting(internals, frameState(2), pipelineState, unprepared),
    ).toThrow(cause);
    endRenderFrame(world);
  });

  it.each([
    ['pipeline state', { ...fence, pipelineState: {} as PipelineState }],
    ['configuration epoch', { ...fence, pipelineHandle: 3 }],
    ['device generation', { ...fence, deviceGeneration: 6 }],
  ])('rejects the submission once the %s moved after RenderPrepare', (_name, moved) => {
    const { world, internals } = setup(() => ({ kind: 'prepared', lighting, fence: moved }));
    beginRenderFrame(world, 1);
    let thrown: unknown;
    try {
      consumeViewStandardLighting(internals, frameState(2), pipelineState, unprepared);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RendererOperationError);
    expect((thrown as RendererOperationError<'frame-submit-rejected'>).code).toBe(
      'frame-submit-rejected',
    );
    endRenderFrame(world);
  });

  it('lets a direct recorder outside a Render World view prepare its own lighting', () => {
    const internals = { renderWorld: createRenderWorld() } as unknown as RenderSystemInternals;
    expect(
      consumeViewStandardLighting(internals, frameState(0), pipelineState, () => lighting),
    ).toBe(lighting);
  });

  it('declares its view reads and phase order in the schedule', () => {
    const { world } = setup(() => ({ kind: 'not-admitted' }), viewOwner().owner);
    const system = world
      .scheduleData()
      .find((data) => data.name === 'RenderPrepare')
      ?.systems.find((data) => data.name === RENDER_STANDARD_LIGHTING_SYSTEM);
    expect(system?.after).toEqual([
      RENDER_VIEW_FRAME_SYSTEM,
      RENDER_CASCADE_FIT_SYSTEM,
      VIEW_ENVIRONMENT_ADMIT_SYSTEM,
    ]);
    expect(system?.queries[0]?.read).toEqual(['ViewRecorder', 'ViewFrame']);
    expect(system?.queries[0]?.optional).toEqual(['ViewStandardLighting']);
  });
});

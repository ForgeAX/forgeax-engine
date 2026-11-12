import type { EntityHandle } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import type { RenderSystemInternals } from '../../record/render-context';
import type { RenderableSnapshot } from '../../render-system-extract';
import { MaterialFrame } from '../../scene/material-dispatch';
import type { SsrDependenciesInspection } from '../../ssr/admission';
import {
  type PassPlanInput,
  registerPassPlanSystems,
  viewPassPlanQueue,
} from '../pass-plan-systems';
import { RENDER_PHASE_SORT_SYSTEM } from '../queue-systems';
import { beginRenderFrame, createRenderWorld, RenderQueue } from '../render-world';
import {
  consumeViewSsrAdmission,
  RENDER_SSR_ADMISSION_SYSTEM,
  reflectionFallbackDemandOf,
  registerSsrAdmissionSystem,
  viewSsrAdmissionOf,
} from '../ssr-admission-systems';
import { ViewStandardLighting } from '../standard-lighting-systems';

const noSubsurface = {} as PassPlanInput['subsurface'];

const camera = { near: 0.1, far: 100, projection: 'perspective' } as PassPlanInput['ssr']['camera'];
const dependencies = {
  requested: false,
  admission: { status: 'unavailable' },
} as unknown as SsrDependenciesInspection;
const caps = { compute: true, storageTexture: true, rgba16floatRenderable: true } as const;

function input(ssr: Partial<PassPlanInput['ssr']> = {}, rest: Partial<PassPlanInput> = {}) {
  return {
    requested: 'sorted',
    rgba16floatRenderable: false,
    renderables: [],
    dispatch: [],
    phaseSorted: false,
    materials: new MaterialFrame(undefined),
    sceneTransmission: { activeCount: 0, needsRoughMips: false },
    preparation: undefined,
    renderPath: 'forward',
    gpuOcclusion: undefined,
    clearOnly: false,
    ssr: { camera, dependencies, probeFallbackDemand: false, capabilities: caps, ...ssr },
    subsurface: noSubsurface,
    ...rest,
  } satisfies PassPlanInput;
}

function setup(lighting: 'forward' | 'deferred' | 'none' = 'forward') {
  const world = createRenderWorld();
  registerPassPlanSystems(world);
  registerSsrAdmissionSystem(world);
  beginRenderFrame(world, 1);
  const view = world.spawn().unwrap();
  if (lighting !== 'none') {
    const outcome = {
      kind: 'prepared',
      lighting: { ok: true, value: { standard: { prepared: { renderPath: lighting } } } },
      fence: {},
    };
    const state = world.allocUniqueRef('ViewStandardLighting', { frame: 1, outcome });
    world.addComponent(view, { component: ViewStandardLighting, data: { state } }).unwrap();
  }
  const internals = { renderWorld: world, viewEntity: view } as unknown as RenderSystemInternals;
  return { world, view, internals };
}

const stage = (world: ReturnType<typeof createRenderWorld>, view: EntityHandle, p: PassPlanInput) =>
  viewPassPlanQueue(world, view).stage(p);

describe('render-ssr-admission system', () => {
  it('registers once in RenderQueue after render-phase-sort', () => {
    const { world } = setup();
    registerSsrAdmissionSystem(world);
    const queue = world.scheduleData().find((schedule) => schedule.name === 'RenderQueue');
    const system = queue?.systems.find((s) => s.name === RENDER_SSR_ADMISSION_SYSTEM);
    expect(queue?.systems.filter((s) => s.name === RENDER_SSR_ADMISSION_SYSTEM)).toHaveLength(1);
    expect(system?.after).toEqual([RENDER_PHASE_SORT_SYSTEM]);
    expect(system?.queries[0]?.read).toEqual(['ViewPassPlans']);
    expect(system?.queries[0]?.optional).toEqual([
      'ViewPhases',
      'ViewStandardLighting',
      'ViewSsrAdmission',
    ]);
  });

  it('writes a frame-stamped admission the recording and its readers consume', () => {
    const { world, view, internals } = setup();
    stage(world, view, input());
    expect(world.run(RenderQueue).ok).toBe(true);
    const outcome = viewSsrAdmissionOf(world, view);
    expect(outcome).toMatchObject({
      kind: 'resolved',
      admission: { status: 'not-requested', lane: 'forward' },
      reflectionFallbackCandidate: false,
      reflectionFallbackDemand: false,
    });
    expect(consumeViewSsrAdmission(internals, camera)).toBe(outcome);
    expect(reflectionFallbackDemandOf(internals)).toBe(false);
    // Another frame's admission is never read.
    beginRenderFrame(world, 2);
    expect(viewSsrAdmissionOf(world, view)).toBeUndefined();
    expect(reflectionFallbackDemandOf(internals)).toBe(false);
  });

  it('stores an unavailable code when the view prepared no Standard lighting', () => {
    const { world, view, internals } = setup('none');
    stage(world, view, input());
    expect(world.run(RenderQueue).ok).toBe(true);
    expect(viewSsrAdmissionOf(world, view)).toEqual({
      kind: 'unavailable',
      code: 'standard-lighting-unavailable',
    });
    expect(() => consumeViewSsrAdmission(internals, camera)).toThrow(
      'standard-lighting-unavailable',
    );
  });

  it('stores a rejected scene input as data instead of throwing in the system', () => {
    const { world, view, internals } = setup();
    // The accepted material frame lacks the renderable's material.
    const source = { material: {}, materials: [] } as unknown as RenderableSnapshot;
    stage(world, view, input({ probeFallbackDemand: true }, { renderables: [source] }));
    expect(world.run(RenderQueue).ok).toBe(true);
    const outcome = viewSsrAdmissionOf(world, view);
    expect(outcome).toMatchObject({ kind: 'failed', code: 'scene-input-rejected' });
    expect(() => consumeViewSsrAdmission(internals, camera)).toThrow('accepted material frame');
    expect(reflectionFallbackDemandOf(internals)).toBe(false);
  });

  it('leaves the recorded view without admission once the system is removed', () => {
    const { world, view, internals } = setup();
    expect(world.removeSystem(RenderQueue, RENDER_SSR_ADMISSION_SYSTEM).ok).toBe(true);
    stage(world, view, input());
    expect(world.run(RenderQueue).ok).toBe(true);
    expect(viewSsrAdmissionOf(world, view)).toBeUndefined();
    expect(() => consumeViewSsrAdmission(internals, camera)).toThrow(RENDER_SSR_ADMISSION_SYSTEM);
  });

  it('admits a direct recorder outside a Render World view as not requesting SSR', () => {
    const internals = {} as unknown as RenderSystemInternals;
    expect(consumeViewSsrAdmission(internals, camera)).toMatchObject({
      kind: 'resolved',
      admission: { status: 'not-requested', lane: 'forward', viewRange: 99.9 },
      reflectionFallbackCandidate: false,
      reflectionFallbackDemand: false,
    });
  });
});

import type { RhiDevice } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import type { CubeCaptureFrameInput } from '../../record/frame';
import type { RenderSystemInternals } from '../../record/render-context';
import { MaterialFrame } from '../../scene/material-dispatch';
import {
  type PassPlanInput,
  registerPassPlanSystems,
  viewPassPlanQueue,
} from '../pass-plan-systems';
import { beginRenderFrame, createRenderWorld, RenderQueue } from '../render-world';
import {
  consumeViewSubsurface,
  RENDER_SUBSURFACE_ADMISSION_SYSTEM,
  registerSubsurfaceAdmissionSystem,
  type SubsurfaceAdmissionInput,
  subsurfaceCaptureClass,
  viewSubsurfaceAdmissionOf,
} from '../subsurface-admission-systems';

const device = {
  caps: { compute: true, storageTexture: true, float32Filterable: true },
  features: new Set(['float32-blendable']),
  limits: { maxComputeWorkgroupStorageSize: 32768 },
} as unknown as RhiDevice;
const deferred = { renderPath: 'deferred' } as SubsurfaceAdmissionInput['profile'];

function subsurface(rest: Partial<SubsurfaceAdmissionInput> = {}): SubsurfaceAdmissionInput {
  return {
    renderableCount: 1,
    projection: { source: 3, authorVisible: 2, admitted: 1 },
    manualDemand: undefined,
    profile: deferred,
    msaa: false,
    captureOnly: false,
    device,
    ...rest,
  };
}

function staged(input: SubsurfaceAdmissionInput) {
  return {
    requested: 'sorted',
    rgba16floatRenderable: false,
    renderables: [],
    dispatch: [],
    phaseSorted: false,
    materials: new MaterialFrame(undefined),
    sceneTransmission: { activeCount: 0, needsRoughMips: false },
    preparation: undefined,
    renderPath: 'deferred',
    gpuOcclusion: undefined,
    clearOnly: false,
    ssr: {} as PassPlanInput['ssr'],
    subsurface: input,
  } satisfies PassPlanInput;
}

function setup() {
  const world = createRenderWorld();
  registerPassPlanSystems(world);
  registerSubsurfaceAdmissionSystem(world);
  beginRenderFrame(world, 1);
  const view = world.spawn().unwrap();
  const internals = { renderWorld: world, viewEntity: view } as unknown as RenderSystemInternals;
  return { world, view, internals };
}

describe('render-subsurface-admission system', () => {
  it('registers once in RenderQueue and lists its reads', () => {
    const { world } = setup();
    registerSubsurfaceAdmissionSystem(world);
    const queue = world.scheduleData().find((schedule) => schedule.name === 'RenderQueue');
    const system = queue?.systems.find((s) => s.name === RENDER_SUBSURFACE_ADMISSION_SYSTEM);
    expect(
      queue?.systems.filter((s) => s.name === RENDER_SUBSURFACE_ADMISSION_SYSTEM),
    ).toHaveLength(1);
    expect(system?.queries[0]?.read).toEqual(['ViewPassPlans']);
    expect(system?.queries[0]?.optional).toEqual(['ViewSubsurfaceAdmission']);
  });

  it('admits every capture class and the recording takes the one it drew with', () => {
    const { world, view, internals } = setup();
    viewPassPlanQueue(world, view).stage(staged(subsurface()));
    expect(world.run(RenderQueue).ok).toBe(true);
    const outcome = viewSubsurfaceAdmissionOf(world, view);
    expect(outcome?.none).toMatchObject({ ok: true, value: { quality: 'high' } });
    // The capture class demands the unsupported view; Deferred display only.
    expect(outcome?.unsupported.ok).toBe(false);
    expect(consumeViewSubsurface(internals, undefined, false, subsurface)).toMatchObject({
      ok: true,
    });
    expect(consumeViewSubsurface(internals, undefined, true, subsurface)).toMatchObject({
      ok: false,
    });
    beginRenderFrame(world, 2);
    expect(viewSubsurfaceAdmissionOf(world, view)).toBeUndefined();
  });

  it('stores a rejected demand as data instead of throwing in the system', () => {
    const { world, view, internals } = setup();
    viewPassPlanQueue(world, view).stage(
      staged(subsurface({ profile: { renderPath: 'forward' } as never })),
    );
    expect(world.run(RenderQueue).ok).toBe(true);
    const result = consumeViewSubsurface(internals, undefined, false, subsurface);
    expect(result).toMatchObject({ ok: false, error: { code: 'rhi-descriptor-invalid' } });
  });

  it('fails the recording naming the system once it is removed', () => {
    const { world, view, internals } = setup();
    expect(world.removeSystem(RenderQueue, RENDER_SUBSURFACE_ADMISSION_SYSTEM).ok).toBe(true);
    viewPassPlanQueue(world, view).stage(staged(subsurface()));
    expect(world.run(RenderQueue).ok).toBe(true);
    expect(viewSubsurfaceAdmissionOf(world, view)).toBeUndefined();
    expect(() => consumeViewSubsurface(internals, undefined, false, subsurface)).toThrow(
      RENDER_SUBSURFACE_ADMISSION_SYSTEM,
    );
  });

  it('admits a direct recorder outside a Render World view from its own input', () => {
    const internals = {} as unknown as RenderSystemInternals;
    expect(
      consumeViewSubsurface(internals, undefined, false, () => subsurface({ renderableCount: 0 })),
    ).toMatchObject({ ok: true });
    expect(
      consumeViewSubsurface(internals, undefined, false, () => subsurface({ profile: undefined })),
    ).toMatchObject({ ok: false });
  });

  it('classifies a settled capture input', () => {
    const capture = (rest: object) => rest as unknown as CubeCaptureFrameInput;
    const state = { work: [] as unknown[] };
    expect(subsurfaceCaptureClass(undefined, false)).toBe('none');
    expect(subsurfaceCaptureClass(capture({ state }), true)).toBe('unsupported');
    expect(subsurfaceCaptureClass(capture({ state: { work: [1] } }), false)).toBe('unsupported');
    expect(subsurfaceCaptureClass(capture({ state, subsurfaceDemand: 2 }), false)).toBe(
      'consumers',
    );
  });
});

import type { EntityHandle } from '@forgeax/engine-ecs';
import { RhiNullAdapter } from '@forgeax/engine-rhi-null';
import { describe, expect, it, vi } from 'vitest';
import { DeviceScope } from '../../device/device-scope';
import type { RenderFrameState } from '../../record/frame-snapshot';
import type { RenderSystemInternals } from '../../record/render-context';
import { beginSsrHistoryFrame } from '../../record/ssr-history-frame';
import type { CameraSnapshot, VolumetricFogFrameContext } from '../../render-contract';
import type { ExtractedVolumetricFog } from '../../render-system-extract';
import type { SsrSpatialAdmission } from '../../ssr/admission';
import { ViewDiffuseGi } from '../gi-systems';
import {
  commitSsrHistoryBaseline,
  consumeViewHistoryAdmission,
  consumeViewSsrHistoryStage,
  RENDER_HISTORY_ADMISSION_SYSTEM,
  RENDER_SSR_HISTORY_STAGE_SYSTEM,
  registerHistoryAdmissionSystem,
  viewHistoryAdmissionOf,
  viewSsrHistoryStageOf,
  volumeTemporalSignature,
} from '../history-admission-systems';
import { type PassPlanInput, viewPassPlanQueue } from '../pass-plan-systems';
import { createViewRecord, ViewCascadeFit, type ViewLights } from '../render-lights';
import { ViewRecorder } from '../render-views';
import { beginRenderFrame, createRenderWorld, RenderQueue } from '../render-world';
import { RENDER_SSR_ADMISSION_SYSTEM, ViewSsrAdmission } from '../ssr-admission-systems';
import { ViewTopologyInputs } from '../view-topology-systems';
import { withInertTemporal } from './temporal-owner-fixture';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const camera = {
  world: identity,
  fov: 1,
  aspect: 1,
  near: 0.1,
  far: 100,
  orthoLeft: -1,
  orthoRight: 1,
  orthoBottom: -1,
  orthoTop: 1,
  antialias: 'none',
  entityKey: 7,
  historyVersion: 1,
} as unknown as CameraSnapshot;
const fog = {
  status: 'available',
  guid: 'fog',
  digest: 'd',
  worldTimeSeconds: 3,
  fog: {
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    extinction: [1, 1, 1],
    albedo: [1, 1, 1],
    emission: [0, 0, 0],
    anisotropy: 0,
    maxDistance: 10,
    sampling: 'density',
  },
} as unknown as ExtractedVolumetricFog;
const baseContext = { densityGeneration: 1 } as unknown as VolumetricFogFrameContext;
const lights = { point: [], spot: [], directional: undefined } as unknown as ViewLights;
const admitted = { status: 'admitted' } as SsrSpatialAdmission;

function setup(
  options: {
    fog?: boolean;
    topology?: boolean;
    frameState?: object;
    internals?: object;
    ssr?: SsrSpatialAdmission;
    extent?: { internalWidth: number; internalHeight: number };
  } = {},
) {
  const world = createRenderWorld();
  registerHistoryAdmissionSystem(world);
  beginRenderFrame(world, 1);
  const view = world.spawn().unwrap();
  const frameState = {
    volumetricFogHistorySlot: null,
    volumetricFogHistorySignature: null,
    temporalFrameTransaction: { inspect: () => ({ staged: false }), accepted: () => undefined },
    ...options.frameState,
  } as unknown as RenderFrameState;
  const owner = {
    frameState,
    internals: { canvas: { width: 8, height: 4 }, ...options.internals },
  };
  const recorder = world.allocUniqueRef('ViewRecorder', withInertTemporal({}, owner));
  world.addComponent(view, { component: ViewRecorder, data: { state: recorder } }).unwrap();
  const record = createViewRecord(view);
  record.lights = lights;
  world
    .addComponent(view, {
      component: ViewCascadeFit,
      data: { fit: world.allocUniqueRef('ViewCascadeFit', record) },
    })
    .unwrap();
  if (options.topology !== false) {
    const volume = options.fog === true ? { graphFog: fog, baseContext } : {};
    const outcome = { kind: 'planned', topology: { volume } };
    const state = world.allocUniqueRef('ViewTopologyInputs', { frame: 1, outcome });
    world.addComponent(view, { component: ViewTopologyInputs, data: { state } }).unwrap();
  }
  const ssr = { kind: 'resolved', admission: options.ssr ?? admitted };
  world
    .addComponent(view, {
      component: ViewSsrAdmission,
      data: { state: world.allocUniqueRef('ViewSsrAdmission', { frame: 1, outcome: ssr }) },
    })
    .unwrap();
  viewPassPlanQueue(world, view).stage({ ssr: { camera } } as unknown as PassPlanInput);
  const prepared = { ok: true, value: { renderExtent: options.extent } };
  const gi = world.allocUniqueRef('ViewDiffuseGi', { frame: 1, outcome: prepared });
  world.addComponent(view, { component: ViewDiffuseGi, data: { state: gi } }).unwrap();
  const internals = { renderWorld: world, viewEntity: view } as unknown as RenderSystemInternals;
  return { world, view, internals, frameState };
}

const signature = volumeTemporalSignature(fog, baseContext, camera, lights, 8, 4);

describe('render-history-admission system', () => {
  it('registers in RenderQueue after render-ssr-admission', () => {
    const { world } = setup();
    const system = world
      .scheduleData()
      .find((schedule) => schedule.name === 'RenderQueue')
      ?.systems.find((s) => s.name === RENDER_HISTORY_ADMISSION_SYSTEM);
    expect(system?.after).toEqual([RENDER_SSR_ADMISSION_SYSTEM]);
    expect(system?.queries[0]?.read).toEqual(['ViewRecorder', 'ViewPassPlans']);
    expect(system?.queries[0]?.optional).toEqual(['ViewHistoryAdmission']);
  });

  it('writes a frame-stamped admission without fog history for a view without a volume', () => {
    const { world, view, internals } = setup();
    expect(world.run(RenderQueue).ok).toBe(true);
    const outcome = viewHistoryAdmissionOf(world, view);
    expect(outcome).toEqual({ kind: 'admitted', fog: undefined, ssrReset: undefined });
    expect(consumeViewHistoryAdmission(internals)).toBe(outcome);
    beginRenderFrame(world, 2);
    expect(viewHistoryAdmissionOf(world, view)).toBeUndefined();
  });

  it('keeps the accepted fog slot while the signature is unchanged', () => {
    const accepted = { ...signature, worldTimeSeconds: 2.95 };
    const frameState = { volumetricFogHistorySlot: 1, volumetricFogHistorySignature: accepted };
    const { world, internals } = setup({ fog: true, frameState });
    expect(world.run(RenderQueue).ok).toBe(true);
    const { fog: history } = consumeViewHistoryAdmission(internals);
    expect(history?.readSlot).toBe(1);
    expect(history?.elapsedSeconds).toBeCloseTo(0.05);
    expect(history?.signature).toEqual(signature);
  });

  it('resets the fog slot when the committed signature differs', () => {
    const moved = { ...signature, cameraRevision: signature.cameraRevision + 1 };
    const frameState = { volumetricFogHistorySlot: 0, volumetricFogHistorySignature: moved };
    const { world, internals } = setup({ fog: true, frameState });
    expect(world.run(RenderQueue).ok).toBe(true);
    expect(consumeViewHistoryAdmission(internals).fog?.readSlot).toBeNull();
  });

  it('derives the SSR camera reset from the committed baseline', () => {
    const cut = setup({ frameState: { ssrLastCameraEntity: 3 } });
    expect(cut.world.run(RenderQueue).ok).toBe(true);
    expect(consumeViewHistoryAdmission(cut.internals).ssrReset).toBe('camera-cut');
    const version = setup({ frameState: { ssrLastCameraEntity: 7, ssrLastHistoryVersion: 0 } });
    expect(version.world.run(RenderQueue).ok).toBe(true);
    expect(consumeViewHistoryAdmission(version.internals).ssrReset).toBe('history-version');
  });

  it('stores an unavailable code when the view planned no topology', () => {
    const { world, view, internals } = setup({ topology: false });
    expect(world.run(RenderQueue).ok).toBe(true);
    expect(viewHistoryAdmissionOf(world, view)).toEqual({
      kind: 'unavailable',
      code: 'topology-unavailable',
    });
    expect(() => consumeViewHistoryAdmission(internals)).toThrow('topology-unavailable');
  });

  it('leaves the recording without history admission once the system is removed', () => {
    const { world, view, internals } = setup();
    expect(world.removeSystem(RenderQueue, RENDER_HISTORY_ADMISSION_SYSTEM).ok).toBe(true);
    expect(world.run(RenderQueue).ok).toBe(true);
    expect(viewHistoryAdmissionOf(world, view)).toBeUndefined();
    expect(() => consumeViewHistoryAdmission(internals)).toThrow(RENDER_HISTORY_ADMISSION_SYSTEM);
  });
});

describe('commitSsrHistoryBaseline', () => {
  function withSsr(
    world: ReturnType<typeof createRenderWorld>,
    view: EntityHandle,
    status: string,
  ) {
    const state = world.allocUniqueRef('ViewSsrAdmission', {
      frame: 1,
      outcome: { kind: 'resolved', admission: { status } },
    });
    world.removeComponent(view, ViewSsrAdmission).unwrap();
    world.addComponent(view, { component: ViewSsrAdmission, data: { state } }).unwrap();
  }

  it('advances the camera baseline and keeps an admitted owner', () => {
    const owner = { reset: vi.fn(), retireAfterFence: vi.fn() };
    const { world, view, frameState } = setup({ frameState: { ssrHistoryOwner: owner } });
    const internals = { device: { queue: {} } } as unknown as RenderSystemInternals;
    commitSsrHistoryBaseline(world, view, frameState, internals, camera);
    expect(frameState.ssrLastCameraEntity).toBe(7);
    expect(frameState.ssrLastHistoryVersion).toBe(1);
    expect(frameState.ssrHistoryOwner).toBe(owner);
    expect(owner.reset).not.toHaveBeenCalled();
  });

  it('retires the owner of an accepted submission whose SSR is no longer admitted', () => {
    const owner = { reset: vi.fn(), retireAfterFence: vi.fn() };
    const { world, view, frameState } = setup({ frameState: { ssrHistoryOwner: owner } });
    withSsr(world, view, 'not-requested');
    const internals = { device: { queue: {} } } as unknown as RenderSystemInternals;
    commitSsrHistoryBaseline(world, view, frameState, internals, camera);
    expect(owner.reset).toHaveBeenCalledWith('disable');
    expect(owner.retireAfterFence).toHaveBeenCalledOnce();
    expect(frameState.ssrHistoryOwner).toBeUndefined();
  });
});

describe('render-ssr-history-stage system', () => {
  async function device() {
    const rhi = (await new RhiNullAdapter().requestDevice()).unwrap();
    const fired: unknown[] = [];
    const runtime = {
      device: rhi,
      deviceScope: DeviceScope.create(41, 'renderer'),
      errorRegistry: { fire: (error: unknown) => fired.push(error) },
    };
    return { runtime, fired };
  }
  const config = { thickness: 1 };
  const admittedSsr = { status: 'admitted', config } as unknown as SsrSpatialAdmission;

  it('registers in RenderQueue after render-history-admission', () => {
    const { world } = setup();
    const system = world
      .scheduleData()
      .find((schedule) => schedule.name === 'RenderQueue')
      ?.systems.find((s) => s.name === RENDER_SSR_HISTORY_STAGE_SYSTEM);
    expect(system?.after).toEqual([RENDER_HISTORY_ADMISSION_SYSTEM]);
    expect(system?.queries[0]?.read).toEqual(['ViewRecorder', 'ViewPassPlans']);
    expect(system?.queries[0]?.optional).toEqual(['ViewSsrHistoryStage']);
  });

  it('stages an idle outcome and the admission for a view without SSR', () => {
    const notRequested = { status: 'not-requested' } as SsrSpatialAdmission;
    const { world, view, internals, frameState } = setup({ ssr: notRequested });
    expect(world.run(RenderQueue).ok).toBe(true);
    expect(viewSsrHistoryStageOf(world, view)).toEqual({ kind: 'idle' });
    expect(frameState.ssrSpatialAdmission).toBe(notRequested);
    expect(consumeViewSsrHistoryStage(internals, notRequested)).toEqual({ kind: 'idle' });
  });

  it('allocates the owner at the render extent and applies the camera reset', async () => {
    const { runtime } = await device();
    const { world, view, internals, frameState } = setup({
      ssr: admittedSsr,
      internals: runtime,
      extent: { internalWidth: 6, internalHeight: 3 },
      frameState: { ssrLastCameraEntity: 3 },
    });
    expect(world.run(RenderQueue).ok).toBe(true);
    expect(viewSsrHistoryStageOf(world, view)).toEqual({
      kind: 'staged',
      cameraReset: 'camera-cut',
    });
    const owner = frameState.ssrHistoryOwner;
    expect(owner?.resources.width).toBe(6);
    expect(owner?.resources.height).toBe(3);
    expect(owner?.inspect().resetReason).toBe('camera-cut');
    expect(frameState.ssrSpatialAdmission).toBe(admittedSsr);
    expect(owner?.candidate).toBeUndefined();
    expect(consumeViewSsrHistoryStage(internals, admittedSsr)).toEqual({
      kind: 'staged',
      cameraReset: 'camera-cut',
    });
  });

  it('resizes an owner whose extent changed and keeps one that did not', async () => {
    const { runtime } = await device();
    const first = setup({
      ssr: admittedSsr,
      internals: runtime,
      extent: { internalWidth: 6, internalHeight: 3 },
      frameState: { ssrLastCameraEntity: 7, ssrLastHistoryVersion: 1 },
    });
    expect(first.world.run(RenderQueue).ok).toBe(true);
    const owner = first.frameState.ssrHistoryOwner;
    const before = owner?.resources;
    // Same extent on the next frame: the resources survive and nothing resets.
    beginRenderFrame(first.world, 2);
    first.world.run(RenderQueue);
    expect(first.frameState.ssrHistoryOwner).toBe(owner);
    expect(owner?.resources).toBe(before);
    expect(owner?.inspect().resetReason).toBe('first-enable');
    const resized = setup({
      ssr: admittedSsr,
      internals: runtime,
      extent: { internalWidth: 10, internalHeight: 5 },
      frameState: { ssrHistoryOwner: owner, ssrLastCameraEntity: 7, ssrLastHistoryVersion: 1 },
    });
    expect(resized.world.run(RenderQueue).ok).toBe(true);
    expect(owner?.resources.width).toBe(10);
    expect(owner?.inspect().resetReason).toBe('resize');
  });

  it('stores a reported failure when the owner cannot be allocated', async () => {
    const { runtime, fired } = await device();
    runtime.device.createTexture = () =>
      ({
        ok: false,
        error: { code: 'out-of-memory' },
      }) as never;
    const { world, view, frameState } = setup({ ssr: admittedSsr, internals: runtime });
    expect(world.run(RenderQueue).ok).toBe(true);
    expect(viewSsrHistoryStageOf(world, view)).toMatchObject({
      kind: 'failed',
      code: 'owner-create-failed',
    });
    expect(fired).toHaveLength(1);
    expect(frameState.ssrHistoryOwner).toBeUndefined();
  });

  it('stores an unexpected throw as data and the recording rethrows it', () => {
    const { world, view, internals } = setup({
      ssr: admittedSsr,
      // A device without `createTexture`: allocation throws inside the system.
      internals: { device: {}, deviceScope: undefined },
    });
    expect(world.run(RenderQueue).ok).toBe(true);
    expect(viewSsrHistoryStageOf(world, view)).toMatchObject({
      kind: 'failed',
      code: 'owner-threw',
    });
    expect(() => consumeViewSsrHistoryStage(internals, admittedSsr)).toThrow(TypeError);
  });

  it('leaves the recording without a stage once the system is removed', () => {
    const { world, view, internals } = setup({ ssr: admittedSsr });
    expect(world.removeSystem(RenderQueue, RENDER_SSR_HISTORY_STAGE_SYSTEM).ok).toBe(true);
    expect(world.run(RenderQueue).ok).toBe(true);
    expect(viewSsrHistoryStageOf(world, view)).toBeUndefined();
    expect(() => consumeViewSsrHistoryStage(internals, admittedSsr)).toThrow(
      RENDER_SSR_HISTORY_STAGE_SYSTEM,
    );
  });

  it('begins the candidate in recording and takes the temporal reset only without a camera reset', async () => {
    const { runtime } = await device();
    const { world, internals, frameState } = setup({
      ssr: admittedSsr,
      internals: runtime,
      extent: { internalWidth: 6, internalHeight: 3 },
    });
    expect(world.run(RenderQueue).ok).toBe(true);
    const stage = consumeViewSsrHistoryStage(internals, admittedSsr);
    const view = { resetReason: 'resize', currentJitterUv: [0.25, 0.5] } as never;
    const record = {
      ...runtime,
      canvas: { width: 8, height: 4 },
    } as unknown as RenderSystemInternals;
    expect(beginSsrHistoryFrame(record, frameState, admittedSsr, stage, view)).toBe(true);
    const owner = frameState.ssrHistoryOwner;
    expect(owner?.candidate).toBeDefined();
    expect(owner?.inspect().resetReason).toBe('resize');
    owner?.abortFrame(owner.candidate as never, 'submit');
    expect(
      beginSsrHistoryFrame(
        record,
        frameState,
        admittedSsr,
        { kind: 'failed', code: 'owner-resize-failed', cause: 1 },
        view,
      ),
    ).toBe(false);
  });
});

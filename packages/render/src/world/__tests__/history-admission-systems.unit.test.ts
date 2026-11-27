import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { registeredSystem } from '../../__tests__/registered-system.fixture';
import { viewSourceFixture } from '../../__tests__/view-source.fixture';
import type { RenderFrameState } from '../../record/frame-snapshot';
import type { RenderSystemInternals } from '../../record/render-context';
import type { CameraSnapshot, VolumetricFogFrameContext } from '../../render-contract';
import type { ExtractedVolumetricFog } from '../../render-system-extract';
import type { SsrSpatialAdmission } from '../../ssr/admission';

import { ViewDiffuseGi } from '../gi-systems';
import {
  consumeViewHistoryAdmission,
  RENDER_HISTORY_ADMISSION_SYSTEM,
  registerHistoryAdmissionSystem,
  viewHistoryAdmissionOf,
  volumeTemporalSignature,
} from '../history-admission-systems';
import { type PassPlanInput, viewPassPlanQueue } from '../pass-plan-systems';
import { createViewRecord, ViewCascadeFit, type ViewLights } from '../render-lights';
import { RenderViewInput, ViewRecorder } from '../render-views';
import { beginRenderFrame, createRenderWorld, RenderQueue } from '../render-world';
import { RENDER_SSR_ADMISSION_SYSTEM, ViewSsrAdmission } from '../ssr-admission-systems';
import { ViewFrame, type ViewFrameState } from '../view-frame-systems';
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

function runQueue(world: World) {
  const result = world.run(RenderQueue);
  if (!result.ok) throw result.error;
  return result;
}

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
  world.insertResource(
    RenderViewInput,
    viewSourceFixture({ world: new World(), lease: undefined }),
  );
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
  const viewFrame = {
    frame: 1,
    mode: true,
    opts: {},
    publication: undefined,
    result: { ok: true, value: { cameras: [camera], cubeCameras: [], auxiliaryCameras: [] } },
  } as unknown as ViewFrameState;
  world
    .addComponent(view, {
      component: ViewFrame,
      data: { state: world.allocUniqueRef('ViewFrame', viewFrame) },
    })
    .unwrap();
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
    expect(runQueue(world).ok).toBe(true);
    const outcome = viewHistoryAdmissionOf(world, view);
    expect(outcome).toEqual({ kind: 'admitted', fog: undefined });
    expect(consumeViewHistoryAdmission(internals)).toBe(outcome);
    beginRenderFrame(world, 2);
    expect(viewHistoryAdmissionOf(world, view)).toBeUndefined();
  });

  it('keeps the accepted fog slot while the signature is unchanged', () => {
    const accepted = { ...signature, worldTimeSeconds: 2.95 };
    const frameState = { volumetricFogHistorySlot: 1, volumetricFogHistorySignature: accepted };
    const { world, internals } = setup({ fog: true, frameState });
    expect(runQueue(world).ok).toBe(true);
    const { fog: history } = consumeViewHistoryAdmission(internals);
    expect(history?.readSlot).toBe(1);
    expect(history?.elapsedSeconds).toBeCloseTo(0.05);
    expect(history?.signature).toEqual(signature);
  });

  it('resets the fog slot when the committed signature differs', () => {
    const moved = { ...signature, cameraRevision: signature.cameraRevision + 1 };
    const frameState = { volumetricFogHistorySlot: 0, volumetricFogHistorySignature: moved };
    const { world, internals } = setup({ fog: true, frameState });
    expect(runQueue(world).ok).toBe(true);
    expect(consumeViewHistoryAdmission(internals).fog?.readSlot).toBeNull();
  });

  it('stores an unavailable code when the view planned no topology', () => {
    const { world, view, internals } = setup({ topology: false });
    expect(runQueue(world).ok).toBe(true);
    expect(viewHistoryAdmissionOf(world, view)).toEqual({
      kind: 'unavailable',
      code: 'topology-unavailable',
    });
    expect(() => consumeViewHistoryAdmission(internals)).toThrow('topology-unavailable');
  });

  it('leaves the recording without history admission once the system is removed', () => {
    const { world, view, internals } = setup();
    expect(
      world.removeSystem(
        RenderQueue,
        registeredSystem(world, RenderQueue, 'render-history-admission'),
      ).ok,
    ).toBe(true);
    expect(runQueue(world).ok).toBe(true);
    expect(viewHistoryAdmissionOf(world, view)).toBeUndefined();
    expect(() => consumeViewHistoryAdmission(internals)).toThrow(RENDER_HISTORY_ADMISSION_SYSTEM);
  });
});

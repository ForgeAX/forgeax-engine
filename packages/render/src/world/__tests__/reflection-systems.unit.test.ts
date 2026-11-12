import { describe, expect, it } from 'vitest';
import type { ReflectionProbeRecordState } from '../../record/render-context';
import type { CameraSnapshot } from '../../render-contract';
import type { ExtractedFrame } from '../../render-system-extract';
import { TemporalViewHistory } from '../../temporal/frame';
import { RENDER_CASCADE_FIT_SYSTEM } from '../light-systems';
import {
  consumeViewReflectionProbes,
  RENDER_REFLECTION_PROBE_ROSTER_SYSTEM,
  registerReflectionProbeSystems,
  VIEW_REFLECTION_PROBES_SETTLE_SYSTEM,
  VIEW_REFLECTION_PROBES_SYSTEM,
  viewReflectionProbesOf,
} from '../reflection-systems';
import { createViewRecord, ViewCascadeFit, type ViewLights } from '../render-lights';
import { RenderReflectionProbe } from '../render-probes';
import { RenderViewFrameSource, RenderViewInput, ViewRecorder } from '../render-views';
import {
  beginRenderFrame,
  createRenderWorld,
  endRenderFrame,
  RenderExtract,
  RenderPrepare,
} from '../render-world';
import { RenderProbeInput } from '../scene-systems';
import {
  RENDER_VIEW_FRAME_SYSTEM,
  RENDER_VIEW_RECORDERS_SYSTEM,
  stageViewFrame,
} from '../view-frame-systems';
import { registerViewFrameStub, withInertTemporal } from './temporal-owner-fixture';

const opts = { cameraOwner: 0, resourceOwner: 0 } as const;
const lights = {
  directional: [],
  point: [],
  spot: [],
  rect: [],
} as unknown as ViewLights;

function probeState(log: string[]): ReflectionProbeRecordState {
  return {
    table: { rows: [] },
    graph: { work: [] },
    completeSubmission: async (submitted: boolean, _c?: unknown, _o?: unknown, fallback = true) => {
      log.push(`complete:${submitted}:${fallback}`);
    },
  } as unknown as ReflectionProbeRecordState;
}

interface Setup {
  /** The probe owner's prepare; records its arguments. */
  readonly prepare?: (...args: unknown[]) => ReflectionProbeRecordState;
  readonly frameOk?: boolean;
  readonly fitted?: boolean;
  readonly camera?: Partial<CameraSnapshot>;
  readonly fallbackGeneration?: () => number | undefined;
}

function setup({
  prepare = () => probeState([]),
  frameOk = true,
  fitted = true,
  camera = {},
  fallbackGeneration = () => undefined,
}: Setup = {}) {
  const world = createRenderWorld();
  world.insertResource(
    RenderViewInput,
    new RenderViewFrameSource({ canvas: { width: 8, height: 8 } }),
  );
  const probeFacts = [
    {
      worldId: 0,
      entityKey: 5,
      center: [0, 0, 0],
      halfExtents: [1, 1, 1],
      priority: 0,
      intensity: 1,
      resolution: 64,
      revision: 1,
    },
  ] as const;
  world.insertResource(RenderProbeInput, { facts: probeFacts });
  const order: string[] = [];
  const log: string[] = [];
  const projected: unknown[] = [];
  const selected = new Map();
  // Registered first so only `after` can order the probe system behind it.
  registerReflectionProbeSystems(world);
  registerViewFrameStub(world, () => recorder.prepareViewFrame());
  world
    .addSystem(RenderPrepare, {
      name: RENDER_CASCADE_FIT_SYSTEM,
      queries: [],
      fn: () => void order.push('cascade-fit'),
    })
    .unwrap();
  const recorder = {
    prepareViewFrame: () => {
      order.push('frame');
      return frameOk
        ? {
            ok: true as const,
            value: {
              renderables: [],
              cameras: [camera],
              reflectionProbes: [],
            } as unknown as ExtractedFrame,
          }
        : { ok: false as const, cause: new Error('pending') };
    },
  };
  const frameState = {
    frameNumber: 7,
    temporalFrameTransaction: {
      inspect: () => ({ staged: false }),
      reset: (reason: string) => log.push(`temporal.reset:${reason}`),
    },
    temporalView: new TemporalViewHistory(),
    ssrHistoryOwner: { reset: (reason: string) => log.push(`ssr.reset:${reason}`) },
  } as Record<string, unknown>;
  // The reflection-fallback lane: the scene has a probe projection and no GPU scene.
  const scene = {
    projectReflectionProbes: (roster: unknown) => void projected.push(roster),
    reflectionProbeProjection: () => ({ selected }),
    reflectionCaptureRevision: () => 'r0',
  };
  const reflectionProbes = {
    prepare: (...args: unknown[]) => {
      order.push('probes');
      return prepare(...args);
    },
    pipelineFallbackReceipt: () => {
      const projectionGeneration = fallbackGeneration();
      return projectionGeneration === undefined ? undefined : { projectionGeneration };
    },
  };
  const staged = world.spawn().unwrap();
  const held = world.spawn().unwrap();
  for (const entity of [staged, held]) {
    const state = world.allocUniqueRef(
      'ViewRecorder',
      withInertTemporal({}, { frameState, scene, reflectionProbes }),
    );
    world.addComponent(entity, { component: ViewRecorder, data: { state } }).unwrap();
  }
  if (fitted) {
    const record = createViewRecord(staged);
    record.lights = lights;
    world
      .addComponent(staged, {
        component: ViewCascadeFit,
        data: { fit: world.allocUniqueRef('ViewCascadeFit', record) },
      })
      .unwrap();
  }
  world
    .addSystem(RenderExtract, {
      name: RENDER_VIEW_RECORDERS_SYSTEM,
      queries: [],
      fn: (world) => stageViewFrame(world, staged, opts),
    })
    .unwrap();
  return { world, order, log, staged, held, frameState, selected, projected, probeFacts };
}

describe('view-reflection-probes', () => {
  it('prepares from the view camera, lights and scene projection without a GPU scene', () => {
    const log: string[] = [];
    const value = probeState(log);
    let args: unknown[] = [];
    const camera = { entityKey: 3 };
    const { world, order, staged, held, frameState, selected, projected, probeFacts } = setup({
      prepare: (...received) => {
        args = received;
        return value;
      },
      camera,
    });
    beginRenderFrame(world, 1);
    expect(order).toEqual(['frame', 'cascade-fit', 'probes']);
    // The probe entities, not the view's frame, supply the roster both the selection and the owner read.
    expect(args[0]).toEqual(probeFacts);
    expect(projected).toEqual([{ facts: probeFacts, revision: 1 }]);
    expect(args[1]).toBe(selected);
    expect(args[2]).toBe(camera);
    expect(args[3]).toBe(7);
    const outcome = viewReflectionProbesOf(world, staged);
    expect(outcome?.ok).toBe(true);
    if (outcome?.ok !== true) throw new Error('unreachable');
    expect(outcome.value.probes).toBe(value);
    // SSR dependencies are admitted in RenderPrepare, from the prepared fallback.
    expect(frameState.ssrRequested).toBe(false);
    expect(outcome.value.ssr.requested).toBe(false);
    expect(viewReflectionProbesOf(world, held)).toBeUndefined();
    // No recording took the state: RenderCleanup releases its capture tickets.
    endRenderFrame(world);
    expect(log).toEqual(['complete:false:false']);

    beginRenderFrame(world, 2);
    expect(consumeViewReflectionProbes(world, staged).probes).toBe(value);
    // The recording's submission settles taken state.
    endRenderFrame(world);
    expect(log).toEqual(['complete:false:false']);
  });

  it('resets SSR and temporal history when the committed fallback generation changes', () => {
    let generation = 1;
    const { world, log, frameState } = setup({
      camera: { screenSpaceReflection: {} as never },
      fallbackGeneration: () => generation,
    });
    beginRenderFrame(world, 1);
    expect(frameState.ssrRequested).toBe(true);
    expect(frameState.ssrFallbackGeneration).toBe(1);
    endRenderFrame(world);
    beginRenderFrame(world, 2);
    endRenderFrame(world);
    expect(log).toEqual([]);
    generation = 2;
    beginRenderFrame(world, 3);
    expect(log).toEqual(['temporal.reset:signature-change', 'ssr.reset:reflection-generation']);
    expect(frameState.ssrFallbackGeneration).toBe(2);
    endRenderFrame(world);
  });

  it('stores closed failure codes for the recording to rethrow and skips unresolved frames', () => {
    const cause = new Error('probe pipeline');
    const failed = setup({
      prepare: () => {
        throw cause;
      },
    });
    beginRenderFrame(failed.world, 1);
    expect(viewReflectionProbesOf(failed.world, failed.staged)).toEqual({
      ok: false,
      code: 'probe-prepare-failed',
      cause,
    });
    expect(() => consumeViewReflectionProbes(failed.world, failed.staged)).toThrow(cause);
    endRenderFrame(failed.world);

    const unfitted = setup({ fitted: false });
    beginRenderFrame(unfitted.world, 1);
    expect(unfitted.order).toEqual(['frame', 'cascade-fit']);
    const outcome = viewReflectionProbesOf(unfitted.world, unfitted.staged);
    expect(outcome?.ok === false && outcome.code).toBe('lights-unavailable');
    expect(() => consumeViewReflectionProbes(unfitted.world, unfitted.staged)).toThrow(
      /render-cascade-fit/,
    );
    endRenderFrame(unfitted.world);

    const unresolved = setup({ frameOk: false });
    beginRenderFrame(unresolved.world, 1);
    expect(unresolved.order).toEqual(['frame', 'cascade-fit']);
    expect(() => consumeViewReflectionProbes(unresolved.world, unresolved.staged)).toThrow(
      /view-reflection-probes/,
    );
    endRenderFrame(unresolved.world);
  });

  it('follows the probe entities: a vanished source probe leaves the next prepare', () => {
    let args: unknown[] = [];
    const { world } = setup({
      prepare: (...received) => {
        args = received;
        return probeState([]);
      },
    });
    const rows = () => [...world.query({ read: [RenderReflectionProbe] }).unwrap()].length;
    beginRenderFrame(world, 1);
    expect(rows()).toBe(1);
    endRenderFrame(world);
    world.getResource<{ facts: readonly unknown[] }>(RenderProbeInput).facts = [];
    beginRenderFrame(world, 2);
    expect(rows()).toBe(0);
    expect(args[0]).toEqual([]);
    endRenderFrame(world);
  });

  it('declares its view reads and phase order in the schedule', () => {
    const { world } = setup();
    const systems = world
      .scheduleData()
      .flatMap((schedule) =>
        schedule.systems.map((system) => ({ schedule: schedule.name, ...system })),
      );
    const prepare = systems.find((system) => system.name === VIEW_REFLECTION_PROBES_SYSTEM);
    expect(prepare?.schedule).toBe('RenderPrepare');
    expect(prepare?.after).toEqual([
      RENDER_VIEW_FRAME_SYSTEM,
      RENDER_CASCADE_FIT_SYSTEM,
      RENDER_REFLECTION_PROBE_ROSTER_SYSTEM,
    ]);
    expect(prepare?.queries[0]?.read).toEqual(['ViewRecorder', 'ViewFrame']);
    expect(prepare?.queries[0]?.optional).toEqual(['ViewReflectionProbes', 'ViewCascadeFit']);
    expect(prepare?.queries[0]?.write ?? []).toEqual([]);
    const settle = systems.find((system) => system.name === VIEW_REFLECTION_PROBES_SETTLE_SYSTEM);
    expect(settle?.schedule).toBe('RenderCleanup');
    expect(settle?.queries[0]?.read).toEqual(['ViewReflectionProbes']);
  });
});

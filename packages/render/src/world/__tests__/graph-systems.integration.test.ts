import { vec3 } from '@forgeax/engine-math';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrameRecording } from '../../__tests__/frame-recording-driver';
import { compileRecordedViewGraph } from '../../__tests__/frame-recording-driver';

import type { ViewGraphCompileOutcome } from '../../record/graph-adoption';
import type { RenderSystemInternals } from '../../record/render-context';
import type { GraphCompileInput } from '../../record/typed-frame-graph';
import * as typedGraph from '../../record/typed-frame-graph';
import { MaterialFrame } from '../../scene/material-dispatch';
import { ViewFeaturePlans } from '../feature-plan-systems';
import { ViewDiffuseGi } from '../gi-systems';
import { ViewGpuDriven } from '../gpu-driven-systems';
import {
  RENDER_GRAPH_COMPILE_RELEASE_SYSTEM,
  RENDER_GRAPH_COMPILE_SYSTEM,
  ViewGraphCandidate,
} from '../graph-systems';
import { ViewPassPlanQueue, ViewPassPlans } from '../pass-plan-systems';
import { RENDER_ENCODER_OPEN_SYSTEM } from '../record-systems';
import { ViewCascadeFit } from '../render-lights';
import { ViewRecorder } from '../render-views';
import {
  beginRenderFrame,
  createRenderWorld,
  endRenderFrame,
  RenderRecord,
  renderSubmission,
  runRenderRecord,
} from '../render-world';
import { ViewSsrAdmission } from '../ssr-admission-systems';
import { ViewStandardLighting } from '../standard-lighting-systems';
import { ViewSubsurfaceAdmission } from '../subsurface-admission-systems';
import type { ViewGraphCompileRequest } from '../view-graph-input';
import { ViewTopologyInputs } from '../view-topology-systems';
import { withInertTemporal } from './temporal-owner-fixture';

const typed = {
  compileViewGraph: vi.spyOn(typedGraph, 'compileViewGraph'),
  retire: vi.spyOn(typedGraph, 'retire'),
};

const device = async (): Promise<RhiDevice> =>
  (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();

const graph = { label: 'view-graph' };

function compiledOutcome(frame: number): ViewGraphCompileOutcome {
  return { frame, kind: 'compiled', graph, installed: {}, effects: {} } as never;
}

function setup() {
  const world = createRenderWorld();
  const view = world.spawn().unwrap();
  const internals = {
    renderWorld: world,
    viewEntity: view,
    canvas: { width: 8, height: 8 },
    errorRegistry: { fire: vi.fn() },
  } as unknown as RenderSystemInternals;
  const onAbandoned = vi.fn();
  const frameState = { frameNumber: 4 };
  const input = {
    internals,
    frameState,
    featurePlan: { candidate: { onAbandoned } },
  } as unknown as GraphCompileInput;
  const request: ViewGraphCompileRequest = {
    camera: {} as never,
    clearOnly: false,
    subsurfaceClass: 'none',
    rendererRecording: true,
    shadowDepthLayers: {} as never,
  };
  const state = world.allocUniqueRef(
    'ViewRecorder',
    withInertTemporal({}, { internals, frameState, captures: {} }),
  );
  world.addComponent(view, { component: ViewRecorder, data: { state } }).unwrap();
  const attach = (component: typeof ViewTopologyInputs, outcome: unknown) => {
    const stored = {
      get frame() {
        return renderSubmission(world).frame;
      },
      outcome,
    };
    world
      .addComponent(view, {
        component,
        data: { state: world.allocUniqueRef(component.name, stored) },
      })
      .unwrap();
  };
  attach(ViewTopologyInputs as never, {
    kind: 'planned',
    topology: { volume: {}, terrainReceivers: [] },
  });
  attach(ViewStandardLighting as never, {
    kind: 'prepared',
    lighting: { ok: true, value: {} },
    fence: { pipelineState: {} },
  });
  attach(ViewSsrAdmission as never, { kind: 'resolved', admission: {} });
  attach(ViewDiffuseGi as never, { ok: true, value: {} });
  attach(ViewGpuDriven as never, { kind: 'selected', raster: {} });
  attach(ViewFeaturePlans as never, { kind: 'planned', plan: input.featurePlan });
  attach(ViewSubsurfaceAdmission as never, { none: { ok: true, value: undefined } });
  const queue = new ViewPassPlanQueue();
  Object.assign(queue, {
    staged: { materials: new MaterialFrame(undefined) },
    transparent: {},
    transmission: {},
    opaque: {},
  });
  world
    .addComponent(view, {
      component: ViewPassPlans,
      data: { state: world.allocUniqueRef('ViewPassPlanQueue', queue) },
    })
    .unwrap();
  world
    .addComponent(view, {
      component: ViewCascadeFit,
      data: { fit: world.allocUniqueRef('ViewCascadeFit', { lights: {} }) },
    })
    .unwrap();
  return { world, view, internals, input, request, onAbandoned, frameState, queue };
}

type Compile = ReturnType<typeof compileRecordedViewGraph>;

/** Advance the recording to its compile barrier. */
function toBarrier(recording: Compile): void {
  const step = recording.next();
  expect(step.done).toBe(false);
  expect((step.value as { kind: string }).kind).toBe('compile');
}

function resume(recording: Compile) {
  const step = recording.next(undefined as never);
  if (step.done !== true) throw new Error('the compile recording yields once');
  return step.value;
}

describe('render-graph-compile system', () => {
  beforeEach(() => {
    typed.compileViewGraph.mockReset();
    typed.retire.mockReset();
    typed.retire.mockImplementation(() => undefined);
    typed.compileViewGraph.mockImplementation((input: GraphCompileInput) =>
      compiledOutcome(input.frameState.frameNumber),
    );
  });

  it('registers in RenderRecord after the encoder open and settles in RenderCleanup', () => {
    const { world } = setup();
    const schedules = world.scheduleData();
    const record = schedules.find((schedule) => schedule.name === 'RenderRecord');
    const compile = record?.systems.find((system) => system.name === RENDER_GRAPH_COMPILE_SYSTEM);
    expect(compile?.after).toEqual([RENDER_ENCODER_OPEN_SYSTEM]);
    expect(compile?.queries[0]?.write).toEqual(['ViewGraphCandidate']);
    const cleanup = schedules.find((schedule) => schedule.name === 'RenderCleanup');
    const release = cleanup?.systems.find(
      (system) => system.name === RENDER_GRAPH_COMPILE_RELEASE_SYSTEM,
    );
    expect(release?.queries[0]?.write).toEqual(['ViewGraphCandidate']);
    expect(compile?.queries[0]?.read).toEqual(['ViewRecorder']);
    expect(compile?.queries[0]?.optional).toContain('ViewTopologyInputs');
  });

  it('compiles a staged view at the RenderRecord barrier into its frame-stamped outcome', async () => {
    const { world, view, internals, input, request } = setup();
    beginRenderFrame(world, 9);
    const recording = compileRecordedViewGraph(internals, () => input, request) as Compile &
      FrameRecording;
    toBarrier(recording);
    expect(world.hasComponent(view, ViewGraphCandidate)).toBe(true);
    expect(typed.compileViewGraph).not.toHaveBeenCalled();
    expect(runRenderRecord(world, { device: await device(), frameId: 9 }).ok).toBe(true);
    expect(typed.compileViewGraph).toHaveBeenCalledTimes(1);
    expect(typed.compileViewGraph.mock.calls[0]?.[0]).toMatchObject({
      internals,
      frameState: input.frameState,
      featurePlan: input.featurePlan,
      camera: request.camera,
    });
    const compiled = resume(recording);
    expect(compiled.ok).toBe(true);
    if (compiled.ok) expect(compiled.value).toMatchObject({ kind: 'compiled', graph, frame: 4 });
    endRenderFrame(world);
    // The adopted candidate is not released a second time.
    expect(typed.retire).not.toHaveBeenCalled();
  });

  it.each([
    false,
    true,
  ])('reads opaque fog opt-out demand from the queued material frame: %s', async (unfogged) => {
    const { world, internals, input, request, queue } = setup();
    const snapshot = {
      baseColor: vec3.create(1, 1, 1),
      metallic: 0,
      roughness: 0.5,
      passes: [],
      renderState: { fog: !unfogged },
    };
    const material = { snapshot } as unknown as Parameters<MaterialFrame['with']>[0];
    Object.assign(queue.staged as object, {
      materials: new MaterialFrame(undefined).with(material),
    });
    beginRenderFrame(world, 9);
    const recording = compileRecordedViewGraph(internals, () => input, request);
    toBarrier(recording);
    expect(runRenderRecord(world, { device: await device(), frameId: 9 }).ok).toBe(true);
    expect(typed.compileViewGraph.mock.calls[0]?.[0].unfoggedOpaque).toBe(unfogged);
    expect(resume(recording).ok).toBe(true);
    endRenderFrame(world);
  });

  it('rejects a missing topology component as data instead of consuming staged owner copies', async () => {
    const { world, view, internals, input, request } = setup();
    beginRenderFrame(world, 9);
    world.removeComponent(view, ViewTopologyInputs).unwrap();
    const direct = vi.fn(() => input);
    const recording = compileRecordedViewGraph(internals, direct, request);
    toBarrier(recording);
    expect(runRenderRecord(world, { device: await device(), frameId: 9 }).ok).toBe(true);
    const compiled = resume(recording);
    expect(direct).not.toHaveBeenCalled();
    expect(typed.compileViewGraph).not.toHaveBeenCalled();
    expect(compiled.ok && compiled.value).toMatchObject({
      kind: 'failed',
      cause: {
        code: 'graph-build-failed',
        detail: {
          cause: { code: 'graph-input-unavailable', detail: { system: 'render-view-topology' } },
        },
      },
    });
    expect(world.execution.health).toBe('healthy');
    endRenderFrame(world);
  });

  it.each([
    'no RenderRecord run',
    'failed encoder',
  ] as const)('returns graph-compile-missing data after the barrier with %s', async (mode) => {
    const { world, internals, input, request } = setup();
    beginRenderFrame(world, 2);
    const recording = compileRecordedViewGraph(internals, () => input, request);
    toBarrier(recording);
    if (mode === 'failed encoder') expect(world.run(RenderRecord).ok).toBe(true);
    const compiled = resume(recording);
    expect(typed.compileViewGraph).not.toHaveBeenCalled();
    expect(compiled.ok).toBe(false);
    if (!compiled.ok) {
      expect(compiled.error.code).toBe('graph-build-failed');
      expect(compiled.error.detail).toMatchObject({
        cause: { code: 'graph-compile-missing', detail: { system: RENDER_GRAPH_COMPILE_SYSTEM } },
      });
    }
    endRenderFrame(world);
  });

  it('keeps a thrown compile as its failed outcome without poisoning the World', async () => {
    const { world, internals, input, request } = setup();
    const cause = new Error('graph build exploded');
    typed.compileViewGraph.mockImplementation(() => ({ frame: 4, kind: 'failed', cause }));
    beginRenderFrame(world, 3);
    const recording = compileRecordedViewGraph(internals, () => input, request);
    toBarrier(recording);
    expect(runRenderRecord(world, { device: await device(), frameId: 3 }).ok).toBe(true);
    const compiled = resume(recording);
    expect(compiled.ok && compiled.value).toEqual({ frame: 4, kind: 'failed', cause });
    expect(() => endRenderFrame(world)).not.toThrow();
  });

  it('compiles in place outside an open frame or without a view entity', () => {
    const { world, internals, input, request } = setup();
    const outside = compileRecordedViewGraph(internals, () => input, request).next();
    expect(outside.done).toBe(true);
    beginRenderFrame(world, 5);
    const direct = compileRecordedViewGraph(
      { ...internals, viewEntity: undefined } as RenderSystemInternals,
      () => input,
      request,
    ).next();
    expect(direct.done).toBe(true);
    expect(typed.compileViewGraph).toHaveBeenCalledTimes(2);
    endRenderFrame(world);
  });

  it('retires an unadopted compiled graph and abandons its Feature plan in RenderCleanup', async () => {
    const { world, internals, input, request, onAbandoned, frameState } = setup();
    beginRenderFrame(world, 6);
    const recording = compileRecordedViewGraph(internals, () => input, request);
    toBarrier(recording);
    expect(runRenderRecord(world, { device: await device(), frameId: 6 }).ok).toBe(true);
    // The recording is abandoned at the barrier and never resumes.
    recording.return(undefined as never);
    endRenderFrame(world);
    expect(typed.retire).toHaveBeenCalledExactlyOnceWith(frameState, graph);
    expect(onAbandoned).toHaveBeenCalledOnce();
    // A settled candidate is not released again next frame.
    beginRenderFrame(world, 7);
    endRenderFrame(world);
    expect(typed.retire).toHaveBeenCalledOnce();
    expect(onAbandoned).toHaveBeenCalledOnce();
  });
});

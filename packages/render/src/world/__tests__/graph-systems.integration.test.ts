import { err, type RhiDevice } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as recording from '../../record/frame';
import { captureGraphFailure } from '../../record/frame-capture';
import type { ViewGraphCompileOutcome } from '../../record/graph-adoption';
import type { RenderSystemInternals } from '../../record/render-context';
import type { GraphCompileInput } from '../../record/typed-frame-graph';
import * as typedGraph from '../../record/typed-frame-graph';
import * as captures from '../capture-graph-systems';
import {
  RENDER_GRAPH_SEAL_SYSTEM,
  stagePreparedViewGraph,
  viewGraphSealOutcome,
} from '../graph-seal-systems';
import { RENDER_ENCODER_OPEN_SYSTEM } from '../record-systems';
import { ViewRecorder } from '../render-views';
import {
  beginRenderFrame,
  createRenderWorld,
  endRenderFrame,
  RenderRecord,
  renderSubmission,
  runRenderRecord,
} from '../render-world';
import {
  adoptViewRecordAttempt,
  ViewRecordAttempt,
  type ViewRecordAttemptState,
} from '../view-record-attempt';
import { withInertTemporal } from './temporal-owner-fixture';

const sealCompiledViewGraph = recording.sealCompiledViewGraph;

const typed = {
  compileViewGraph: vi.spyOn(typedGraph, 'compileViewGraph'),
  captureGraphOutcome: vi.spyOn(captures, 'captureGraphOutcome'),
  seal: vi.spyOn(recording, 'sealCompiledViewGraph'),
};

const device = async (): Promise<RhiDevice> =>
  (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();

const graph = { label: 'view-graph' };

function compiledOutcome(frame: number): ViewGraphCompileOutcome {
  return { frame, kind: 'compiled', graph, installed: {}, effects: {} } as never;
}

function setup(fixtureDevice: RhiDevice) {
  const world = createRenderWorld();
  const view = world.spawn().unwrap();
  const internals = {
    device: fixtureDevice,
    renderWorld: world,
    viewEntity: view,
    canvas: { width: 8, height: 8 },
    errorRegistry: { fire: vi.fn() },
  } as unknown as RenderSystemInternals;
  const onAbandoned = vi.fn();
  const frameState = { frameNumber: 4 };
  const camera = {};
  const prepared = {
    internals,
    frameState,
    pipelineState: {},
    camera,
    cameras: [camera],
    featurePlan: { candidate: { onAbandoned } },
    standard: { kind: 'no-local-lights' },
    passPlan: { unfoggedOpaque: false },
    subsurface: {},
    volume: {},
    rendererRecording: true,
    terrainReceivers: [],
    cubeCaptureWork: [],
  } as unknown as recording.PreparedFrameGraph;
  const state = world.allocUniqueRef(
    'ViewRecorder',
    withInertTemporal({}, { internals, frameState, captures: {} }),
  );
  world.addComponent(view, { component: ViewRecorder, data: { state } }).unwrap();
  adoptViewRecordAttempt(world, view);
  const attempt = world
    .resolveUniqueRef<ViewRecordAttemptState>(world.get(view, ViewRecordAttempt).unwrap().state)
    .unwrap();
  const stage = (prepared: recording.PreparedFrameGraph) => {
    attempt.frame = renderSubmission(world).frame;
    stagePreparedViewGraph(attempt, prepared);
  };
  return { world, view, internals, prepared, onAbandoned, stage };
}

describe('view graph preparation in RenderRecord', () => {
  let fixtureDevice: RhiDevice;

  beforeEach(async () => {
    fixtureDevice = await device();
    typed.compileViewGraph.mockReset();
    typed.compileViewGraph.mockImplementation((input: GraphCompileInput) =>
      compiledOutcome(input.frameState.frameNumber),
    );
    typed.seal.mockReset();
    typed.seal.mockReturnValue({ kind: 'pending' });
    typed.captureGraphOutcome.mockReset();
  });

  it('keeps ordinary display preparation and release on the existing view attempt', () => {
    const { world, view, prepared, stage } = setup(fixtureDevice);
    const state = world
      .resolveUniqueRef<{ prepared?: unknown }>(world.get(view, ViewRecordAttempt).unwrap().state)
      .unwrap();
    beginRenderFrame(world, 9);
    try {
      stage(prepared);
      expect(state.prepared).toBe(prepared);
      expect(world.hasComponent(view, captures.ViewCaptureGraphs)).toBe(false);
    } finally {
      endRenderFrame(world);
    }
    expect(state.prepared).toBeUndefined();
  });

  it('uses the staged view admission after the encoder opens', () => {
    const { world, view, prepared, internals, onAbandoned, stage } = setup(fixtureDevice);
    const record = world.scheduleData().find((schedule) => schedule.name === 'RenderRecord');
    const seal = record?.systems.find((system) => system.name === RENDER_GRAPH_SEAL_SYSTEM);
    expect(seal?.after).toContain(RENDER_ENCODER_OPEN_SYSTEM);
    expect(seal?.queries[0]?.write).toEqual(['ViewRecordAttempt']);
    expect(seal?.queries[0]?.optional).toEqual(['ViewCaptureGraphs']);

    beginRenderFrame(world, 9);
    stage(prepared);
    expect(typed.compileViewGraph).not.toHaveBeenCalled();
    expect(runRenderRecord(world, { device: fixtureDevice, frameId: 9 }).ok).toBe(true);
    expect(typed.compileViewGraph).toHaveBeenCalledTimes(1);
    expect(typed.compileViewGraph.mock.calls[0]?.[0]).toMatchObject({
      internals,
      frameState: prepared.frameState,
      featurePlan: prepared.featurePlan,
      camera: prepared.camera,
    });
    expect(typed.compileViewGraph.mock.calls[0]?.[0].standardLighting).toBe(prepared.standard);
    expect(typed.captureGraphOutcome).not.toHaveBeenCalled();
    expect(typed.seal.mock.calls[0]?.[1]).toMatchObject({ kind: 'compiled', graph, frame: 4 });
    expect(viewGraphSealOutcome(world, view)).toMatchObject({ kind: 'pending' });
    endRenderFrame(world);
    expect(onAbandoned).not.toHaveBeenCalled();
  });

  it.each([false, true])('uses the admitted material fog demand %s', (unfogged) => {
    const { world, prepared, stage } = setup(fixtureDevice);
    const passPlan = { ...prepared.passPlan, unfoggedOpaque: unfogged };
    beginRenderFrame(world, 9);
    stage({ ...prepared, passPlan });
    expect(runRenderRecord(world, { device: fixtureDevice, frameId: 9 }).ok).toBe(true);
    expect(typed.compileViewGraph.mock.calls[0]?.[0].unfoggedOpaque).toBe(unfogged);
    endRenderFrame(world);
  });

  it('builds no view graph while its required capture preparation has failed', async () => {
    const { world, view, internals, prepared, onAbandoned, stage } = setup(fixtureDevice);
    const error = captureGraphFailure('invalid capture declaration');
    typed.captureGraphOutcome.mockReturnValue(err(error));
    typed.seal.mockImplementation(sealCompiledViewGraph);
    beginRenderFrame(world, 9);
    const captureGraph = { internals } as NonNullable<typeof prepared.captureGraph>;
    stage({ ...prepared, captureGraph });
    expect(world.hasComponent(view, captures.ViewCaptureGraphs)).toBe(true);
    expect(runRenderRecord(world, { device: fixtureDevice, frameId: 9 }).ok).toBe(true);
    expect(typed.compileViewGraph).not.toHaveBeenCalled();
    expect(viewGraphSealOutcome(world, view)).toEqual({
      kind: 'rejected',
      code: 'capture-compile',
    });
    expect(internals.errorRegistry.fire).toHaveBeenCalledWith(error);
    endRenderFrame(world);
    expect(onAbandoned).toHaveBeenCalledOnce();
  });

  it('releases a consumed Feature plan when display compilation fails', async () => {
    const { world, view, prepared, onAbandoned, stage } = setup(fixtureDevice);
    const cause = new Error('invalid display declaration');
    const failed = { frame: 4, kind: 'failed', cause } as const;
    typed.compileViewGraph.mockReturnValue(failed);
    typed.seal.mockImplementation(() => {
      throw cause;
    });
    beginRenderFrame(world, 9);
    stage(prepared);
    expect(runRenderRecord(world, { device: fixtureDevice, frameId: 9 }).ok).toBe(true);
    expect(typed.seal.mock.calls[0]?.[1]).toBe(failed);
    expect(viewGraphSealOutcome(world, view)).toMatchObject({ kind: 'failed' });
    expect(world.execution.health).toBe('healthy');
    endRenderFrame(world);
    expect(onAbandoned).toHaveBeenCalledOnce();
  });

  it('releases the unused display plan on a capture-only view', async () => {
    const { world, prepared, onAbandoned, stage } = setup(fixtureDevice);
    beginRenderFrame(world, 9);
    stage({ ...prepared, captureOnly: true });
    expect(runRenderRecord(world, { device: fixtureDevice, frameId: 9 }).ok).toBe(true);
    expect(typed.compileViewGraph).not.toHaveBeenCalled();
    expect(typed.seal.mock.calls[0]?.[1]).toBeUndefined();
    endRenderFrame(world);
    expect(onAbandoned).toHaveBeenCalledOnce();
  });

  it.each([
    'no RenderRecord run',
    'failed encoder',
  ])('releases an unprepared plan after %s', async (mode) => {
    const { world, view, prepared, onAbandoned, stage } = setup(fixtureDevice);
    beginRenderFrame(world, 2);
    stage(prepared);
    if (mode === 'failed encoder') expect(world.run(RenderRecord).ok).toBe(true);
    expect(typed.compileViewGraph).not.toHaveBeenCalled();
    expect(viewGraphSealOutcome(world, view)).toMatchObject({ kind: 'failed' });
    endRenderFrame(world);
    expect(onAbandoned).toHaveBeenCalledOnce();
    beginRenderFrame(world, 3);
    endRenderFrame(world);
    expect(onAbandoned).toHaveBeenCalledOnce();
  });
});

import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { registeredSystem } from '../../__tests__/registered-system.fixture';
import { ProjectedDecalInvalidError } from '../../decals/component';
import * as frame from '../../record/frame';
import type { RenderSystemInternals } from '../../record/render-context';
import * as compile from '../../record/typed-frame-graph';
import { viewGraphSealOutcome } from '../graph-seal-systems';
import {
  createRenderWorld,
  endRenderFrame,
  RenderRecord,
  renderSubmission,
  runRenderRecord,
} from '../render-world';
import { viewComposition } from '../view-output-systems';
import { ViewRecordAttempt } from '../view-record-attempt';

async function fixture() {
  const world = createRenderWorld();
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  Object.assign(renderSubmission(world), { frame: 1, open: true });
  const internals = {
    device,
    renderWorld: world,
    errorRegistry: { fire: vi.fn() },
  } as unknown as RenderSystemInternals;
  const view = world
    .spawn({
      component: ViewRecordAttempt,
      data: {
        state: world.allocUniqueRef('ViewRecordAttempt', {
          frame: 1,
          prepared: {
            internals,
            captureOnly: true,
            frameState: { pipelinePreparationPending: false },
          },
          outcome: undefined,
        }),
      },
    })
    .unwrap();
  return { world, view, record: () => runRenderRecord(world, { device, frameId: 1 }) };
}

it('compiles from the view admission already consumed by recording', async () => {
  const f = await fixture();
  const state = f.world
    .resolveUniqueRef<{ prepared: frame.PreparedFrameGraph }>(
      f.world.get(f.view, ViewRecordAttempt).unwrap().state,
    )
    .unwrap();
  const camera = { entityKey: 3 };
  const renderExtent = { internalWidth: 320, internalHeight: 180 };
  const passPlan = { unfoggedOpaque: true };
  const graphOutcome = { kind: 'reused' } as const;
  Object.assign(state.prepared.internals, { viewEntity: f.view });
  Object.assign(state.prepared, {
    cameras: [camera],
    captureOnly: false,
    camera,
    fixedMaterials: { hasUnfoggedOpaque: false },
    passPlan,
    renderExtent,
    subsurface: {},
    volume: {},
  });
  const compiler = vi.spyOn(compile, 'compileViewGraph').mockReturnValue(graphOutcome as never);
  const seal = vi
    .spyOn(frame, 'sealCompiledViewGraph')
    .mockReturnValue({ kind: 'rejected', code: 'extent-mismatch' });
  try {
    expect(f.record().ok).toBe(true);
    expect(compiler).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ camera, passPlan, renderExtent, unfoggedOpaque: true }),
    );
    expect(seal).toHaveBeenCalledWith(
      state.prepared,
      graphOutcome,
      expect.objectContaining({ ok: true, value: { cube: [], probes: [] } }),
      undefined,
    );
    expect(f.world.execution.health).toBe('healthy');
  } finally {
    compiler.mockRestore();
    seal.mockRestore();
    endRenderFrame(f.world);
  }
});

it('rejects a superseded display binding before acquiring the surface', () => {
  const acquire = vi.fn(() => {
    throw new Error('A superseded display must not acquire the surface');
  });
  const fire = vi.fn();
  const display = { graph: {} };
  const replacement = { graph: {} };
  const prepared = {
    internals: { context: { getCurrentTexture: acquire }, errorRegistry: { fire } },
    frameState: { compiledFrameGraph: replacement },
    captureOnly: false,
    captureViewWork: [],
  } as unknown as frame.PreparedFrameGraph;
  const sealed = {
    kind: 'sealed',
    display,
    value: { target: {} },
  } as unknown as Extract<frame.ViewGraphSealOutcome, { kind: 'sealed' }>;
  expect(frame.encodePreparedViewGraph(prepared, sealed)).toEqual({ kind: 'rejected' });
  expect(acquire).not.toHaveBeenCalled();
  expect(fire).toHaveBeenCalledOnce();
});

it('routes ordered display to command preparation without compiling a capture or sealing a graph', async () => {
  const f = await fixture();
  const state = f.world
    .resolveUniqueRef<{ prepared: frame.PreparedFrameGraph; awaitingPlan: boolean }>(
      f.world.get(f.view, ViewRecordAttempt).unwrap().state,
    )
    .unwrap();
  const camera = { entityKey: 3 };
  Object.assign(state.prepared, {
    cameras: [camera],
    captureOnly: false,
    camera,
    fixedMaterials: { hasUnfoggedOpaque: false },
    passPlan: {},
    subsurface: {},
    volume: {},
  });
  state.awaitingPlan = true;
  const outcome = { kind: 'ordered-display' } as const;
  const compiler = vi.spyOn(compile, 'compileViewGraph').mockReturnValue(outcome as never);
  const seal = vi.spyOn(frame, 'sealCompiledViewGraph');
  const ordered = vi
    .spyOn(frame, 'prepareOrderedDisplayRecording')
    .mockReturnValue({ kind: 'pending' });
  try {
    expect(f.record().ok).toBe(true);
    expect(compiler).toHaveBeenCalledOnce();
    expect(ordered).toHaveBeenCalledExactlyOnceWith(state.prepared, outcome, undefined, undefined);
    expect(viewGraphSealOutcome(f.world, f.view)).toEqual({ kind: 'pending' });
    expect(state.awaitingPlan).toBe(false);
    expect(seal).not.toHaveBeenCalled();
  } finally {
    compiler.mockRestore();
    ordered.mockRestore();
    seal.mockRestore();
    endRenderFrame(f.world);
  }
});

it('does not run manual seal when the registered system is removed', async () => {
  const f = await fixture();
  const seal = vi.spyOn(frame, 'sealCompiledViewGraph');
  f.world
    .removeSystem(RenderRecord, registeredSystem(f.world, RenderRecord, 'render-graph-seal'))
    .unwrap();
  expect(f.record().ok).toBe(true);
  expect(viewGraphSealOutcome(f.world, f.view)).toMatchObject({
    kind: 'failed',
    error: { code: 'graph-build-failed', detail: { cause: { code: 'graph-seal-unavailable' } } },
  });
  expect(seal).not.toHaveBeenCalled();
  seal.mockRestore();
  endRenderFrame(f.world);
  expect(f.world.execution.health).toBe('healthy');
});

it('contains an unexpected seal failure as data and releases its staged inputs', async () => {
  const f = await fixture();
  const seal = vi.spyOn(frame, 'sealCompiledViewGraph').mockImplementationOnce(() => {
    throw new Error('seal rejected');
  });
  expect(f.record().ok).toBe(true);
  expect(viewGraphSealOutcome(f.world, f.view)).toMatchObject({
    kind: 'failed',
    error: { code: 'graph-build-failed' },
  });
  expect(seal).toHaveBeenCalledTimes(1);
  seal.mockRestore();
  endRenderFrame(f.world);
  const state = f.world
    .resolveUniqueRef<{ prepared: unknown; outcome: unknown }>(
      f.world.get(f.view, ViewRecordAttempt).unwrap().state,
    )
    .unwrap();
  expect(state).toMatchObject({ prepared: undefined, outcome: undefined });
  expect(f.world.execution.health).toBe('healthy');
});

it.each([
  'render-capture-graph-encode',
  'render-view-graph-encode',
])('does not encode manually when %s is removed', async (removed) => {
  const f = await fixture();
  const seal = vi.spyOn(frame, 'sealCompiledViewGraph').mockReturnValue({
    kind: 'sealed',
    display: undefined,
    value: {},
  } as never);
  const captures = vi
    .spyOn(frame, 'encodePreparedFrameCaptures')
    .mockReturnValue({ kind: 'ready' });
  const encode = vi.spyOn(frame, 'encodePreparedViewGraph').mockReturnValue({ kind: 'rejected' });
  try {
    f.world.removeSystem(RenderRecord, registeredSystem(f.world, RenderRecord, removed)).unwrap();
    expect(f.record().ok).toBe(true);
    const { viewGraphEncodingOutcome } = await import('../graph-seal-systems');
    expect(viewGraphEncodingOutcome(f.world, f.view).kind).not.toBe('encoded');
    expect(encode).not.toHaveBeenCalled();
    expect(captures).toHaveBeenCalledTimes(removed === 'render-capture-graph-encode' ? 0 : 1);
    expect(f.world.execution.health).toBe('healthy');
  } finally {
    seal.mockRestore();
    captures.mockRestore();
    encode.mockRestore();
    endRenderFrame(f.world);
  }
});

it('encodes in capture then view order and contains a capture failure without poisoning the World', async () => {
  const f = await fixture();
  const seal = vi
    .spyOn(frame, 'sealCompiledViewGraph')
    .mockReturnValue({ kind: 'sealed', display: undefined, value: {} } as never);
  const events: string[] = [];
  const captures = vi.spyOn(frame, 'encodePreparedFrameCaptures').mockImplementation(() => {
    events.push('capture');
    return { kind: 'ready' };
  });
  const encode = vi.spyOn(frame, 'encodePreparedViewGraph').mockImplementation(() => {
    events.push('view');
    return { kind: 'rejected' };
  });
  try {
    expect(f.record().ok).toBe(true);
    expect(events).toEqual(['capture', 'view']);
    endRenderFrame(f.world);
    Object.assign(renderSubmission(f.world), { frame: 2, open: true });
    const state = f.world
      .resolveUniqueRef<{ frame: number; prepared: unknown }>(
        f.world.get(f.view, ViewRecordAttempt).unwrap().state,
      )
      .unwrap();
    state.frame = 2;
    state.prepared = {
      internals: {},
      captureOnly: true,
      frameState: { pipelinePreparationPending: false },
    };
    captures.mockImplementationOnce(() => {
      throw new Error('capture encode rejected');
    });
    expect(f.record().ok).toBe(true);
    const { viewGraphEncodingOutcome } = await import('../graph-seal-systems');
    expect(viewGraphEncodingOutcome(f.world, f.view)).toMatchObject({
      kind: 'failed',
      cause: { message: 'capture encode rejected' },
    });
    expect(encode).toHaveBeenCalledTimes(1);
    expect(f.world.execution.health).toBe('healthy');
  } finally {
    seal.mockRestore();
    captures.mockRestore();
    encode.mockRestore();
    endRenderFrame(f.world);
  }
});

it('shares the submitted presentation order from capture through display and releases it for the next frame', async () => {
  const f = await fixture();
  const first = f.world
    .resolveUniqueRef<{ prepared: unknown }>(f.world.get(f.view, ViewRecordAttempt).unwrap().state)
    .unwrap();
  const other = {
    internals: {},
    captureOnly: true,
    frameState: { pipelinePreparationPending: false },
  };
  const second = f.world
    .spawn({
      component: ViewRecordAttempt,
      data: { state: f.world.allocUniqueRef('ViewRecordAttempt', { frame: 1, prepared: other }) },
    })
    .unwrap();
  const composition = viewComposition(f.world);
  composition.recorded.push({ entity: second } as (typeof composition.recorded)[number]);
  const events: string[] = [];
  const seal = vi.spyOn(frame, 'sealCompiledViewGraph').mockReturnValue({
    kind: 'sealed',
    display: undefined,
    value: {},
  } as never);
  const capture = vi.spyOn(frame, 'encodePreparedFrameCaptures').mockImplementation((view) => {
    events.push(view === first.prepared ? 'capture-primary' : 'capture-second');
    composition.recorded.length = 0;
    return { kind: 'ready' };
  });
  const encode = vi.spyOn(frame, 'encodePreparedViewGraph').mockImplementation((view) => {
    events.push(view === first.prepared ? 'display-primary' : 'display-second');
    return { kind: 'rejected' };
  });
  try {
    expect(f.record().ok).toBe(true);
    expect(events).toEqual([
      'capture-second',
      'capture-primary',
      'display-second',
      'display-primary',
    ]);
    endRenderFrame(f.world);
    Object.assign(renderSubmission(f.world), { frame: 2, open: true });
    expect(f.record().ok).toBe(true);
    expect(encode).toHaveBeenCalledTimes(2);
  } finally {
    seal.mockRestore();
    capture.mockRestore();
    encode.mockRestore();
    endRenderFrame(f.world);
  }
});

it('preserves a rejected decal configuration as domain data without poisoning the World', async () => {
  const f = await fixture();
  const failure = new ProjectedDecalInvalidError('renderPath', 'Standard Deferred');
  const seal = vi.spyOn(frame, 'sealCompiledViewGraph').mockImplementationOnce(() => {
    throw failure;
  });
  try {
    expect(f.record().ok).toBe(true);
    const result = viewGraphSealOutcome(f.world, f.view);
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') expect(result.error).toBe(failure);
    expect(f.world.execution.health).toBe('healthy');
  } finally {
    seal.mockRestore();
    endRenderFrame(f.world);
  }
  expect(f.world.execution.health).toBe('healthy');
});

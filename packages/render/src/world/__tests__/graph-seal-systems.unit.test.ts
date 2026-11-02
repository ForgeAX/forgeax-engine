import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { ProjectedDecalInvalidError } from '../../decals/component';
import * as frame from '../../record/frame';
import type { RenderSystemInternals } from '../../record/render-context';
import {
  RENDER_GRAPH_SEAL_SYSTEM,
  ViewGraphSeal,
  viewGraphSealOutcome,
} from '../graph-seal-systems';
import {
  createRenderWorld,
  endRenderFrame,
  RenderRecord,
  renderSubmission,
  runRenderRecord,
} from '../render-world';

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
      component: ViewGraphSeal,
      data: {
        state: world.allocUniqueRef('ViewGraphSeal', {
          frame: 1,
          prepared: { internals },
          outcome: undefined,
        }),
      },
    })
    .unwrap();
  return { world, view, record: () => runRenderRecord(world, { device, frameId: 1 }) };
}

it('does not run manual seal when the registered system is removed', async () => {
  const f = await fixture();
  const seal = vi.spyOn(frame, 'sealCompiledViewGraph');
  f.world.removeSystem(RenderRecord, RENDER_GRAPH_SEAL_SYSTEM).unwrap();
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
      f.world.get(f.view, ViewGraphSeal).unwrap().state,
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
    graph: {},
    value: {},
  } as never);
  const captures = vi
    .spyOn(frame, 'encodePreparedFrameCaptures')
    .mockReturnValue({ kind: 'ready' });
  const encode = vi.spyOn(frame, 'encodePreparedViewGraph').mockReturnValue({ kind: 'rejected' });
  try {
    f.world.removeSystem(RenderRecord, removed).unwrap();
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
    .mockReturnValue({ kind: 'sealed', graph: {}, value: {} } as never);
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
        f.world.get(f.view, ViewGraphSeal).unwrap().state,
      )
      .unwrap();
    state.frame = 2;
    state.prepared = { internals: {} };
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

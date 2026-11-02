import { createProfiler, type RecorderSession } from '@forgeax/engine-profiler';
import { RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import type { RenderSystemInternals } from '../record/render-context';
import { RENDER_PHASE_CATALOG } from '../render-contract';
import { createRenderWorld } from '../world/render-world';
import { installSurfaceUi, type UiCompositorOwner } from '../world/surface-ui';
import {
  type FrameRecording,
  profileFrameRecording,
  submitFrameRecordings,
} from './frame-recording-driver';

type Failure = 'none' | 'presentation' | 'finish' | 'before-submit' | 'submit';

async function fixture(enabled = true, failure: Failure = 'none') {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const encoder = device.createCommandEncoder().unwrap();
  // RenderRecord opens the submission encoder this fixture times.
  vi.spyOn(device, 'createCommandEncoder').mockReturnValue(ok(encoder) as never);
  let micros = 0;
  let resolveCompletion!: () => void;
  const completion = new Promise<undefined>((resolve) => {
    resolveCompletion = () => resolve(undefined);
  });
  const allocationReport = { profilerEventObjectAllocations: 0 };
  const profiler = createProfiler({
    enabled,
    clock: { nowMicros: () => micros },
    allocationReport,
    phaseCatalog: { app: ['renderer-draw'], render: RENDER_PHASE_CATALOG },
  });
  let session: RecorderSession | undefined;
  if (enabled) {
    const started = profiler.startCapture({ frameLimit: 1, eventLimit: 32 });
    if (!started.ok) throw started.error;
    session = started.value;
    expect(session.beginFrame(1).ok).toBe(true);
    expect(session.beginPhase('app', 'renderer-draw').ok).toBe(true);
  }
  const error = new RhiError({
    code: 'webgpu-runtime-error',
    expected: 'the test-selected operation succeeds',
    hint: 'this is the deliberate submission failure fixture',
  });
  const events: string[] = [];
  const originalFinish = encoder.finish.bind(encoder);
  const finish = vi.spyOn(encoder, 'finish').mockImplementation(() => {
    events.push('finish');
    micros += 103;
    return failure === 'finish' ? err(error) : originalFinish();
  });
  const originalSubmit = device.queue.submit.bind(device.queue);
  const submit = vi.spyOn(device.queue, 'submit').mockImplementation((buffers) => {
    events.push('submit');
    micros += 107;
    return failure === 'submit' ? err(error) : originalSubmit(buffers);
  });
  const completed = vi.spyOn(device.queue, 'onSubmittedWorkDone').mockImplementation(() => {
    events.push('completion-register');
    micros += 109;
    return completion;
  });
  const world = createRenderWorld();
  const ui = installSurfaceUi(
    world,
    {
      generation: 1,
      encode() {
        events.push('presentation');
        micros += 101;
        if (failure === 'presentation') throw error;
        return { kind: 'encoded' };
      },
    } as unknown as UiCompositorOwner,
    'rgba8unorm',
  );
  ui.outcome = { kind: 'retained', frame: 0, generation: 1 };
  const internals = {
    profiler,
    device,
    deviceScope: { generation: 1 },
    context: { getCurrentTexture: () => ok({}) },
    canvas: { width: 1, height: 1 },
  } as unknown as RenderSystemInternals;
  const resumed: boolean[] = [];
  const errors: RhiError[] = [];
  function* view(): FrameRecording {
    micros += 7;
    const accepted = yield {
      beforeSubmit() {
        events.push('before-submit');
        micros += 13;
        return failure === 'before-submit' ? error : undefined;
      },
      isCurrent() {
        micros += 5;
        return true;
      },
      onSubmittedWork(value) {
        expect(value).toBe(completion);
        events.push('track');
        micros += 17;
      },
      reportError(value) {
        errors.push(value);
      },
    };
    resumed.push(accepted.ok);
    micros += 11;
    return accepted.ok;
  }
  const recording = () =>
    profileFrameRecording(view(), (action) => {
      const opened = session?.beginPhase('render', 'record').ok;
      try {
        return action();
      } finally {
        if (opened) session?.endPhase();
      }
    });
  return {
    profiler,
    session,
    allocationReport,
    events,
    finish,
    submit,
    completed,
    resumed,
    errors,
    run: () =>
      submitFrameRecordings({ world, device, rendererInternals: internals }, [
        recording(),
        recording(),
      ]),
    capture() {
      if (session === undefined) throw new Error('capture is disabled');
      expect(session.endPhase().ok).toBe(true);
      expect(session.endFrame().ok).toBe(true);
      const result = session.finish();
      if (!result.ok) throw result.error;
      return result.value;
    },
    async settleLater() {
      micros += 1_000_000;
      resolveCompletion();
      await completion;
    },
  };
}

describe('shared Renderer submission CPU phases', () => {
  it('records one real barrier for two views under the live App parent, without waiting', async () => {
    const f = await fixture();
    expect(f.run()).toBe(true);
    expect(f.finish).toHaveBeenCalledTimes(1);
    expect(f.submit).toHaveBeenCalledTimes(1);
    expect(f.completed).toHaveBeenCalledTimes(1);
    expect(f.resumed).toEqual([true, true]);
    const capture = f.capture();
    const phases = capture.records.filter(
      (row) => row.kind === 'phase' && row.phase.startsWith('submission/'),
    );
    // Submission includes fence registration and a second live-input check before publication.
    expect(phases).toMatchObject([
      { phase: 'submission/presentation', durationMicros: 101 },
      { phase: 'submission/finish', durationMicros: 103 },
      { phase: 'submission/submit', durationMicros: 283 },
    ]);
    for (const phase of phases)
      expect(phase).toMatchObject({
        source: 'render',
        frameId: 1,
        parentSource: 'app',
        parentPhase: 'renderer-draw',
      });
    const recorded = capture.records.filter(
      (row) => row.kind === 'phase' && row.phase === 'record',
    );
    expect(recorded).toHaveLength(4);
    for (const phase of phases)
      for (const row of recorded)
        expect(
          phase.kind === 'phase' &&
            row.kind === 'phase' &&
            (phase.endMicros <= row.startMicros || phase.startMicros >= row.endMicros),
        ).toBe(true);
    await f.settleLater();
    expect(f.profiler.latestCapture()).toBe(capture);
    expect(phases.map((row) => row.kind === 'phase' && row.durationMicros)).toEqual([
      101, 103, 283,
    ]);
  });

  it.each([
    ['presentation', ['submission/presentation']],
    ['finish', ['submission/presentation', 'submission/finish']],
    ['before-submit', ['submission/presentation', 'submission/finish', 'submission/submit']],
    ['submit', ['submission/presentation', 'submission/finish', 'submission/submit']],
  ] as const)('closes reached phases and preserves the %s failure', async (failure, expected) => {
    const f = await fixture(true, failure);
    if (failure === 'finish') expect(f.run()).toBe(false);
    else expect(f.run).toThrow();
    expect(f.resumed).toEqual([false, false]);
    expect(f.completed).not.toHaveBeenCalled();
    expect(
      f
        .capture()
        .records.filter((row) => row.phase.startsWith('submission/'))
        .map((row) => row.phase),
    ).toEqual(expected);
    await f.settleLater();
  });

  it('keeps the ordinary backend call order and zero event objects when disabled', async () => {
    const f = await fixture(false);
    expect(f.run()).toBe(true);
    expect(f.events).toEqual([
      'presentation',
      'finish',
      'before-submit',
      'submit',
      'completion-register',
      'track',
      'track',
    ]);
    expect(f.resumed).toEqual([true, true]);
    expect(f.allocationReport.profilerEventObjectAllocations).toBe(0);
    expect(f.profiler.latestCapture()).toBeUndefined();
    await f.settleLater();
  });

  it('does not let a failing profiler change a successful submission', async () => {
    const f = await fixture();
    vi.spyOn(f.profiler, 'activeSession').mockImplementation(() => {
      throw new Error('diagnostic reader failed');
    });
    expect(f.run()).toBe(true);
    expect(f.resumed).toEqual([true, true]);
    expect(f.submit).toHaveBeenCalledTimes(1);
    f.capture();
    await f.settleLater();
  });
});

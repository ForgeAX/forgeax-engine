import type { FrameReceipt, RenderFrameInput } from '@forgeax/engine-render';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { completeFrameFailure } from '../../../render/src/assembly/renderer-frame-transaction';
import { prepareVisibleColdScene } from './gi-visible-temporal-capture.fixture';
import {
  regroupVisibleFrames,
  requireConsecutiveVisibleFrame,
  visibleAdjacentChanges,
  visibleFrameMetrics,
} from './gi-visible-temporal-metrics.fixture';

function image(gain = 1, support = 1) {
  return {
    width: 1,
    height: 1,
    rgb: new Float32Array([gain, gain, gain]),
    covered: new Uint8Array([1]),
    support: new Float32Array([support]),
  };
}
const reference = new Float32Array([1, 1, 1]);
const thresholds = { mean: 0.1, p95: 0.2 };

type ColdHost = Parameters<typeof prepareVisibleColdScene>[0];
type PreparationResult = Awaited<NonNullable<FrameReceipt['preparationCompleted']>>;
function coldHost(signal: FrameReceipt['preparationCompleted']) {
  let current = 0;
  let ready = false;
  const submit = vi.fn(() =>
    ok({
      frameId: ++current,
      presentation: ready ? 'ready' : 'pending',
      presentationPendingReason: { code: 'scene-pipeline-preparation' },
      preparationCompleted: ready ? undefined : signal,
      completed: Promise.resolve(ok(undefined)),
      observationDomains: [],
    } as unknown as FrameReceipt),
  );
  const h: ColdHost = {
    submit,
    renderer: {
      inspect: () => ({ frame: { frameId: current, deviceGeneration: 0 } }),
    },
    save: vi.fn(),
  };
  return { h, submit, ready: () => (ready = true) };
}

describe('explicit visible cold setup (artificial CPU controls)', () => {
  afterEach(() => vi.useRealTimers());

  it('waits for the real delayed signal, then submits a new ready receipt', async () => {
    vi.useFakeTimers();
    let release!: (result: PreparationResult) => void;
    const signal = new Promise<PreparationResult>((resolve) => (release = resolve));
    const f = coldHost(signal);
    let settled = false;
    const pending = prepareVisibleColdScene(f.h).then((receipt) => {
      settled = true;
      return receipt;
    });
    await vi.advanceTimersByTimeAsync(16_000);
    expect(settled).toBe(false);
    expect(f.submit).toHaveBeenCalledTimes(1);
    f.ready();
    release(ok(undefined));
    expect((await pending).frameId).toBe(2);
    expect(f.submit).toHaveBeenCalledTimes(2);
    expect(f.h.save).toHaveBeenCalledWith(
      'cold-preparation-setup.json',
      expect.objectContaining({ submissions: 2, readyFrameId: 2, timeoutMs: 90_000 }),
    );
  });

  it('keeps the next observed default frame on its original fifteen-second bound', async () => {
    vi.useFakeTimers();
    const f = coldHost(new Promise(() => {}));
    f.ready();
    await prepareVisibleColdScene(f.h);
    const pending = coldHost(new Promise(() => {}));
    const frame = drawReadyFrame(
      { draw: pending.submit, requestObservation: () => ok(undefined), observe: vi.fn() },
      {} as RenderFrameInput,
      ['linear-hdr'],
    );
    const rejected = expect(frame).rejects.toThrow('"stageTimeoutMs":15000');
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(pending.submit).toHaveBeenCalledTimes(1);
  });

  it('propagates a failed compile without another submission', async () => {
    vi.useFakeTimers();
    const cause = new RhiError({
      code: 'shader-compile-failed',
      expected: 'controlled actual preparation result',
      hint: 'Artificial CPU compile-error control',
    });
    const error = completeFrameFailure(1, 0, cause);
    const f = coldHost(Promise.resolve(err(error)));
    await expect(prepareVisibleColdScene(f.h)).rejects.toBe(error);
    expect(f.submit).toHaveBeenCalledTimes(1);
  });

  it('rejects the ninety-second setup limit and never retries a late signal', async () => {
    vi.useFakeTimers();
    let release!: (result: PreparationResult) => void;
    const signal = new Promise<PreparationResult>((resolve) => (release = resolve));
    const f = coldHost(signal);
    const rejected = expect(prepareVisibleColdScene(f.h)).rejects.toThrow('"stageTimeoutMs":90000');
    await vi.advanceTimersByTimeAsync(90_000);
    await rejected;
    f.ready();
    release(ok(undefined));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.submit).toHaveBeenCalledTimes(1);
  });
});

describe('completed-frame visible temporal checks', () => {
  it('rejects a skipped completed receipt in the actual collector witness (artificial CPU control)', () => {
    expect(() => requireConsecutiveVisibleFrame(undefined, 109)).not.toThrow();
    expect(() => requireConsecutiveVisibleFrame(109, 110)).not.toThrow();
    expect(() => requireConsecutiveVisibleFrame(109, 111)).toThrow('consecutive');
    expect(() => requireConsecutiveVisibleFrame(109, 109)).toThrow('consecutive');
    expect(() => requireConsecutiveVisibleFrame(109, NaN)).toThrow('consecutive');
  });
  it('retains a bad frame that a 32-frame mean would hide (artificial CPU control)', () => {
    const frames = Array.from({ length: 32 }, () => image());
    frames[13] = image(1.5);
    const checks = frames.map((frame) => visibleFrameMetrics(frame, reference, [0], thresholds));
    expect(checks.flatMap((check, index) => (check.passed ? [] : [index]))).toEqual([13]);
    expect(visibleFrameMetrics(image(1 + 0.5 / 32), reference, [0], thresholds).passed).toBe(true);
    expect(
      visibleFrameMetrics(regroupVisibleFrames(frames.slice(8, 16)), reference, [0], thresholds)
        .passed,
    ).toBe(true);
    expect(visibleAdjacentChanges(frames, [0]).filter((x) => x.maximum > 0)).toHaveLength(2);
  });
  it('does not hide a single visible hole or pair hidden black with another frame visibility', () => {
    expect(visibleFrameMetrics(image(1, 0), reference, [0], thresholds).missing).toBe(1);
    const hidden = {
      width: 2,
      height: 1,
      rgb: new Float32Array([1, 1, 1, 0, 0, 0]),
      covered: new Uint8Array([1, 0]),
      support: new Float32Array([1, 0]),
    };
    expect(
      visibleFrameMetrics(hidden, new Float32Array([1, 1, 1, 0, 0, 0]), [0], thresholds).passed,
    ).toBe(true);
  });
  it('reconstructs the existing ordered f32 eight-frame window exactly', () => {
    const frames = Array.from({ length: 8 }, (_, i) => image((i + 1) / 7));
    const expected = new Float32Array(3);
    for (const frame of frames)
      for (let c = 0; c < 3; c++) expected[c] = (expected[c] ?? 0) + (frame.rgb[c] ?? NaN) / 8;
    expect(new Uint8Array(regroupVisibleFrames(frames).rgb.buffer)).toEqual(
      new Uint8Array(expected.buffer),
    );
    expect(() => regroupVisibleFrames(frames.slice(1))).toThrow('Exactly eight');
  });
  it('fails closed for missing or nonfinite receipt data', () => {
    expect(() => visibleFrameMetrics(image(NaN), reference, [0], thresholds)).toThrow('Nonfinite');
    expect(() =>
      visibleFrameMetrics(
        { width: 1, height: 1, rgb: reference, covered: new Uint8Array([1]) },
        reference,
        [0],
        thresholds,
      ),
    ).toThrow('support');
  });
});

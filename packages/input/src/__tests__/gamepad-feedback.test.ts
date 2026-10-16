import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachBrowserGamepadFeedback } from '../browser-gamepad-feedback';
import type { GamepadFeedbackTarget } from '../gamepad-feedback';
import { createGamepadFeedback, GAMEPAD_FEEDBACK_CAPACITY } from '../gamepad-feedback';
import type { RawGamepadStub } from '../gamepad-frame';

const effect = { durationMs: 100, strongMagnitude: 1, weakMagnitude: 0.2 };
function requiredTarget(target: GamepadFeedbackTarget | undefined): GamepadFeedbackTarget {
  if (!target) throw new Error('Missing connected feedback target');
  return target;
}
function rig() {
  const win = new EventTarget() as Window;
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' }) as Document;
  const plays: { resolve: (result: string) => void; reject: (cause: unknown) => void }[] = [];
  const actuator = {
    effects: ['dual-rumble'],
    playEffect: vi.fn(
      () => new Promise<string>((resolve, reject) => plays.push({ resolve, reject })),
    ),
    reset: vi.fn(() => Promise.resolve('complete')),
  };
  const pad = {
    index: 0,
    id: 'test pad',
    connected: true,
    mapping: 'standard',
    buttons: [],
    axes: [],
    vibrationActuator: actuator,
  };
  const host = attachBrowserGamepadFeedback(doc, win);
  host.observe([pad]);
  return { win, doc, plays, actuator, pad, host, target: requiredTarget(host.target(0)) };
}
function sync(host: ReturnType<typeof attachBrowserGamepadFeedback>) {
  const result = host.sampleResults();
  host.feedback.acceptResults(result.feedbackResults, result.feedbackLostResults);
  return result;
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
afterEach(() => vi.useRealTimers());

describe('bounded feedback contract and native ownership (test double, no physical evidence)', () => {
  it('keeps headless input attachment usable without a DOM owner', () => {
    const host = attachBrowserGamepadFeedback(undefined, undefined);
    expect(host.target(0)).toBeUndefined();
    expect(host.sampleResults().feedbackResults).toEqual([]);
    host.detach();
    expect(host.feedback.stop({ attachment: 1, index: 0, generation: 1 })).toEqual({
      ok: false,
      reason: 'disposed',
    });
  });
  it('validates parameters, owns POD copies and retains capacity until results are polled', () => {
    const port = createGamepadFeedback();
    const target = { index: 0, attachment: 1, generation: 1 };
    expect(port.play(target, { ...effect, durationMs: Infinity })).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(port.play(target, { ...effect, weakMagnitude: -1 })).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(port.play(target, { ...effect, durationMs: 10_001 })).toEqual({
      ok: false,
      reason: 'invalid',
    });
    for (let i = 0; i < GAMEPAD_FEEDBACK_CAPACITY; i++)
      expect(port.play(target, effect).ok).toBe(true);
    target.generation = 9;
    const batch = JSON.parse(JSON.stringify(port.drainIntents()));
    expect(batch[0].target.generation).toBe(1);
    expect(port.stop(target)).toEqual({ ok: false, reason: 'capacity' });
    port.acceptResults(
      batch.map((intent: { id: number }) => ({ id: intent.id, status: 'complete' })),
    );
    expect(port.stop(target).ok).toBe(false);
    expect(port.readResults()).toHaveLength(32);
    expect(port.stop(target).ok).toBe(true);
    port.dispose();
    expect(port.readResults()[0]?.status).toBe('disposed');
    expect(port.stop(target)).toEqual({ ok: false, reason: 'disposed' });
  });
  it('plays, replaces, stops in order; late settlement cannot clear the replacement', async () => {
    const r = rig();
    r.host.feedback.play(r.target, effect);
    sync(r.host);
    r.host.feedback.play(r.target, { ...effect, strongMagnitude: 0, weakMagnitude: 1 });
    sync(r.host);
    r.plays[0]?.resolve('preempted');
    await flush();
    r.host.feedback.stop(r.target);
    sync(r.host);
    await flush();
    r.plays[1]?.resolve('preempted');
    await flush();
    sync(r.host);
    expect(r.host.feedback.readResults()).toEqual([
      { id: 1, status: 'preempted' },
      { id: 2, status: 'preempted' },
      { id: 3, status: 'complete' },
    ]);
    expect(r.actuator.reset).toHaveBeenCalledTimes(1);
    r.host.detach();
  });
  it('fences disconnect/reconnect with same id and slot, and deduplicates transport', () => {
    const r = rig();
    const intent = { id: 1, target: r.target, kind: 'play' as const, effect };
    r.host.dispatch([intent, intent]);
    expect(r.actuator.playEffect).toHaveBeenCalledTimes(1);
    const event = Object.assign(new Event('gamepaddisconnected'), { gamepad: r.pad });
    r.win.dispatchEvent(event);
    r.host.observe([r.pad]);
    expect(r.host.target(0)?.generation).not.toBe(r.target.generation);
    r.host.dispatch([{ ...intent, id: 2 }]);
    expect(sync(r.host).feedbackResults.map((x) => x.status)).toEqual(['disconnected', 'stale']);
    expect(r.actuator.playEffect).toHaveBeenCalledTimes(1);
    r.host.detach();
  });
  it('two owners arbitrate latest play; disposing A cannot stop B', async () => {
    const r = rig();
    const b = attachBrowserGamepadFeedback(r.doc, r.win);
    b.observe([r.pad]);
    r.host.dispatch([{ id: 1, target: r.target, kind: 'play', effect }]);
    b.dispatch([{ id: 1, target: requiredTarget(b.target(0)), kind: 'play', effect }]);
    r.host.dispatch([{ id: 2, target: r.target, kind: 'stop' }]);
    expect(sync(r.host).feedbackResults.map((x) => x.status)).toEqual(['preempted', 'busy']);
    r.host.detach();
    expect(r.actuator.reset).not.toHaveBeenCalled();
    b.detach();
    expect(r.actuator.reset).toHaveBeenCalledTimes(1);
    for (const play of r.plays) play.resolve('preempted');
    await flush();
  });
  it('hidden revokes queued targets, reset rejection survives, visible does not replay', async () => {
    const r = rig();
    r.actuator.reset.mockImplementation(() => Promise.reject(new Error('reset denied')));
    r.host.feedback.play(r.target, effect);
    sync(r.host);
    Object.defineProperty(r.doc, 'visibilityState', { value: 'hidden', configurable: true });
    r.doc.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(sync(r.host).feedbackResults).toContainEqual({
      id: 0,
      status: 'rejected',
      detail: 'Lifecycle reset: Error: reset denied',
    });
    Object.defineProperty(r.doc, 'visibilityState', { value: 'visible', configurable: true });
    r.doc.dispatchEvent(new Event('visibilitychange'));
    r.host.feedback.play(r.target, effect);
    sync(r.host);
    expect(r.host.feedback.readResults().map((x) => x.status)).toContain('stale');
    expect(r.actuator.playEffect).toHaveBeenCalledTimes(1);
    r.host.detach();
  });
  it('native reject is structured; unsupported gamepads still have targets', async () => {
    const r = rig();
    r.host.feedback.play(r.target, effect);
    sync(r.host);
    r.plays[0]?.reject(new Error('permission denied'));
    await flush();
    sync(r.host);
    expect(r.host.feedback.readResults()).toEqual([
      { id: 1, status: 'rejected', detail: 'Error: permission denied' },
    ]);
    const pad: RawGamepadStub = { ...r.pad, index: 1 };
    r.host.observe([r.pad, { ...pad, vibrationActuator: undefined } as RawGamepadStub]);
    r.host.feedback.play(requiredTarget(r.host.target(1)), effect);
    sync(r.host);
    expect(r.host.feedback.readResults()[0]?.status).toBe('unsupported');
    r.host.detach();
  });
  it('never-settling calls remain bounded after timeout; a pending reset blocks takeover', async () => {
    vi.useFakeTimers();
    const r = rig();
    r.actuator.reset.mockImplementation(() => new Promise<string>(() => {}));
    for (let id = 1; id <= 20; id++)
      r.host.dispatch([{ id, target: r.target, kind: 'play', effect }]);
    expect(r.actuator.playEffect).toHaveBeenCalledTimes(7);
    expect(r.host.inspect().pendingNative).toBe(7);
    await vi.advanceTimersByTimeAsync(1101);
    expect(r.actuator.reset).toHaveBeenCalledTimes(1);
    expect(r.host.inspect().pendingNative).toBe(8);
    await vi.advanceTimersByTimeAsync(1001);
    for (let id = 21; id <= 100; id++)
      r.host.dispatch([{ id, target: r.target, kind: 'play', effect }]);
    expect(r.actuator.playEffect).toHaveBeenCalledTimes(7);
    expect(r.host.inspect().pendingNative).toBe(8);
    expect(r.host.inspect().queuedResults).toBeLessThanOrEqual(64);
    expect(r.host.inspect().lostResults).toBeGreaterThan(0);
    r.host.detach();
  });
  it('rejects oversized transport batches explicitly without partially dispatching', () => {
    const r = rig();
    r.host.dispatch(
      Array.from({ length: 33 }, (_, index) => ({
        id: index + 1,
        target: r.target,
        kind: 'play',
        effect,
      })),
    );
    expect(r.actuator.playEffect).not.toHaveBeenCalled();
    expect(sync(r.host).feedbackLostResults).toBe(33);
    r.host.detach();
  });
  it('retains lifecycle reject evidence when authored command capacity is full', () => {
    const port = createGamepadFeedback();
    for (let id = 0; id < 32; id++) port.play({ attachment: 1, index: 0, generation: 1 }, effect);
    for (let n = 0; n < 100; n++)
      port.acceptResults([{ id: 0, status: 'rejected', detail: `reset denied ${n}` }]);
    const observed = port.readResults();
    expect(observed.length).toBeLessThanOrEqual(64);
    expect(observed.some((result) => result.detail?.includes('reset denied 99'))).toBe(true);
    expect(observed.some((result) => result.status === 'result-overflow')).toBe(true);
    port.dispose();
    expect(port.readResults()).toHaveLength(32);
  });
  it('result loss terminates pending producer commands instead of silently wedging capacity', () => {
    const port = createGamepadFeedback();
    port.play({ attachment: 1, index: 0, generation: 1 }, effect);
    port.drainIntents();
    port.acceptResults([], 1);
    expect(port.readResults()).toEqual([{ id: 1, status: 'result-overflow' }]);
  });
});

import { expect, it } from 'vitest';
import { attachBrowserInputBackend } from '../browser-backend';
import type { GamepadFeedbackResult } from '../gamepad-feedback';
import { snapshotFromSample } from '../input-snapshot';

it('uses actual DOM input ownership and an actual Worker POD roundtrip (actuator double)', async () => {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  const nativeCalls: string[] = [];
  const pad = {
    index: 0,
    id: 'contract device',
    connected: true,
    mapping: 'standard',
    buttons: [],
    axes: [],
    vibrationActuator: {
      effects: ['dual-rumble'],
      playEffect: (_: string, params: { strongMagnitude: number }) => {
        nativeCalls.push(params.strongMagnitude ? 'strong' : 'weak');
        return Promise.resolve('complete');
      },
      reset: () => {
        nativeCalls.push('stop');
        return Promise.resolve('complete');
      },
    },
  } as unknown as Gamepad;
  const handle = attachBrowserInputBackend(canvas, { navigator: { getGamepads: () => [pad] } });
  const worker = new Worker(new URL('./support/feedback-worker.ts', import.meta.url), {
    type: 'module',
  });
  let observed: readonly GamepadFeedbackResult[] = [];
  let dispatched = false;
  worker.onmessage = (event) => {
    if (event.data.kind === 'intents') {
      handle.backend.dispatchFeedback?.(event.data.intents);
      dispatched = true;
    } else observed = event.data.results;
  };
  try {
    const snapshot = snapshotFromSample(handle.backend.sample());
    const target = snapshot.gamepad(0).feedbackTarget;
    expect(Object.isFrozen(target)).toBe(true);
    expect(snapshot.gamepad(0).dualRumble).toBe(true);
    worker.postMessage({ kind: 'target', target });
    await expect.poll(() => dispatched).toBe(true);
    const results = handle.backend.sample().feedbackResults;
    worker.postMessage({ kind: 'results', results });
    await expect.poll(() => observed.length).toBe(3);
    expect(nativeCalls).toEqual(['strong', 'weak', 'stop']);
    expect(observed.map((value) => [value.id, value.status])).toEqual([
      [1, 'preempted'],
      [2, 'preempted'],
      [3, 'complete'],
    ]);
    handle();
    expect(nativeCalls).toEqual(['strong', 'weak', 'stop']);
  } finally {
    worker.terminate();
    handle();
    canvas.remove();
  }
});

it('samples the actual browser Gamepad API without a physical-device claim', () => {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  const handle = attachBrowserInputBackend(canvas);
  try {
    const native = navigator.getGamepads();
    const sample = handle.backend.sample();
    expect(sample.gamepads?.length ?? 0).toBe(native.filter((pad) => pad?.connected).length);
  } finally {
    handle();
    canvas.remove();
  }
});

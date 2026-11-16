import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForCompletedAppFrames } from '../wait-for-completed-app-frames.mjs';

function fixture() {
  const canvas = new EventTarget();
  let frameId = 0;
  return {
    canvas,
    emit(presentation = 'ready', generation = 0, world = 'world-1') {
      const frame = {
        frameId: ++frameId,
        presentation,
        deviceGeneration: generation,
        worldIdentity: world,
      };
      canvas.forgeaxFrameProgress = {
        submitted: { ...frame, receipt: { presentation } },
        completed: frame,
      };
      const event = new Event('forgeax:frame-completed');
      event.detail = frame;
      canvas.dispatchEvent(event);
      return event;
    },
  };
}

test('animation callbacks cannot satisfy a completed-picture gate', async () => {
  const previous = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => queueMicrotask(callback);
  try {
    await assert.rejects(
      waitForCompletedAppFrames({ count: 60, canvas: fixture().canvas, timeoutMs: 10 }),
      /completed 0\/60/,
    );
  } finally {
    if (previous === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previous;
  }
});

test('sixty warming completions cannot qualify a ready-picture gate', async () => {
  const f = fixture();
  const waiting = waitForCompletedAppFrames({ count: 60, canvas: f.canvas, timeoutMs: 10 });
  for (let index = 0; index < 60; index++) f.emit('warming');
  await assert.rejects(waiting, /completed 0\/60/);
});

test('counts unique successfully completed ready frames from one generation', async () => {
  const f = fixture();
  const waiting = waitForCompletedAppFrames({ count: 2, canvas: f.canvas, timeoutMs: 100 });
  const duplicate = f.emit();
  f.canvas.dispatchEvent(duplicate);
  f.emit('warming');
  f.emit();
  assert.equal(await waiting, 2);
});

test('cannot combine device generations', async () => {
  const f = fixture();
  const waiting = waitForCompletedAppFrames({ count: 2, canvas: f.canvas, timeoutMs: 100 });
  f.emit('ready', 0);
  f.emit('ready', 1);
  await assert.rejects(waiting, /generation or World changed/);
});

test('cannot combine different World identities', async () => {
  const f = fixture();
  const waiting = waitForCompletedAppFrames({ count: 2, canvas: f.canvas, timeoutMs: 100 });
  f.emit('ready', 0, 'one');
  f.emit('ready', 0, 'two');
  await assert.rejects(waiting, /generation or World changed/);
});

test('rejects an invalid completed-frame target', async () => {
  await assert.rejects(
    waitForCompletedAppFrames({ count: 0, canvas: fixture().canvas }),
    RangeError,
  );
});

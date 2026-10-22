import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForReadyFrames } from '../wait-for-ready-frames.ts';

function fixture() {
  const listeners = new Set();
  let generation = 0;
  return {
    listeners,
    renderer: {
      inspect: () => ({ frame: { deviceGeneration: generation } }),
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    generation(value) {
      generation = value;
    },
    emit(presentation, completed = Promise.resolve({ ok: true })) {
      for (const listener of listeners)
        listener({
          kind: 'frame-submitted',
          deviceGeneration: generation,
          receipt: { presentation, completed },
        });
    },
  };
}

test('sixty submitted warming frames cannot satisfy the sixty-ready-frame gate', async () => {
  const f = fixture();
  const waiting = waitForReadyFrames(f.renderer, 60, 10);
  for (let i = 0; i < 60; i++) f.emit('warming');
  await assert.rejects(waiting, /completed 0\/60 ready frames/);
  assert.equal(f.listeners.size, 0);
});

test('waits for successful completion of every ready receipt', async () => {
  const f = fixture();
  let complete;
  const receipt = new Promise((resolve) => {
    complete = resolve;
  });
  let settled = false;
  const waiting = waitForReadyFrames(f.renderer, 2).then((count) => {
    settled = true;
    return count;
  });
  f.emit('ready', receipt);
  f.emit('warming');
  f.emit('ready');
  await Promise.resolve();
  assert.equal(settled, false);
  complete({ ok: true });
  assert.equal(await waiting, 2);
  assert.equal(f.listeners.size, 0);
});

test('rejects a failed completion and releases the subscription', async () => {
  const f = fixture();
  const waiting = waitForReadyFrames(f.renderer, 1);
  f.emit('ready', Promise.resolve({ ok: false, error: { code: 'device-lost' } }));
  await assert.rejects(waiting, /completion failed: device-lost/);
  assert.equal(f.listeners.size, 0);
});

test('owns rejected completion promises', async () => {
  const f = fixture();
  const waiting = waitForReadyFrames(f.renderer, 1);
  f.emit('ready', Promise.reject(new Error('driver completion rejected')));
  await assert.rejects(waiting, /frame completion rejected/);
  assert.equal(f.listeners.size, 0);
});

test('an undefined rejection cannot become a successful zero-frame result', async () => {
  const f = fixture();
  const waiting = waitForReadyFrames(f.renderer, 1);
  f.emit('ready', Promise.reject(undefined));
  await assert.rejects(waiting, /frame completion rejected/);
  assert.equal(f.listeners.size, 0);
});

test('cannot combine receipts from different device generations', async () => {
  const f = fixture();
  const waiting = waitForReadyFrames(f.renderer, 2);
  f.emit('ready');
  await Promise.resolve();
  f.generation(1);
  f.emit('ready');
  await assert.rejects(waiting, /device generation changed/);
  assert.equal(f.listeners.size, 0);
});

test('rejects an old receipt completing after recovery', async () => {
  const f = fixture();
  let complete;
  const receipt = new Promise((resolve) => {
    complete = resolve;
  });
  const waiting = waitForReadyFrames(f.renderer, 1);
  f.emit('ready', receipt);
  f.generation(1);
  complete({ ok: true });
  await assert.rejects(waiting, /device generation changed/);
  assert.equal(f.listeners.size, 0);
});

test('rejects an empty ready-frame target', async () => {
  const f = fixture();
  await assert.rejects(waitForReadyFrames(f.renderer, 0), RangeError);
  assert.equal(f.listeners.size, 0);
});

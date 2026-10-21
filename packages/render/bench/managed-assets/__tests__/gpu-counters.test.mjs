import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { gpuCounters } from '../gpu-counters.mjs';

test('counts both native buffer-copy overloads and preserves their arguments', () => {
  const calls = [];
  class GPUCommandEncoder {
    copyBufferToBuffer(...args) { calls.push([this, ...args]); }
  }
  const counters = runInNewContext(`(${gpuCounters.toString()})()`, { GPUCommandEncoder, performance });
  const source = { size: 32 }, destination = { size: 32 };
  const encoder = new GPUCommandEncoder();
  encoder.copyBufferToBuffer(source, destination, 8);
  encoder.copyBufferToBuffer(source, destination);
  encoder.copyBufferToBuffer(source, 0, destination, 0, 16);
  encoder.copyBufferToBuffer(source, 8, destination, 0);
  assert.equal(counters.snapshot().bufferCopyBytes, 80);
  assert.deepEqual(calls, [
    [encoder, source, destination, 8],
    [encoder, source, destination],
    [encoder, source, 0, destination, 0, 16],
    [encoder, source, 8, destination, 0],
  ]);
  counters.reset();
  encoder.copyBufferToBuffer(source, destination, 0);
  assert.equal(counters.snapshot().bufferCopyBytes, 0);
});


test('retains uploads for every observed Scene table across source layouts', () => {
  const calls = [];
  class GPUDevice {
    createBuffer(descriptor) { return { ...descriptor }; }
  }
  class GPUQueue {
    writeBuffer(...args) { calls.push(args); }
  }
  const counters = runInNewContext(`(${gpuCounters.toString()})()`, {
    GPUDevice, GPUQueue, performance,
  });
  const device = new GPUDevice(), queue = new GPUQueue();
  const bytes = new Uint8Array(32);
  const labels = [
    'gpu-scene-primitive-table',
    'gpu-scene-drawTemplate-table',
    'gpu-scene-shared-input-table',
  ];
  for (const label of labels) {
    const buffer = device.createBuffer({ label, size: 64 });
    queue.writeBuffer(buffer, 0, bytes);
    assert.equal(counters.snapshot()[label + 'UploadBytes'], 32);
  }
  assert.equal(counters.snapshot().bufferUploadBytes, 96);
  assert.equal(counters.snapshot().bufferUploadCalls, 3);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((args) => args[1] === 0 && args[2] === bytes));
});

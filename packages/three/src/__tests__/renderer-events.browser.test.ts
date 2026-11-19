import * as THREE from '@forgeax/engine/three';
import { expect, it } from 'vitest';
import { readyFrames, SIZE } from './render.fixture';

it('forwards an actual device loss once, with the original event and native state', {
  timeout: 120000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const renderer = new THREE.WebGPURenderer({ canvas });
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const losses: Parameters<THREE.WebGPURenderer['onDeviceLost']>[0][] = [];
  let timeout: (() => void) | undefined;
  const lost = new Promise<void>((resolve, reject) => {
    renderer.onDeviceLost = (info) => {
      losses.push(info);
      resolve();
    };
    timeout = () => reject(new Error('native loss notification timed out'));
  });
  renderer.onError = () => undefined;
  try {
    await renderer.init();
    await readyFrames(renderer, scene, camera, 60);
    const device = renderer.getContext().getConfiguration()?.device;
    if (device === undefined) throw new Error('missing configured WebGPU device');
    timer = setTimeout(() => timeout?.(), 30000);
    device.destroy();
    const originalEvent = await device.lost;
    await lost;
    expect(renderer.inspect().renderer.state).toBe('device-lost');
    expect(losses).toHaveLength(1);
    expect(losses[0]).toEqual({
      api: 'WebGPU',
      reason: 'destroyed',
      message: originalEvent.message,
      originalEvent,
    });
  } finally {
    clearTimeout(timer);
    await renderer.dispose();
  }
  expect(losses).toHaveLength(1);
});

it('forwards the actual uncaptured GPU error object without replacing native handling', {
  timeout: 120000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const renderer = new THREE.WebGPURenderer({ canvas });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await renderer.init();
    await readyFrames(renderer, new THREE.Scene(), new THREE.PerspectiveCamera(), 60);
    const device = renderer.getContext().getConfiguration()?.device;
    if (device === undefined) throw new Error('missing configured WebGPU device');
    const received = new Promise<THREE.RendererErrorInfo>((resolve, reject) => {
      renderer.onError = resolve;
      timer = setTimeout(() => reject(new Error('uncaptured GPU error timed out')), 30000);
    });
    // MAP_READ may only combine with COPY_DST. Submit flushes the validation
    // message even while no animation loop is driving this fixture.
    const buffer = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.STORAGE,
    });
    device.queue.submit([]);
    await device.queue.onSubmittedWorkDone();
    const info = await received;
    expect(info.api).toBe('WebGPU');
    expect(info.type).toBe('GPUValidationError');
    expect(info.message).toBe(info.originalEvent.error.message);
    expect(info.originalEvent).toBeInstanceOf(GPUUncapturedErrorEvent);
    buffer.destroy();
  } finally {
    clearTimeout(timer);
    await renderer.dispose();
  }
});

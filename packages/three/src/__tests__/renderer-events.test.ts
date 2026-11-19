import type { Renderer, RendererEvent } from '@forgeax/engine-render';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { forwardRendererEvents } from '../renderer-events';

function fixture() {
  let notify: ((event: RendererEvent) => void) | undefined;
  let lose: ((info: GPUDeviceLostInfo) => void) | undefined;
  const lost = new Promise<GPUDeviceLostInfo>((resolve) => {
    lose = resolve;
  });
  const remove = vi.fn();
  const device = new EventTarget();
  const native = {
    nativeDevice: () => ok(Object.assign(device, { lost })),
    subscribe: (listener: (event: RendererEvent) => void) => {
      notify = listener;
      return remove;
    },
  } as unknown as Renderer;
  const callbacks = { onError: vi.fn(), onDeviceLost: vi.fn() };
  const stop = forwardRendererEvents(native, callbacks);
  return {
    callbacks,
    device,
    remove,
    stop,
    notify: (event: RendererEvent) => notify?.(event),
    lose: (info: GPUDeviceLostInfo) => lose?.(info),
  };
}

it('uses native lifecycle admission and preserves original device-loss detail', async () => {
  const f = fixture();
  const info = { reason: 'destroyed', message: 'test loss' } as GPUDeviceLostInfo;
  f.lose(info);
  await Promise.resolve();
  expect(f.callbacks.onDeviceLost).not.toHaveBeenCalled();
  f.notify({ kind: 'state-changed', previous: 'alive', current: 'device-lost' });
  await Promise.resolve();
  expect(f.callbacks.onDeviceLost).toHaveBeenCalledExactlyOnceWith({
    api: 'WebGPU',
    reason: 'destroyed',
    message: 'test loss',
    originalEvent: info,
  });
  f.stop();
  expect(f.remove).toHaveBeenCalledOnce();
});

it('reads replaced callbacks and cancels a pending notification on disposal', async () => {
  const f = fixture();
  const replacement = vi.fn();
  f.callbacks.onError = replacement;
  const event = Object.assign(new Event('uncapturederror'), { error: new Error('native failure') });
  f.device.dispatchEvent(event);
  expect(replacement).toHaveBeenCalledExactlyOnceWith({
    api: 'WebGPU',
    type: 'Error',
    message: 'native failure',
    originalEvent: event,
  });
  f.notify({ kind: 'state-changed', previous: 'alive', current: 'device-lost' });
  f.stop();
  f.lose({ reason: 'destroyed', message: '' } as GPUDeviceLostInfo);
  await Promise.resolve();
  expect(f.callbacks.onDeviceLost).not.toHaveBeenCalled();
  replacement.mockClear();
  f.device.dispatchEvent(event);
  expect(replacement).not.toHaveBeenCalled();
});

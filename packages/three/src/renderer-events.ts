import type { Renderer } from '@forgeax/engine-render';
import type UpstreamRenderer from 'three/src/renderers/common/Renderer.js';

/** Actual r187 runtime payload; @types/three incorrectly declares a string callback. */
export interface RendererErrorInfo {
  readonly api: 'WebGPU';
  readonly type: string;
  readonly message: string;
  readonly originalEvent: GPUUncapturedErrorEvent;
}

export interface RendererCallbacks {
  onDeviceLost: UpstreamRenderer['onDeviceLost'];
  onError: (info: RendererErrorInfo) => void;
}

/** Observe raw errors without replacing the native owner's handler or lifecycle authority. */
export function forwardRendererEvents(native: Renderer, callbacks: RendererCallbacks): () => void {
  let active = true;
  let device: GPUDevice | undefined;
  const error = (event: GPUUncapturedErrorEvent) => {
    if (active)
      callbacks.onError({
        api: 'WebGPU',
        type: event.error.constructor.name,
        message: event.error.message || 'Unknown uncaptured GPU error',
        originalEvent: event,
      });
  };
  const bindDevice = () => {
    const current = native.nativeDevice();
    const next = current.ok ? current.value : undefined;
    if (next === device) return;
    device?.removeEventListener('uncapturederror', error);
    device = next;
    device?.addEventListener('uncapturederror', error);
  };
  bindDevice();
  const remove = native.subscribe((event) => {
    if (event.kind !== 'state-changed') return;
    if (event.current === 'alive') bindDevice();
    if (event.current !== 'device-lost' || device === undefined) return;
    void device.lost.then((info) => {
      if (active)
        callbacks.onDeviceLost({
          api: 'WebGPU',
          reason: info.reason,
          message: info.message,
          originalEvent: info,
        });
    });
  });
  return () => {
    active = false;
    remove();
    device?.removeEventListener('uncapturederror', error);
  };
}

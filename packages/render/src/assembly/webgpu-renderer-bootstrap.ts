import type { RhiCanvasContext, RhiCanvasTarget, RhiDevice } from '@forgeax/engine-rhi';
import {
  HealthListenerRegistry,
  LostListenerRegistry,
  RhiErrorListenerRegistry,
} from '../lifecycle';
import { createOutputColorSpaceState } from '../output-color-space';
import type { RendererOptions } from '../render-contract';
import type { RhiBackendPack } from './backend-contract';
import type { BundlerOptions } from './bundler-contract';
import { deviceOptionsForAdapter } from './device-feature-admission';
import type { RendererAssemblyImplementation } from './host-contract';
import { attachDeviceLostFanout } from './recovery/device-loss-fanout';
import type { WebGPUOutcome, WebGPURendererInternals } from './webgpu-renderer-contract';

export type { WebGPUOutcome, WebGPURendererInternals } from './webgpu-renderer-contract';

export type WebGPURendererFactory = (
  internals: WebGPURendererInternals,
) => Promise<RendererAssemblyImplementation>;

/** Acquire the selected backend and build one renderer generation. */
export async function tryCreateWebGPURenderer(
  canvas: RhiCanvasTarget,
  options: RendererOptions | undefined,
  pack: RhiBackendPack,
  bundler: BundlerOptions | undefined,
  createRenderer: WebGPURendererFactory,
): Promise<WebGPUOutcome> {
  const importTransport = bundler?.importTransport;
  const adapterResult = await pack.rhi.requestAdapter(undefined, canvas);
  if (!adapterResult.ok) return { kind: 'rhi-err', error: adapterResult.error };
  const adapter = adapterResult.value;
  const deviceOpts = deviceOptionsForAdapter(adapter);
  const result = await adapter.requestDevice(deviceOpts);
  if (!result.ok) return { kind: 'rhi-err', error: result.error };
  const device: RhiDevice = result.value;
  const ctxResult = pack.rhi.acquireCanvasContext(canvas);
  if (!ctxResult.ok) return { kind: 'rhi-err', error: ctxResult.error };
  const context: RhiCanvasContext = ctxResult.value;

  const lostRegistry = new LostListenerRegistry();
  const errorRegistry = new RhiErrorListenerRegistry();
  const healthRegistry = new HealthListenerRegistry();
  const lossObserver: WebGPURendererInternals['lossObserver'] = { current: () => {} };
  const generationState: { current: number; onStaleLoss?: () => void } = { current: 0 };
  attachDeviceLostFanout(device, pack, {
    lostRegistry,
    errorRegistry,
    healthRegistry,
    generation: 0,
    currentGeneration: () => (lossObserver.current === null ? undefined : generationState.current),
    onStaleLoss: () => generationState.onStaleLoss?.(),
    onDeviceLost: (detail) => lossObserver.current?.(detail),
  });

  return {
    kind: 'ok',
    renderer: await createRenderer({
      canvas,
      device,
      context,
      options,
      bundler,
      lostRegistry,
      errorRegistry,
      healthRegistry,
      pack,
      importTransport,
      lossObserver,
      outputColorSpace: createOutputColorSpaceState(options?.outputColorSpace ?? 'srgb'),
      generationState,
    }),
  };
}

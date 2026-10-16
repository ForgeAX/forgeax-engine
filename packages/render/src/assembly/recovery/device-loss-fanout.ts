import type { RhiDevice } from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import type {
  HealthListenerRegistry,
  LostListenerRegistry,
  RhiErrorListenerRegistry,
} from '../../lifecycle';
import type { RhiBackendPack } from '../backend-contract';

/** Wire one device's loss promise into the Renderer-owned observability channels. */
export function attachDeviceLostFanout(
  device: RhiDevice,
  pack: RhiBackendPack,
  registries: {
    lostRegistry: LostListenerRegistry;
    errorRegistry: RhiErrorListenerRegistry;
    healthRegistry: HealthListenerRegistry;
    generation: number;
    /** No active generation remains after Renderer disposal. */
    currentGeneration: () => number | undefined;
    onStaleLoss?: () => void;
    onDeviceLost?: (detail: string) => void;
  },
): void {
  const {
    lostRegistry,
    errorRegistry,
    healthRegistry,
    generation,
    currentGeneration,
    onStaleLoss,
    onDeviceLost,
  } = registries;
  if (pack._internal_getRawDevice && pack.translateErrorEventToRhiError) {
    const backendDevice = pack._internal_getRawDevice(device);
    if (backendDevice && typeof backendDevice === 'object') {
      const target = backendDevice as {
        onuncapturederror?: ((event: unknown) => void) | null;
      };
      target.onuncapturederror = (event: unknown): void => {
        if (generation !== currentGeneration()) return;
        const translated = pack.translateErrorEventToRhiError?.(event);
        if (translated && !translated.ok) errorRegistry.fire(translated.error);
      };
    }
  }
  const dispatch = (safe: {
    readonly reason: 'destroyed' | 'unknown';
    readonly message: string;
  }) => {
    const current = currentGeneration();
    if (current === undefined) return;
    if (generation < current) {
      onStaleLoss?.();
      return;
    }
    const detail = `device.lost: ${safe.reason}; ${safe.message || '<empty>'}`;
    // A candidate loss is not an active renderer loss until its generation is
    // published. The candidate callback remains available to the recovery
    // owner, while the public lost/health/error channels stay on the active
    // generation only.
    if (generation > current) {
      onDeviceLost?.(detail);
      return;
    }
    onDeviceLost?.(detail);
    lostRegistry.fire(safe);
    // Native `destroyed` describes this device, not the Renderer lifetime.
    // An active device of either reason needs recovery; candidate and retired
    // generations and the disposed Renderer are isolated above.
    pack.instrumentation?.onDeviceLost?.();
    healthRegistry.fire({
      reason: 'device-lost',
      detail: { lostReason: safe.reason, message: safe.message },
      recoverable: true,
    });
    if (pack.translateErrorEventToRhiError) {
      const translated = pack.translateErrorEventToRhiError(safe);
      errorRegistry.fire(translated.error);
    } else {
      errorRegistry.fire(
        new RhiError({
          code: 'device-lost',
          expected: 'device must remain alive (driver / browser must not destroy the GPUDevice)',
          hint: `device-lost reason: ${safe.reason}; message: ${safe.message || '<empty>'}`,
        }),
      );
    }
  };
  // Deterministic recovery fixtures may project a replacement loss promise
  // without mutating the backend-owned device. Production packs leave this
  // hook unset, so the native RHI promise remains the default source.
  const loss = pack.instrumentation?.deviceLost?.(device) ?? device.lost;
  loss
    .then((info) => {
      const safe = {
        reason: info?.reason ?? 'unknown',
        message: info?.message ?? '',
      };
      dispatch(safe);
    })
    .catch((cause: unknown) => {
      dispatch({ reason: 'unknown', message: String(cause) });
    });
}

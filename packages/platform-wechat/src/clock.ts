import { createPlatformClock, platformError } from '@forgeax/engine-platform';
import { ok } from '@forgeax/engine-types';
import type { WechatHost } from './native.js';

export type WechatClockSource = Pick<WechatHost['wx'], 'getPerformance' | 'getDeviceInfo'>;

/** Both Platform and native WASM use the same qualified unit and monotonic checks. */
export function createWechatClock(source: WechatClockSource) {
  if (typeof source?.getPerformance !== 'function' || typeof source?.getDeviceInfo !== 'function') {
    return platformError('platform-unavailable', { operation: 'wx.getPerformance/getDeviceInfo' });
  }
  try {
    const native = source.getPerformance();
    // Device API uses microseconds; the qualified DevTools runtime uses milliseconds.
    const unit = source.getDeviceInfo().platform === 'devtools' ? 'milliseconds' : 'microseconds';
    const clock = createPlatformClock(() => native.now(), unit);
    const initial = clock.now();
    return initial.ok ? ok(clock) : initial;
  } catch (cause) {
    return platformError('platform-operation-failed', { operation: 'clock.initialize', cause });
  }
}

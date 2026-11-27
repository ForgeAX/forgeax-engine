/// <reference lib="dom" />
import {
  type AudioBackend,
  createWebAudioBackend,
  WebAudioEngine,
} from '@forgeax/engine-audio-webaudio';
import {
  type Platform,
  type PlatformError,
  platformError,
  releasePlatformResources,
} from '@forgeax/engine-platform';
import { AUDIO_ERROR_HINTS, AudioError, err, ok, type Result } from '@forgeax/engine-types';

/** The context is admitted against the Web Audio owner's consumed native surface. */
export interface WechatAudioSource {
  createWebAudioContext?(): unknown;
  onTouchStart?(listener: () => void): void;
  offTouchStart?(listener: () => void): void;
  onAudioInterruptionBegin?(listener: () => void): void;
  offAudioInterruptionBegin?(listener: () => void): void;
  onAudioInterruptionEnd?(listener: () => void): void;
  offAudioInterruptionEnd?(listener: () => void): void;
}

export interface WechatAudioOptions {
  /** Native lifecycle and cleanup failures preserve their original cause here. */
  readonly onError: (error: PlatformError) => void;
}

function validateNativeAudioContext(native: AudioContext): void {
  for (const name of [
    'decodeAudioData',
    'createGain',
    'createBufferSource',
    'createPanner',
    'createAnalyser',
    'createBuffer',
    'createBiquadFilter',
    'resume',
    'suspend',
    'close',
  ] as const)
    if (typeof native[name] !== 'function')
      throw new TypeError(`native WebAudioContext.${name} is unavailable`);
  if (
    !['running', 'suspended'].includes(native.state) ||
    !Number.isFinite(native.currentTime) ||
    native.currentTime < 0 ||
    !Number.isFinite(native.sampleRate) ||
    !(native.sampleRate > 0)
  )
    throw new TypeError('native WebAudioContext is not live');
  for (const name of [
    'positionX',
    'positionY',
    'positionZ',
    'forwardX',
    'forwardY',
    'forwardZ',
    'upX',
    'upY',
    'upZ',
  ] as const)
    if (typeof native.listener?.[name]?.value !== 'number')
      throw new TypeError(`native AudioListener.${name} needs AudioParam support`);
}

/** Lazy native Context and scoped lifecycle; all decoding, nodes and buses retain WebAudio ownership. */
export function createWechatAudioBackend(
  source: WechatAudioSource,
  platform: Platform,
  options: WechatAudioOptions,
): AudioBackend {
  let context: AudioContext | undefined;
  let disposed = false;
  let interrupted = false;
  let wanted: 'running' | 'suspended' = 'running';
  let changing = false;
  const releases: (() => void)[] = [];
  const notify = (operation: string, cause: unknown) => {
    try {
      options.onError(platformError('platform-operation-failed', { operation, cause }).error);
    } catch {
      // Diagnostics do not interrupt native audio lifecycle or rollback.
    }
  };
  const report = (operation: string, cause: unknown) => {
    if (!disposed)
      engine.reportError(
        new AudioError({
          code: 'context-suspended',
          expected: 'the owned native audio Context to complete its lifecycle transition',
          hint: AUDIO_ERROR_HINTS['context-suspended'],
          detail: { code: 'context-suspended' },
        }),
      );
    notify(operation, cause);
  };
  const close = (native: AudioContext) => {
    try {
      void Promise.resolve(native.close()).catch((cause) => report('WebAudioContext.close', cause));
    } catch (cause) {
      report('WebAudioContext.close', cause);
    }
  };
  const reconcile = () => {
    if (disposed || !context || changing) return;
    const native = context;
    const target = wanted;
    const operation = target === 'running' ? 'resume' : 'suspend';
    try {
      if (native.state === target) return;
      changing = true;
      void Promise.resolve(native[operation]()).then(
        () => finish(),
        (cause) => {
          try {
            if (!disposed && context === native) report(`WebAudioContext.${operation}`, cause);
          } finally {
            finish();
          }
        },
      );
    } catch (cause) {
      changing = false;
      report(`WebAudioContext.${operation}`, cause);
    }
    function finish() {
      changing = false;
      // A completed old resume cannot leave a hidden/interrupted game running.
      if (!disposed && context === native && wanted !== target) reconcile();
    }
  };
  const update = () => {
    wanted = platform.visible() && !interrupted ? 'running' : 'suspended';
    reconcile();
  };
  const touch = () => {
    if (platform.visible() && !interrupted) update();
  };
  const begin = () => {
    interrupted = true;
    update();
  };
  const end = () => {
    interrupted = false;
    update();
  };

  const acquire = (): Result<AudioContext, AudioError> => {
    let native: AudioContext | undefined;
    try {
      for (const name of ['createWebAudioContext', 'onTouchStart', 'offTouchStart'] as const)
        if (typeof source[name] !== 'function')
          throw platformError('platform-unavailable', { operation: `wx.${name}` }).error;
      const interruption = [
        'onAudioInterruptionBegin',
        'offAudioInterruptionBegin',
        'onAudioInterruptionEnd',
        'offAudioInterruptionEnd',
      ] as const;
      if (interruption.some((name) => source[name] !== undefined))
        for (const name of interruption)
          if (typeof source[name] !== 'function')
            throw platformError('platform-unavailable', { operation: `wx.${name}` }).error;
      const candidate = source.createWebAudioContext?.();
      if (!candidate || typeof candidate !== 'object')
        throw new TypeError('wx.createWebAudioContext returned no Context');
      native = candidate as AudioContext;
      validateNativeAudioContext(native);
      context = native;
      const lease = platform
        .subscribe((event) => {
          if (event.kind === 'visibility') update();
        })
        .unwrap();
      releases.push(lease);
      releases.push(() => source.offTouchStart?.(touch));
      source.onTouchStart?.(touch);
      if (source.onAudioInterruptionBegin) {
        releases.push(() => source.offAudioInterruptionBegin?.(begin));
        source.onAudioInterruptionBegin(begin);
        releases.push(() => source.offAudioInterruptionEnd?.(end));
        source.onAudioInterruptionEnd?.(end);
      }
      // A suspended native context waits for a real gesture. Hidden startup stays silent.
      if (!platform.visible()) update();
      return ok(native);
    } catch (cause) {
      context = undefined;
      try {
        releasePlatformResources(releases.splice(0).reverse());
      } catch (cleanup) {
        notify('native audio startup cleanup', cleanup);
      }
      if (native && typeof native.close === 'function') close(native);
      notify('wx.createWebAudioContext', cause);
      return err(
        new AudioError({
          code: 'context-creation-failed',
          expected: 'a native Context satisfying the Web Audio backend contract',
          hint: AUDIO_ERROR_HINTS['context-creation-failed'],
          detail: {
            code: 'context-creation-failed',
            reason: cause instanceof Error ? cause.message : String(cause),
          },
        }),
      );
    }
  };
  const engine = new WebAudioEngine({ context: acquire });
  const backend = createWebAudioBackend(engine);
  return {
    ...backend,
    destroy() {
      if (disposed) return;
      disposed = true;
      const native = context;
      context = undefined;
      releasePlatformResources([
        () => backend.destroy(),
        ...releases.splice(0).reverse(),
        () => {
          if (native) close(native);
        },
      ]);
    },
  };
}

/** Project-owned startup presentation, serialized by the build root. */
import { Script } from 'node:vm';
import type { LoadProgressView } from '@forgeax/engine-types';
import type { JSHandle } from 'playwright';

/** Inline source is available before Engine modules or Pack assets load. */
export interface StartupUiTemplate {
  /** Body fragment inside the Host-owned full-screen root. Use inline/data-URI assets. */
  readonly html: string;
  /** CSS appended after default styles; scope selectors to the supplied root. */
  readonly css?: string;
  /** Classic JavaScript body receiving `screen: StartupUiScreen`; may return cleanup. */
  readonly script?: string;
}

export interface StartupUiOptions {
  readonly loading?: 'default' | 'none' | StartupUiTemplate;
  readonly failure?: 'default' | 'none' | StartupUiTemplate;
}

export interface StartupUiState {
  readonly phase:
    | 'loading'
    | 'preparing'
    | 'fading'
    | 'entered'
    | 'failed'
    | 'disabled'
    | 'destroyed';
  readonly progress: LoadProgressView;
  readonly slow: boolean;
  readonly message: string;
  readonly diagnostics: string;
  readonly recovery: 'idle' | 'retrying' | 'exhausted' | 'failed';
  readonly copyStatus: 'idle' | 'copied' | 'failed';
}

/** Presentation observes readiness; only the Host can admit game input. */
export interface StartupUiScreen {
  readonly kind: 'loading' | 'failure';
  readonly root: HTMLElement;
  readonly document: Document;
  /** Immediately receives the current snapshot; returns an unsubscribe function. */
  subscribe(listener: (state: StartupUiState) => void): () => void;
  reload(): void;
  copyDiagnostics(): Promise<boolean>;
}

/** Reject malformed source during project preparation, before publishing a host. */
export function validateStartupUi(value: unknown): asserts value is StartupUiOptions | undefined {
  if (value === undefined) return;
  const record = (input: unknown): input is Record<string, unknown> =>
    typeof input === 'object' && input !== null && !Array.isArray(input);
  if (!record(value) || Object.keys(value).some((key) => key !== 'loading' && key !== 'failure'))
    throw new TypeError('devkitAppOptions.startupUi must contain only loading and failure');
  for (const [kind, template] of Object.entries(value)) {
    if (template === 'default' || template === 'none') continue;
    if (
      !record(template) ||
      typeof template.html !== 'string' ||
      Object.entries(template).some(
        ([key, field]) => !['html', 'css', 'script'].includes(key) || typeof field !== 'string',
      )
    )
      throw new TypeError(
        `devkitAppOptions.startupUi.${kind} must be default, none, or an html/css/script template`,
      );
    if (/<script[\s>]/i.test(template.html))
      throw new TypeError(`startupUi.${kind}: place JavaScript in script, not HTML script tags`);
    if (typeof template.script === 'string')
      new Script(`(function(screen) {\n${template.script}\n})`, {
        filename: `startupUi.${kind}.script`,
      });
  }
}

/** Serialized by Playwright into the page or frame. */
export function observeBrowserStartup(
  target:
    | 'canvas'
    | 'frame'
    | 'input'
    | '__forgeaxToolHost'
    | '__forgeaxToolReplayHost'
    | { readonly afterFrameId: number }
    | { readonly checkpoint: string },
): boolean | string {
  function startupFailure(): boolean | string {
    const startup = (
      Reflect.get(globalThis, '__forgeaxStartup') as { inspect?(): StartupUiState } | undefined
    )?.inspect?.();
    const readinessOnly = target === 'canvas' || typeof target === 'object';
    const limit = target === 'input' ? 2_000 : 16_384;
    if (startup !== undefined) {
      if (startup.phase !== 'failed' || startup.recovery === 'retrying') return false;
      return (
        readinessOnly ||
        (startup.diagnostics || startup.message || 'Engine startup failed').slice(0, limit)
      );
    }
    const fatal = document.querySelector('#forgeax-fatal');
    if (!fatal?.checkVisibility()) return false;
    return (
      readinessOnly ||
      (
        document.querySelector('#forgeax-fatal-details')?.textContent?.trim() ||
        fatal.textContent?.trim() ||
        'Engine startup failed'
      ).slice(0, limit)
    );
  }
  const failure = startupFailure();
  if (failure) return failure;
  if (target === 'input') return document.documentElement.dataset.forgeaxInput === 'open';
  if (typeof target === 'object' && 'checkpoint' in target)
    return document.documentElement.dataset.forgeaxCaptureReady === target.checkpoint;
  if (target === 'canvas' || target === 'frame' || typeof target === 'object') {
    const canvas = document.querySelector('canvas');
    if (target === 'canvas')
      return canvas instanceof HTMLCanvasElement && canvas.width > 0 && canvas.height > 0;
    const frameId = canvas?.forgeaxFrameProgress?.submitted?.frameId;
    if (target === 'frame') return (frameId ?? 0) > 0;
    return frameId !== undefined && Number.isSafeInteger(frameId) && frameId > target.afterFrameId;
  }
  return (globalThis as unknown as Record<string, { ready?: boolean }>)[target]?.ready === true;
}

/** Bind the diagnostic observation to the same document that satisfied its predicate. */
export async function readStartupObservation(observation: JSHandle<unknown>): Promise<unknown> {
  try {
    return await observation.jsonValue();
  } finally {
    await observation.dispose();
  }
}

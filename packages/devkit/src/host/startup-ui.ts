/** Project-owned startup presentation, serialized by the build root. */
import { Script } from 'node:vm';
import type { LoadProgressView } from '@forgeax/engine-types';

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

import type { UiBrowserExtension } from './browser-extensions.js';
import type { UiResult } from './errors.js';
import type { UiLocalization } from './localization/resources.js';
import type { UiResource } from './resources.js';

export interface UiAsset {
  readonly guid: string;
  readonly html: string;
  readonly css: string;
  /** Explicit non-portable CSS requirements, checked against the receiving document. */
  readonly browserExtensions?: readonly UiBrowserExtension[];
  /** Author file relative to its companion directory; never a host filesystem path. */
  readonly sourcePath?: string;
  /** Verified bytes or admitted stream URLs from this asset's immutable publication. */
  readonly resources?: Readonly<Record<string, UiResource>>;
  readonly localization?: UiLocalization;
  readonly actions?: Readonly<Record<string, string>>;
}

export interface UiInstance {
  readonly host: HTMLElement;
  readonly signal: AbortSignal;
  resourceUrl(reference: string): UiResult<string>;
  dispose(): void;
}

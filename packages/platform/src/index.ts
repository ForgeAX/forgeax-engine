import type { Result } from '@forgeax/engine-types';

export { createPlatformClock } from './clock.js';
export type { PlatformError, PlatformErrorCode } from './errors.js';
export { platformError } from './errors.js';
export { releasePlatformResources } from './release.js';

import type { PlatformError } from './errors.js';

export interface DisplayRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DisplayFacts {
  /** Window and safe-area coordinates are logical pixels. */
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
  readonly safeArea: DisplayRect;
  /** Actual drawing-buffer dimensions, independently of logical window size. */
  readonly drawingWidth: number;
  readonly drawingHeight: number;
}

export type PlatformEvent =
  | { readonly kind: 'visibility'; readonly visible: boolean }
  | { readonly kind: 'display'; readonly display: DisplayFacts }
  | { readonly kind: 'memory-pressure'; readonly level: 'moderate' | 'critical' | 'unknown' }
  | { readonly kind: 'surface-lost'; readonly cause: unknown };

/** Idempotent release; native failures throw PlatformError with all cleanup causes. */
export type PlatformRelease = () => void;

export interface PlatformClock {
  /** Finite monotonic milliseconds in this realm's native time origin. */
  now(): Result<number, PlatformError>;
}

/** Host facts and native callbacks; App owns frame policy and World owns game time. */
export interface Platform extends PlatformClock {
  /** One future host callback. Its execution does not prove GPU completion. */
  requestFrame(callback: () => void): Result<PlatformRelease, PlatformError>;
  display(): Result<DisplayFacts, PlatformError>;
  visible(): boolean;
  subscribe(listener: (event: PlatformEvent) => void): Result<PlatformRelease, PlatformError>;
  /** Release this platform's native listeners and pending callbacks. */
  dispose(): void;
}

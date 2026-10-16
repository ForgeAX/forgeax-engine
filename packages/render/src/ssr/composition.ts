import { err, ok, type Result } from '@forgeax/engine-types';

/** Linear HDR RGB used by the M0 composition contract. */
export type SsrReflectionColor = readonly [number, number, number];

export interface SsrCompositionInput {
  /** Screen-hit confidence. The parent SSR consumer supplies 0..1. */
  readonly c: number;
  /** The Standard BRDF specular lobe before SSR replacement. */
  readonly baseSpecular: SsrReflectionColor;
  /** The same-source BRDF-projected screen contribution. */
  readonly screenSpecular: SsrReflectionColor;
  /** The committed producer-owned environment contribution. */
  readonly fallbackSpecular: SsrReflectionColor;
}

export interface SsrCompositionInputError {
  readonly code: 'ssr-composition-input-invalid';
  readonly expected: string;
  readonly hint: string;
  readonly detail: Readonly<{
    readonly field: 'c' | 'baseSpecular' | 'screenSpecular' | 'fallbackSpecular';
  }>;
}

export type SsrCompositionResult = Result<SsrReflectionColor, SsrCompositionInputError>;

function finiteColor(value: SsrReflectionColor): boolean {
  return value.length === 3 && value.every(Number.isFinite);
}

function invalid(
  field: SsrCompositionInputError['detail']['field'],
  expected: string,
): SsrCompositionResult {
  return err({
    code: 'ssr-composition-input-invalid',
    expected,
    hint: 'preserve linear HDR and the bounded SSR confidence before composing',
    detail: Object.freeze({ field }),
  });
}

/**
 * Apply the M0 reflection replacement contract without owning an SSR pass.
 *
 * `c=0` returns the base Standard specular lobe. `c=1` replaces only that
 * lobe with the same-source screen contribution, subtracting the committed
 * environment contribution once. Depth-pyramid traversal, history and graph wiring
 * remain owned by the parent SSR feature.
 */
export function composeSsrReflection(input: SsrCompositionInput): SsrCompositionResult {
  if (!Number.isFinite(input.c) || input.c < 0 || input.c > 1) {
    return invalid('c', 'a finite confidence in the inclusive range 0..1');
  }
  for (const [field, value] of [
    ['baseSpecular', input.baseSpecular],
    ['screenSpecular', input.screenSpecular],
    ['fallbackSpecular', input.fallbackSpecular],
  ] as const) {
    if (!finiteColor(value)) {
      return invalid(field, 'three finite linear HDR RGB channels');
    }
  }
  const c = input.c;
  return ok(
    Object.freeze([
      input.baseSpecular[0] + c * (input.screenSpecular[0] - input.fallbackSpecular[0]),
      input.baseSpecular[1] + c * (input.screenSpecular[1] - input.fallbackSpecular[1]),
      input.baseSpecular[2] + c * (input.screenSpecular[2] - input.fallbackSpecular[2]),
    ]) as SsrReflectionColor,
  );
}

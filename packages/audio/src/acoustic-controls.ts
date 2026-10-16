import { AudioError, err, ok, type Result } from '@forgeax/engine-types';

/** An automatic layer over the latest explicit source bus. */
export interface AcousticRoutes {
  readonly fallback: number;
  readonly buses: readonly { readonly bus: string; readonly gain: number }[];
}

/** Blend an absolute parameter target with its latest explicit value. */
export interface AcousticParameter {
  readonly weight: number;
  readonly value: number;
}

export interface AcousticEnvironment {
  readonly bus: string;
  readonly wet?: AcousticParameter;
  readonly sends: readonly { readonly target: string; readonly gain: AcousticParameter }[];
}

export function acousticFailure(reason: string): Result<never, AudioError> {
  return err(
    new AudioError({
      code: 'control-failed',
      expected: 'bounded valid acoustic regions and accepted bus/send references',
      hint: 'repair the saved region shape/transform, use finite native-range gains, reduce capacity, or configure the referenced bus/send before activation',
      detail: { code: 'control-failed', reason },
    }),
  );
}

export function validateAcousticRoutes(routes: AcousticRoutes): Result<void, AudioError> {
  if (
    !Number.isFinite(routes.fallback) ||
    routes.fallback < 0 ||
    routes.fallback > 1 ||
    routes.buses.length > 64 ||
    new Set(routes.buses.map((r) => r.bus)).size !== routes.buses.length ||
    routes.buses.some(
      (r) => !r.bus || r.bus.length > 128 || !Number.isFinite(r.gain) || r.gain < 0,
    ) ||
    Math.abs(routes.fallback + routes.buses.reduce((sum, r) => sum + r.gain, 0) - 1) > 2e-5
  )
    return acousticFailure('route weights must be unique, finite, non-negative and sum to one');
  return ok(undefined);
}

export function validateAcousticEnvironment(
  environment: readonly AcousticEnvironment[],
): Result<void, AudioError> {
  const valid = (p: AcousticParameter, wet: boolean) =>
    Number.isFinite(p.weight) &&
    p.weight >= 0 &&
    p.weight <= 1 + 2e-5 &&
    Number.isFinite(p.value) &&
    Number.isFinite(Math.fround(p.value)) &&
    p.value >= 0 &&
    (!wet || p.value <= 1);
  if (
    environment.length > 64 ||
    new Set(environment.map((e) => e.bus)).size !== environment.length ||
    environment.some(
      (e) =>
        !e.bus ||
        e.bus.length > 128 ||
        (e.wet && !valid(e.wet, true)) ||
        e.sends.length > 32 ||
        new Set(e.sends.map((s) => s.target)).size !== e.sends.length ||
        e.sends.some((s) => !s.target || s.target.length > 128 || !valid(s.gain, false)),
    )
  )
    return acousticFailure('invalid listener wet/send weights, native float range or capacity');
  return ok(undefined);
}

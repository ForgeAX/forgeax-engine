import { vec3 } from '@forgeax/engine-math';
import { spotBinningSphere } from '../../cluster-binner';
import type { LightRoster, LightSnapshot } from '../../render-system-extract';
import type { StandardLocalLightInput } from './light-frame';
import type { projectLightSlotWork } from './slot-work';

type LocalLightSources = Pick<LightRoster, 'point' | 'spot' | 'rect' | 'additionalDirectional'>;

export interface LocalLightPublication {
  readonly sources: LocalLightSources;
  readonly work: ReturnType<typeof projectLightSlotWork>;
}

export function sameLocalLightSources(left: LocalLightSources, right: LocalLightSources): boolean {
  return (
    left.point === right.point &&
    left.spot === right.spot &&
    left.rect === right.rect &&
    (left.additionalDirectional === right.additionalDirectional ||
      ((left.additionalDirectional?.length ?? 0) === 0 &&
        (right.additionalDirectional?.length ?? 0) === 0))
  );
}

/**
 * An `invRangeSquared` whose range window is zero at every receiver: the
 * punctual evaluators floor `d^2` at 1e-4, so `x = 1e-4 * 1e5 = 10` and the
 * window `clamp(1 - x * x, 0, 1)` is exactly 0 with f32 margin. `range = 0`
 * extracts as 1e8 (`computeInvRangeSquared`), well past it.
 */
const PUNCTUAL_NO_REACH_INV_RANGE_SQUARED = 1e5;

/**
 * Whether a local light contributes exactly zero radiance this frame, so it can
 * stay out of Cluster membership. The extract pre-multiplies `color` by
 * intensity, and every surface / volume evaluator is linear in that product;
 * a punctual light whose range is zero (`range = 0` extracts as 1e8) has a
 * zero range window everywhere. NaN inputs are kept so degenerate lights keep
 * their existing behaviour. The light keeps its slot, so light counts, slot
 * indices and the published shader variant never change when it toggles.
 */
export function standardLocalLightEmitsNothing(
  kind: StandardLocalLightInput['kind'],
  source: { readonly color: ArrayLike<number>; readonly invRangeSquared?: number },
): boolean {
  const color = source.color;
  if (color[0] === 0 && color[1] === 0 && color[2] === 0) return true;
  return (
    (kind === 'point' || kind === 'spot') &&
    source.invRangeSquared !== undefined &&
    source.invRangeSquared >= PUNCTUAL_NO_REACH_INV_RANGE_SQUARED
  );
}

/** A dark light keeps its slot but bins nowhere (`bin` culls `range <= 0`). */
function binningRange(
  kind: StandardLocalLightInput['kind'],
  source: { readonly color: ArrayLike<number>; readonly invRangeSquared?: number },
  range: number,
): number {
  return standardLocalLightEmitsNothing(kind, source) ? 0 : range;
}

const ORIGIN = vec3.create(0, 0, 0);

function finiteRange(invRangeSquared: number): number {
  return Number.isFinite(invRangeSquared) && invRangeSquared > 0
    ? Math.sqrt(1 / invRangeSquared)
    : Number.POSITIVE_INFINITY;
}

/** World-space projection of one accepted light version, shared by all cameras. */
export function projectLocalLight(source: LightSnapshot): StandardLocalLightInput {
  switch (source.kind) {
    case 'point':
      return {
        kind: 'point',
        shadowed: source.shadowAtlasLayer !== undefined && source.shadowAtlasLayer >= 0,
        position: source.position,
        range: binningRange('point', source, finiteRange(source.invRangeSquared)),
        source,
      };
    case 'spot': {
      const range = finiteRange(source.invRangeSquared);
      const center = vec3.create();
      const radius = spotBinningSphere(
        source.position,
        source.direction,
        source.cosOuter,
        range,
        center,
      );
      return {
        kind: 'spot',
        shadowed:
          source.castShadow && source.shadowAtlasTile >= 0 && source.lightViewProj !== undefined,
        position: center,
        range: binningRange('spot', source, radius),
        cone: {
          apex: source.position,
          direction: source.direction,
          cosOuter: source.cosOuter,
          range,
        },
        source,
      };
    }
    case 'rect-area':
      return {
        kind: 'rect-area',
        shadowed: false,
        position: source.position,
        rectNormal: vec3.cross(vec3.create(), source.axisX, source.axisY),
        range: binningRange('rect-area', source, finiteRange(source.invRangeSquared)),
        source,
      };
    case 'directional':
      return {
        kind: 'directional',
        shadowed: false,
        position: ORIGIN,
        range: binningRange('directional', source, Number.POSITIVE_INFINITY),
        source,
      };
  }
}

/** Hand-driven and capped rosters keep their independently admitted order. */
export function createStandardLocalLights(lights: LocalLightSources): StandardLocalLightInput[] {
  const local: StandardLocalLightInput[] = [];
  for (const source of lights.point) local.push(projectLocalLight(source));
  for (const source of lights.spot) local.push(projectLocalLight(source));
  for (const source of lights.rect) local.push(projectLocalLight(source));
  if (lights.additionalDirectional !== undefined)
    for (const source of lights.additionalDirectional) local.push(projectLocalLight(source));
  return local;
}

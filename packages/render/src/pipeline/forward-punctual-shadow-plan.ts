import { mat4 } from '@forgeax/engine-math';
import { prepareForwardShadowVisibility } from './forward-shadow-projection-bounds';
import type { StandardLocalLightInput } from './standard-lighting/light-frame';
import type { PreparedStandardLighting } from './standard-lighting/prepare';

export interface ForwardProjectedLight {
  readonly slot: number;
  readonly entity?: number;
  readonly kind: 'point' | 'spot';
  readonly channel: number;
  readonly fade?: number;
}

type PunctualShadowPlan =
  | {
      readonly kind: 'projected';
      readonly lights: readonly ForwardProjectedLight[];
      readonly channels: Uint8Array;
      readonly channelCount: number;
      readonly point: boolean;
      readonly spot: boolean;
    }
  | { readonly kind: 'raw'; readonly reason: 'channel-overflow' | 'shadow-family' };

interface ScopedLight {
  readonly slot: number;
  readonly source: Extract<
    NonNullable<StandardLocalLightInput['source']>,
    { kind: 'point' | 'spot' }
  >;
  readonly radius: number;
  readonly fade: number;
}

interface ForwardProjectionView {
  readonly width: number;
  readonly height: number;
  readonly viewFade?: true;
  readonly ambientOcclusion?: true;
}

const plans = new WeakMap<
  PreparedStandardLighting,
  {
    key: string;
    plan: PunctualShadowPlan;
  }
>();

/** Graph admission, recording and Cluster upload share the same per-View roster. */
export function forwardPunctualShadowPlan(
  prepared: PreparedStandardLighting,
  directional: boolean,
  view: ForwardProjectionView,
): PunctualShadowPlan {
  const key = `${directional}:${view.width}:${view.height}:${view.viewFade === true}:${view.ambientOcclusion === true}`;
  const cached = plans.get(prepared);
  if (cached?.key === key) return cached.plan;
  const plan = planPunctualShadows(prepared, directional, view);
  plans.set(prepared, { key, plan });
  return plan;
}

function shadowViewFade(radiusPx: number, kind: 'point' | 'spot'): number {
  const resolution = radiusPx * (kind === 'spot' ? 2.54648 : 1.27324);
  if (resolution <= 32) return 0;
  if (resolution >= 64) return 1;
  const first = (1 / 32) ** 0.25;
  return Math.max(0, (((resolution - 32) / 32) ** 0.25 - first) / (1 - first));
}

function prepareShadowViewFade(
  camera: NonNullable<PreparedStandardLighting['camera']>,
  view: ForwardProjectionView,
) {
  const origin = mat4.invert(mat4.create(), camera.view);
  const screenScale =
    0.5 *
    Math.max(
      view.width * Math.abs(camera.projection[0] ?? 0),
      view.height * Math.abs(camera.projection[5] ?? 0),
    );
  return (light: ScopedLight['source']): number => {
    const range = 1 / Math.sqrt(light.invRangeSquared);
    if (!Number.isFinite(range)) return 1;
    const x = (light.position[0] ?? 0) - (origin[12] ?? 0);
    const y = (light.position[1] ?? 0) - (origin[13] ?? 0);
    const z = (light.position[2] ?? 0) - (origin[14] ?? 0);
    if (light.kind === 'point')
      return shadowViewFade((screenScale * range) / Math.max(1, Math.hypot(x, y, z)), 'point');
    // Match UE's effective cone radius and its approximate sphere center.
    const [dx = 0, dy = 0, dz = 0] = light.direction;
    const alongCone = (range * light.cosOuter) / Math.max(Math.hypot(dx, dy, dz), 1e-6);
    const distance = Math.hypot(x + dx * alongCone, y + dy * alongCone, z + dz * alongCone);
    const radius = range * Math.sqrt(Math.max(0, 1 - light.cosOuter * light.cosOuter));
    return shadowViewFade((screenScale * radius) / Math.max(1, distance), 'spot');
  };
}

function planPunctualShadows(
  prepared: PreparedStandardLighting,
  directional: boolean,
  view: ForwardProjectionView,
): PunctualShadowPlan {
  const { camera, local } = prepared;
  const visible =
    camera === undefined
      ? undefined
      : prepareForwardShadowVisibility(camera.view, camera.projection);
  const fadeFor =
    view.viewFade && camera !== undefined ? prepareShadowViewFade(camera, view) : undefined;
  const candidates = collectVisibleShadows(local, visible, view, fadeFor);
  if (!Array.isArray(candidates)) return candidates;
  candidates.sort(
    (a, b) =>
      Number(a.source.entity ?? a.slot) - Number(b.source.entity ?? b.slot) || a.slot - b.slot,
  );
  // The primary directional shadow owns R. Active AO reserves A.
  const channelCount = 4 - Number(directional) - Number(view.ambientOcclusion === true);
  const buckets: ScopedLight[][] = Array.from({ length: channelCount }, () => []);
  const channels = new Uint8Array(candidates.length === 0 ? 0 : local.length);
  const lights: ForwardProjectedLight[] = [];
  for (const candidate of candidates) {
    const index = buckets.findIndex((bucket) =>
      bucket.every((other) => disjointPunctualRanges(candidate, other)),
    );
    const bucket = buckets[index];
    if (bucket === undefined) return { kind: 'raw', reason: 'channel-overflow' };
    bucket.push(candidate);
    const channel = index + (directional ? 1 : 0);
    channels[candidate.slot] = channel + 1;
    lights.push({
      slot: candidate.slot,
      ...(candidate.source.entity === undefined ? {} : { entity: Number(candidate.source.entity) }),
      kind: candidate.source.kind,
      channel,
      ...(candidate.fade === 1 ? {} : { fade: candidate.fade }),
    });
  }
  return {
    kind: 'projected',
    lights,
    channels,
    channelCount: buckets.filter((bucket) => bucket.length !== 0).length,
    point: lights.some(({ kind }) => kind === 'point'),
    spot: lights.some(({ kind }) => kind === 'spot'),
  };
}

function collectVisibleShadows(
  local: readonly StandardLocalLightInput[],
  visible: ReturnType<typeof prepareForwardShadowVisibility> | undefined,
  view: ForwardProjectionView,
  fadeFor: ReturnType<typeof prepareShadowViewFade> | undefined,
): ScopedLight[] | Extract<PunctualShadowPlan, { kind: 'raw' }> {
  const candidates: ScopedLight[] = [];
  for (const [slot, row] of local.entries()) {
    if (!row.shadowed) continue;
    const source = row.source;
    if (source?.kind !== 'point' && source?.kind !== 'spot')
      return { kind: 'raw', reason: 'shadow-family' };
    const amount = source.shadowIntensity ?? 1;
    if (amount <= 0) continue;
    if (visible !== undefined && visible(source, view.width, view.height) === undefined) continue;
    const fade = fadeFor?.(source) ?? 1;
    if (fadeFor !== undefined && fade * amount <= 1 / 256) continue;
    // Match the f32 radius of the attenuation window. Pad its outer edge for
    // quantization in the GPU position, distance, and reciprocal calculations.
    const inverseRangeSquared = Math.fround(source.invRangeSquared);
    const radius =
      inverseRangeSquared > 0 && Number.isFinite(inverseRangeSquared)
        ? Math.sqrt(1 / inverseRangeSquared) * 1.0001
        : Infinity;
    candidates.push({ slot, source, radius, fade });
  }
  return candidates;
}

function disjointPunctualRanges(a: ScopedLight, b: ScopedLight): boolean {
  const p = a.source.position;
  const q = b.source.position;
  const distance = Math.hypot(
    Math.fround(p[0] ?? NaN) - Math.fround(q[0] ?? NaN),
    Math.fround(p[1] ?? NaN) - Math.fround(q[1] ?? NaN),
    Math.fround(p[2] ?? NaN) - Math.fround(q[2] ?? NaN),
  );
  return distance > a.radius + b.radius;
}

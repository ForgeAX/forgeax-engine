import { err, ok, type Result } from '@forgeax/engine-types';

/**
 * Diagnostic GPU-cost ablation: removes one kind of render work so a paired
 * A/B run attributes frame time to it. It changes pixels and is never a
 * quality setting. Off by default; when unset every hook is one `undefined`
 * check. The state is realm-wide (every Renderer in this JS realm), set before
 * the first frame through `createApp({ renderAblation })` or toggled later
 * from devtools through `globalThis.__forgeaxRenderAblation`.
 */
export interface RenderAblation {
  /** false: shadow passes still clear their layers but encode no casters. */
  readonly shadowRaster?: boolean;
  /** false: receivers ignore point and spot shadow maps (rasters still run). */
  readonly shadowSampling?: boolean;
  /** Fraction in [0, 1] of point and spot lights kept, per kind in roster order. */
  readonly punctualLights?: number;
  /** false: no bloom stage. */
  readonly bloom?: boolean;
  /** false: no FXAA stage. */
  readonly fxaa?: boolean;
  /** Drawing-buffer scale in [0.25, 1] applied by the browser canvas sizing. */
  readonly renderScale?: number;
}

export interface RenderAblationInvalidDetail {
  readonly entry: string;
  readonly expected: string;
}

export class RenderAblationInvalidError extends Error {
  readonly code = 'render-ablation-invalid' as const;
  readonly expected: string;
  readonly hint =
    'use comma-separated shadow-raster=0, shadow-sampling=0, lights=<0..1>, bloom=0, fxaa=0, post=0, scale=<0.25..1>';
  readonly detail: RenderAblationInvalidDetail;

  constructor(detail: RenderAblationInvalidDetail) {
    super(`render ablation entry '${detail.entry}' is invalid`);
    this.name = 'RenderAblationInvalidError';
    this.expected = detail.expected;
    this.detail = detail;
  }
}

let active: RenderAblation | undefined;

/** The active ablation, or undefined (the default) when nothing is ablated. */
export function renderAblation(): RenderAblation | undefined {
  return active;
}

function fraction(
  entry: string,
  value: number,
  min: number,
): Result<number, RenderAblationInvalidError> {
  return Number.isFinite(value) && value >= min && value <= 1
    ? ok(value)
    : err(new RenderAblationInvalidError({ entry, expected: `a number in [${min}, 1]` }));
}

/** Validate and install an ablation; undefined or an empty object clears it. */
export function setRenderAblation(
  ablation: RenderAblation | undefined,
): Result<RenderAblation | undefined, RenderAblationInvalidError> {
  if (ablation === undefined) {
    active = undefined;
    return ok(undefined);
  }
  const out: { -readonly [K in keyof RenderAblation]: RenderAblation[K] } = {};
  for (const key of ['shadowRaster', 'shadowSampling', 'bloom', 'fxaa'] as const) {
    const value = ablation[key];
    if (value === undefined || value === true) continue;
    if (value !== false) {
      return err(new RenderAblationInvalidError({ entry: key, expected: 'a boolean' }));
    }
    out[key] = false;
  }
  if (ablation.punctualLights !== undefined && ablation.punctualLights !== 1) {
    const value = fraction('punctualLights', ablation.punctualLights, 0);
    if (!value.ok) return value;
    out.punctualLights = value.value;
  }
  if (ablation.renderScale !== undefined && ablation.renderScale !== 1) {
    const value = fraction('renderScale', ablation.renderScale, 0.25);
    if (!value.ok) return value;
    out.renderScale = value.value;
  }
  active = Object.keys(out).length === 0 ? undefined : Object.freeze(out);
  return ok(active);
}

/**
 * Parse the query form, for example `shadow-raster=0,lights=0.5,scale=0.5`.
 * `post=0` turns off bloom and FXAA. An empty string is no ablation.
 */
export function parseRenderAblation(
  text: string,
): Result<RenderAblation, RenderAblationInvalidError> {
  const out: { -readonly [K in keyof RenderAblation]: RenderAblation[K] } = {};
  for (const raw of text.split(',')) {
    const entry = raw.trim();
    if (entry === '') continue;
    const [name, value = ''] = entry.split('=', 2) as [string, string?];
    const off = value === '0' || value === 'off' || value === 'false';
    const on = value === '1' || value === 'on' || value === 'true';
    const flag = (key: 'shadowRaster' | 'shadowSampling' | 'bloom' | 'fxaa') => {
      if (!off && !on) return false;
      out[key] = on;
      return true;
    };
    let accepted: boolean;
    switch (name) {
      case 'shadow-raster':
        accepted = flag('shadowRaster');
        break;
      case 'shadow-sampling':
        accepted = flag('shadowSampling');
        break;
      case 'bloom':
        accepted = flag('bloom');
        break;
      case 'fxaa':
        accepted = flag('fxaa');
        break;
      case 'post':
        accepted = flag('bloom') && flag('fxaa');
        break;
      case 'lights': {
        const parsed = fraction(entry, value === '' ? Number.NaN : Number(value), 0);
        if (!parsed.ok) return parsed;
        out.punctualLights = parsed.value;
        accepted = true;
        break;
      }
      case 'scale': {
        const parsed = fraction(entry, value === '' ? Number.NaN : Number(value), 0.25);
        if (!parsed.ok) return parsed;
        out.renderScale = parsed.value;
        accepted = true;
        break;
      }
      default:
        accepted = false;
    }
    if (!accepted) {
      return err(new RenderAblationInvalidError({ entry, expected: 'a known ablation entry' }));
    }
  }
  return ok(Object.freeze(out));
}

interface AblatableLocalLight {
  readonly kind: string;
  readonly shadowed: boolean;
  readonly source?: unknown;
}

const unshadowedSources = new WeakMap<object, object>();

/** The same light record without a shadow map; cached so slot uploads stay steady. */
function withoutShadow(source: object): object {
  let copy = unshadowedSources.get(source);
  if (copy === undefined) {
    copy = Object.freeze({ ...source, shadowAtlasLayer: -1, shadowAtlasTile: -1 });
    unshadowedSources.set(source, copy);
  }
  return copy;
}

/**
 * Apply `punctualLights` and `shadowSampling` to the Standard local-light
 * corpus. Returns the input unchanged when neither is ablated.
 */
export function ablateLocalLights<T extends AblatableLocalLight>(
  local: T[],
  ablation: RenderAblation | undefined = active,
): T[] {
  if (ablation === undefined) return local;
  const keep = ablation.punctualLights;
  const sampling = ablation.shadowSampling !== false;
  if (keep === undefined && sampling) return local;
  const limit = new Map<string, number>();
  if (keep !== undefined) {
    for (const kind of ['point', 'spot']) {
      const count = local.reduce((total, light) => total + (light.kind === kind ? 1 : 0), 0);
      limit.set(kind, Math.round(count * keep));
    }
  }
  const out: T[] = [];
  for (const light of local) {
    const remaining = limit.get(light.kind);
    if (remaining !== undefined) {
      if (remaining <= 0) continue;
      limit.set(light.kind, remaining - 1);
    }
    const punctual = light.kind === 'point' || light.kind === 'spot';
    if (
      sampling ||
      !punctual ||
      !light.shadowed ||
      typeof light.source !== 'object' ||
      light.source === null
    ) {
      out.push(light);
      continue;
    }
    out.push({ ...light, shadowed: false, source: withoutShadow(light.source) });
  }
  return out;
}

/** Devtools accessor installed by `installRenderAblationDevtools`. */
export interface RenderAblationDevtools {
  get(): RenderAblation | undefined;
  set(
    ablation: RenderAblation | string | undefined,
  ): Result<RenderAblation | undefined, RenderAblationInvalidError>;
}

/** Expose `globalThis.__forgeaxRenderAblation` for devtools toggling. */
export function installRenderAblationDevtools(): RenderAblationDevtools {
  const devtools: RenderAblationDevtools = Object.freeze({
    get: renderAblation,
    set(ablation: RenderAblation | string | undefined) {
      if (typeof ablation !== 'string') return setRenderAblation(ablation);
      const parsed = parseRenderAblation(ablation);
      return parsed.ok ? setRenderAblation(parsed.value) : parsed;
    },
  });
  (globalThis as { __forgeaxRenderAblation?: RenderAblationDevtools }).__forgeaxRenderAblation =
    devtools;
  return devtools;
}

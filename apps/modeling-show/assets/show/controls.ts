import { err, ok, type Result } from '@forgeax/engine/types';

/**
 * Debug panel controls a subject declares (`ShowSubjectSource.controls`). The panel renders a
 * declared control only where it applies to the subject on stage (`applicableControls`), so
 * adding a subject is data. Kinds marked `false` in `SHOW_CONTROL_KINDS` are schema slots
 * without a panel implementation yet; declaring one is rejected.
 */
export type BakeChannel = 'normal' | 'ao' | 'materialId';

export type ShowControl =
  /** Lit, curvature, zebra and facet-edge surface views (`analysis.ts`). */
  | { readonly kind: 'shading' }
  /** Parts move along their offset from the subject centre. */
  | { readonly kind: 'explode' }
  /** Clip plane across the subject bounds along x, y or z. */
  | { readonly kind: 'section' }
  /** Visibility toggle per part. */
  | { readonly kind: 'parts' }
  /** Camera presets and the return to the choreographed camera. */
  | { readonly kind: 'camera' }
  | { readonly kind: 'floor' }
  /** Clean or weathered paint (subjects with `clean` looks). */
  | { readonly kind: 'finish' }
  /** Transformation parameter u of a rigged subject's clip. */
  | { readonly kind: 'mechanism' }
  /**
   * A high-to-low bake case: the high mesh (Pack source key), the low meshes (a source key prefix, one
   * mesh per part), the plain material (Pack source key, constant values with the maps off) and the
   * baked map channels. The panel switches Low/High and Baked/Plain; the channel viewer is not built,
   * so `channels` is accepted and unused.
   */
  | {
      readonly kind: 'bake';
      readonly high: string;
      readonly low: string;
      readonly plain: string;
      readonly channels: readonly BakeChannel[];
    }
  /** LOD level of the subject's meshes (`<key>/lod<n>` Pack outputs). */
  | { readonly kind: 'lod'; readonly levels: number }
  /** UV checker texture on every part. */
  | { readonly kind: 'uv-checker'; readonly scale: number };

export type ShowControlKind = ShowControl['kind'];

/** Every control kind and whether the panel implements it. */
export const SHOW_CONTROL_KINDS = {
  shading: true,
  explode: false,
  section: false,
  parts: true,
  camera: true,
  floor: true,
  finish: true,
  mechanism: false,
  bake: true,
  lod: false,
  'uv-checker': false,
} as const satisfies Record<ShowControlKind, boolean>;

export type ReadyControlKind = {
  [K in ShowControlKind]: (typeof SHOW_CONTROL_KINDS)[K] extends true ? K : never;
}[ShowControlKind];

/** The controls of a subject that declares none: every common control (the panel keeps the applicable ones). */
export const COMMON_CONTROLS: readonly ShowControl[] = [
  { kind: 'camera' },
  { kind: 'floor' },
  { kind: 'finish' },
  { kind: 'shading' },
  { kind: 'parts' },
];

export type ShowControlErrorCode = 'control-unknown' | 'control-not-ready' | 'control-invalid' | 'control-duplicate';

export interface ShowControlError {
  readonly code: ShowControlErrorCode;
  readonly index: number;
  readonly expected: string;
  readonly detail: unknown;
}

const BAKE_CHANNELS: readonly BakeChannel[] = ['normal', 'ao', 'materialId'];

function invalid(index: number, expected: string, detail: unknown): Result<never, ShowControlError> {
  return err({ code: 'control-invalid', index, expected, detail });
}

/** Validates declared controls: known, implemented, well-formed kinds, each at most once. */
export function parseControls(value: unknown): Result<readonly ShowControl[], ShowControlError> {
  if (!Array.isArray(value)) return invalid(-1, 'an array of controls', value);
  const seen = new Set<string>();
  for (const [index, control] of value.entries()) {
    const kind = (control as { kind?: unknown } | null)?.kind;
    if (typeof kind !== 'string' || !Object.hasOwn(SHOW_CONTROL_KINDS, kind))
      return err({ code: 'control-unknown', index, expected: Object.keys(SHOW_CONTROL_KINDS).join(' | '), detail: kind });
    const known = kind as ShowControlKind;
    if (!SHOW_CONTROL_KINDS[known])
      return err({ code: 'control-not-ready', index, expected: 'a control kind the panel implements', detail: kind });
    if (seen.has(known)) return err({ code: 'control-duplicate', index, expected: 'each control kind once', detail: kind });
    seen.add(known);
    const shape = control as Record<string, unknown>;
    switch (known) {
      case 'bake':
        if (
          typeof shape.high !== 'string' ||
          typeof shape.low !== 'string' ||
          typeof shape.plain !== 'string' ||
          !Array.isArray(shape.channels) ||
          !shape.channels.every((c) => BAKE_CHANNELS.includes(c as BakeChannel))
        )
          return invalid(index, `{ high, low, plain, channels: (${BAKE_CHANNELS.join(' | ')})[] }`, control);
        break;
      case 'lod':
        if (!Number.isInteger(shape.levels) || (shape.levels as number) < 1) return invalid(index, '{ levels: integer >= 1 }', control);
        break;
      case 'uv-checker':
        if (typeof shape.scale !== 'number' || !(shape.scale > 0)) return invalid(index, '{ scale: number > 0 }', control);
        break;
      case 'shading':
      case 'explode':
      case 'section':
      case 'parts':
      case 'camera':
      case 'floor':
      case 'finish':
      case 'mechanism':
        break;
    }
  }
  return ok(value as readonly ShowControl[]);
}

/** What the Show knows about a subject on stage that decides where a control applies. */
export interface SubjectFacts {
  readonly parts: number;
  /** Some part has a clean look. */
  readonly clean: boolean;
  /** The subject's scenes carry a transformation clip. */
  readonly mechanism: boolean;
}

export function applicableControls(controls: readonly ShowControl[], facts: SubjectFacts): ShowControl[] {
  return controls.filter((control) => {
    switch (control.kind) {
      case 'explode':
      case 'parts':
        return facts.parts > 1;
      case 'finish':
        return facts.clean;
      case 'mechanism':
        return facts.mechanism;
      case 'shading':
      case 'section':
      case 'camera':
      case 'floor':
      case 'bake':
      case 'lod':
      case 'uv-checker':
        return true;
    }
  });
}

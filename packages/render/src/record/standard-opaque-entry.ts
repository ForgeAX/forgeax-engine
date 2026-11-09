import type { MaterialShaderProgram } from '@forgeax/engine-shader';

/**
 * Forward fragment entry for Standard draws bound to the unfogged View slot.
 *
 * Standard programs (built-in rigid/skin and every cooked Surface composed
 * from those templates) declare `fs_opaque` beside `fs_main`. Both write the
 * same outputs; `fs_main` additionally runs `translucent_fog_transmission`,
 * which is the identity when the bound View slot's `fogHeightOpacity.z` is 0
 * and the surface does not transmit. `fs_opaque` compiles that chain out
 * unless `TRANSMISSION_AVAILABLE`, so the selection below is output-exact.
 *
 * A main-pass draw binds a z = 0 slot exactly when its View offset is the
 * base slot (0) and the pass is not an atmosphere capture (which writes
 * z = 1 into its own base slot); translucent blends bind the per-composition
 * copies at non-zero offsets.
 */
export const STANDARD_OPAQUE_FRAGMENT_ENTRY = 'fs_opaque';

export const STANDARD_FORWARD_SCREEN_FRAGMENT_ENTRY = 'fs_forward_screen';
const declaredByProgram = new WeakMap<MaterialShaderProgram, number>();
function declaresStandardForwardEntry(
  source: string | MaterialShaderProgram | undefined,
  entry: typeof STANDARD_OPAQUE_FRAGMENT_ENTRY | typeof STANDARD_FORWARD_SCREEN_FRAGMENT_ENTRY,
): boolean {
  if (source === undefined) return false;
  if (typeof source === 'string') return source.includes(`fn ${entry}(`);
  if (source.entryPoints !== undefined)
    return source.entryPoints.some((candidate) => candidate.name === entry);
  let mask = declaredByProgram.get(source);
  if (mask === undefined) {
    const text = source.source;
    mask =
      Number(text.includes(`fn ${STANDARD_OPAQUE_FRAGMENT_ENTRY}(`)) |
      (Number(text.includes(`fn ${STANDARD_FORWARD_SCREEN_FRAGMENT_ENTRY}(`)) << 1);
    declaredByProgram.set(source, mask);
  }
  return (mask & (entry === STANDARD_OPAQUE_FRAGMENT_ENTRY ? 1 : 2)) !== 0;
}
/** Whether the program declares the unfogged Forward entry. */
export function declaresStandardOpaqueEntry(
  source: string | MaterialShaderProgram | undefined,
): boolean {
  return declaresStandardForwardEntry(source, STANDARD_OPAQUE_FRAGMENT_ENTRY);
}

/**
 * The entry a program can actually serve: `fs_opaque` falls back to the
 * default forward entry (`undefined`) on programs that do not declare it --
 * sprite, hand-written WGSL, or Surfaces cooked before the entry existed.
 */
export function declaredFragmentEntry(
  fragmentEntry: string | undefined,
  source: string | MaterialShaderProgram | undefined,
): string | undefined {
  return (fragmentEntry === STANDARD_OPAQUE_FRAGMENT_ENTRY ||
    fragmentEntry === STANDARD_FORWARD_SCREEN_FRAGMENT_ENTRY) &&
    !declaresStandardForwardEntry(source, fragmentEntry)
    ? undefined
    : fragmentEntry;
}

/** A screen receiver overrides only the ordinary Standard entry, never authored shading. */
export function selectStandardForwardScreenEntry(
  requested: string | undefined,
  authored: string | undefined,
): string | undefined {
  if (
    requested === STANDARD_FORWARD_SCREEN_FRAGMENT_ENTRY &&
    authored !== undefined &&
    authored !== 'fs_main'
  )
    return authored;
  return requested ?? authored;
}

/** Source of a material program lookup, or `undefined` when it is not registered. */
export function materialProgramSource(
  lookup:
    | {
        readonly ok: true;
        readonly value: { readonly source: string; readonly program?: MaterialShaderProgram };
      }
    | { readonly ok: false },
): string | MaterialShaderProgram | undefined {
  return lookup.ok ? (lookup.value.program ?? lookup.value.source) : undefined;
}

export interface ForwardFragmentEntryInput {
  readonly passKind: string;
  /** The entry resolved from the pass override or the selected material pass. */
  readonly fragmentEntry: string | undefined;
  /** Draw recorded into the weighted-blended OIT accumulation targets. */
  readonly oitAccumulate: boolean;
  /** Dynamic offset of the View slot this draw binds. */
  readonly viewOffset: number;
  /** The pass renders an atmosphere capture (base slot carries z = 1). */
  readonly atmosphereCapture: boolean;
}

/**
 * Select `fs_opaque` for forward draws whose `fs_main` output would pass
 * through translucent fog unchanged; otherwise return the input entry. The
 * pipeline factory keeps the default entry for programs that do not declare
 * `fs_opaque` ({@link declaresStandardOpaqueEntry}).
 */
export function selectForwardFragmentEntry(input: ForwardFragmentEntryInput): string | undefined {
  if (
    input.passKind === 'forward' &&
    (input.fragmentEntry === undefined || input.fragmentEntry === 'fs_main') &&
    !input.oitAccumulate &&
    input.viewOffset === 0 &&
    !input.atmosphereCapture
  ) {
    return STANDARD_OPAQUE_FRAGMENT_ENTRY;
  }
  return input.fragmentEntry;
}

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

const DECLARATION = `fn ${STANDARD_OPAQUE_FRAGMENT_ENTRY}(`;
const declaredBySource = new Map<string, boolean>();

/** `true` when a material program source declares the `fs_opaque` entry. */
export function declaresStandardOpaqueEntry(source: string | undefined): boolean {
  if (source === undefined) return false;
  let declared = declaredBySource.get(source);
  if (declared === undefined) {
    declared = source.includes(DECLARATION);
    // Program sources are few and long-lived; bound the memo anyway.
    if (declaredBySource.size >= 256) declaredBySource.clear();
    declaredBySource.set(source, declared);
  }
  return declared;
}

/**
 * The entry a program can actually serve: `fs_opaque` falls back to the
 * default forward entry (`undefined`) on programs that do not declare it --
 * sprite, hand-written WGSL, or Surfaces cooked before the entry existed.
 */
export function declaredFragmentEntry(
  fragmentEntry: string | undefined,
  source: string | undefined,
): string | undefined {
  return fragmentEntry === STANDARD_OPAQUE_FRAGMENT_ENTRY && !declaresStandardOpaqueEntry(source)
    ? undefined
    : fragmentEntry;
}

/** Source of a material program lookup, or `undefined` when it is not registered. */
export function materialProgramSource(
  lookup:
    | { readonly ok: true; readonly value: { readonly source: string } }
    | { readonly ok: false },
): string | undefined {
  return lookup.ok ? lookup.value.source : undefined;
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

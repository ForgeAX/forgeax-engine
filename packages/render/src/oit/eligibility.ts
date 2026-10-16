import type { MaterialRenderState } from '@forgeax/engine-types';

/**
 * Why a transparent draw under a `weighted-blended` view stays in the sorted
 * `transparent` pass. Closed union; inspection counts draws per member.
 */
export type OitIneligibleReason =
  | 'blend-not-eligible'
  | 'depth-write-enabled'
  | 'program-without-oit-output';

export const OIT_INELIGIBLE_REASONS: readonly OitIneligibleReason[] = Object.freeze([
  'blend-not-eligible',
  'depth-write-enabled',
  'program-without-oit-output',
]);

export type OitDrawEligibility =
  | { readonly eligible: true; readonly premultiplied: boolean }
  | { readonly eligible: false; readonly reason: OitIneligibleReason };

/** The OIT accumulation fragment entries on Standard PBR and Unlit. */
export const OIT_FRAGMENT_ENTRY = 'fs_oit';
export const OIT_PREMULTIPLIED_FRAGMENT_ENTRY = 'fs_oit_premultiplied';

/**
 * Both WBOIT targets (accum rgba16float, weight r16float) share this blend:
 * color accumulates additively, alpha accumulates revealage prod(1 - a).
 */
export const OIT_ACCUMULATE_BLEND: GPUBlendState = Object.freeze({
  color: Object.freeze({ srcFactor: 'one', dstFactor: 'one', operation: 'add' }),
  alpha: Object.freeze({ srcFactor: 'zero', dstFactor: 'one-minus-src-alpha', operation: 'add' }),
}) as GPUBlendState;

const OIT_PROGRAMS: ReadonlySet<string> = new Set([
  'forgeax::default-standard-pbr',
  'forgeax::default-unlit',
]);

function isOverComponent(
  component: GPUBlendComponent | undefined,
  src: GPUBlendFactor,
  dst: GPUBlendFactor,
): boolean {
  return (
    component !== undefined &&
    (component.operation ?? 'add') === 'add' &&
    (component.srcFactor ?? 'one') === src &&
    (component.dstFactor ?? 'zero') === dst
  );
}

/** `true` for premultiplied over, `false` for straight over, `null` otherwise. */
function overBlendKind(blend: GPUBlendState | undefined): boolean | null {
  if (blend === undefined) return null;
  if (isOverComponent(blend.color, 'src-alpha', 'one-minus-src-alpha')) {
    return isOverComponent(blend.alpha, 'src-alpha', 'one-minus-src-alpha') ||
      isOverComponent(blend.alpha, 'one', 'one-minus-src-alpha')
      ? false
      : null;
  }
  if (isOverComponent(blend.color, 'one', 'one-minus-src-alpha')) {
    return isOverComponent(blend.alpha, 'one', 'one-minus-src-alpha') ? true : null;
  }
  return null;
}

/**
 * Classify one transparent draw for weighted blended accumulation.
 *
 * `materialShaderId` is the selected pass program; `skinned` routes to the skin
 * program, which has no OIT output. `fragmentEntry` other than the program's
 * default forward entry is a custom program surface and stays sorted.
 */
export function classifyOitDraw(input: {
  readonly materialShaderId: string | undefined;
  readonly skinned: boolean;
  readonly renderState: MaterialRenderState | undefined;
  readonly fragmentEntry: string | undefined;
}): OitDrawEligibility {
  const program = input.materialShaderId ?? 'forgeax::default-standard-pbr';
  if (
    input.skinned ||
    !OIT_PROGRAMS.has(program) ||
    (input.fragmentEntry !== undefined && input.fragmentEntry !== 'fs_main') ||
    input.renderState?.outputs !== undefined
  ) {
    return { eligible: false, reason: 'program-without-oit-output' };
  }
  const premultiplied = overBlendKind(input.renderState?.blend);
  if (premultiplied === null) return { eligible: false, reason: 'blend-not-eligible' };
  if (input.renderState?.depthWriteEnabled === true) {
    return { eligible: false, reason: 'depth-write-enabled' };
  }
  return { eligible: true, premultiplied };
}

/**
 * The render state an eligible draw records with in `oit-accumulate`. Culling,
 * depth compare, depth bias and stencil stay authored; blend, write mask and
 * alpha-to-coverage are owned by the accumulation contract.
 */
export function oitAccumulateRenderState(
  state: MaterialRenderState | undefined,
): MaterialRenderState {
  const {
    blend: _blend,
    colorWriteMask: _mask,
    alphaToCoverageEnabled: _a2c,
    outputs: _outputs,
    ...rest
  } = state ?? {};
  return { ...rest, blend: OIT_ACCUMULATE_BLEND, depthWriteEnabled: false };
}

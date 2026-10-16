import { color } from '@forgeax/engine-math';

/**
 * Colour space of the final display-encoded output. Both members use the sRGB
 * transfer curve and D65; `display-p3` widens the primaries. The working
 * space stays linear Rec.709 — the Output Transform converts once, after
 * tonemapping.
 */
export type OutputColorSpace = color.RgbColorSpace;

/** Numeric `TonemapParams.outputGamut` values; mirrored by the generated WGSL block. */
export const OUTPUT_GAMUT_CODE: Readonly<Record<OutputColorSpace, number>> = Object.freeze({
  srgb: 0,
  'display-p3': 1,
});

export const OUTPUT_COLOR_SPACES: readonly OutputColorSpace[] = Object.freeze([
  'srgb',
  'display-p3',
]);

export function isOutputColorSpace(value: unknown): value is OutputColorSpace {
  return value === 'srgb' || value === 'display-p3';
}

export const OUTPUT_GAMUT_WGSL_BEGIN = '// BEGIN GENERATED output-gamut';
export const OUTPUT_GAMUT_WGSL_END = '// END GENERATED output-gamut';

function wgslFloat(value: number): string {
  // Round-off residue of exactly-zero entries (shared blue primary) prints as 0.
  if (Math.abs(value) < 1e-12) return '0.0';
  const text = String(Number(Math.fround(value).toPrecision(9)));
  return /[.e]/.test(text) ? text : `${text}.0`;
}

function wgslMat3(name: string, m: color.RgbMatrix3): string {
  // WGSL mat3x3 constructors take columns; the SSOT matrix is row-major.
  const columns = [0, 1, 2].map(
    (col) =>
      `  vec3<f32>(${[0, 1, 2].map((row) => wgslFloat(m[row * 3 + col] as number)).join(', ')}),`,
  );
  return [`const ${name} : mat3x3<f32> = mat3x3<f32>(`, ...columns, ');'].join('\n');
}

/**
 * The generated WGSL block in `packages/shader/src/output-encoding.wgsl`.
 * Regenerate with `bun scripts/forgeax/generate-output-gamut-wgsl.ts`; the
 * render unit gate fails when the checked-in block drifts from the primaries.
 */
export function renderOutputGamutWgsl(): string {
  return [
    `${OUTPUT_GAMUT_WGSL_BEGIN} (bun scripts/forgeax/generate-output-gamut-wgsl.ts; SSOT @forgeax/engine-math color.RGB_PRIMARIES)`,
    `const OUTPUT_GAMUT_SRGB : u32 = ${OUTPUT_GAMUT_CODE.srgb}u;`,
    `const OUTPUT_GAMUT_DISPLAY_P3 : u32 = ${OUTPUT_GAMUT_CODE['display-p3']}u;`,
    wgslMat3('LINEAR_SRGB_TO_LINEAR_DISPLAY_P3', color.LINEAR_SRGB_TO_LINEAR_DISPLAY_P3),
    wgslMat3('LINEAR_DISPLAY_P3_TO_LINEAR_SRGB', color.LINEAR_DISPLAY_P3_TO_LINEAR_SRGB),
    OUTPUT_GAMUT_WGSL_END,
  ].join('\n');
}

/** Closed list of ways a surface can fail to honour a Display-P3 request. */
export type OutputColorSpaceFallbackObservation =
  | 'configure-rejected'
  | 'configuration-absent'
  | 'color-space-absent'
  | 'color-space-mismatch';

/** Structured evidence that the surface presents sRGB although Display P3 was requested. */
export interface OutputColorSpaceFallback {
  readonly code: 'canvas-color-space-unsupported';
  readonly expected: string;
  readonly hint: string;
  readonly detail: {
    readonly requested: 'display-p3';
    readonly observed: OutputColorSpaceFallbackObservation;
    /** Present for `color-space-mismatch` and `configure-rejected`. */
    readonly reported?: string;
  };
}

/**
 * The renderer's output colour-space decision. `effective` is what the Output
 * Transform encodes and what the surface presents; a fallback always carries
 * its structured cause.
 */
export type OutputColorSpaceReport =
  | {
      readonly status: 'applied';
      readonly requested: OutputColorSpace;
      readonly effective: OutputColorSpace;
    }
  | {
      readonly status: 'fallback';
      readonly requested: 'display-p3';
      readonly effective: 'srgb';
      readonly fallback: OutputColorSpaceFallback;
    };

export function appliedOutputColorSpace(colorSpace: OutputColorSpace): OutputColorSpaceReport {
  return { status: 'applied', requested: colorSpace, effective: colorSpace };
}

export function outputColorSpaceFallback(
  observed: OutputColorSpaceFallbackObservation,
  reported?: string,
): OutputColorSpaceReport {
  return {
    status: 'fallback',
    requested: 'display-p3',
    effective: 'srgb',
    fallback: {
      code: 'canvas-color-space-unsupported',
      expected:
        "a canvas context whose getConfiguration().colorSpace is 'display-p3' after configure",
      hint:
        observed === 'configure-rejected'
          ? 'the backend rejected colorSpace display-p3; output stays sRGB-encoded and sRGB-presented'
          : 'this backend or host cannot present Display P3; output stays sRGB-encoded and sRGB-presented',
      detail: {
        requested: 'display-p3',
        observed,
        ...(reported === undefined ? {} : { reported }),
      },
    },
  };
}

/** Classify the context's reported configuration after a Display-P3 configure. */
export function observeDisplayP3Configuration(
  configuration: { readonly colorSpace?: string | undefined } | undefined,
): OutputColorSpaceReport {
  if (configuration === undefined) return outputColorSpaceFallback('configuration-absent');
  if (!('colorSpace' in configuration) || configuration.colorSpace === undefined) {
    return outputColorSpaceFallback('color-space-absent');
  }
  if (configuration.colorSpace !== 'display-p3') {
    return outputColorSpaceFallback('color-space-mismatch', String(configuration.colorSpace));
  }
  return appliedOutputColorSpace('display-p3');
}

/**
 * Renderer-owned mutable negotiation slot. `requested` is the public choice;
 * `report` is refreshed by every surface configure and read by the record
 * stage to select the Output Transform gamut.
 */
export interface OutputColorSpaceState {
  requested: OutputColorSpace;
  report: OutputColorSpaceReport;
}

export function createOutputColorSpaceState(requested: OutputColorSpace): OutputColorSpaceState {
  return { requested, report: appliedOutputColorSpace(requested) };
}

import { STANDARD_OUTPUT_V2_PARAMS_LAYOUT } from '@forgeax/engine-shader';
import { tonemapToU32 } from '../../components/camera';
import type { LensEffectsSnapshot } from '../../components/lens-effects';
import { chromaticAberrationScales } from '../../features/lens-effects';
import type { OUTPUT_GAMUT_CODE } from '../../output-color-space';
import type { CameraSnapshot } from '../../render-contract';
import { applyStandardWhiteBalance } from './color-transform';

export interface StandardOutputV2Parameters {
  readonly camera: Pick<CameraSnapshot, 'exposure' | 'whitePoint' | 'tonemap'>;
  readonly outputGamut: (typeof OUTPUT_GAMUT_CODE)[keyof typeof OUTPUT_GAMUT_CODE];
  readonly lens?: LensEffectsSnapshot | undefined;
  readonly whiteBalance?: { readonly temperature: number; readonly tint: number } | undefined;
  readonly bloom?: { readonly intensity: number; readonly radius: number } | undefined;
  readonly lutStrength: number;
  readonly sharpen: number;
  readonly elapsedSeconds: number;
  readonly dither: boolean;
  readonly finishInGrade: boolean;
  readonly linearGrade?: boolean | undefined;
  readonly chromaticAberration?: boolean | undefined;
}

function writeLensParameters(floats: Float32Array, lens: LensEffectsSnapshot | undefined): void {
  floats[24] = lens?.vignetteIntensity ?? 0;
  floats[25] = lens?.vignetteRadius ?? 0.5;
  floats[26] = lens?.vignetteSoftness ?? 0.5;
  floats[27] = 0;
  floats[28] = lens?.vignetteColor[0] ?? 0;
  floats[29] = lens?.vignetteColor[1] ?? 0;
  floats[30] = lens?.vignetteColor[2] ?? 0;
  floats[31] = 0;
  floats[32] = lens?.grainIntensity ?? 0;
  floats[33] = lens?.grainSize ?? 1;
}

/** One graph's synchronous upload scratch. Consume the borrowed bytes before the next write. */
export function createStandardOutputV2ParameterWriter() {
  const bytes = new Uint8Array(STANDARD_OUTPUT_V2_PARAMS_LAYOUT.byteSize);
  const floats = new Float32Array(bytes.buffer);
  const words = new Uint32Array(bytes.buffer);
  const whiteBalance = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  let previousTemperature = 6504;
  let previousTint = 0;
  let previousFringe = 0;
  let previousStart = 0;
  let red = 0;
  let green = 0;
  return (input: StandardOutputV2Parameters): Uint8Array => {
    const mode = tonemapToU32(input.camera.tonemap);
    const temperature = input.whiteBalance?.temperature ?? 6504;
    const tint = input.whiteBalance?.tint ?? 0;
    if (temperature !== previousTemperature || tint !== previousTint) {
      const r = applyStandardWhiteBalance([1, 0, 0], temperature, tint);
      const g = applyStandardWhiteBalance([0, 1, 0], temperature, tint);
      const b = applyStandardWhiteBalance([0, 0, 1], temperature, tint);
      whiteBalance.set([r[0], g[0], b[0], 0, r[1], g[1], b[1], 0, r[2], g[2], b[2], 0]);
      previousTemperature = temperature;
      previousTint = tint;
    }
    const fringe = input.chromaticAberration === false ? 0 : (input.lens?.chromaticAberration ?? 0);
    const start = input.lens?.chromaticAberrationStartOffset ?? 0;
    if (fringe !== previousFringe || start !== previousStart) {
      [red, green] = chromaticAberrationScales(fringe, start);
      previousFringe = fringe;
      previousStart = start;
    }
    floats[0] = 1; // The same buffer can supply the neutral candidate when AE is off.
    floats[1] = input.camera.exposure;
    floats[2] = input.camera.whitePoint;
    floats[3] = mode;
    floats.set(whiteBalance, 4);
    floats[16] = red;
    floats[17] = green;
    floats[18] = start;
    floats[19] = input.lutStrength;
    floats[20] = input.bloom?.intensity ?? 0;
    floats[21] = input.bloom?.radius ?? 0;
    floats[22] = 0;
    floats[23] = 0;
    writeLensParameters(floats, input.lens);
    floats[34] = input.sharpen;
    floats[35] = input.elapsedSeconds;
    words[36] = input.outputGamut;
    words[37] = input.linearGrade === true ? 1 : 0;
    words[38] = input.dither ? 1 : 0;
    words[39] = input.finishInGrade ? 1 : 0;
    return bytes;
  };
}

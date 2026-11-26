import { STANDARD_OUTPUT_V2_PARAMS_LAYOUT } from '@forgeax/engine-shader';
import { tonemapToU32 } from '../../components/camera';
import type { LensEffectsSnapshot } from '../../components/lens-effects';
import { writeChromaticAberrationScales } from '../../features/lens-effects';
import type { OUTPUT_GAMUT_CODE } from '../../output-color-space';
import type { CameraSnapshot } from '../../render-contract';
import { createWhiteBalanceMatrixWriter } from './auto-exposure/oracle';

type OutputCamera = Pick<
  CameraSnapshot,
  'exposure' | 'whitePoint' | 'tonemap' | 'lensEffects' | 'bloomIntensity'
> & {
  readonly output?: Pick<NonNullable<CameraSnapshot['output']>, 'temperature' | 'tint'> | undefined;
  readonly temporal?:
    | Pick<NonNullable<CameraSnapshot['temporal']>, 'sampleTimeSeconds'>
    | undefined;
};

export interface GradeParameters {
  readonly bloomIntensity: 0 | 1 | 'camera';
  readonly sharpen: number;
  readonly finishInGrade: boolean;
  /** Apply dither at the first UNORM write, before encoded AA. */
  readonly ditherAtEncoding?: boolean | undefined;
  readonly linearGrade?: boolean | undefined;
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
export function createStandardOutputV2ParameterWriter(policy: GradeParameters) {
  const bytes = new Uint8Array(STANDARD_OUTPUT_V2_PARAMS_LAYOUT.byteSize);
  const floats = new Float32Array(bytes.buffer);
  const words = new Uint32Array(bytes.buffer);
  const writeWhiteBalance = createWhiteBalanceMatrixWriter();
  return (
    camera: OutputCamera,
    outputGamut: (typeof OUTPUT_GAMUT_CODE)[keyof typeof OUTPUT_GAMUT_CODE],
    lutStrength: number,
    dither: boolean,
  ): Uint8Array => {
    const mode = tonemapToU32(camera.tonemap);
    const temperature = camera.output?.temperature ?? 6504;
    const tint = camera.output?.tint ?? 0;
    const fringe = camera.lensEffects?.chromaticAberration ?? 0;
    const start = camera.lensEffects?.chromaticAberrationStartOffset ?? 0;
    floats[0] = 1; // The same buffer can supply the neutral candidate when AE is off.
    floats[1] = camera.exposure;
    floats[2] = camera.whitePoint;
    floats[3] = mode;
    writeWhiteBalance(floats, 4, temperature, tint);
    writeChromaticAberrationScales(floats, 16, fringe, start);
    floats[18] = start;
    floats[19] = lutStrength;
    floats[20] = policy.bloomIntensity === 'camera' ? camera.bloomIntensity : policy.bloomIntensity;
    floats[22] = 0;
    floats[23] = 0;
    writeLensParameters(floats, camera.lensEffects);
    floats[34] = policy.sharpen;
    floats[35] = camera.temporal?.sampleTimeSeconds ?? 0;
    words[36] = outputGamut;
    words[37] = policy.linearGrade === true ? 1 : 0;
    words[38] = dither ? (policy.ditherAtEncoding === true ? 2 : 1) : 0;
    words[39] = policy.finishInGrade ? 1 : 0;
    return bytes;
  };
}

import { groundSolarTransmittance } from '../../environment/ground-solar';
import { CloudLayerInvalidParameterError } from '../../errors/cloud';
import type { AtmosphereParameters } from '../../extract/environment';
import type { SkylightSnapshot } from '../../render-system-extract';
import type { CloudRgb } from '../contracts';

export const CLOUD_ATMOSPHERE_TARGETS = {
  transmittance: 'cloud-atmosphere-transmittance',
  distantSkyLight: 'cloud-atmosphere-distant-sky',
} as const;

export interface CloudLightingEnvironment {
  readonly groundSolarTransmittance?: CloudRgb;
  readonly atmosphereAvailable: boolean;
  readonly skyLuminance: CloudRgb;
  readonly skySource: 'none' | 'atmosphere' | 'skylight' | 'unavailable-image';
}

/** Project the already selected environment, never choose a second atmosphere. */
export function selectCloudLightingEnvironment(
  atmosphereAvailable: boolean,
  sky:
    | Pick<
        SkylightSnapshot,
        'equirectHandle' | 'color' | 'groundColor' | 'ambientIrradiance' | 'intensity'
      >
    | undefined,
  solar?: {
    readonly atmosphere: AtmosphereParameters;
    readonly directionToLight: ArrayLike<number>;
  },
): CloudLightingEnvironment {
  if (atmosphereAvailable)
    return {
      atmosphereAvailable: true,
      skyLuminance: [0, 0, 0],
      skySource: 'atmosphere',
      ...(solar === undefined
        ? {}
        : {
            groundSolarTransmittance: groundSolarTransmittance(
              solar.atmosphere,
              solar.directionToLight,
            ),
          }),
    };
  if (!sky) return { atmosphereAvailable: false, skyLuminance: [0, 0, 0], skySource: 'none' };
  if ((sky.equirectHandle ?? 0) > 0)
    return { atmosphereAvailable: false, skyLuminance: [0, 0, 0], skySource: 'unavailable-image' };
  const hemisphere = sky.groundColor?.some((value) => value !== 0) ?? false;
  const luminance = [0, 1, 2].map((index) => {
    const color = sky.color[index] ?? 0;
    const ground = sky.groundColor?.[index] ?? 0;
    return (
      (hemisphere ? (color + ground) * 0.5 : color) * sky.intensity +
      (sky.ambientIrradiance?.[index] ?? 0) / Math.PI
    );
  });
  if (!luminance.every((value) => Number.isFinite(value) && value >= 0))
    throw new CloudLayerInvalidParameterError(
      'skyLuminance',
      luminance,
      'finite nonnegative selected Skylight luminance',
    );
  return {
    atmosphereAvailable: false,
    skyLuminance: [luminance[0] ?? 0, luminance[1] ?? 0, luminance[2] ?? 0],
    skySource: 'skylight',
  };
}

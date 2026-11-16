import type { CloudEdit, CloudPreset } from './cloud-controls.ts';
import type { CloudParameterKey } from './parameter-labels.ts';
import { sunDirection, sunFieldsFromDirection, type SunFields } from './sun-controls.ts';
import { degrees, OCCLUDER_CENTER, referenceCamera, REFERENCE_VERTICAL_FOV, SUN_DIRECTION, type GroundCamera } from './terrain.ts';
import { ueCloudWindOffset } from '@forgeax-assets/volumetric-clouds/reference';

export const WEATHER_PRESET_IDS = ['clear', 'backlit', 'overcast'] as const;
export type WeatherPresetId = typeof WEATHER_PRESET_IDS[number];

export const WEATHER_PARAMETER_KEYS = [
  'bottomMeters', 'thicknessMeters', 'extinctionPerMeter', 'coverageBias',
  'layoutWeight', 'maskWeight', 'profileWeight', 'bodyWeight', 'erosionWeight',
  'windX', 'windY', 'windZ', 'sunElevation', 'sunAzimuth', 'sunIlluminanceLux', 'exposure',
  'phaseG', 'phaseG2', 'phaseBlend', 'msContribution', 'msOcclusion', 'msEccentricity',
] as const satisfies readonly CloudParameterKey[];

export function weatherAtmosphereParameters(parameters: CloudEdit): CloudEdit {
  return Object.fromEntries(WEATHER_PARAMETER_KEYS.flatMap(key =>
    parameters[key] === undefined ? [] : [[key, parameters[key]]]));
}

const freeze = <T extends object>(value: T): Readonly<T> => Object.freeze(value);
const extent = freeze([1280, 720] as const);
const pose = freeze(referenceCamera());
const floorCentimeters = -0.5;
const exposure = 0.00022;

export function uePose(camera: Readonly<GroundCamera>) {
  return freeze({
    positionCm: freeze([-100 * camera.z, 100 * camera.x, 100 * camera.y + floorCentimeters] as const),
    rotationDegrees: freeze([camera.pitch / degrees, camera.yaw / degrees, 0] as const),
  });
}

/** One route formula serves the App clock and the independently captured UE input samples. */
export function weatherRoutePose(seconds: number): GroundCamera {
  const swing = Math.sin(seconds * Math.PI / 8);
  return { ...pose, x: pose.x + 8 * swing, z: pose.z + 6 * Math.sin(seconds * Math.PI / 4), yaw: pose.yaw + 5 * degrees * swing };
}

export function weatherCutPose(camera: Readonly<GroundCamera>): GroundCamera {
  return { ...camera, x: camera.x + 20, yaw: camera.yaw + 55 * degrees };
}

const shot = freeze({
  extent, dpr: 1, projection: 'perspective', pose, uePose: uePose(pose),
  verticalFovRadians: REFERENCE_VERTICAL_FOV,
  horizontalFovDegrees: 2 * Math.atan(Math.tan(REFERENCE_VERTICAL_FOV / 2) * extent[0] / extent[1]) / degrees,
  nearMeters: 0.05, forgeaxFarMeters: 25_000,
  fixture: freeze({
    centerCm: freeze([-100 * OCCLUDER_CENTER[2], 100 * OCCLUDER_CENTER[0], 100 * OCCLUDER_CENTER[1] + floorCentimeters]),
    sizeCm: freeze([60, 125, 190]),
  }),
  exposureMultiplier: exposure,
  forgeaxDisplayTransform: 'ACES filmic fit / sRGB',
  unrealDisplayTransform: 'UE filmic tonemapper / sRGB (not the ForgeaX filmic fit)',
});

const routeDurationSeconds = 3;
const holdAfterCutSeconds = 1;
const unrealFps = 12;
const timeline = freeze({
  referenceTimeSeconds: 0, routeDurationSeconds, holdAfterCutSeconds, unrealFps,
  oddResize: freeze([913, 617] as const),
  dynamic: freeze(Array.from({ length: (routeDurationSeconds + holdAfterCutSeconds) * unrealFps }, (_, frame) => {
    const seconds = frame / unrealFps;
    const cut = frame === routeDurationSeconds * unrealFps;
    const camera = seconds < routeDurationSeconds ? weatherRoutePose(seconds) : weatherCutPose(weatherRoutePose(routeDurationSeconds));
    return freeze({ frame, seconds, cut, uePose: uePose(camera) });
  })),
});

const ueCvars = freeze({
  'r.VolumetricRenderTarget': 1,
  'r.VolumetricRenderTarget.Mode': 0,
  'r.VolumetricRenderTarget.UpsamplingMode': 4,
  'r.VolumetricCloud.ApplyFogLate': 1,
  'r.VolumetricCloud.EmptySpaceSkipping': 0,
  'r.VolumetricCloud.DisableCompute': 0,
  'r.VolumetricCloud.DistanceToSampleMaxCount': 15,
  'r.VolumetricCloud.SampleMinCount': 2,
  'r.VolumetricCloud.ViewRaySampleMaxCount': 768,
  'r.VolumetricCloud.ShadowMap': 1,
  'r.EyeAdaptation.LensAttenuation': 0.78,
  'r.Tonemapper.OutputDevice': 0,
  'r.MotionBlurQuality': 0,
});

const wind = ueCloudWindOffset(1);
const common = freeze({
  bottomMeters: 5000, thicknessMeters: 10000,
  layoutWeight: 1, maskWeight: 0, profileWeight: 1, bodyWeight: 1, erosionWeight: 1,
  useDetail: false, skipEmpty: false,
  windX: wind[0], windY: wind[1], windZ: wind[2],
  sunIlluminanceLux: 120_000, exposure,
  phaseG: 0.800000011920929, phaseG2: 0.16666699945926666, phaseBlend: 0.574999988079071,
  multiScatteringOctaves: 2, msContribution: 0.6666669845581055, msOcclusion: 0.25, msEccentricity: 0.18000000715255737,
  atmosphereTransmittanceMode: 0, enableDistantSkyLightSampling: true,
  selfShadow: true, shadowMode: 0,
  groundShadowEnabled: true, atmosphereShadowEnabled: true, surfaceShadowStrength: 1, atmosphereShadowStrength: 1,
  shadowSamples: 10, shadowDistanceMeters: 15000, shadowExtentMeters: 160000,
  shadowLightDistanceMeters: 80000, shadowFarDepthMeters: 160000, shadowDepthBiasMeters: 0,
  shadowStrength: 1, shadowResolution: 128, shadowMapSamples: 64,
  entryLimitMeters: 350000, traceLimitMeters: 50000, viewSampleCountScale: 1, stopTransmittance: 0.005,
} satisfies CloudEdit);

const sky = freeze({ planetRadiusMeters: 6_360_000, layerBottomMeters: common.bottomMeters, layerThicknessMeters: common.thicknessMeters });

function preset(id: WeatherPresetId, label: string, visualGoal: string, sun: SunFields, coverageBias: number,
  extinctionPerMeter: number, ueGraphDensity: number, ueSourceSolarTimeHours: number | null) {
  const outgoing = sunDirection(sun);
  const forgeax = freeze({
    materialMode: 'shape', enabled: true,
    parameters: freeze({ ...common, ...sun, coverageBias, extinctionPerMeter }),
    clock: freeze({ referenceTimeSeconds: timeline.referenceTimeSeconds, elapsedSeconds: 0, paused: true }),
    camera: freeze({ pose, cameraView: 'ground', routeTime: null, fixtureVisible: true, viewMode: 'normal' }),
  } as const satisfies CloudPreset);
  return freeze({
    version: 1 as const, id, label, visualGoal, shot, timeline, sky, forgeax,
    forgeaxQuality: freeze({ renderTargetMode: 0, viewSampleCountScale: common.viewSampleCountScale,
      stopTransmittance: common.stopTransmittance, shadowMapSamples: common.shadowMapSamples,
      shadowResolution: common.shadowResolution, sampledTextureLod: 0 }),
    unreal: freeze({
      sourceMap: '/Game/SimBlank/Levels/SimBlank',
      sourceSolarTimeHours: ueSourceSolarTimeHours,
      outgoingLightDirection: freeze([-outgoing[2], outgoing[0], outgoing[1]]),
      lightRotationDegrees: freeze([-sun.sunElevation, -sun.sunAzimuth, 0]),
      illuminanceLux: common.sunIlluminanceLux,
      exposureCompensationStops: Math.log2(exposure),
      // The UE source graph uses this scalar; it is not the ForgeaX inverse-metre coefficient.
      scalarOverrides: freeze({ Cloud_GlobalCoverage: coverageBias, Cloud_GlobalDensity: ueGraphDensity, StormClouds: 0 }),
      staticSwitches: freeze({ UseNoise3: false }),
      cvars: ueCvars,
      component: freeze({
        layer_bottom_altitude: common.bottomMeters / 1000,
        layer_height: common.thicknessMeters / 1000,
        tracing_start_max_distance: common.entryLimitMeters / 1000,
        tracing_max_distance: common.traceLimitMeters / 1000,
        view_sample_count_scale: common.viewSampleCountScale,
        stop_tracing_transmittance_threshold: common.stopTransmittance,
      }),
    }),
    intentionalDifferences: freeze([
      'ForgeaX uses the independent seeded layout textures; UE uses the source instance textures and graph.',
      'ForgeaX extinction is inverse metres; UE Cloud_GlobalDensity is an independent graph scalar.',
      'UE native lighting, BSM, temporal resolve, material LOD and display transform use their own implementation.',
      'The foreground fixture matches geometry, while ground and fixture materials remain engine-specific.',
    ]),
  });
}

const daylight = sunFieldsFromDirection(SUN_DIRECTION);
export const WEATHER_PRESETS = freeze({
  clear: preset('clear', '晴天', 'Cloud gaps, a layered base and a smooth horizon.', daylight, -0.2, 0.008, 0.00800000037997961, 15),
  backlit: preset('backlit', '低太阳逆光', 'A low sun behind the clouds, cloud rims and consistent ground shadows.',
    { sunElevation: 8, sunAzimuth: pose.yaw / degrees }, -0.2, 0.008, 0.00800000037997961, null),
  overcast: preset('overcast', '密云', 'Lower transmission while retaining variation in optical thickness.', daylight, -0.1, 0.008, 0.009, 15),
});

export function readWeatherPreset(value: unknown): (typeof WEATHER_PRESETS)[WeatherPresetId] | undefined {
  return typeof value === 'string' && Object.hasOwn(WEATHER_PRESETS, value) ? WEATHER_PRESETS[value as WeatherPresetId] : undefined;
}

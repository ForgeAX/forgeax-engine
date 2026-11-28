import { isStandardOutputContract } from '../pipeline/standard-output/types';
import {
  isStandardLightCount,
  STANDARD_MAX_LIGHT_COUNT,
  STANDARD_PIPELINE_ID,
  STANDARD_POST_STAGE_NAMES,
} from '../pipeline/standard-profile';
import { validateRenderQualityBudgets } from '../quality';
import {
  freezeDiffuseGi,
  freezeGlobalSdfGrid,
  validateCardCapture,
  validateDiffuseGi,
  validateGlobalSdfRegion,
} from '../raytracing/irradiance-field-plan';
import { RAY_REFERENCE_LIMIT } from '../raytracing/scene';
import type { RenderProfile } from '../render-contract';
import { hasStandardAoKeys, resolveSsaoParameters } from '../ssao-config';

const RENDER_PROFILE_KEYS = new Set([
  'quality',
  'configurationRevision',
  'atmosphereLutModel',
  'cloudMode0Model',
  'realtimeSkyCapture',
  'outputContract',
  'featureReadOnlyDepthBatching',
  'roughRefraction',
  'featureReadOnlyDepthBatchDiagnostic',
  'pipelineId',
  'lightCount',
  'renderPath',
  'gbufferFormat',
  'atmosphere',
  'deferredDirectionalShadowReceiver',
  'forwardDirectionalShadowReceiver',
  'forwardShadowViewFade',
  'forwardShadowSpotFilter',
  'subsurfaceQuality',
  'visibleSurface',
  'diffuseGi',
  'probePlacement',
  'pbr',
  'contactShadows',
  'ibl',
  'ambientOcclusion',
  'volumetricFog',
  'gpuOcclusion',
  'gbufferBatchOrderDiagnostic',
  'postStages',
]);

function validateConfigurationProfile(profile: RenderProfile): string | undefined {
  if (
    profile.configurationRevision !== undefined &&
    (!Number.isSafeInteger(profile.configurationRevision) || profile.configurationRevision < 1)
  )
    return 'configurationRevision must be a positive safe integer';
  if (profile.contactShadows !== undefined && typeof profile.contactShadows !== 'boolean')
    return 'RenderProfile.contactShadows must be boolean';
  const qualityFailure = validateRenderQualityBudgets(profile.quality);
  if (qualityFailure !== undefined) return qualityFailure;
  return undefined;
}

function validateProfileFields(profile: RenderProfile): string | undefined {
  if (typeof profile !== 'object' || profile === null) return 'RenderProfile must be a POD object';
  const unknownKey = Object.keys(profile).find((key) => !RENDER_PROFILE_KEYS.has(key));
  if (unknownKey !== undefined) return `RenderProfile contains unsupported field '${unknownKey}'`;
  if (profile.outputContract !== undefined && !isStandardOutputContract(profile.outputContract))
    return 'RenderProfile.outputContract requires standard-output-v1 or standard-output-v2';
  return undefined;
}

export function validateRenderProfile(profile: RenderProfile): string | undefined {
  // Validate automatic author intent against the Deferred feature vocabulary;
  // the owner also validates its concrete device selection before applying it.
  if (profile?.renderPath === 'auto')
    return validateRenderProfile({ ...profile, renderPath: 'deferred' });
  const fieldFailure = validateProfileFields(profile);
  if (fieldFailure !== undefined) return fieldFailure;
  const cloudFailure = validateCloudProfile(profile);
  if (cloudFailure !== undefined) return cloudFailure;
  const configurationFailure = validateConfigurationProfile(profile);
  if (configurationFailure !== undefined) return configurationFailure;
  let failure = validateStandardPipelineSelection(profile);
  if (failure !== undefined) return failure;
  failure = validateAtmosphereProfile(profile.atmosphere);
  if (failure !== undefined) return failure;
  failure = validateVolumetricFogProfile(profile.volumetricFog);
  if (failure !== undefined) return failure;
  failure = validateDiagnosticFlags(profile);
  if (failure !== undefined) return failure;
  failure = validateGbufferBatchOrderDiagnostic(profile.gbufferBatchOrderDiagnostic);
  if (failure !== undefined) return failure;
  if (profile.visibleSurface === true && profile.renderPath !== 'deferred')
    return 'Visible surfaces require the Standard deferred path';
  failure = validateProbePlacementProfile(profile);
  if (failure !== undefined) return failure;
  failure = validateDiffuseGiProfile(profile);
  if (failure !== undefined) return failure;
  for (const field of ['pbr', 'ibl'] as const) {
    if (typeof profile[field] !== 'boolean') return `RenderProfile.${field} must be boolean`;
  }
  failure = validateSsaoProfile(profile);
  if (failure !== undefined) return failure;
  return validatePostStageOrder(profile);
}

function validateCloudProfile(profile: RenderProfile): string | undefined {
  if (profile.cloudMode0Model !== undefined && profile.cloudMode0Model !== 'ue5-desktop')
    return 'RenderProfile.cloudMode0Model requires ue5-desktop';
  if (profile.atmosphereLutModel !== undefined && profile.atmosphereLutModel !== 'ue5-desktop')
    return 'RenderProfile.atmosphereLutModel requires ue5-desktop';
  if (profile.atmosphereLutModel === 'ue5-desktop' && profile.renderPath !== 'forward')
    return 'The UE5 atmosphere profile requires Standard Forward';
  if (profile.realtimeSkyCapture !== undefined && typeof profile.realtimeSkyCapture !== 'boolean')
    return 'RenderProfile.realtimeSkyCapture must be boolean';
  return undefined;
}

function validatePostStageOrder(profile: RenderProfile): string | undefined {
  const stages = STANDARD_POST_STAGE_NAMES;
  if (
    !Array.isArray(profile.postStages) ||
    profile.postStages.length !== stages.length ||
    stages.some((stage, index) => profile.postStages[index] !== stage)
  ) {
    return 'RenderProfile.postStages must preserve the Standard post stage order';
  }
  return undefined;
}

/** Pipeline identity, light budget, render path and subsurface quality. */
function validateStandardPipelineSelection(profile: RenderProfile): string | undefined {
  if (profile.pipelineId !== STANDARD_PIPELINE_ID) {
    return `RenderProfile.pipelineId must be '${STANDARD_PIPELINE_ID}'`;
  }
  if (!isStandardLightCount(profile.lightCount)) {
    return `RenderProfile.lightCount must be an integer from 1 to ${STANDARD_MAX_LIGHT_COUNT}`;
  }
  if (profile.renderPath !== 'forward' && profile.renderPath !== 'deferred') {
    return "RenderProfile.renderPath must be 'forward' or 'deferred'";
  }
  if (
    profile.gbufferFormat !== undefined &&
    (profile.renderPath !== 'deferred' || profile.gbufferFormat !== 'default')
  )
    return "RenderProfile.gbufferFormat must be 'default' with renderPath 'deferred'";
  if (
    profile.forwardDirectionalShadowReceiver !== undefined &&
    profile.forwardDirectionalShadowReceiver !== 'screen'
  )
    return 'RenderProfile.forwardDirectionalShadowReceiver must be screen when specified';
  if (profile.forwardShadowViewFade !== undefined && profile.forwardShadowViewFade !== true)
    return 'RenderProfile.forwardShadowViewFade must be true when specified';
  if (profile.forwardShadowSpotFilter !== undefined && profile.forwardShadowSpotFilter !== 'gather')
    return 'RenderProfile.forwardShadowSpotFilter must be gather when specified';
  if (
    profile.deferredDirectionalShadowReceiver !== undefined &&
    profile.deferredDirectionalShadowReceiver !== 'projected'
  )
    return 'RenderProfile.deferredDirectionalShadowReceiver must be projected when specified';
  if (
    profile.subsurfaceQuality !== undefined &&
    profile.subsurfaceQuality !== 'low' &&
    profile.subsurfaceQuality !== 'high'
  )
    return 'RenderProfile.subsurfaceQuality must be low or high';
  return undefined;
}

function validateAtmosphereProfile(atmosphere: RenderProfile['atmosphere']): string | undefined {
  if (atmosphere === undefined) return;
  if (typeof atmosphere !== 'object' || atmosphere === null)
    return 'RenderProfile.atmosphere must be an object';
  for (const [key, value] of Object.entries(atmosphere)) {
    if (!validAtmosphereSetting(key, value))
      return `RenderProfile.atmosphere contains an invalid '${key}'`;
  }
  return undefined;
}

function validAtmosphereSetting(key: string, value: unknown): boolean {
  switch (key) {
    case 'aerialPerspectiveQuality':
      return value === undefined || value === 'fast' || value === 'rgb';
    case 'skyAtmosphereAffectsHeightFog':
      return value === undefined || typeof value === 'boolean';
    case 'aerialPerspectiveStartM':
      return validAtmosphereNumber(value, 0, 1e8);
    case 'aerialPerspectiveRangeM':
      return validAtmosphereNumber(value, 1, 1e8);
    case 'traceSampleCountScale':
      return validAtmosphereNumber(value, 0, 32);
    case 'sampleCountMaxPerSlice':
      return (
        value === undefined || (Number.isInteger(value) && validAtmosphereNumber(value, 1, 64))
      );
    default:
      return false;
  }
}

function validAtmosphereNumber(value: unknown, min: number, max: number): boolean {
  return value === undefined || (typeof value === 'number' && value >= min && value <= max);
}

function validateVolumetricFogProfile(volume: RenderProfile['volumetricFog']): string | undefined {
  if (volume === undefined) return undefined;
  if (
    typeof volume !== 'object' ||
    volume === null ||
    Array.isArray(volume) ||
    Object.keys(volume).some((key) => !['quality', 'depth', 'tileSize'].includes(key)) ||
    (volume.quality !== 'low' && volume.quality !== 'high') ||
    (volume.depth !== 48 && volume.depth !== 64) ||
    (volume.tileSize !== 4 && volume.tileSize !== 16)
  )
    return 'RenderProfile.volumetricFog requires quality low/high, depth 48/64 and tileSize 4/16';
  return undefined;
}

/** Optional boolean switches for experiments and diagnostics. */
function validateDiagnosticFlags(profile: RenderProfile): string | undefined {
  if (profile.roughRefraction !== undefined && typeof profile.roughRefraction !== 'boolean')
    return 'RenderProfile.roughRefraction must be boolean';
  if (
    profile.featureReadOnlyDepthBatching !== undefined &&
    typeof profile.featureReadOnlyDepthBatching !== 'boolean'
  )
    return 'RenderProfile.featureReadOnlyDepthBatching must be boolean';
  if (
    profile.featureReadOnlyDepthBatchDiagnostic !== undefined &&
    typeof profile.featureReadOnlyDepthBatchDiagnostic !== 'boolean'
  )
    return 'RenderProfile.featureReadOnlyDepthBatchDiagnostic must be boolean';
  if (profile.visibleSurface !== undefined && typeof profile.visibleSurface !== 'boolean')
    return 'RenderProfile.visibleSurface must be boolean';
  if (profile.gpuOcclusion !== undefined && typeof profile.gpuOcclusion !== 'boolean')
    return 'RenderProfile.gpuOcclusion must be boolean';
  return undefined;
}

function validateGbufferBatchOrderDiagnostic(
  diagnostic: RenderProfile['gbufferBatchOrderDiagnostic'],
): string | undefined {
  if (diagnostic === undefined) return undefined;
  if (
    typeof diagnostic !== 'object' ||
    diagnostic === null ||
    Array.isArray(diagnostic) ||
    Object.keys(diagnostic).some((key) => key !== 'order' && key !== 'programDigests') ||
    (diagnostic.order !== 'near' && diagnostic.order !== 'far') ||
    !Array.isArray(diagnostic.programDigests) ||
    diagnostic.programDigests.length > 128 ||
    !diagnostic.programDigests.every(
      (digest) => typeof digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(digest),
    )
  )
    return 'RenderProfile.gbufferBatchOrderDiagnostic requires near/far order and up to 128 audited SHA-256 programDigests';
  return undefined;
}

function validateProbePlacementProfile(profile: RenderProfile): string | undefined {
  const placement = profile.probePlacement;
  if (placement === undefined) return undefined;
  if (
    typeof placement !== 'object' ||
    placement === null ||
    Array.isArray(placement) ||
    Object.keys(placement).some((key) => !['seeds', 'global'].includes(key))
  )
    return 'Probe placement requires one seeds/global configuration object';
  const seeds = placement.seeds;
  if (profile.renderPath !== 'deferred') return 'Probe placement requires Standard deferred';
  if (
    !Array.isArray(seeds) ||
    seeds.length < 1 ||
    seeds.length > 4096 ||
    new Set(seeds.map((seed) => seed?.id)).size !== seeds.length ||
    !seeds.every(validProbeSeed)
  )
    return 'Probe placement requires 1..4096 unique nonzero u32 seed identities/generations, finite positions, bounded positive cells and explicit traced eligibility';
  return validateGlobalProbes(placement.global, seeds);
}

/** Is a seed a closed record with u32 identity, finite position, bounded cell and traced flag? */
function validProbeSeed(
  seed: NonNullable<RenderProfile['probePlacement']>['seeds'][number],
): boolean {
  return !(
    typeof seed !== 'object' ||
    seed === null ||
    Object.keys(seed).some(
      (key) => !['id', 'generation', 'position', 'cellSize', 'traced'].includes(key),
    ) ||
    ![seed.id, seed.generation].every((v) => Number.isInteger(v) && v > 0 && v <= 0xffffffff) ||
    typeof seed.traced !== 'boolean' ||
    !Array.isArray(seed.position) ||
    seed.position.length !== 3 ||
    !seed.position.every(
      (v: unknown) =>
        typeof v === 'number' && Number.isFinite(Math.fround(v)) && Math.abs(v) < 1e30,
    ) ||
    typeof seed.cellSize !== 'number' ||
    !(Math.fround(seed.cellSize) > 1e-20 && Math.fround(seed.cellSize) < 1e20)
  );
}

function validateGlobalProbes(
  global: NonNullable<RenderProfile['probePlacement']>['global'],
  seeds: NonNullable<RenderProfile['probePlacement']>['seeds'],
): string | undefined {
  if (global === undefined) return undefined;
  const region = validateGlobalSdfRegion(global, ['rayResolution', 'tMax', 'cards']);
  if (!region.ok) return region.error.detail.cause;
  if (
    !Number.isInteger(global.rayResolution) ||
    global.rayResolution < 1 ||
    global.rayResolution > 256 ||
    seeds.length * global.rayResolution ** 2 > RAY_REFERENCE_LIMIT ||
    !(Math.fround(global.tMax) >= 2 ** -126 && Math.fround(global.tMax) < 1e30) ||
    seeds.some((seed) => seed.position.some((v: number) => Math.abs(v) + global.tMax >= 1e30))
  )
    return 'Global probes require 1..256 ray texels/axis within the query ray limit and finite normal f32 endpoints';
  if (global.cards !== undefined) {
    const cards = validateCardCapture(global.cards);
    if (!cards.ok) return cards.error.detail.cause;
  }
  return undefined;
}

function validateDiffuseGiProfile(profile: RenderProfile): string | undefined {
  if (profile.diffuseGi === undefined) return undefined;
  const gi = validateDiffuseGi(profile.diffuseGi);
  if (!gi.ok) return gi.error.detail.cause;
  if (profile.renderPath !== 'deferred' || !profile.pbr) return 'Diffuse GI requires deferred PBR';
  return undefined;
}

function validateSsaoProfile(profile: RenderProfile): string | undefined {
  const settings = profile.ambientOcclusion;
  if (
    typeof settings !== 'object' ||
    settings === null ||
    Array.isArray(settings) ||
    typeof settings.enabled !== 'boolean'
  )
    return 'RenderProfile.ambientOcclusion requires a boolean enabled field';
  if (!hasStandardAoKeys(settings))
    return 'Use Standard SSAO or GTAO on indirect lighting; remove legacy AO parameters';
  const resolved = resolveSsaoParameters(settings);
  if (!resolved.ok) return resolved.error.hint;
  if (Object.keys(settings).some((key) => key !== 'enabled' && !Object.hasOwn(resolved.value, key)))
    return 'RenderProfile.ambientOcclusion contains an unsupported parameter';
  return undefined;
}

export function freezeRenderProfile(profile: RenderProfile): RenderProfile {
  return Object.freeze({
    ...profile,
    ...(profile.atmosphere === undefined
      ? {}
      : { atmosphere: Object.freeze({ ...profile.atmosphere }) }),
    ...(profile.quality === undefined
      ? {}
      : {
          quality: Object.freeze({
            ...profile.quality,
            ambientOcclusion: Object.freeze({ ...profile.quality.ambientOcclusion }),
            ssr: Object.freeze({ ...profile.quality.ssr }),
          }),
        }),
    ...(profile.gbufferBatchOrderDiagnostic === undefined
      ? {}
      : {
          gbufferBatchOrderDiagnostic: Object.freeze({
            order: profile.gbufferBatchOrderDiagnostic.order,
            programDigests: Object.freeze([...profile.gbufferBatchOrderDiagnostic.programDigests]),
          }),
        }),
    ...(profile.probePlacement === undefined
      ? {}
      : {
          visibleSurface: true,
          probePlacement: Object.freeze({
            seeds: Object.freeze(
              profile.probePlacement.seeds.map((seed) =>
                Object.freeze({
                  ...seed,
                  position: Object.freeze([...seed.position]) as readonly [number, number, number],
                }),
              ),
            ),
            ...(profile.probePlacement.global === undefined
              ? {}
              : {
                  global: Object.freeze({
                    ...profile.probePlacement.global,
                    ...(profile.probePlacement.global.cards === undefined
                      ? {}
                      : { cards: Object.freeze({ ...profile.probePlacement.global.cards }) }),
                    grid: freezeGlobalSdfGrid(profile.probePlacement.global.grid),
                  }),
                }),
          }),
        }),
    // Software Screen receivers reconstruct from the real deferred primitive,
    // rather than treating the depth-derived point as an exact World origin.
    ...(profile.diffuseGi === undefined
      ? {}
      : {
          ...(profile.diffuseGi.gather === 'exact' ||
          (profile.diffuseGi.gather === 'screen-probe' &&
            profile.diffuseGi.field.hardwareRayTracing === false)
            ? { visibleSurface: true }
            : {}),
          diffuseGi: freezeDiffuseGi(profile.diffuseGi),
        }),
    ambientOcclusion: Object.freeze({
      ...profile.ambientOcclusion,
      ...(profile.ambientOcclusion.gtao === undefined
        ? {}
        : { gtao: Object.freeze({ ...profile.ambientOcclusion.gtao }) }),
    }),
    ...(profile.volumetricFog === undefined
      ? {}
      : { volumetricFog: Object.freeze({ ...profile.volumetricFog }) }),
    postStages: Object.freeze([...profile.postStages]) as RenderProfile['postStages'],
  });
}

import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { readRenderArrayView } from '@forgeax/engine-ecs/projection';
import { worldRead } from '@forgeax/engine-ecs/world-read';
import type { AssetHandle, TextureAsset } from '@forgeax/engine-types';
import { err, ok, type Result } from '@forgeax/engine-types';
import { DirectionalLight } from '../components/directional-light';
import { VolumetricCloudLayer } from '../components/volumetric-cloud-layer';
import {
  type CloudLayerError,
  CloudLayerInvalidParameterError,
  CloudLayerOwnerConflictError,
} from '../errors/cloud';
import { createEnvironmentQuery } from '../extract/environment-gate';
import { worldRenderResources } from '../publication/resource-scope';
import { cloudIdentity } from './authoring/identity';
import { encodeCloudRendererParameters } from './authoring/renderer-program';
import { resolveCloudMaterial, verifyCloudTexture } from './authoring/resolve';
import {
  CLOUD_REFERENCE_TEXTURE_ROLES,
  type CloudMaterialAsset,
  type CloudMaterialInstanceAsset,
  type CloudParameterValue,
  type CloudVector,
  type MediumSample,
} from './contracts';
import type { CloudLightingEnvironment } from './lighting/environment';
import type { CloudShadowSettings, CookedCloudShadow } from './lighting/shadow';

const extractVolumetricCloudLayerQuery = createEnvironmentQuery({ read: [VolumetricCloudLayer] });
const cloudDirectionalLightQuery = createEnvironmentQuery({ read: [DirectionalLight] });

export interface CloudAdoptionSource {
  readonly requestRevision: number;
  readonly worldIdentity: string;
  readonly entity: EntityHandle;
  readonly materialGuid?: string;
  readonly instanceGuid?: string;
  readonly cookIdentity: string;
  readonly uniformExtinctionPerMeter?: number;
  readonly programValues?: Readonly<Record<string, CloudParameterValue>>;
}

interface ExtractedCookedCloudGeometry {
  readonly adoption?: CloudAdoptionSource;
  readonly lightEnvironment?: CloudLightingEnvironment;
  readonly shadowMap?: CookedCloudShadow;
  readonly shadowSettings?: CloudShadowSettings;
  readonly lighting?: {
    readonly atmosphereTransmittanceMode?: number;
    readonly enableDistantSkyLightSampling?: boolean;
    readonly phase: readonly [number, number, number];
    readonly multipleScattering: readonly [number, number, number, number];
    readonly shadow: readonly [number, number, number];
  };
  readonly initializationRevision?: number;
  readonly bottomMeters: number;
  readonly thicknessMeters: number;
  readonly entryLimitMeters: number;
  readonly traceLimitMeters: number;
}

/** Detached uniform sample carried across the same frame publication as the camera. */
export interface ExtractedAnalyticCloudLayer extends ExtractedCookedCloudGeometry {
  readonly status: 'analytic';
  readonly sample: MediumSample;
}

export interface CloudTextureFact {
  readonly role: 'layoutPattern' | 'layoutMask' | 'heightProfile' | 'bodyNoise';
  readonly guid: string;
  readonly handle: AssetHandle<'texture'>;
  readonly revision: number;
  readonly dimension: '2d' | '3d';
}

export interface ExtractedSampledCloudLayer extends ExtractedCookedCloudGeometry {
  readonly status: 'sampled';
  readonly materialGuid: string;
  readonly cookIdentity: string;
  readonly programIdentity: string;
  readonly kernelIdentity: string;
  readonly textures: readonly CloudTextureFact[];
  readonly layoutScaleMeters: number;
  readonly coverageBias: number;
  readonly extinctionPerMeter: number;
  readonly albedo: readonly [number, number, number, number];
  readonly weights: readonly [number, number, number, number, number];
  readonly windOffsetMeters: readonly [number, number, number];
  readonly useDetail: boolean;
  readonly skipEmpty: boolean;
  readonly viewSampleCountScale: number;
  readonly stopTransmittance: number;
  readonly diagnostic: readonly [number, number, number];
}

export interface ExtractedProgramCloudLayer extends ExtractedCookedCloudGeometry {
  readonly diagnostic: readonly [number, number, number];
  readonly status: 'program';
  readonly materialGuid: string;
  readonly instanceGuid?: string;
  readonly cookIdentity: string;
  readonly programIdentity: string;
  readonly rendererSource: string;
  readonly extinctionOverridePerMeter?: number;
  readonly materialParameters: Float32Array;
  readonly windOffsetMeters: readonly [number, number, number];
  readonly viewSampleCountScale: number;
  readonly stopTransmittance: number;
}

export type ExtractedCookedCloudLayer =
  | ExtractedAnalyticCloudLayer
  | ExtractedSampledCloudLayer
  | ExtractedProgramCloudLayer;
export type ExtractedCloudLayer = ExtractedCookedCloudLayer;

type ReadCloudField = (name: string) => number | undefined;
type CloudBounds = Pick<
  ExtractedCookedCloudGeometry,
  'bottomMeters' | 'thicknessMeters' | 'entryLimitMeters' | 'traceLimitMeters'
>;

function invalidCloudInput(name: string, value: unknown, expectation: string) {
  return err(new CloudLayerInvalidParameterError(name, value, expectation));
}

function extractCloudBounds(field: ReadCloudField): Result<CloudBounds, CloudLayerError> {
  const bottomMeters = field('bottomMeters') as number;
  const thicknessMeters = field('thicknessMeters') as number;
  const entryLimitMeters = field('entryLimitMeters') as number;
  const traceLimitMeters = field('traceLimitMeters') as number;
  for (const [name, value] of Object.entries({
    bottomMeters,
    thicknessMeters,
    entryLimitMeters,
    traceLimitMeters,
  })) {
    if (!Number.isFinite(value) || value <= 0)
      return err(new CloudLayerInvalidParameterError(name, value, 'finite and greater than zero'));
  }
  return ok({ bottomMeters, thicknessMeters, entryLimitMeters, traceLimitMeters });
}

function extractCloudLighting(
  field: ReadCloudField,
): Result<NonNullable<ExtractedCookedCloudGeometry['lighting']>, CloudLayerError> {
  const phase = [field('phaseG'), field('phaseG2'), field('phaseBlend')] as [
    number,
    number,
    number,
  ];
  const multipleScattering = [
    field('msContribution'),
    field('msOcclusion'),
    field('msEccentricity'),
    field('multiScatteringOctaves'),
  ] as [number, number, number, number];
  const shadow = [field('selfShadow'), field('shadowSamples'), field('shadowDistanceMeters')] as [
    number,
    number,
    number,
  ];
  if (
    !phase.every(Number.isFinite) ||
    Math.abs(phase[0]) >= 1 ||
    Math.abs(phase[1]) >= 1 ||
    phase[2] < 0 ||
    phase[2] > 1 ||
    !multipleScattering.every(Number.isFinite) ||
    multipleScattering.some((value, index) => value < 0 || value > (index === 3 ? 2 : 1)) ||
    !shadow.every(Number.isFinite) ||
    shadow[1] < 1 ||
    shadow[1] > 64 ||
    shadow[2] < 0 ||
    ![0, 1].includes(field('atmosphereTransmittanceMode') as number)
  )
    return err(
      new CloudLayerInvalidParameterError(
        'lighting',
        { phase, multipleScattering, shadow },
        'bounded finite phase, multiple-scattering and secondary-shadow settings',
      ),
    );
  return ok({
    phase,
    multipleScattering,
    shadow,
    atmosphereTransmittanceMode: field('atmosphereTransmittanceMode') as number,
    enableDistantSkyLightSampling: field('enableDistantSkyLightSampling') !== 0,
  });
}

function validShadowProjection(mapSettings: CloudShadowSettings): boolean {
  const { directionToLight } = mapSettings;
  return (
    directionToLight.every(Number.isFinite) &&
    Math.hypot(...directionToLight) !== 0 &&
    [mapSettings.extentMeters, mapSettings.lightDistanceMeters, mapSettings.depthMeters].every(
      (distance) => Number.isFinite(distance) && (distance as number) > 0,
    ) &&
    Number.isSafeInteger(mapSettings.resolution) &&
    mapSettings.resolution >= 16 &&
    mapSettings.resolution <= 2048 &&
    Number.isSafeInteger(mapSettings.mapSamples) &&
    mapSettings.mapSamples >= 1 &&
    mapSettings.mapSamples <= 256 &&
    [0, 1].includes(mapSettings.mode) &&
    Number.isFinite(mapSettings.biasMeters) &&
    [mapSettings.strength, mapSettings.surfaceStrength, mapSettings.atmosphereStrength].every(
      (value) => Number.isFinite(value) && Number(value) >= 0 && Number(value) <= 1,
    )
  );
}

function extractCloudShadow(
  world: World,
  field: ReadCloudField,
): Result<CloudShadowSettings, CloudLayerError> {
  const read = world[worldRead];
  const sunQuery = cloudDirectionalLightQuery(world);
  let sun: EntityHandle | undefined;
  if (sunQuery.ok)
    for (const row of sunQuery.value) {
      sun = row.entity;
      break;
    }
  if (sun === undefined)
    return err(
      new CloudLayerInvalidParameterError(
        'sun',
        sun,
        'an authored primary DirectionalLight for cloud lighting',
      ),
    );
  const directionToLight = [0, 1, 2].map(
    (index) => -(read.getArrayElement(sun, DirectionalLight, 'direction', index) as number),
  ) as [number, number, number];
  const mapSettings = {
    directionToLight,
    lightDistanceMeters: field('shadowLightDistanceMeters') as number,
    depthMeters: field('shadowFarDepthMeters') as number,
    extentMeters: field('shadowExtentMeters') as number,
    resolution: field('shadowResolution') as number,
    mapSamples: field('shadowMapSamples') as number,
    mode: field('shadowMode') as number,
    cast: field('castCloudShadows') !== 0,
    biasMeters: field('shadowDepthBiasMeters') as number,
    strength: field('shadowStrength') as number,
    surfaceStrength: field('surfaceShadowStrength') as number,
    atmosphereStrength: field('atmosphereShadowStrength') as number,
  };
  if (!validShadowProjection(mapSettings)) {
    return err(
      new CloudLayerInvalidParameterError(
        'shadowMap',
        mapSettings,
        'bounded finite BSM projection settings',
      ),
    );
  }
  return ok(mapSettings);
}

function readCloudWind(world: World, owner: EntityHandle) {
  const wind = readRenderArrayView(
    world,
    owner,
    VolumetricCloudLayer,
    'windOffsetMeters',
  ) as Float32Array;
  return [wind[0] ?? NaN, wind[1] ?? NaN, wind[2] ?? NaN] as const;
}

function extractProgramTrace(
  world: World,
  owner: EntityHandle,
  field: ReadCloudField,
  materialGuid: string,
) {
  const windOffsetMeters = readCloudWind(world, owner);
  const viewSampleCountScale = field('viewSampleCountScale') as number;
  const stopTransmittance = field('stopTransmittance') as number;
  if (
    !windOffsetMeters.every(Number.isFinite) ||
    !Number.isFinite(viewSampleCountScale) ||
    viewSampleCountScale < 0 ||
    !Number.isFinite(stopTransmittance) ||
    stopTransmittance < 0 ||
    stopTransmittance > 1
  )
    return err(
      new CloudLayerInvalidParameterError('trace', materialGuid, 'finite trace and wind settings'),
    );
  return ok({ windOffsetMeters, viewSampleCountScale, stopTransmittance });
}

function extractProgramCloud(
  world: World,
  owner: EntityHandle,
  material: AssetHandle<'cloud-material', CloudMaterialAsset>,
  cooked: CloudMaterialAsset,
  rendererPrograms: Readonly<Record<string, string>>,
  cookedGeometry: ExtractedCookedCloudGeometry,
  requestRevision: number,
  field: ReadCloudField,
  extinction: number,
): Result<ExtractedProgramCloudLayer, CloudLayerError> {
  const scope = worldRenderResources(world);
  const materialGuid = scope.sourceForAsset(material)?.guid;
  const instanceHandle = field('materialInstance') as
    | AssetHandle<'cloud-material-instance', CloudMaterialInstanceAsset>
    | undefined;
  const instance = instanceHandle ? world.assets?.read(instanceHandle) : undefined;
  if (materialGuid === undefined || (instanceHandle && !instance?.ok))
    return err(
      new CloudLayerInvalidParameterError(
        'materialInstance',
        instanceHandle,
        'a loaded instance of the selected material',
      ),
    );
  const resolved = resolveCloudMaterial(
    cooked,
    instance?.ok ? instance.value : undefined,
    { guid: materialGuid, source: 'render extraction' },
    new Map(),
  );
  if (!resolved.ok || !resolved.value.variant)
    return err(
      new CloudLayerInvalidParameterError(
        'material',
        materialGuid,
        'a complete resolved renderer variant',
      ),
    );
  const variant = resolved.value.variant;
  const rendererSource = rendererPrograms[variant.programIdentity];
  if (rendererSource === undefined || variant.renderer === undefined)
    return err(
      new CloudLayerInvalidParameterError(
        'renderer',
        variant.programIdentity,
        'the verified cooked renderer artifact',
      ),
    );
  const trace = extractProgramTrace(world, owner, field, materialGuid);
  if (!trace.ok) return trace;
  const instanceGuid = instanceHandle ? scope.sourceForAsset(instanceHandle)?.guid : undefined;
  if (instanceHandle && instanceGuid === undefined)
    return err(
      new CloudLayerInvalidParameterError(
        'materialInstance',
        instanceHandle,
        'a captured publication GUID',
      ),
    );
  return ok({
    status: 'program',
    diagnostic: [
      field('diagnosticMode') as number,
      field('diagnosticPixelX') as number,
      field('diagnosticPixelY') as number,
    ],
    extinctionOverridePerMeter: extinction,
    ...cookedGeometry,
    materialGuid,
    ...(instanceGuid === undefined ? {} : { instanceGuid }),
    cookIdentity: cooked.cookIdentity,
    programIdentity: variant.programIdentity,
    rendererSource,
    ...(requestRevision === 0
      ? {}
      : {
          adoption: {
            ...cloudAdoptionSource(
              world,
              owner,
              requestRevision,
              cooked.cookIdentity,
              materialGuid,
              instanceGuid,
            ),
            ...(cooked.sample === undefined
              ? {}
              : { uniformExtinctionPerMeter: cooked.sample.extinctionPerMeter }),
            programValues: {
              ...Object.fromEntries(
                variant.renderer.parameterNames.flatMap((name) => {
                  const value = resolved.value.values[name];
                  return value === undefined ? [] : [[name, value] as const];
                }),
              ),
              ...variant.staticValues,
            },
          },
        }),
    materialParameters: encodeCloudRendererParameters(cooked.parameters, resolved.value.values),
    ...trace.value,
  });
}

function resolveSampledCloudInstance(
  world: World,
  material: CloudMaterialAsset,
  materialGuid: string,
  field: ReadCloudField,
) {
  const instanceHandle = field('materialInstance') as
    | AssetHandle<'cloud-material-instance', CloudMaterialInstanceAsset>
    | undefined;
  const instance = instanceHandle ? world.assets?.read(instanceHandle) : undefined;
  if (instanceHandle && !instance?.ok)
    return invalidCloudInput(
      'materialInstance',
      instanceHandle,
      'a loaded instance of the selected material',
    );
  const overrides: Record<string, CloudParameterValue> = {
    ...(instance?.ok ? instance.value.overrides : {}),
  };
  const detailOverride = field('useDetail');
  if (detailOverride !== 0 && detailOverride !== 1 && detailOverride !== 2)
    return invalidCloudInput('useDetail', detailOverride, 'a cooked static detail selection');
  if (detailOverride !== 2) overrides.useDetail = detailOverride === 1;
  const effectiveInstance: CloudMaterialInstanceAsset = {
    ...(instance?.ok
      ? instance.value
      : {
          kind: 'cloud-material-instance',
          version: 1,
          material: materialGuid,
          parameterIdentity: cloudIdentity(material.parameters),
        }),
    overrides,
  };

  return ok({ effectiveInstance, instanceHandle, overrides });
}

function resolveSampledCloudTextures(
  scope: ReturnType<typeof worldRenderResources>,
  material: CloudMaterialAsset,
  materialGuid: string,
  overrides: Readonly<Record<string, CloudParameterValue>>,
) {
  const textureValues = new Map<string, TextureAsset>();
  const textureFacts = new Map<string, CloudTextureFact>();
  for (const [name, parameter] of Object.entries(material.parameters)) {
    if (parameter.kind !== 'texture') continue;
    const guid = overrides[name] ?? parameter.default;
    if (typeof guid !== 'string') return invalidCloudInput(name, guid, 'a cooked texture GUID');
    const textureHandle = scope.handleForGuid(guid) as AssetHandle<'texture'> | undefined;
    const revision = textureHandle === undefined ? undefined : scope.assetRevision(textureHandle);
    if (textureHandle === undefined || revision === undefined)
      return invalidCloudInput(name, guid, 'a live texture in the cooked dependency closure');
    // The source World has not pinned the publication version yet. Capture
    // its current payload and revision together inside this synchronous read.
    const resolved = scope.resolveAsset<TextureAsset>(textureHandle);
    if (
      !resolved.ok ||
      resolved.value.kind !== 'texture' ||
      !verifyCloudTexture(parameter, resolved.value)
    )
      return invalidCloudInput(
        name,
        guid,
        `the exact cooked ${parameter.dimension} texture version`,
      );
    textureValues.set(guid, resolved.value);
    const role = CLOUD_REFERENCE_TEXTURE_ROLES.find(([role]) => role === name);
    if (role !== undefined) {
      if (parameter.dimension !== role[1])
        return invalidCloudInput(name, parameter, `a cooked ${role[1]} texture parameter`);
      textureFacts.set(name, {
        role: role[0],
        guid,
        handle: textureHandle,
        revision,
        dimension: role[1],
      });
    }
  }
  const textures: CloudTextureFact[] = [];
  for (const [role] of CLOUD_REFERENCE_TEXTURE_ROLES) {
    const texture = textureFacts.get(role);
    if (texture === undefined)
      return invalidCloudInput(role, materialGuid, 'a cooked reference texture parameter');
    textures.push(texture);
  }

  return ok({ textures, textureValues });
}

type SampledDensity = Pick<
  ExtractedSampledCloudLayer,
  'layoutScaleMeters' | 'coverageBias' | 'extinctionPerMeter' | 'albedo' | 'weights' | 'useDetail'
>;

function extractSampledDensity(
  material: CloudMaterialAsset,
  values: Readonly<Record<string, CloudParameterValue>>,
  field: ReadCloudField,
  extinction: number,
  materialGuid: string,
): Result<SampledDensity, CloudLayerError> {
  const scalar = (name: string) => {
    const value = values[name];
    return material.parameters[name]?.kind === 'scalar' && typeof value === 'number' ? value : NaN;
  };
  const useDetail = values.useDetail;
  if (material.parameters.useDetail?.kind !== 'static' || typeof useDetail !== 'boolean')
    return invalidCloudInput('useDetail', useDetail, 'a cooked static detail selection');
  const layoutScaleMeters = scalar('layoutScaleMeters');
  const coverageOverride = field('coverageBias');
  const coverageBias = coverageOverride === -2 ? scalar('coverageBias') : (coverageOverride ?? NaN);
  const extinctionPerMeter = extinction < 0 ? scalar('extinctionPerMeter') : extinction;
  const weight = (name: string) => {
    const override = field(name);
    return override === -1 ? scalar(name) : (override ?? NaN);
  };
  const weights = [
    weight('layoutWeight'),
    weight('maskWeight'),
    weight('profileWeight'),
    weight('bodyWeight'),
    weight('erosionWeight'),
  ] as const;
  const albedoValue = values.albedo;
  const albedo: CloudVector | undefined =
    material.parameters.albedo?.kind === 'vector' && Array.isArray(albedoValue)
      ? (albedoValue as CloudVector)
      : undefined;
  if (
    albedo?.length !== 4 ||
    !albedo.every((v) => Number.isFinite(v) && v >= 0 && v <= 1) ||
    !Number.isFinite(layoutScaleMeters) ||
    layoutScaleMeters <= 0 ||
    !Number.isFinite(extinctionPerMeter) ||
    extinctionPerMeter < 0 ||
    !Number.isFinite(coverageBias) ||
    coverageBias < -1 ||
    coverageBias > 1 ||
    !weights.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)
  )
    return invalidCloudInput(
      'density',
      materialGuid,
      'finite bounded cooked density parameters and overrides',
    );

  return ok({ layoutScaleMeters, coverageBias, extinctionPerMeter, albedo, weights, useDetail });
}

function extractSampledTrace(world: World, owner: EntityHandle, field: ReadCloudField) {
  const windOffsetMeters = readCloudWind(world, owner);
  const diagnostic = [
    field('diagnosticMode') ?? NaN,
    field('diagnosticPixelX') ?? NaN,
    field('diagnosticPixelY') ?? NaN,
  ] as const;
  const viewSampleCountScale = field('viewSampleCountScale') ?? NaN;
  const stopTransmittance = field('stopTransmittance') ?? NaN;
  if (
    !Number.isFinite(viewSampleCountScale) ||
    viewSampleCountScale < 0 ||
    !Number.isFinite(stopTransmittance) ||
    stopTransmittance < 0 ||
    stopTransmittance > 1
  )
    return invalidCloudInput(
      'trace',
      [viewSampleCountScale, stopTransmittance],
      'a nonnegative sample scale and a transmittance threshold in [0, 1]',
    );
  if (
    !windOffsetMeters.every(Number.isFinite) ||
    !diagnostic.every(Number.isSafeInteger) ||
    diagnostic[0] < 0 ||
    diagnostic[0] > 4 ||
    diagnostic[1] < 0 ||
    diagnostic[2] < 0
  )
    return invalidCloudInput(
      'diagnostic',
      diagnostic,
      'valid wind offset and a bounded diagnostic pixel',
    );

  return ok({ windOffsetMeters, diagnostic, viewSampleCountScale, stopTransmittance });
}

function extractUniformCloud(
  world: World,
  owner: EntityHandle,
  material: AssetHandle<'cloud-material', CloudMaterialAsset>,
  cooked: CloudMaterialAsset,
  cookedGeometry: ExtractedCookedCloudGeometry,
  requestRevision: number,
  extinction: number,
): Result<ExtractedAnalyticCloudLayer, CloudLayerError> {
  const sample = cooked.sample;
  if (sample === undefined)
    return err(
      new CloudLayerInvalidParameterError('material', material, 'a cooked uniform sample'),
    );
  return ok({
    status: 'analytic',
    ...cookedGeometry,
    ...(requestRevision === 0
      ? {}
      : {
          adoption: cloudAdoptionSource(
            world,
            owner,
            requestRevision,
            cooked.cookIdentity,
            worldRenderResources(world).sourceForAsset(material)?.guid,
          ),
        }),
    sample: extinction < 0 ? sample : { ...sample, extinctionPerMeter: extinction },
  });
}

function extractCookedCloud(
  world: World,
): Result<ExtractedCookedCloudLayer | null | undefined, CloudLayerError> {
  const query = extractVolumetricCloudLayerQuery(world);
  if (!query.ok) return ok(undefined);
  let owner: EntityHandle | undefined;
  let count = 0;
  for (const row of query.value) {
    owner ??= row.entity;
    count += 1;
  }
  if (owner === undefined) return ok(undefined);
  if (count > 1) return err(new CloudLayerOwnerConflictError(count));
  const read = world[worldRead];
  const field = (name: string) => read.getFieldValue(owner, VolumetricCloudLayer, name);
  if (field('enabled') === 0) return ok(null);
  const material = field('material') as AssetHandle<'cloud-material', CloudMaterialAsset>;
  const cooked = world.assets?.read(material);
  if (!cooked?.ok)
    return err(
      new CloudLayerInvalidParameterError('material', material, 'a loaded cooked cloud material'),
    );
  const bounds = extractCloudBounds(field);
  if (!bounds.ok) return bounds;
  const extinction = field('extinctionOverridePerMeter') as number;
  if (!Number.isFinite(extinction) || (extinction < 0 && extinction !== -1))
    return err(
      new CloudLayerInvalidParameterError(
        'extinctionOverridePerMeter',
        extinction,
        '-1 or a finite nonnegative number',
      ),
    );
  const lighting = extractCloudLighting(field);
  if (!lighting.ok) return lighting;
  const requestRevision = field('requestRevision') ?? 0;
  const initializationRevision = field('initializationRevision') ?? 0;
  const shadow = extractCloudShadow(world, field);
  if (!shadow.ok) return shadow;
  const cookedGeometry = {
    ...bounds.value,
    lighting: lighting.value,
    initializationRevision,
    shadowSettings: shadow.value,
  };
  if (cooked.value.model === 'uniform' && cooked.value.rendererPrograms === undefined) {
    return extractUniformCloud(
      world,
      owner,
      material,
      cooked.value,
      cookedGeometry,
      requestRevision,
      extinction,
    );
  }
  if (cooked.value.rendererPrograms !== undefined) {
    return extractProgramCloud(
      world,
      owner,
      material,
      cooked.value,
      cooked.value.rendererPrograms,
      cookedGeometry,
      requestRevision,
      field,
      extinction,
    );
  }
  return extractSampledCloud(
    world,
    owner,
    material,
    cooked.value,
    cookedGeometry,
    requestRevision,
    field,
    extinction,
  );
}

function cloudAdoptionSource(
  world: World,
  entity: EntityHandle,
  requestRevision: number,
  cookIdentity: string,
  materialGuid?: string,
  instanceGuid?: string,
): CloudAdoptionSource {
  return {
    requestRevision,
    worldIdentity: world.identity,
    entity,
    cookIdentity,
    ...(materialGuid === undefined ? {} : { materialGuid }),
    ...(instanceGuid === undefined ? {} : { instanceGuid }),
  };
}

function extractSampledCloud(
  world: World,
  owner: EntityHandle,
  handle: AssetHandle<'cloud-material', CloudMaterialAsset>,
  material: CloudMaterialAsset,
  geometry: ExtractedCookedCloudGeometry,
  requestRevision: number,
  field: (name: string) => number | undefined,
  extinction: number,
): Result<ExtractedSampledCloudLayer, CloudLayerError> {
  const scope = worldRenderResources(world);
  const materialGuid = scope.sourceForAsset(handle)?.guid;
  const kernelIdentity = material.densityKernelIdentity;
  if (
    materialGuid === undefined ||
    kernelIdentity === undefined ||
    !/^[0-9a-f]{64}$/.test(kernelIdentity)
  )
    return invalidCloudInput(
      'material',
      materialGuid,
      'a cooked reference material with canonical density identity',
    );
  const selected = resolveSampledCloudInstance(world, material, materialGuid, field);
  if (!selected.ok) return selected;
  const { effectiveInstance, instanceHandle, overrides } = selected.value;
  const textureClosure = resolveSampledCloudTextures(scope, material, materialGuid, overrides);
  if (!textureClosure.ok) return textureClosure;
  const { textures, textureValues } = textureClosure.value;
  // Component static selection participates before the resolver selects a variant.
  const resolved = resolveCloudMaterial(
    material,
    effectiveInstance,
    { guid: materialGuid, source: 'render extraction' },
    textureValues,
  );
  if (!resolved.ok || resolved.value.variant === undefined)
    return invalidCloudInput(
      'materialInstance',
      instanceHandle,
      'a complete resolved sampled variant',
    );
  const { values, variant } = resolved.value;
  const density = extractSampledDensity(material, values, field, extinction, materialGuid);
  if (!density.ok) return density;
  const trace = extractSampledTrace(world, owner, field);
  if (!trace.ok) return trace;
  return ok({
    status: 'sampled',
    ...geometry,
    ...(requestRevision === 0
      ? {}
      : {
          adoption: cloudAdoptionSource(
            world,
            owner,
            requestRevision,
            material.cookIdentity,
            materialGuid,
            instanceHandle ? scope.sourceForAsset(instanceHandle)?.guid : undefined,
          ),
        }),
    materialGuid,
    cookIdentity: material.cookIdentity,
    programIdentity: variant.programIdentity,
    kernelIdentity,
    textures,
    ...density.value,
    ...trace.value,
    skipEmpty: field('skipEmpty') !== 0,
  });
}

export function extractStandardCloudLayer(
  world: World,
): Result<ExtractedCloudLayer | undefined, CloudLayerError> {
  const cooked = extractCookedCloud(world);
  if (!cooked.ok) return cooked;
  return ok(cooked.value ?? undefined);
}

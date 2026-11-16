import type { RenderFeatureExtractView } from '../../features/types';
import type { CloudParameterValue } from '../contracts';
import type { CloudAdoptionSource, ExtractedCookedCloudLayer } from '../extract';
import type { CloudCompletedAdoption } from '../inspection';
import { cookedCloudViewSampleBudget } from '../tracing/policy';

export type CloudRecordedAdoption = Omit<
  CloudCompletedAdoption,
  'frameId' | 'deviceGeneration' | 'graphGeneration'
>;

type Availability = CloudCompletedAdoption['unavailableFields'][string];

const referenceDensityFields = [
  'layoutWeight',
  'maskWeight',
  'profileWeight',
  'bodyWeight',
  'erosionWeight',
  'coverageBias',
  'useDetail',
  'skipEmpty',
] as const;
const mapFields = [
  'shadowExtentMeters',
  'shadowLightDistanceMeters',
  'shadowFarDepthMeters',
  'shadowDepthBiasMeters',
  'shadowStrength',
  'shadowResolution',
  'shadowMapSamples',
] as const;
const rayFields = ['shadowSamples', 'shadowDistanceMeters'] as const;

function uniformValue(value: CloudParameterValue): CloudParameterValue {
  if (typeof value === 'number') return Math.fround(value);
  if (typeof value !== 'object') return value;
  return value.length === 3
    ? Object.freeze([Math.fround(value[0]), Math.fround(value[1]), Math.fround(value[2])] as const)
    : Object.freeze([
        Math.fround(value[0]),
        Math.fround(value[1]),
        Math.fround(value[2]),
        Math.fround(value[3]),
      ] as const);
}

type MaterialLayer = Exclude<ExtractedCookedCloudLayer, { status: 'analytic' }>;
type AdoptedValues = Record<string, CloudParameterValue>;
type MarkUnavailable = (fields: readonly string[], status: Availability) => void;

function captureShadowMap(
  map: NonNullable<MaterialLayer['shadowMap']>,
  atmosphereAvailable: boolean,
  selfShadow: boolean,
  values: AdoptedValues,
  unavailable: MarkUnavailable,
): void {
  const surface = map.cast ? Math.fround(map.surfaceStrength) : 0;
  const atmosphere = map.cast && atmosphereAvailable ? Math.fround(map.atmosphereStrength ?? 1) : 0;
  values.castCloudShadows = surface > 0 || atmosphere > 0;
  values.groundShadowEnabled = surface > 0;
  values.atmosphereShadowEnabled = atmosphere > 0;
  if (surface > 0) values.surfaceShadowStrength = surface;
  else unavailable(['surfaceShadowStrength'], 'inactive');
  if (atmosphere > 0) values.atmosphereShadowStrength = atmosphere;
  else unavailable(['atmosphereShadowStrength'], 'inactive');
  if (surface > 0 || atmosphere > 0 || (selfShadow && map.mode === 1)) {
    values.shadowExtentMeters = Math.fround(map.extentMeters);
    values.shadowLightDistanceMeters = Math.fround(map.lightDistanceMeters ?? 300000);
    values.shadowFarDepthMeters = Math.fround(map.depthMeters);
    values.shadowDepthBiasMeters = Math.fround(map.biasMeters);
    values.shadowStrength = Math.fround(map.strength);
    values.shadowResolution = map.resolution;
    values.shadowMapSamples = map.mapSamples;
  } else unavailable(mapFields, 'inactive');
}

function captureShadowSettings(
  layer: MaterialLayer,
  shadow: readonly [number, number, number],
  values: AdoptedValues,
  unavailable: MarkUnavailable,
  recordedShadow: boolean,
): void {
  const [enabled, samples, distance] = shadow;
  const map = layer.shadowMap;
  values.selfShadow = enabled !== 0;
  if (enabled !== 0 && (map?.mode !== 1 || recordedShadow)) values.shadowMode = map?.mode ?? 0;
  else unavailable(['shadowMode'], enabled === 0 ? 'inactive' : 'unsupported');
  if (enabled !== 0 && map?.mode !== 1) {
    values.shadowSamples = samples;
    values.shadowDistanceMeters = Math.fround(distance);
  } else unavailable(rayFields, 'inactive');
  if (map !== undefined && recordedShadow) {
    captureShadowMap(
      map,
      layer.lightEnvironment?.atmosphereAvailable === true,
      enabled !== 0,
      values,
      unavailable,
    );
  }
}

function captureMaterialLighting(
  layer: MaterialLayer,
  values: AdoptedValues,
  unavailable: MarkUnavailable,
  recordedShadow: boolean,
): void {
  values.windOffsetMeters = uniformValue(layer.windOffsetMeters);
  values.viewSampleCountScale = layer.viewSampleCountScale;
  values.viewSampleCountMax = cookedCloudViewSampleBudget(layer.viewSampleCountScale);
  values.stopTransmittance = Math.fround(layer.stopTransmittance);
  const lighting = layer.lighting;
  if (lighting !== undefined) {
    const [g, g2, blend] = lighting.phase;
    values.phaseG = Math.fround(g);
    values.phaseBlend = Math.fround(blend);
    if (blend > 0) values.phaseG2 = Math.fround(g2);
    else unavailable(['phaseG2'], 'inactive');
    const [contribution, occlusion, eccentricity, octaves] = lighting.multipleScattering;
    values.multiScatteringOctaves = octaves;
    if (octaves > 0) {
      values.msContribution = Math.fround(contribution);
      values.msOcclusion = Math.fround(occlusion);
      values.msEccentricity = Math.fround(eccentricity);
    } else unavailable(['msContribution', 'msOcclusion', 'msEccentricity'], 'inactive');
    if (layer.lightEnvironment?.atmosphereAvailable === true)
      values.atmosphereTransmittanceMode = lighting.atmosphereTransmittanceMode ?? 0;
    else unavailable(['atmosphereTransmittanceMode'], 'inactive');
    if (layer.lightEnvironment?.groundSolarTransmittance !== undefined)
      values.groundSolarTransmittance = uniformValue(
        layer.lightEnvironment.groundSolarTransmittance,
      );
    if (
      layer.lightEnvironment?.skySource === 'atmosphere' ||
      layer.lightEnvironment?.skySource === 'skylight'
    )
      values.enableDistantSkyLightSampling = lighting.enableDistantSkyLightSampling ?? true;
    else unavailable(['enableDistantSkyLightSampling'], 'inactive');
    captureShadowSettings(layer, lighting.shadow, values, unavailable, recordedShadow);
  }
}

function captureMaterialValues(
  layer: ExtractedCookedCloudLayer,
  source: CloudAdoptionSource,
  values: AdoptedValues,
  unavailable: MarkUnavailable,
): AdoptedValues | undefined {
  if (layer.status === 'program') {
    let materialValues: AdoptedValues;
    materialValues = Object.create(null) as Record<string, CloudParameterValue>;
    for (const [name, value] of Object.entries(source.programValues ?? {}))
      if (value !== undefined) materialValues[name] = uniformValue(value);
    if (typeof materialValues.useDetail === 'boolean') values.useDetail = materialValues.useDetail;
    const extinction = layer.extinctionOverridePerMeter;
    if (extinction !== undefined && extinction >= 0)
      values.extinctionPerMeter = Math.fround(extinction);
    else if (source.uniformExtinctionPerMeter !== undefined)
      values.extinctionPerMeter = Math.fround(source.uniformExtinctionPerMeter);
    else unavailable(['extinctionPerMeter'], 'unsupported');
    unavailable(referenceDensityFields, 'unsupported');
    return materialValues;
  } else if (layer.status === 'sampled') {
    Object.assign(values, {
      extinctionPerMeter: Math.fround(layer.extinctionPerMeter),
      coverageBias: Math.fround(layer.coverageBias),
      layoutScaleMeters: Math.fround(layer.layoutScaleMeters),
      layoutWeight: Math.fround(layer.weights[0]),
      maskWeight: Math.fround(layer.weights[1]),
      profileWeight: Math.fround(layer.weights[2]),
      bodyWeight: Math.fround(layer.weights[3]),
      erosionWeight: Math.fround(layer.weights[4]),
      albedo: uniformValue(layer.albedo),
      useDetail: layer.useDetail,
      skipEmpty: layer.skipEmpty,
    });
    for (const texture of layer.textures) values[texture.role] = texture.guid;
  } else {
    values.extinctionPerMeter = Math.fround(layer.sample.extinctionPerMeter);
    values.albedo = uniformValue(layer.sample.albedo);
    unavailable(referenceDensityFields, 'unsupported');
    unavailable(
      [
        'windOffsetMeters',
        'viewSampleCountScale',
        'viewSampleCountMax',
        'stopTransmittance',
        'phaseG',
        'phaseG2',
        'phaseBlend',
        'multiScatteringOctaves',
        'msContribution',
        'msOcclusion',
        'msEccentricity',
        'atmosphereTransmittanceMode',
        'enableDistantSkyLightSampling',
        'selfShadow',
        'shadowMode',
        'castCloudShadows',
        'groundShadowEnabled',
        'atmosphereShadowEnabled',
        'surfaceShadowStrength',
        'atmosphereShadowStrength',
        ...mapFields,
        ...rayFields,
      ],
      'unsupported',
    );
  }
  return undefined;
}

/** Capture the render plan's effective inputs only after its physical cloud draws were accepted. */
export function captureCloudAdoption(
  layer: ExtractedCookedCloudLayer,
  view: RenderFeatureExtractView | undefined,
  recordedShadow: boolean,
): CloudRecordedAdoption | undefined {
  const source = layer.adoption;
  if (source === undefined) return undefined;
  const values: Record<string, CloudParameterValue> = Object.create(null);
  const unavailableFields: Record<string, Availability> = Object.create(null);
  const unavailable = (fields: readonly string[], status: Availability): void => {
    for (const field of fields) if (values[field] === undefined) unavailableFields[field] = status;
  };
  const materialValues = captureMaterialValues(layer, source, values, unavailable);
  unavailable(
    ['sunElevation', 'sunAzimuth', 'windX', 'windY', 'windZ', 'referenceTimeSeconds', 'exposure'],
    'unsupported',
  );
  Object.assign(values, {
    enabled: true,
    bottomMeters: Math.fround(layer.bottomMeters),
    thicknessMeters: Math.fround(layer.thicknessMeters),
    entryLimitMeters: Math.fround(layer.entryLimitMeters),
    traceLimitMeters: Math.fround(layer.traceLimitMeters),
  });
  if (layer.initializationRevision !== undefined)
    values.initializationRevision = layer.initializationRevision;
  const sun = view?.frame?.cloudSun;
  if (sun !== undefined) {
    values.sunDirectionToLight = Object.freeze([
      Math.fround(-(sun.direction[0] ?? 0)),
      Math.fround(-(sun.direction[1] ?? -1)),
      Math.fround(-(sun.direction[2] ?? 0)),
    ] as const);
    values.sunIlluminanceLux = sun.intensity;
  } else unavailable(['sunDirectionToLight', 'sunIlluminanceLux'], 'unsupported');
  if (layer.status !== 'analytic') {
    captureMaterialLighting(layer, values, unavailable, recordedShadow);
  }
  return Object.freeze({
    requestRevision: source.requestRevision,
    worldIdentity: source.worldIdentity,
    entity: source.entity,
    cookIdentity: source.cookIdentity,
    ...(source.materialGuid === undefined ? {} : { materialGuid: source.materialGuid }),
    ...(source.instanceGuid === undefined ? {} : { instanceGuid: source.instanceGuid }),
    ...(layer.status === 'analytic' ? {} : { programIdentity: layer.programIdentity }),
    path: layer.status,
    values: Object.freeze(values),
    ...(materialValues === undefined ? {} : { materialValues: Object.freeze(materialValues) }),
    unavailableFields: Object.freeze(unavailableFields),
  });
}

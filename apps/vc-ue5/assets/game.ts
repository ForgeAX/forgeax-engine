import type { GameProjectionValue } from '@forgeax/engine/app';
import { defineSystem, Time, Update } from '@forgeax/engine/ecs';
import {
  InputFrameStartScan, INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot,
} from '@forgeax/engine/input';
import type { Plugin } from '@forgeax/engine/plugin';
import {
  Camera, DirectionalLight, TONEMAP_NONE, Visibility, VisibilityStateValue, VolumetricCloudLayer,
} from '@forgeax/engine/render';
import { cloudMaterialKind, cloudMaterialInstanceKind, resolveCloudParameters } from '@forgeax/engine/render/authoring';
import {
  PropagateTransforms, Transform, sceneEntity, worldDespawnScene, worldResolveSceneEntity,
} from '@forgeax/engine/scene';
import type { AssetHandle } from '@forgeax/engine/types';
import {
  GROUND_ENTITY_KEYS, GROUND_SCENE_KEY, cameraTransform, type GroundEntityKey,
} from './ground-scene.ts';
import { ueCloudWindOffset } from '@forgeax-assets/volumetric-clouds/reference';
import { shadowConsumerFields, type CloudShadowControls } from './cloud-shadow-controls.ts';
import { readSunFields, sunDirection, sunFieldsFromDirection, type SunFields } from './sun-controls.ts';
import {
  CLOUD_MODES, isRecord, isSampledCloudMode, observeCloudRenderer, readCloudSnapshot, receiptTimingMatchesCompletion,
  sameCloudFrameEpoch, unavailableParameter, validateCloudEdit,
  type CameraView, type CloudAssets, type CloudConfiguration, type CloudEdit, type CloudMaterialMode,
  type CloudMode, type CloudPreset, type CloudRenderEvidence, type CloudSnapshotV1, type ReadyCloudFrame,
} from './cloud-controls.ts';
import { createCloudRequestTracker, createCloudSnapshotHistory, readWorldReadyCloudFrame } from './cloud-inspection.ts';
import { cloudParameterLabels, type CloudParameterKey } from './parameter-labels.ts';
import { readWeatherPreset, WEATHER_PRESET_IDS, WEATHER_PRESETS, WEATHER_PARAMETER_KEYS,
  weatherAtmosphereParameters, weatherCutPose, weatherRoutePose } from './weather-presets.ts';
import { matchQualityPreset, QUALITY_PRESETS, readQualityPreset } from './quality-presets.ts';
import { BSM_REFERENCE_PRESET, BSM_REFERENCE_PRESET_ID } from './bsm-reference-preset.ts';
import {
  DAYTIME_DEFAULT_MATERIAL_MODE, DAYTIME_DURATION_SECONDS, DAYTIME_MAX_ELEVATION, DAYTIME_MIN_ELEVATION,
  describeDaytimeStage, evaluateDaytimeParameters, readDaytimeSpeed, readDaytimeStage, stepDaytimeElevation,
  touchesDaytimeDrivenParameter, type DaytimeSpeed, type DaytimeTransformState,
} from './daytime-transform.ts';
import { isNubisMode, type NubisMode } from './nubis/presets.ts';
import {
  degrees, groundShadowCamera, referenceCamera, shadowInspectionCamera, stepGroundCamera,
} from './terrain.ts';

const CHANNEL = 'vc-ue5/ground';
const SYSTEM = 'vc-ue5-ground-input';

type StreamedCloudSet = NubisMode | 'alpine-valley';
function isStreamedCloudSet(mode: unknown): mode is StreamedCloudSet {
  return mode === 'alpine-valley' || isNubisMode(mode);
}

interface TerrainConfig {
  readonly scene: string;
  readonly cloudMaterial: string;
  readonly referenceCloudMaterial: string;
  readonly sampleUeTextureSet: string;
  readonly alpineTextureSet: string;
  readonly bandCloudMaterial: string;
  readonly bandWideInstance: string;
  readonly nubisInstances: Record<NubisMode, string>;
}

const LEGACY_CLOUD_FIELDS = [
  'bottomMeters', 'thicknessMeters', 'extinctionPerMeter', 'coverageBias', 'layoutWeight', 'maskWeight',
  'profileWeight', 'bodyWeight', 'erosionWeight', 'windX', 'windY', 'windZ', 'referenceTimeSeconds',
  'viewSampleCountScale', 'stopTransmittance', 'phaseG', 'phaseG2', 'phaseBlend', 'exposure',
  'msContribution', 'msOcclusion', 'msEccentricity', 'multiScatteringOctaves', 'shadowSamples',
  'shadowDistanceMeters', 'shadowExtentMeters', 'shadowStrength', 'surfaceShadowStrength', 'shadowDepthBiasMeters',
  'shadowLightDistanceMeters', 'shadowFarDepthMeters',
  'shadowMode', 'atmosphereShadowStrength', 'atmosphereTransmittanceMode', 'skipEmpty', 'useDetail',
  'selfShadow', 'groundShadowEnabled', 'atmosphereShadowEnabled', 'enableDistantSkyLightSampling',
] as const satisfies readonly CloudParameterKey[];

type CloudFields = Required<Pick<CloudEdit, typeof LEGACY_CLOUD_FIELDS[number]>>;

export function readCloudFields(data: unknown): CloudFields | undefined {
  if (!isRecord(data)) return;
  const checked = validateCloudEdit(Object.fromEntries(LEGACY_CLOUD_FIELDS.map(key => [key, data[key]])));
  return 'edit' in checked ? checked.edit as CloudFields : undefined;
}

const REFERENCE_PRESET: CloudPreset = {};
const CLOUD_PRESET_DEFAULTS = { viewBlueNoise: false } as const;

type CloudRequest = {
  readonly id: number;
  readonly clientId: number | null;
  readonly action: string;
  readonly requested: unknown;
  readonly status: 'cpu-applied' | 'rejected';
  readonly reason?: string;
};
type AppliedCloudRequest = Omit<CloudRequest, 'status' | 'reason'> & { readonly status: 'cpu-applied' };
const project = (value: unknown): GameProjectionValue => JSON.parse(JSON.stringify(value)) as GameProjectionValue;
const PARAMETER_KEYS = Object.keys(cloudParameterLabels) as CloudParameterKey[];
const SAMPLED_WEIGHTS = ['layoutWeight', 'maskWeight', 'profileWeight', 'bodyWeight', 'erosionWeight'] as const;

export const engine: Plugin.Object<TerrainConfig> = {
  name: 'vc-ue5/engine',
  inject: ['world', 'assets', 'gameHost'],
  async apply(ctx, config) {
    const { world, assets, gameHost } = ctx;
    if (!assets || !gameHost) throw new Error('地面场景需要应用宿主与资产服务。');
    // The reference uses explicit right-drag; keep left clicks available for the HUD.
    gameHost.setPointerLockAllowed?.(false);
    await ctx.effect(async function* () {
      const scene = (await assets.load(config.scene, 'scene')).unwrap();
      yield () => assets.release(scene).unwrap();
      const source = assets.source(scene).unwrap();
      const sourceKey = source === undefined ? undefined : assets.sourceKeyOf(source.guid);
      if (sourceKey !== GROUND_SCENE_KEY) throw new Error('地面场景需要正式的参考 Scene 资产。');
      const root = assets.instantiate(scene, world).unwrap();
      yield () => worldDespawnScene(world, root).unwrap();
      const resolve = (key: GroundEntityKey) =>
        worldResolveSceneEntity(world, root, sceneEntity(sourceKey, key)).unwrap();
      const camera = resolve('camera');
      const occluder = resolve('occluder');
      const cloud = resolve('cloud');
      const sun = resolve('sun');
      const unregisterScene = gameHost.gameProjection?.registerRead({
        id: 'vc-ue5.scene',
        title: '正式场景与实例实体',
        read: () => {
          const adopted = assets.source(scene).unwrap();
          return {
            guid: adopted?.guid ?? null, sourceKey, root,
            sourcePath: adopted?.publication?.sourcePath ?? null,
            sourceRevision: adopted?.publication?.sourceRevision ?? null,
            generation: adopted?.publication?.generation ?? null,
            packageDigest: adopted?.publication?.digest ?? null,
            outputSetDigest: adopted?.publication?.outputSetDigest ?? null,
            entities: Object.fromEntries(GROUND_ENTITY_KEYS.map((key) => [key, resolve(key)])),
          };
        },
      });
      if (unregisterScene) yield unregisterScene;
      const cloudMaterial = (await assets.load(config.cloudMaterial, cloudMaterialKind)).unwrap();
      yield () => assets.release(cloudMaterial).unwrap();
      const cloudSample = assets.read(cloudMaterial).unwrap().sample;
      if (cloudSample === undefined) throw new Error('参考场景需要已编译的均匀云材质。');
      const uniformExtinction = cloudSample.extinctionPerMeter;
      const referenceMaterial = (await assets.load(config.referenceCloudMaterial, cloudMaterialKind)).unwrap();
      yield () => assets.release(referenceMaterial).unwrap();
      const reference = assets.read(referenceMaterial).unwrap();
      const sampleUeInstance = (await assets.load(config.sampleUeTextureSet, cloudMaterialInstanceKind)).unwrap();
      yield () => assets.release(sampleUeInstance).unwrap();
      const sampleUe = assets.read(sampleUeInstance).unwrap();
      const bandMaterial = (await assets.load(config.bandCloudMaterial, cloudMaterialKind)).unwrap();
      yield () => assets.release(bandMaterial).unwrap();
      const band = assets.read(bandMaterial).unwrap();
      const bandWideInstance = (await assets.load(config.bandWideInstance, cloudMaterialInstanceKind)).unwrap();
      yield () => assets.release(bandWideInstance).unwrap();
      const bandWide = assets.read(bandWideInstance).unwrap();
      type StreamedCloudOption = {
        handle: typeof referenceMaterial; material: typeof reference; guid: string;
        instance: typeof bandWide; instanceGuid: string; instanceHandle: typeof bandWideInstance;
      };
      const streamedCloudOptions = new Map<StreamedCloudSet, StreamedCloudOption>();
      let acceptStreamedCloudLoads = true;
      yield () => {
        acceptStreamedCloudLoads = false;
        for (const option of streamedCloudOptions.values()) assets.release(option.instanceHandle).unwrap();
      };
      const loadStreamedCloudOption = async (mode: StreamedCloudSet) => {
        const instanceGuid = mode === 'alpine-valley' ? config.alpineTextureSet : config.nubisInstances[mode];
        const loaded = await assets.load(instanceGuid, cloudMaterialInstanceKind);
        if (!loaded.ok) return '云纹理加载失败，请重试。';
        const instanceHandle = loaded.value;
        const instance = assets.read(instanceHandle);
        if (!acceptStreamedCloudLoads || !instance.ok) {
          assets.release(instanceHandle).unwrap();
          return '云纹理未就绪，请重试。';
        }
        streamedCloudOptions.set(mode, {
          handle: referenceMaterial, material: reference, guid: config.referenceCloudMaterial,
          instance: instance.value, instanceGuid, instanceHandle,
        });
        return undefined;
      };
      if (reference.model !== 'program' || reference.densityKernelIdentity === undefined)
        throw new Error('The texture sets require the cooked reference density program.');
      if (reference.parameters.useDetail?.kind !== 'static')
        throw new Error('The reference material requires a cooked detail switch.');
      let windX = 0;
      let windY = 0;
      let windZ = 0;
      let referenceTimeSeconds = 0;
      let elapsedSeconds = 0;
      let paused = false;
      let daytimeActive = false;
      let daytimePlaying = false;
      let daytimeSpeed: DaytimeSpeed = 1;
      let daytimeLastPublishSeconds = 0;
      let clockInitializedThisUpdate = false;
      let preset: string | null = null;
      let runtimeParameters: CloudEdit = {};
      let latestRequest: CloudRequest | null = null;
      let lastRequestId = 0;
      let lastClientRequestId = 0;
      let savedSnapshot: CloudSnapshotV1 | null = null;
      const snapshotHistory = createCloudSnapshotHistory(world.identity);
      const cloudRequests = createCloudRequestTracker<AppliedCloudRequest>(requestRevision =>
        world.set(cloud, VolumetricCloudLayer, { requestRevision }).unwrap());
      let materialMode: CloudMaterialMode = 'shape';
      let routeTime: number | undefined;
      let cutRequested = false;
      const normalCamera = world.get(camera, Camera).unwrap();
      let normalExposure = normalCamera.exposure;
      const normalTonemap = normalCamera.tonemap;

      let pose = referenceCamera();
      let cameraView: CameraView = 'ground';
      let sunAzimuthHint = sunFieldsFromDirection(world.get(sun, DirectionalLight).unwrap().direction).sunAzimuth;
      let sunElevationHint = sunFieldsFromDirection(world.get(sun, DirectionalLight).unwrap().direction).sunElevation;
      const readSun = () => sunFieldsFromDirection(world.get(sun, DirectionalLight).unwrap().direction, sunAzimuthHint, sunElevationHint);
      const initialCloud = world.get(cloud, VolumetricCloudLayer).unwrap();
      const initialSun = { ...readSun(), sunIlluminanceLux: world.get(sun, DirectionalLight).unwrap().intensity };
      const initialExposure = normalExposure;
      let shadowControls: CloudShadowControls = {
        groundShadowEnabled: initialCloud.castCloudShadows && initialCloud.surfaceShadowStrength > 0,
        atmosphereShadowEnabled: initialCloud.castCloudShadows && initialCloud.atmosphereShadowStrength > 0,
        surfaceShadowStrength: initialCloud.surfaceShadowStrength,
        atmosphereShadowStrength: initialCloud.atmosphereShadowStrength,
      };
      let aspect = world.get(camera, Camera).unwrap().aspect;
      let fixtureVisible = world.get(occluder, Visibility).unwrap().state === VisibilityStateValue.visible;
      const initialShadowControls = { ...shadowControls };
      const initialFixtureVisible = fixtureVisible;
      const uniform = assets.read(cloudMaterial).unwrap();
      const materialOptions = {
        uniform: { handle: cloudMaterial, material: uniform, guid: config.cloudMaterial, instance: undefined, instanceGuid: null, instanceHandle: undefined },
        shape: { handle: referenceMaterial, material: reference, guid: config.referenceCloudMaterial, instance: undefined, instanceGuid: null, instanceHandle: undefined },
        'sample-ue': { handle: referenceMaterial, material: reference, guid: config.referenceCloudMaterial, instance: sampleUe, instanceGuid: config.sampleUeTextureSet, instanceHandle: sampleUeInstance },
        band: { handle: bandMaterial, material: band, guid: config.bandCloudMaterial, instance: undefined, instanceGuid: null, instanceHandle: undefined },
        'band-wide': { handle: bandMaterial, material: band, guid: config.bandCloudMaterial, instance: bandWide, instanceGuid: config.bandWideInstance, instanceHandle: bandWideInstance },
      };
      const materialOption = (mode: CloudMaterialMode) =>
        isStreamedCloudSet(mode) ? streamedCloudOptions.get(mode)! : materialOptions[mode];
      const selectCook = (mode: CloudMaterialMode, override?: boolean) => {
        const option = materialOption(mode);
        const { material, instance, guid, instanceGuid, instanceHandle } = option;
        const values = resolveCloudParameters(material.parameters, instance?.overrides ?? {}, { guid, source: 'vc-ue5.cloud' }).unwrap();
        const staticValues = Object.fromEntries(Object.entries(material.parameters).filter(([, parameter]) => parameter.kind === 'static')
          .map(([name]) => [name, name === 'useDetail' && override !== undefined ? override : values[name]]));
        const variant = material.variants.find(candidate =>
          Object.keys(candidate.staticValues).length === Object.keys(staticValues).length &&
          Object.entries(staticValues).every(([key, value]) => candidate.staticValues[key] === value));
        const instancePublication = instanceHandle === undefined ? null : assets.source(instanceHandle).unwrap()?.publication ?? null;
        const identity: CloudAssets = {
          materialGuid: guid, instanceGuid, cookIdentity: material.cookIdentity,
          instanceCookIdentity: instancePublication?.digest ?? null,
          programIdentity: variant?.programIdentity ?? null,
        };
        return { option, values, variant, identity, instancePublication };
      };
      const viewModeOf = (mode: number) => mode === 3 ? 'transmittance' : mode === 4 ? 'contour' : 'normal';
      const readConfig = (): CloudConfiguration => {
        const layer = world.get(cloud, VolumetricCloudLayer).unwrap();
        const wind = layer.windOffsetMeters;
        return {
          materialMode, enabled: layer.enabled, parameters: { ...runtimeParameters },
          clock: { referenceTimeSeconds, elapsedSeconds, paused, windOffsetMeters: [wind[0], wind[1], wind[2]] },
          camera: { pose: { ...pose }, cameraView, routeTime: routeTime ?? null, fixtureVisible, viewMode: viewModeOf(layer.diagnosticMode) },
          assets: selectCook(materialMode, runtimeParameters.useDetail).identity,
        };
      };
      const unavailableEvidence = observeCloudRenderer(undefined).read(null);
      const receiptRenderer = gameHost.renderer ?? ('renderer' in gameHost.app ? gameHost.app.renderer : undefined);
      let presentationEvidence: CloudRenderEvidence | undefined;
      let presentationFrame: ReadyCloudFrame | null = null;
      const receiveReadyFrame = (value: unknown) => {
        const frame = readWorldReadyCloudFrame(value, world.identity);
        if (!frame || (presentationFrame && (frame.deviceGeneration < presentationFrame.deviceGeneration ||
          (frame.deviceGeneration === presentationFrame.deviceGeneration && frame.frameId < presentationFrame.frameId)))) return false;
        presentationFrame = frame;
        return true;
      };
      const readReadyFrame = (): ReadyCloudFrame | null => {
        const canvas = gameHost.canvas;
        const progress = canvas && 'forgeaxFrameProgress' in canvas ? canvas.forgeaxFrameProgress : undefined;
        const frame = progress?.completed;
        const candidate = (frame?.presentation === 'ready' ? readWorldReadyCloudFrame(frame, world.identity) : null) ?? presentationFrame;
        const submitted = progress?.submitted;
        return !candidate || (receiptRenderer && receiptRenderer.state() !== 'alive') ||
          (submitted && !sameCloudFrameEpoch(candidate, {
            deviceGeneration: submitted.deviceGeneration, worldIdentity: submitted.worldIdentity ?? null,
          })) ? null : candidate;
      };
      const captureSnapshot = (): CloudSnapshotV1 =>
        ({ version: 1, preset, config: readConfig(), frame: readReadyFrame() });
      let initialSnapshotCaptured = false;
      const captureInitialSnapshot = () => {
        if (initialSnapshotCaptured || cloudRequests.read()?.action !== 'initial-configuration') return;
        const frame = readReadyFrame();
        if (!frame) return;
        const requestRevision = world.get(cloud, VolumetricCloudLayer).unwrap().requestRevision;
        if (requestRevision !== cloudRequests.read()?.requestRevision) return;
        const layers = receiptRenderer?.inspect({ fields: ['cloudLayer'] }).cloudLayer ?? presentationEvidence?.renderer.layer;
        for (const { completedAdoption } of Object.values(layers ?? {})) {
          if (completedAdoption?.requestRevision !== requestRevision || completedAdoption.entity !== cloud) continue;
          const adoptionFrame = readWorldReadyCloudFrame(completedAdoption, world.identity);
          if (!adoptionFrame || !receiptTimingMatchesCompletion(adoptionFrame, frame)) continue;
          // Keep the startup clock and camera values even if they changed while waiting for cloud adoption.
          snapshotHistory.capture({ version: 1, preset: null, config: baseline, frame: adoptionFrame }, 'initial');
          initialSnapshotCaptured = true;
          return;
        }
      };
      const readEvidence = () => {
        const completed = readReadyFrame();
        const source = presentationEvidence?.gpu.sourceFrame;
        const canvas = gameHost.canvas;
        const submitted = canvas && 'forgeaxFrameProgress' in canvas ? canvas.forgeaxFrameProgress?.submitted : undefined;
        const stale = source && (source.worldIdentity !== world.identity || !receiptTimingMatchesCompletion(source, completed) ||
          (receiptRenderer && receiptRenderer.state() !== 'alive') ||
          (submitted && !sameCloudFrameEpoch(source, {
            deviceGeneration: submitted.deviceGeneration, worldIdentity: submitted.worldIdentity ?? null,
          })));
        return { ...(stale ? unavailableEvidence : presentationEvidence ?? unavailableEvidence), completed };
      };
      const readDaytime = (): DaytimeTransformState => {
        const elevation = readSun().sunElevation;
        const completed = daytimeActive && elevation >= DAYTIME_MAX_ELEVATION - 1e-4;
        return {
          active: daytimeActive,
          playing: daytimeActive && daytimePlaying && !paused && !completed,
          completed,
          speed: daytimeSpeed,
          elevation,
          durationSeconds: DAYTIME_DURATION_SECONDS,
          stage: describeDaytimeStage(elevation),
        };
      };
      const readCloud = () => {
        const layer = world.get(cloud, VolumetricCloudLayer).unwrap();
        const selected = selectCook(materialMode, runtimeParameters.useDetail);
        const { material, instance } = selected.option;
        const mode: CloudMode = layer.enabled ? materialMode : 'off';
        const cloudConfig = readConfig();
        const shadowValues = {
          phaseG: layer.phaseG, phaseG2: layer.phaseG2, phaseBlend: layer.phaseBlend,
          msContribution: layer.msContribution, msOcclusion: layer.msOcclusion, msEccentricity: layer.msEccentricity,
          multiScatteringOctaves: layer.multiScatteringOctaves, selfShadow: layer.selfShadow,
          castCloudShadows: layer.castCloudShadows, shadowMode: layer.shadowMode, shadowSamples: layer.shadowSamples,
          shadowDistanceMeters: layer.shadowDistanceMeters, shadowExtentMeters: layer.shadowExtentMeters,
          shadowLightDistanceMeters: layer.shadowLightDistanceMeters, shadowFarDepthMeters: layer.shadowFarDepthMeters,
          shadowStrength: layer.shadowStrength, shadowDepthBiasMeters: layer.shadowDepthBiasMeters,
          shadowResolution: layer.shadowResolution, shadowMapSamples: layer.shadowMapSamples,
          shadowMapUe5Reference: layer.shadowMapUe5Reference,
          shadowMapSpatialPasses: layer.shadowMapSpatialPasses,
          atmosphereTransmittanceMode: layer.atmosphereTransmittanceMode,
          enableDistantSkyLightSampling: layer.enableDistantSkyLightSampling,
        };
        const scalar = (key: string) => typeof selected.values[key] === 'number' ? selected.values[key] as number : undefined;
        const weights = Object.fromEntries(SAMPLED_WEIGHTS.map(key => [key, layer[key] === -1 ? scalar(key) ?? null : layer[key]]));
        const fields = {
          enabled: layer.enabled, mode, routeRunning: routeTime !== undefined, cameraView, paused, preset,
          daytime: readDaytime(),
          exposure: normalExposure, ...readSun(), sunIlluminanceLux: world.get(sun, DirectionalLight).unwrap().intensity,
          ...shadowValues, ...shadowControls, ...weights,
          effectiveSurfaceShadowStrength: layer.surfaceShadowStrength,
          effectiveAtmosphereShadowStrength: layer.atmosphereShadowStrength,
          bottomMeters: layer.bottomMeters, thicknessMeters: layer.thicknessMeters,
          extinctionPerMeter: layer.extinctionOverridePerMeter < 0 ? scalar('extinctionPerMeter') ?? uniformExtinction : layer.extinctionOverridePerMeter,
          coverageBias: layer.coverageBias === -2 ? scalar('coverageBias') ?? null : layer.coverageBias,
          useDetail: selected.variant?.staticValues.useDetail ?? false,
          skipEmpty: layer.skipEmpty, windX, windY, windZ, referenceTimeSeconds, elapsedSeconds,
          viewSampleCountScale: layer.viewSampleCountScale, viewBlueNoise: layer.viewBlueNoise,
          stopTransmittance: layer.stopTransmittance,
          traceLimitMeters: layer.traceLimitMeters, entryLimitMeters: layer.entryLimitMeters,
          viewMode: viewModeOf(layer.diagnosticMode), initializationRevision: layer.initializationRevision,
          windOffsetMeters: Array.from(layer.windOffsetMeters),
          diagnostic: [layer.diagnosticMode, layer.diagnosticPixelX, layer.diagnosticPixelY],
          ...selected.identity, kernelIdentity: material.densityKernelIdentity ?? null,
          halfWidthMeters: scalar('halfWidthMeters') ?? null,
          textureGuids: Object.fromEntries(Object.entries(material.parameters)
            .filter(([, parameter]) => parameter.kind === 'texture')
            .map(([name]) => [name, selected.values[name]])),
          authoring: {
            defaults: Object.fromEntries(Object.entries(material.parameters).map(([key, parameter]) => [key, parameter.default])),
            instanceOverrides: instance?.overrides ?? {},
            resolvedCookValues: selected.values,
            selectedCookStaticValues: selected.variant?.staticValues ?? {},
            materialPublication: assets.source(selected.option.handle).unwrap()?.publication ?? null,
            instancePublication: selected.instancePublication,
          },
          configuration: cloudConfig, request: latestRequest, snapshot: savedSnapshot, ...readRequest(), ...readEvidence(),
        };
        return { ...fields, qualityPreset: matchQualityPreset(fields) };
      };
      const readRequest = () => {
        const revision = world.get(cloud, VolumetricCloudLayer).unwrap().requestRevision;
        const active = cloudRequests.read();
        return { requestRevision: revision || null, activeRequest: active?.requestRevision === revision ? active : null };
      };

      const port = gameHost.port;
      let resetRequested = false;
      let shadowViewRequested = false;
      let groundShadowViewRequested = false;
      let toggleRequested = false;
      let cloudViewRequested: 0 | 3 | 4 | undefined;
      let cloudReadRequested = true;
      let cloudStatus: string | undefined;
      const applyUnacknowledgedCloudChange = (action: string, requested: unknown, change: () => void) => {
        const error = cloudRequests.apply({ id: ++lastRequestId, clientId: null, action, requested, status: 'cpu-applied' }, change);
        if (error) cloudStatus = error;
        cloudReadRequested = true;
      };
      const cloudActions: { action: string; value: unknown; requestId: unknown; loadError?: string }[] = [];
      const initializeClock = (seconds: number, elapsed = 0, offset?: readonly [number, number, number]) => {
        referenceTimeSeconds = seconds;
        elapsedSeconds = elapsed;
        clockInitializedThisUpdate = true;
        world.set(cloud, VolumetricCloudLayer, {
          windOffsetMeters: offset === undefined ? ueCloudWindOffset(seconds) : [...offset],
          initializationRevision: world.get(cloud, VolumetricCloudLayer).unwrap().initializationRevision + 1,
        }).unwrap();
      };
      const applySun = (fields: SunFields) => {
        sunAzimuthHint = fields.sunAzimuth;
        sunElevationHint = fields.sunElevation;
        world.set(sun, DirectionalLight, { direction: sunDirection(fields) }).unwrap();
      };
      const selectMaterial = (mode: CloudMaterialMode, enabled: boolean) => {
        const selected = materialOption(mode);
        materialMode = mode;
        world.set(cloud, VolumetricCloudLayer, { enabled, material: selected.handle,
          materialInstance: selected.instanceHandle ?? 0 as AssetHandle<'cloud-material-instance'> }).unwrap();
      };
      const clearDensityOverrides = () => {
        world.set(cloud, VolumetricCloudLayer, {
          extinctionOverridePerMeter: -1, coverageBias: -2, useDetail: 2,
          layoutWeight: -1, maskWeight: -1, profileWeight: -1, bodyWeight: -1, erosionWeight: -1,
        }).unwrap();
        for (const key of ['extinctionPerMeter', 'coverageBias', 'useDetail', ...SAMPLED_WEIGHTS] as const)
          delete runtimeParameters[key];
      };
      const applyLightParameters = ({
        exposure, sunElevation, sunAzimuth, sunIlluminanceLux,
      }: CloudEdit) => {
        if (sunElevation !== undefined || sunAzimuth !== undefined) {
          const currentSun = readSun();
          applySun({ sunElevation: sunElevation ?? currentSun.sunElevation, sunAzimuth: sunAzimuth ?? currentSun.sunAzimuth });
        }
        if (sunIlluminanceLux !== undefined) world.set(sun, DirectionalLight, { intensity: sunIlluminanceLux }).unwrap();
        if (exposure !== undefined) {
          normalExposure = exposure;
          if (world.get(cloud, VolumetricCloudLayer).unwrap().diagnosticMode === 0) world.set(camera, Camera, { exposure }).unwrap();
        }
      };
      const applyShadowParameters = ({
        groundShadowEnabled, atmosphereShadowEnabled, surfaceShadowStrength, atmosphereShadowStrength,
      }: CloudEdit) => {
        if ([groundShadowEnabled, atmosphereShadowEnabled, surfaceShadowStrength, atmosphereShadowStrength].some(value => value !== undefined)) {
          shadowControls = {
            groundShadowEnabled: groundShadowEnabled ?? shadowControls.groundShadowEnabled,
            atmosphereShadowEnabled: atmosphereShadowEnabled ?? shadowControls.atmosphereShadowEnabled,
            surfaceShadowStrength: surfaceShadowStrength ?? shadowControls.surfaceShadowStrength,
            atmosphereShadowStrength: atmosphereShadowStrength ?? shadowControls.atmosphereShadowStrength,
          };
        }
      };
      const applyParameters = (edit: CloudEdit, initialize: boolean) => {
        const { extinctionPerMeter, windX: x, windY: y, windZ: z, referenceTimeSeconds: seconds,
          useDetail, exposure, sunElevation, sunAzimuth, sunIlluminanceLux,
          groundShadowEnabled, atmosphereShadowEnabled, surfaceShadowStrength, atmosphereShadowStrength,
          ...layerFields } = edit;
        applyLightParameters({ exposure, sunElevation, sunAzimuth, sunIlluminanceLux });
        applyShadowParameters({ groundShadowEnabled, atmosphereShadowEnabled, surfaceShadowStrength, atmosphereShadowStrength });
        world.set(cloud, VolumetricCloudLayer, {
          ...layerFields, ...shadowConsumerFields(shadowControls),
          ...(extinctionPerMeter === undefined ? {} : { extinctionOverridePerMeter: extinctionPerMeter }),
          ...(useDetail === undefined ? {} : { useDetail: Number(useDetail) }),
        }).unwrap();
        windX = x ?? windX;
        windY = y ?? windY;
        windZ = z ?? windZ;
        if (initialize || seconds !== undefined) initializeClock(seconds ?? referenceTimeSeconds);
        const stored = { ...edit };
        delete stored.referenceTimeSeconds;
        runtimeParameters = { ...runtimeParameters, ...stored };
      };
      applyParameters({ ...QUALITY_PRESETS['quality-low'].parameters, ...CLOUD_PRESET_DEFAULTS }, false);
      const baseline = readConfig();
      cloudRequests.apply({ id: ++lastRequestId, clientId: null, action: 'initial-configuration',
        requested: null, status: 'cpu-applied' }, () => {});
      const applyView = (mode: 0 | 3 | 4) => {
        world.set(cloud, VolumetricCloudLayer, { diagnosticMode: mode }).unwrap();
        world.set(camera, Camera, mode === 0
          ? { exposure: normalExposure, tonemap: normalTonemap }
          : { exposure: 1, tonemap: TONEMAP_NONE }).unwrap();
      };
      const restoreConfiguration = (next: CloudConfiguration) => {
        const selected = selectCook(next.materialMode, next.parameters.useDetail);
        if (next.parameters.useDetail !== undefined && selected.variant?.staticValues.useDetail !== next.parameters.useDetail)
          return '该材质没有对应的已 Cook 细节变体。';
        if ((Object.keys(selected.identity) as (keyof CloudAssets)[]).some(key => selected.identity[key] !== next.assets[key]))
          return '快照对应的材质、实例或 Cook 变体已变更。';
        const { initializationRevision, requestRevision } = world.get(cloud, VolumetricCloudLayer).unwrap();
        world.set(cloud, VolumetricCloudLayer, { ...initialCloud, initializationRevision, requestRevision }).unwrap();
        selectMaterial(next.materialMode, next.enabled);
        runtimeParameters = {};
        shadowControls = { ...initialShadowControls };
        windX = windY = windZ = 0;
        applyParameters({ ...initialSun, exposure: initialExposure }, false);
        runtimeParameters = {};
        applyParameters({ ...CLOUD_PRESET_DEFAULTS, ...next.parameters }, false);
        paused = next.clock.paused;
        initializeClock(next.clock.referenceTimeSeconds, next.clock.elapsedSeconds, next.clock.windOffsetMeters);
        ({ cameraView, fixtureVisible } = next.camera);
        routeTime = next.camera.routeTime ?? undefined;
        pose = { ...next.camera.pose };
        applyView(next.camera.viewMode === 'transmittance' ? 3 : next.camera.viewMode === 'contour' ? 4 : 0);
        world.set(occluder, Visibility, { state: fixtureVisible ? VisibilityStateValue.visible : VisibilityStateValue.hidden }).unwrap();
        port?.postMessage({ channel: CHANNEL, fixtureVisible });
        world.set(camera, Transform, cameraTransform(pose)).unwrap();
        world.set(camera, Camera, { historyVersion: world.get(camera, Camera).unwrap().historyVersion + 1 }).unwrap();
      };
      const presetConfiguration = (selection: CloudPreset): CloudConfiguration | string => {
        const checked = validateCloudEdit({ ...selection.parameters, ...CLOUD_PRESET_DEFAULTS });
        if (!('edit' in checked)) return `参数须在允许范围内。 ${checked.field}`;
        const parameters = checked.edit;
        const seconds = selection.clock?.referenceTimeSeconds ?? parameters.referenceTimeSeconds ?? baseline.clock.referenceTimeSeconds;
        delete parameters.referenceTimeSeconds;
        const mode = selection.materialMode ?? baseline.materialMode;
        return {
          ...baseline, materialMode: mode, enabled: selection.enabled ?? baseline.enabled, parameters,
          clock: { ...baseline.clock, ...selection.clock, referenceTimeSeconds: seconds, windOffsetMeters: ueCloudWindOffset(seconds) },
          camera: { ...baseline.camera, ...selection.camera }, assets: selectCook(mode, parameters.useDetail).identity,
        };
      };
      const readWeatherCatalog = () => ({
        version: 1 as const,
        entries: WEATHER_PRESET_IDS.map(id => {
          const { version, label, forgeax } = WEATHER_PRESETS[id];
          const config = presetConfiguration(forgeax);
          if (typeof config === 'string') throw new Error(config);
          return { id, version, label, config };
        }),
      });
      const readCloudHistory = () => ({ snapshotHistory: snapshotHistory.read(), weatherCatalog: readWeatherCatalog() });
      const unregisterCloud = gameHost.gameProjection?.registerRead({
        id: 'vc-ue5.cloud',
        title: '体积云配置、请求与帧事实',
        read: () => project({ ...readCloud(), ...readCloudHistory() }),
        workspace: {
          entity: () => world.get(cloud, VolumetricCloudLayer).ok ? cloud : undefined,
          read: () => project({ configuration: readConfig(), preset, ...readRequest(), ...readCloudHistory() }),
        },
      });
      if (unregisterCloud) yield unregisterCloud;
      type AdoptCloudChange = (requested: unknown, change: () => string | void) => string | undefined;
      let actionNotice: string | undefined;
      const applyDaytimeAtElevation = (elevation: number) => {
        const sunAzimuth = readSun().sunAzimuth;
        applySun({ sunElevation: elevation, sunAzimuth });
        applyParameters({ ...evaluateDaytimeParameters(elevation), sunElevation: elevation }, false);
        preset = null;
      };
      const activateDaytime = (elevation: number, playing: boolean) => {
        selectMaterial(DAYTIME_DEFAULT_MATERIAL_MODE, true);
        applyView(0);
        daytimeActive = true;
        daytimePlaying = playing;
        if (playing) paused = false;
        initializeClock(0);
        applyDaytimeAtElevation(elevation);
        daytimeLastPublishSeconds = elapsedSeconds;
      };
      const deactivateDaytime = (notice?: string) => {
        if (!daytimeActive) return;
        daytimeActive = false;
        daytimePlaying = false;
        if (notice) actionNotice = notice;
      };
      const toggleDaytime = (adopt: AdoptCloudChange): string | undefined => adopt(!daytimeActive, () => {
        if (daytimeActive) {
          deactivateDaytime('已关闭白昼变换，保留当前参数。');
          return;
        }
        activateDaytime(DAYTIME_MIN_ELEVATION, true);
        actionNotice = '已开启白昼变换（UE 原纹理，-4° ～ 180° / 120s）。';
      });
      const toggleDaytimePlayback = (adopt: AdoptCloudChange): string | undefined => adopt(daytimePlaying ? 'pause' : 'play', () => {
        if (!daytimeActive) {
          activateDaytime(DAYTIME_MIN_ELEVATION, true);
          actionNotice = '已开启白昼变换（UE 原纹理，-4° ～ 180° / 120s）。';
          return;
        }
        if (daytimePlaying && !paused) {
          daytimePlaying = false;
          actionNotice = '白昼变换已暂停，可拖动太阳高度或点击阶段预览。';
          return;
        }
        const atEnd = readSun().sunElevation >= DAYTIME_MAX_ELEVATION - 1e-4;
        if (atEnd) {
          initializeClock(0);
          applyDaytimeAtElevation(DAYTIME_MIN_ELEVATION);
        }
        daytimePlaying = true;
        paused = false;
        daytimeLastPublishSeconds = elapsedSeconds;
        actionNotice = atEnd ? '白昼变换已从 -4° 重新开始。' : '白昼变换播放中。';
      });
      const setDaytimeSpeed = (value: unknown, adopt: AdoptCloudChange): string | undefined => {
        const speed = readDaytimeSpeed(value);
        if (speed === undefined) return '白昼倍速须在允许选项内。';
        return adopt(speed, () => {
          daytimeSpeed = speed;
        });
      };
      const jumpDaytimeStage = (value: unknown, adopt: AdoptCloudChange): string | undefined => {
        const anchor = readDaytimeStage(value);
        if (anchor === undefined) return '没有该白昼阶段。';
        return adopt(anchor.id, () => {
          if (!daytimeActive) activateDaytime(anchor.elevation, false);
          else {
            daytimePlaying = false;
            applyDaytimeAtElevation(anchor.elevation);
          }
          actionNotice = `已跳转至${anchor.label}（${anchor.elevation}° · ${anchor.cloudType}）。`;
        });
      };
      const updateCloudParameters = (value: unknown, adopt: AdoptCloudChange): string | undefined => {
        const checked = validateCloudEdit(value);
        if (!('edit' in checked)) {
          return `参数须在允许范围内。 ${checked.field}`;
        }
        const edit = checked.edit;
        const layer = world.get(cloud, VolumetricCloudLayer).unwrap();
        const mode = layer.enabled ? materialMode : 'off';
        const conditions: CloudEdit = {
          ...shadowControls, selfShadow: layer.selfShadow, shadowMode: layer.shadowMode,
          multiScatteringOctaves: layer.multiScatteringOctaves, ...edit,
        };
        const inactive = PARAMETER_KEYS.find(key => edit[key] !== undefined && unavailableParameter(key, mode, conditions));
        if (inactive) {
          return `${cloudParameterLabels[inactive].label}：${unavailableParameter(inactive, mode, conditions)}`;
        }
        if (edit.useDetail !== undefined && selectCook(materialMode, edit.useDetail).variant?.staticValues.useDetail !== edit.useDetail) {
          return '该材质没有对应的已 Cook 细节变体。';
        }
        const error = adopt(edit, () => applyParameters(edit, false));
        if (!error) {
          if (daytimeActive && touchesDaytimeDrivenParameter(edit)) {
            deactivateDaytime('已手动调整受控参数，自动退出白昼变换。');
          }
          if (WEATHER_PARAMETER_KEYS.some(key => edit[key] !== undefined)) preset = null;
        }
        return error;
      };
      const applyCloudPreset = (value: unknown, adopt: AdoptCloudChange): string | undefined => {
        let error: string | undefined;
        const quality = readQualityPreset(value);
        const weather = readWeatherPreset(value);
        if (quality) {
          const parameters: CloudEdit = { ...quality.parameters, ...CLOUD_PRESET_DEFAULTS };
          if (selectCook(materialMode).option.material.parameters.useDetail?.kind !== 'static') delete parameters.useDetail;
          error = adopt(value, () => applyParameters(parameters, false));
        } else if (weather) {
          error = adopt(value, () => {
            deactivateDaytime();
            applyParameters({
              ...weatherAtmosphereParameters(weather.forgeax.parameters), ...CLOUD_PRESET_DEFAULTS,
            }, false);
          });
          if (!error) preset = weather.id;
        } else if (value === 'reference' || value === BSM_REFERENCE_PRESET_ID) {
          const next = presetConfiguration(value === BSM_REFERENCE_PRESET_ID ? BSM_REFERENCE_PRESET : REFERENCE_PRESET);
          error = typeof next === 'string' ? next : adopt(value, () => {
            deactivateDaytime();
            return restoreConfiguration(next);
          });
          if (!error) preset = value;
        } else error = '没有该预设。';
        return error;
      };
      const loadCloudSnapshot = (value: unknown, adopt: AdoptCloudChange): string | undefined => {
        let error: string | undefined;
        const next = readCloudSnapshot(value);
        if (!next) error = '快照格式、版本或参数无效。';
        else {
          error = adopt({ version: next.version, preset: next.preset, config: next.config }, () => {
            deactivateDaytime();
            return restoreConfiguration(next.config);
          });
          if (!error) {
            savedSnapshot = next;
            preset = next.preset;
          }
        }
        return error;
      };
      const switchCloudMaterial = (value: unknown, adopt: AdoptCloudChange): string | undefined => {
        if (value === 'off') return adopt(value, () => {
          deactivateDaytime();
          selectMaterial(materialMode, false);
          applyView(0);
        });
        const layer = world.get(cloud, VolumetricCloudLayer).unwrap();
        if (value === 'textured') return adopt(value, () => {
          if (isSampledCloudMode(materialMode)) selectMaterial(materialMode, true);
          else {
            clearDensityOverrides();
            selectMaterial('shape', true);
            preset = null;
          }
        });
        const mode = CLOUD_MODES.find(item => item === value);
        if (mode === undefined) return '该材质没有已 Cook 入口。';
        if (isSampledCloudMode(mode)) return adopt(mode, () => {
          if (!layer.enabled || !isSampledCloudMode(materialMode)) return '切换云资产前请启用纹理云。';
          world.set(cloud, VolumetricCloudLayer, {
            materialInstance: materialOption(mode).instanceHandle ?? (0 as AssetHandle<'cloud-material-instance'>),
          }).unwrap();
          materialMode = mode;
        });
        return adopt(mode, () => {
          deactivateDaytime();
          if (mode !== materialMode && !(materialMode.startsWith('band') && mode.startsWith('band'))) clearDensityOverrides();
          selectMaterial(mode, true);
          applyView(0);
          preset = null;
        });
      };
      const applySolarRequest = (action: string, value: Record<string, unknown>) => {
        const fields = readSunFields(value.fields);
        if (!fields) return;
        applyUnacknowledgedCloudChange(action, fields, () => {
          applySun(fields);
          runtimeParameters = { ...runtimeParameters, ...fields };
          preset = null;
          if (daytimeActive) {
            daytimePlaying = false;
            applyParameters(evaluateDaytimeParameters(fields.sunElevation), false);
          }
          port?.postMessage({ channel: CHANNEL, sun: readSun(), requestId: value.solarId });
        });
      };
      const initializeCloudTime = (value: unknown, adopt: AdoptCloudChange): string | undefined => {
        const checked = validateCloudEdit({ referenceTimeSeconds: value });
        if (!('edit' in checked)) return '参考时间须在允许范围内。';
        const seconds = checked.edit.referenceTimeSeconds ?? referenceTimeSeconds;
        return adopt({ referenceTimeSeconds: seconds }, () => {
          deactivateDaytime('已手动初始化参考时间，自动退出白昼变换。');
          initializeClock(seconds);
        });
      };
      const resetCloudParameters = (adopt: AdoptCloudChange): string | undefined => {
        const error = adopt(null, () => {
          deactivateDaytime();
          return restoreConfiguration(baseline);
        });
        if (!error) preset = null;
        return error;
      };
      const isCurrentCloudRequest = (requestId: unknown) =>
        requestId === undefined ||
        (typeof requestId === 'number' && Number.isSafeInteger(requestId) && requestId > lastClientRequestId);
      const handleUnacknowledgedCloudAction = (action: string, value: unknown): boolean => {
        if (action === 'sun-update' && isRecord(value)) {
          applySolarRequest(action, value);
          return true;
        }
        if (action === 'shadow-comparison') {
          applyShadowComparison(value);
          return true;
        }
        return false;
      };
      const publishCloudActionResult = (id: number, clientId: number | null, action: string, value: unknown, error: string | undefined) => {
        latestRequest = { id, clientId, action, requested: value ?? null, status: error ? 'rejected' : 'cpu-applied', ...(error ? { reason: error } : {}) };
        cloudStatus = error ?? actionNotice;
        cloudReadRequested = true;
      };
      const processCloudAction = ({ action, value, requestId, loadError }: typeof cloudActions[number]) => {
        if (!isCurrentCloudRequest(requestId)) return;
        const clientId = typeof requestId === 'number' ? requestId : null;
        if (clientId !== null) lastClientRequestId = clientId;
        if (handleUnacknowledgedCloudAction(action, value)) return;
        const id = ++lastRequestId;
        const adopt = (requested: unknown, change: () => string | void) =>
          cloudRequests.apply({ id, clientId, action, requested, status: 'cpu-applied' }, change);
        actionNotice = undefined;
        let error = loadError;
        if (error === undefined) switch (action) {
          case 'cloud-update': error = updateCloudParameters(value, adopt); break;
          case 'cloud-initialize': error = initializeCloudTime(value, adopt); break;
          case 'cloud-pause': paused = !paused; break;
          case 'cloud-reset': error = resetCloudParameters(adopt); break;
          case 'cloud-preset': error = applyCloudPreset(value, adopt); break;
          case 'daytime-toggle': error = toggleDaytime(adopt); break;
          case 'daytime-play': error = toggleDaytimePlayback(adopt); break;
          case 'daytime-speed': error = setDaytimeSpeed(value, adopt); break;
          case 'daytime-jump': error = jumpDaytimeStage(value, adopt); break;
          case 'cloud-snapshot-save':
            savedSnapshot = captureSnapshot();
            snapshotHistory.capture(savedSnapshot, 'saved');
            break;
          case 'cloud-snapshot-load': error = loadCloudSnapshot(value, adopt); break;
          case 'cloud-material': error = switchCloudMaterial(value, adopt); break;
          default: return;
        }
        publishCloudActionResult(id, clientId, action, value, error);
      };
      let loadingStreamedCloudOption = false;
      const processCloudActions = () => {
        // Keep HUD requests ordered while streaming the first-use texture bundle.
        while (!loadingStreamedCloudOption && cloudActions.length > 0) {
          const pending = cloudActions[0]!;
          const target = pending.action === 'cloud-material' ? pending.value
            : pending.action === 'cloud-snapshot-load' ? readCloudSnapshot(pending.value)?.config.materialMode : undefined;
          if (pending.loadError === undefined && isStreamedCloudSet(target) && !streamedCloudOptions.has(target) &&
            isCurrentCloudRequest(pending.requestId)) {
            loadingStreamedCloudOption = true;
            const finish = (error: string | undefined) => {
              if (error !== undefined) pending.loadError = error;
              loadingStreamedCloudOption = false;
            };
            void loadStreamedCloudOption(target).then(finish, () => finish('云纹理加载失败，请重试。'));
            return;
          }
          cloudActions.shift();
          processCloudAction(pending);
        }
      };
      const queueSunUpdate = (data: Record<string, unknown>) => {
        const fields = readSunFields('sun' in data ? data.sun : undefined);
        const requestId = 'requestId' in data ? data.requestId : undefined;
        if (fields && typeof requestId === 'number' && Number.isSafeInteger(requestId) && requestId >= 0)
          cloudActions.push({ action: 'sun-update', value: { fields, solarId: requestId }, requestId: undefined });
      };
      const handleViewAction = (data: Record<string, unknown>) => {
        if (data.action === 'camera-shadow') shadowViewRequested = true;
        if (data.action === 'camera-ground-shadow') groundShadowViewRequested = true;
        if (data.action === 'route') {
          if (routeTime === undefined) {
            cameraView = 'ground';
            world.set(camera, Camera, { historyVersion: world.get(camera, Camera).unwrap().historyVersion + 1 }).unwrap();
          }
          routeTime = routeTime === undefined ? 0 : undefined;
          cloudReadRequested = true;
        }
        if (data.action === 'cut') cutRequested = true;
        if (data.action === 'cloud-view-normal') cloudViewRequested = 0;
        if (data.action === 'cloud-view-transmittance') cloudViewRequested = 3;
        if (data.action === 'cloud-view-contour') cloudViewRequested = 4;
        if (data.action === 'cloud-read') cloudReadRequested = true;
      };
      const cloudActionValue = (data: Record<string, unknown>): unknown => {
        if (data.action === 'cloud-update' && 'fields' in data) return data.fields;
        if (data.action === 'cloud-preset' && 'preset' in data) return data.preset;
        if (data.action === 'cloud-snapshot-load' && 'snapshot' in data) return data.snapshot;
        if (data.action === 'daytime-speed' && 'speed' in data) return data.speed;
        if (data.action === 'daytime-jump' && 'stage' in data) return data.stage;
        return 'value' in data ? data.value : undefined;
      };
      const queueCloudAction = (data: Record<string, unknown>, requestId: unknown) => {
        if ('frame' in data && data.action === 'cloud-snapshot-save')
          receiveReadyFrame(data.frame);
        if (data.action === 'cloud-evidence' && 'frame' in data && 'evidence' in data && isRecord(data.evidence) &&
          (data.frame === null || receiveReadyFrame(data.frame))) {
          // This is the paired presentation plugin's projection of Engine receipts.
          presentationEvidence = data.evidence as CloudRenderEvidence;
        }
        if (['cloud-update', 'cloud-initialize', 'cloud-pause', 'cloud-reset', 'cloud-preset',
          'cloud-snapshot-save', 'cloud-snapshot-load',
          'daytime-toggle', 'daytime-play', 'daytime-speed', 'daytime-jump'].includes(String(data.action))) {
          cloudActions.push({ action: String(data.action), value: cloudActionValue(data), requestId });
        }
      };
      const handleAction = ({ data }: MessageEvent<unknown>) => {
        if (!isRecord(data) || data.channel !== CHANNEL || !('action' in data)) return;
        if (data.action === 'reset') resetRequested = true;
        if (data.action === 'fixture') toggleRequested = !toggleRequested;
        if (data.action === 'sun-update') {
          queueSunUpdate(data);
          return;
        }
        if (data.action === 'shadow-comparison') {
          cloudActions.push({ action: 'shadow-comparison', value: data.sunRequestId, requestId: undefined });
          return;
        }
        const requestId = data.requestId;
        const mode = (['off', 'textured', ...CLOUD_MODES] as const).find(mode => data.action === `cloud-${mode}`);
        if (mode !== undefined) {
          cloudActions.push({ action: 'cloud-material', value: mode, requestId });
          return;
        }
        handleViewAction(data);
        queueCloudAction(data, requestId);
      };
      port?.addEventListener('message', handleAction);
      port?.start();
      yield () => port?.removeEventListener('message', handleAction);
      const unregister = gameHost.gameProjection?.registerRead({
        id: 'vc-ue5.ground',
        title: '地面相机与遮挡物',
        read: () => {
          const transform = world.get(camera, Transform).unwrap();
          const projection = world.get(camera, Camera).unwrap();
          return {
            position: Array.from(transform.pos), rotation: Array.from(transform.quat),
            yaw: pose.yaw, pitch: pose.pitch, fov: projection.fov, aspect: projection.aspect,
            cameraView,
            exposure: projection.exposure, tonemap: projection.tonemap, fixtureVisible,
            historyVersion: projection.historyVersion,
            routeTime: routeTime ?? null,
          };
        },
      });
      if (unregister) yield unregister;
      const applyShadowComparison = (sunRequestId: unknown) => {
        shadowViewRequested = true;
        const requested = { materialMode: 'band', sunAzimuth: 90, sunElevation: 36,
          windX: 0, windY: 0, windZ: 0, groundShadowEnabled: true,
          atmosphereShadowEnabled: false, surfaceShadowStrength: 1, ...CLOUD_PRESET_DEFAULTS };
        applyUnacknowledgedCloudChange('shadow-comparison', requested, () => {
          deactivateDaytime();
          applySun(requested);
          const { materialMode: _materialMode, ...parameters } = requested;
          runtimeParameters = { ...runtimeParameters, ...parameters };
          preset = null;
          if (typeof sunRequestId === 'number' && Number.isSafeInteger(sunRequestId) && sunRequestId >= 0)
            port?.postMessage({ channel: CHANNEL, sun: readSun(), requestId: sunRequestId });
          windX = windY = windZ = 0;
          initializeClock(0);
          shadowControls = { ...shadowControls, groundShadowEnabled: true, atmosphereShadowEnabled: false, surfaceShadowStrength: 1 };
          world.set(cloud, VolumetricCloudLayer, { ...shadowConsumerFields(shadowControls), ...CLOUD_PRESET_DEFAULTS }).unwrap();
          clearDensityOverrides();
          selectMaterial('band', true);
          applyView(0);
        });
      };
      const updateFixture = (keyboard: InputSnapshot['keyboard']) => {
        const reset = resetRequested || keyboard.justPressedCode('KeyR');
        resetRequested = false;
        const toggle = toggleRequested || keyboard.justPressedCode('KeyO');
        toggleRequested = false;
        if (reset || toggle) {
          fixtureVisible = reset || !fixtureVisible;
          world.set(occluder, Visibility, { state: fixtureVisible
            ? VisibilityStateValue.visible : VisibilityStateValue.hidden }).unwrap();
          port?.postMessage({ channel: CHANNEL, fixtureVisible });
        }
        return reset;
      };
      const moveCamera = (input: InputSnapshot) => {
        const keyboard = input.keyboard;
        const movementDt = Math.min(0.05, world.getResource(Time).delta);
        const key = (positive: string, negative: string) =>
          Number(keyboard.downCode(positive)) - Number(keyboard.downCode(negative));
        const right = key('KeyD', 'KeyA');
        const forward = key('KeyW', 'KeyS');
        const drag = input.mouse.button(2);
        const turn = key('ArrowRight', 'ArrowLeft') * movementDt * 65 * degrees +
          (drag ? input.mouse.movementDelta.x : 0) * 0.18 * degrees;
        const tilt = key('ArrowUp', 'ArrowDown') * movementDt * 65 * degrees -
          (drag ? input.mouse.movementDelta.y : 0) * 0.18 * degrees;
        if (!(right || forward || turn || tilt)) return false;
        stepGroundCamera(pose, right, forward, turn, tilt, movementDt);
        return true;
      };
      const updateCameraPose = (reset: boolean, dt: number, input: InputSnapshot) => {
        if (reset) {
          routeTime = undefined;
          cameraView = 'ground';
          pose = referenceCamera();
          cloudReadRequested = true;
          world.set(camera, Camera, { historyVersion: world.get(camera, Camera).unwrap().historyVersion + 1 }).unwrap();
        } else if (groundShadowViewRequested) {
          groundShadowViewRequested = false;
          routeTime = undefined;
          cameraView = 'ground-shadow';
          pose = groundShadowCamera();
          cloudReadRequested = true;
          world.set(camera, Camera, { historyVersion: world.get(camera, Camera).unwrap().historyVersion + 1 }).unwrap();
        } else if (shadowViewRequested) {
          shadowViewRequested = false;
          routeTime = undefined;
          cameraView = 'shadow';
          pose = shadowInspectionCamera();
          cloudReadRequested = true;
          world.set(camera, Camera, { historyVersion: world.get(camera, Camera).unwrap().historyVersion + 1 }).unwrap();
        } else if (cutRequested) {
          cutRequested = false;
          routeTime = undefined;
          cloudReadRequested = true;
          pose = weatherCutPose(pose);
          world.set(camera, Camera, { historyVersion: world.get(camera, Camera).unwrap().historyVersion + 1 }).unwrap();
        } else if (routeTime !== undefined) {
          routeTime += dt;
          pose = weatherRoutePose(routeTime);
        } else {
          return moveCamera(input);
        }
        return true;
      };
      const publishCloudState = () => {
        if (!cloudReadRequested) return;
        cloudReadRequested = false;
        port?.postMessage({ channel: CHANNEL, cloud: readCloud(), cloudStatus });
      };
      const inputSystem = defineSystem({
        name: SYSTEM,
        after: [InputFrameStartScan],
        before: [PropagateTransforms],
        queries: [],
        fn: () => {
          const size = gameHost.drawingBufferSize?.();
          if (size && size.width > 0 && size.height > 0 && size.width / size.height !== aspect) {
            aspect = size.width / size.height;
            world.set(camera, Camera, { aspect }).unwrap();
          }
          const input = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
          clockInitializedThisUpdate = false;
          captureInitialSnapshot();
          processCloudActions();
          const dt = paused || clockInitializedThisUpdate ? 0 : Math.min(0.1, world.getResource(Time).delta);
          elapsedSeconds += dt;
          if (daytimeActive && daytimePlaying && dt > 0) {
            const currentElevation = readSun().sunElevation;
            const previousStage = describeDaytimeStage(currentElevation).label;
            const stepped = stepDaytimeElevation(currentElevation, dt, daytimeSpeed);
            applyDaytimeAtElevation(stepped.elevation);
            const nextStage = describeDaytimeStage(stepped.elevation).label;
            if (stepped.completed) {
              daytimePlaying = false;
              cloudStatus = '白昼变换已到达 180° 落日终点。';
              cloudReadRequested = true;
            } else if (nextStage !== previousStage || elapsedSeconds - daytimeLastPublishSeconds >= 0.1) {
              daytimeLastPublishSeconds = elapsedSeconds;
              cloudReadRequested = true;
            }
          }
          if (dt > 0 && (windX !== 0 || windY !== 0 || windZ !== 0)) {
            const offset = world.get(cloud, VolumetricCloudLayer).unwrap().windOffsetMeters;
            world.set(cloud, VolumetricCloudLayer, {
              windOffsetMeters: [offset[0] + windX * dt, offset[1] + windY * dt, offset[2] + windZ * dt],
            }).unwrap();
          }
          if (cloudViewRequested !== undefined) {
            const mode = cloudViewRequested;
            applyUnacknowledgedCloudChange('cloud-view', viewModeOf(mode), () => applyView(mode));
            cloudViewRequested = undefined;
          }
          const reset = updateFixture(input.keyboard);
          if (updateCameraPose(reset, dt, input)) world.set(camera, Transform, cameraTransform(pose)).unwrap();
          publishCloudState();
        },
      });
      world.addSystem(Update, inputSystem).unwrap();
      yield () => world.removeSystem(Update, inputSystem).unwrap();
    });
  },
};

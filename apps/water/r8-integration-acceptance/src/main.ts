import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import type { InputShapeOf, SchemaOf } from '@forgeax/engine/ecs';
import { defineSystem } from '@forgeax/engine/ecs';
import { InputFrameStartScan } from '@forgeax/engine/input';
import { PhysicsSimulation, PhysicsSync, PhysicsWorldResource } from '@forgeax/engine/physics';
import {
  WATER_SYSTEM_RESOURCE,
  WaterBuoyancy,
  WaterBuoyancyCompletion,
  WaterContactProbes,
  WaterSceneReconcile,
} from '@forgeax/engine/runtime';
import type {
  MaterialValue,
  ParticleEffectAsset,
  WaterBodyAsset,
  WaterSimulationRecipeAsset,
  WaterZoneAsset,
} from '@forgeax/engine/types';
import { createWaterCameraControls } from '../../camera-controls';
import { requireDemoMethod, requireDemoValue } from '../../runtime-input';
import {
  bodyEvidence,
  completedCpuWaterMesh,
  configurationCapabilityReport,
  configurationEvidence,
  configurationRendererFacts,
  configurationZoneSettings,
  extinction,
  finiteNumber,
  loadQualityMaterialSources,
  logicalBudget,
  materialControlNames,
  materialDrawEvidence,
  rgbValue,
  sceneEvidence,
  updateVisibleWater as updateWaterMaterialValues,
  waterComposition,
  waterMaterialObservation,
  waterTelemetry,
} from './configuration-evidence';
import {
  createR8ProfileCapture,
  exactProfileToken,
  type R8FrameCompletion,
  type R8ProfileReceipt,
  type R8ProfileRun,
  type R8SubmittedFrameSample,
  receiptKey,
  submittedFrameSample,
} from './profile-capture';
import '../../suite.css';
import {
  configureRuntimeAssetCatalog,
  createRuntimeAssetImportTransport,
  runtimeBinding,
} from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine/app/browser';
import { EngineContent } from '@forgeax/engine/content';
import { type EntityHandle, FixedTime, FixedUpdate, Time, Update } from '@forgeax/engine/ecs';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine/input';
import { mat4, quat, vec3 } from '@forgeax/engine/math';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import { inspectPhysicsCapabilities, type PhysicsWorld, RigidBody } from '@forgeax/engine/physics';
import physics3d from '@forgeax/engine/physics-rapier3d';
import type { Plugin } from '@forgeax/engine/plugin';
import {
  ANTIALIAS_TAA,
  Camera,
  createWaterFluidFeature,
  DEFAULT_STANDARD_PROFILE,
  DirectionalLight,
  type FrameReceipt,
  inspectWaterRenderCapabilities,
  MeshFilter,
  MeshRenderer,
  perspective,
  type RenderInspection,
  renderFeatureTextureSource,
  ScreenSpaceReflection,
  SKYBOX_MODE_CUBEMAP,
  SkyboxBackground,
  Skylight,
  TONEMAP_ACES_FILMIC,
  Visibility,
  VisibilityStateValue,
} from '@forgeax/engine/render';
import { createWaterInfoCaptureDeferralProbe } from '@forgeax/engine/render/internal';
import { inspectRhiDeviceFacts } from '@forgeax/engine/rhi';
import {
  WATER_BUOYANCY_RESOURCE,
  WATER_VISUAL_CONTACTS_RESOURCE,
  type WaterBuoyancyState,
  waterSceneSnapshot,
  waterSceneZoneSnapshot,
} from '@forgeax/engine/runtime';
import {
  readPresentationWorldMatrix,
  sceneEntity,
  Transform,
  WaterBodyInstance,
  WaterContactProbeSet,
  WaterFluidSimulation,
  WaterPontoonSet,
  WaterZoneInstance,
  worldResolveSceneEntity,
} from '@forgeax/engine/scene';
import { ParticleEffectPlayer } from '@forgeax/engine/vfx';
import { createVfxRuntimeHost } from '@forgeax/engine/vfx-render';
import {
  cookWaterAsset,
  rotateWaterVector,
  type WaterAdvancedSimulation,
  type WaterCapabilitySelection,
  type WaterOceanPatch,
  WaterQueryFlags,
  type WaterSystem,
  type WaterVisualContactState,
  waterAdvancedOutputNames,
  waterOceanPatchOutputNames,
} from '@forgeax/engine/water';
import {
  type RuntimeFormField,
  type RuntimeFormFields,
  refreshRuntimeForms,
  runtimeForm,
  runtimeFormVisible,
  runtimeObjectFields,
} from '../../runtime-form';
import { contactProbeInput, pontoonInput } from '../../runtime-input';
import {
  waterEntrySplashDefaults,
  waterEntrySplashParameters,
  waterEntryWaveImpulse,
} from '../assets/entry-splash';
import { COAST_SHIP_MASS_RIG } from '../assets/ship-rig';
import { mountCoastControls } from './control-panel';
import { sampleWaterEntryAttachment, type WaterEntryAttachment } from './entry-attachment';
import {
  COAST_FOAM_CAPTURE,
  COAST_FOAM_DECAY_PER_SECOND,
  COAST_MESH_PROFILES,
  COAST_SEED,
  COAST_SHIP_ROUTE,
  IRON_BALL_MASS_KG,
  IRON_BALL_RADIUS_M,
  SUN_DIRECTION,
  WATER_R8_PACKAGE,
} from './identity';
import {
  ironBallPhysics,
  ironBallSubmerged,
  readIronBallParticipation,
  releaseIronBallWaterCollider,
  sampleIronBallEntry,
} from './iron-ball';
import { snapshotWaterBuoyancyStepForTrace } from './physics-trace';
import {
  shipPontoonLayout,
  WATER_QUALITY_PRESETS,
  type WaterQualityPreset,
} from './quality-presets';
import { DEFAULT_SHIP_HANDLING, readShipHelmInput, stepShipHelm } from './ship-handling';
import './style.css';

type Vector = [number, number, number];
type Mode =
  | 'Q0'
  | 'Q1'
  | 'Q2'
  | 'Q3'
  | 'Q4'
  | 'R1'
  | 'R5'
  | 'R6'
  | 'R7-shallow'
  | 'R7-bake'
  | 'R7-fft';
type View = 'near' | 'middle' | 'far' | 'underwater';
const element = <T extends HTMLElement = HTMLElement>(id: string) => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element ${id}`);
  return found as T;
};
const selections: Record<Mode, WaterCapabilitySelection> = {
  Q0: { quality: 'Q0', configuration: 'surface' },
  Q1: { quality: 'Q1', configuration: 'surface' },
  Q2: { quality: 'Q2', configuration: 'surface-without-ssr' },
  Q3: { quality: 'Q3', configuration: 'surface' },
  Q4: { quality: 'Q4', configuration: null },
  R1: { quality: null, configuration: 'gpu-mesh', subfeature: 'gpu-mesh' },
  R5: { quality: null, configuration: 'async-buoyancy', subfeature: 'async-buoyancy' },
  R6: { quality: null, configuration: 'fluid-simulation', subfeature: 'fluid-simulation' },
  'R7-shallow': { quality: null, configuration: 'advanced-simulation', subfeature: 'advanced-shallow' },
  'R7-bake': { quality: null, configuration: 'advanced-simulation', subfeature: 'river-bake' },
  'R7-fft': { quality: null, configuration: 'advanced-simulation', subfeature: 'ocean-fft' },
};
const regions: Record<string, Vector> = {
  ship: [0, 3, 0],
  island: [-16, 2, -62],
  shallows: [-8, 0, -38],
  ocean: [45, 0, -70],
};
const unavailableModes: Partial<Record<Mode, string>> = {
  'R7-bake':
    'River baking requires a river body, durable texture outputs and a bound query grid. Open the river simulation scene.',
  'R7-fft':
    'The coast uses gravity-wave simulation. Open the ocean simulation scene for spectral FFT.',
};
const json = (_: string, value: unknown): unknown =>
  value instanceof Error
    ? {
        name: value.name,
        message: value.message,
        ...Object.fromEntries(Object.entries(value)),
        ...(value.cause === undefined ? {} : { cause: value.cause }),
      }
    : value instanceof Set
      ? [...value]
      : value instanceof Map
        ? Object.fromEntries(value)
        : ArrayBuffer.isView(value)
          ? Array.from(value as unknown as ArrayLike<number>)
          : value;

async function main() {
  const canvas = element<HTMLCanvasElement>('scene');
  const profileCapture = createR8ProfileCapture(
    () => physics(),
    (kind, detail) => record(kind, detail),
    json,
  );
  const {
    profiler,
    startProfileCapture,
    finishProfileCapture,
    exportProfileCapture,
    downloadProfileCapture,
  } = profileCapture;
  let vfxCamera: EntityHandle | undefined;
  const vfxHost = createVfxRuntimeHost({
    camera: {
      read(world) {
        if (vfxCamera === undefined) return undefined;
        const transform = world.get(vfxCamera, Transform);
        const camera = world.get(vfxCamera, Camera);
        if (!transform.ok || !camera.ok) return undefined;
        const position = new Float32Array(transform.value.pos);
        const right = quat.transformVec3(vec3.create(), transform.value.quat, [1, 0, 0]);
        const up = quat.transformVec3(vec3.create(), transform.value.quat, [0, 1, 0]);
        const projection = mat4.perspectiveReverseZ(
          mat4.create(),
          camera.value.fov,
          camera.value.aspect,
          camera.value.near,
          camera.value.far,
        );
        const viewMatrix = mat4.lookAt(mat4.create(), position, target, [0, 1, 0]);
        return {
          position,
          right,
          up,
          viewProjection: mat4.multiply(mat4.create(), projection, viewMatrix),
        };
      },
    },
  });
  const waterInfoProbe = createWaterInfoCaptureDeferralProbe();
  let onReceiptCompleted: ((event: R8FrameCompletion) => void) | undefined;
  const profilePhysics3dPlugin: Plugin = {
    name: 'water-r8-profiled-physics',
    async apply(ctx) {
      await ctx.plugin(physics3d, { profileNativeStepTimings: true });
    },
  };
  element('state').textContent = '正在创建渲染器';
  const app = (
    await createApp(
      canvas,
      {
        // R8 retains at most four complete source flights and rejects larger
        // readback rosters before GPU allocation.
        featureTextureReadbackBudgetBytes: 64 * 1024 * 1024 * 4,
        plugins: [profilePhysics3dPlugin],
        features: [
          waterInfoProbe.feature,
          vfxHost.feature,
          createWaterFluidFeature({
            contactFoam: {
              resolution: COAST_FOAM_CAPTURE.resolution,
              decayPerSecond: COAST_FOAM_DECAY_PER_SECOND,
              strengthPerMps: 0.08,
            },
          }),
        ],
        uiRoot: element('controls-panel'),
        pointerLockAllowed: () => false,
        profiler,
        onFrameCompleted: (event) => onReceiptCompleted?.(event),
        standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath: 'deferred' },
        gpuPassTiming: { maxPassesPerFrame: 512, retentionFrames: 8 },
        ...(__WATER_R8_SSR_IDENTITY__ === null ? {} : { ssrIdentity: __WATER_R8_SSR_IDENTITY__ }),
        ...(runtimeBinding ? { assetRuntimeBinding: runtimeBinding } : {}),
        pluginPrograms: {
          sessionId: crypto.randomUUID(),
          contextId: 'water-r8',
          sessionGeneration: 1,
          target: 'engine',
          tools: new Map(),
          definitions: new Map(),
          programs: new Map(),
        },
        time: { fixedDeltaSeconds: 1 / 60, maxStepsPerUpdate: 4, maxDeltaSeconds: 0.1 },
      },
      {
        ...forgeaxBundlerAdapter(),
        importTransport: createRuntimeAssetImportTransport(runtimeBinding),
      },
    )
  ).unwrap();
  const { world, assets } = app;
  if (!assets) throw new Error('Asset registry unavailable');
  configureRuntimeAssetCatalog(assets, runtimeBinding);
  const guid = (key: string) => AssetGuid.format(AssetGuid.derive(WATER_R8_PACKAGE, key));
  element('state').textContent = '正在载入海岸场景';
  const scene = (await assets.load(guid('scene/coast'), 'scene')).unwrap();
  element('state').textContent = '正在实例化场景';
  const root = assets.instantiate(scene, world).unwrap();
  const sourceKey = assets.sourceKeyOf(guid('scene/coast'));
  if (!sourceKey) throw new Error('Saved coast Scene has no accepted source key');
  const resolve = (key: string) =>
    worldResolveSceneEntity(world, root, sceneEntity(sourceKey, key)).unwrap();
  const ship = resolve('ship'),
    zone = resolve('zone'),
    oceanFoam = resolve('ocean-foam');
  let shipRigAdmission:
    | { kind: 'unrequested' }
    | { kind: 'queued' | 'ready'; candidateId: string } = { kind: 'unrequested' };
  const zoneAsset = (await assets.load(guid('zone/coast'), 'water-zone')).unwrap();
  const originalZone = assets.read(zoneAsset).unwrap();
  const bodies = await Promise.all(
    ['ocean'].map(async (type) => ({
      type,
      entity: resolve(type),
      handle: (await assets.load(guid(`body/${type}`), 'water-body')).unwrap(),
    })),
  );
  const originalBodies = bodies.map((body) => assets.read(body.handle).unwrap());
  const windSources = await Promise.all(
    ['breeze', 'q1'].map(async (name) => {
      const handle = (await assets.load(guid(`waves/${name}`), 'water-wave-set')).unwrap();
      return { handle, source: assets.read(handle).unwrap() };
    }),
  );
  const maximumWindStrength = 2.4;
  let windStrength = 1;
  let windDirectionDegrees = 35;
  let wavelengthScale = 1;
  let directionSpreadDegrees = 65;
  let spectrumRandomness = 0.8;
  let authoredWaveCount = requireDemoValue(windSources[0], 'accepted authored scene member').source
    .waves.length;
  let pendingWindStrength: number | undefined;
  const applyWindStrength = (strength: number) => {
    const prepared = windSources.map(({ handle, source }) => {
      const cooked = cookWaterAsset({
        kind: 'water-wave-set',
        waveSource: {
          kind: 'generated',
          seed: 1337,
          generatorId: 'forgeax.gerstner.simple',
          generatorVersion: '1',
          generatorConfig: {
            count: authoredWaveCount,
            randomness: spectrumRandomness,
            wavelengthMinM: 1.3 * wavelengthScale,
            wavelengthMaxM: 19 * wavelengthScale,
            wavelengthFalloff: 2,
            amplitudeMinM: 0.006 * strength,
            amplitudeMaxM: 0.16 * strength,
            amplitudeFalloff: 2.5,
            windAngleDegrees: windDirectionDegrees,
            directionAngularSpreadDegrees: directionSpreadDegrees,
            largeWaveSteepness:
              (Math.min(0.0625, 0.85 / Math.max(1, authoredWaveCount)) * strength) /
              maximumWindStrength,
            smallWaveSteepness:
              (Math.min(0.03, 0.4 / Math.max(1, authoredWaveCount)) * strength) /
              maximumWindStrength,
            steepnessFalloff: 1,
          },
        },
        depthMaskM: source.depthMaskM,
        maxWaveHeightM: source.maxWaveHeightM,
        timeSource: assets.read(handle).unwrap().timeSource,
      }).unwrap();
      if (cooked.kind !== 'water-wave-set') throw new Error('Wind source did not cook a WaveSet');
      return { handle, cooked };
    });
    const previous = prepared.map(({ handle }) => assets.read(handle).unwrap());
    try {
      for (const { handle, cooked } of prepared) assets.replace(handle, cooked).unwrap();
    } catch (error) {
      prepared.forEach(({ handle }, index) => {
        assets
          .replace(handle, requireDemoValue(previous[index], 'previous wave publication'))
          .unwrap();
      });
      throw error;
    }
    windStrength = strength;
    record('wind-source-admitted', {
      strength,
      unit: 'authored-spectrum-multiplier',
      waveRevisions: windSources.map(({ handle }) => assets.revision(handle).unwrap()),
    });
  };
  const materials = await Promise.all(
    ['ocean', 'ocean-lod', 'far'].map((type) =>
      assets.load(guid(`material/water/${type}`), 'material').then((result) => result.unwrap()),
    ),
  );
  type WaterMaterialHandle = (typeof materials)[number];
  const qualityMaterialGuids = {
    Q3: {
      bodies: {
        ocean: {
          surface: EngineContent.water.materials.ocean,
          lod: EngineContent.water.materials['ocean-lod'],
        },
      },
      far: EngineContent.water.materials.far,
    },
    Q4: {
      bodies: {
        ocean: {
          surface: guid('material/water/ocean-q4-flat'),
          lod: guid('material/water/ocean-q4-flat'),
        },
      },
      far: guid('material/water/far-q4-flat'),
    },
  } as const;
  const qualityMaterials = await loadQualityMaterialSources(assets, qualityMaterialGuids),
    qualityMaterialHandles = qualityMaterials.handles,
    qualitySourceClosureAccepted = qualityMaterials.accepted,
    qualitySourceVersion = qualityMaterials.version;
  const modeMaterialHandles = (mode: Mode) =>
    mode === 'Q3' || mode === 'Q4' ? qualityMaterialHandles[mode] : materials;
  const observeWaterMaterial = (handle: WaterMaterialHandle) =>
    waterMaterialObservation(assets.read(handle).unwrap());
  const updateVisibleWater = (project: Parameters<typeof updateWaterMaterialValues>[3]) =>
    updateWaterMaterialValues(
      assets,
      modeMaterialHandles(activeMode),
      transaction !== undefined,
      project,
    );
  const ironBallMesh = (await assets.load(guid('mesh/iron-ball'), 'mesh')).unwrap();
  const ironBallMaterial = (await assets.load(guid('material/iron-ball'), 'material')).unwrap();
  const localRecipe = (
    await assets.load(guid('fluid/coast-local'), 'water-simulation-recipe')
  ).unwrap();
  const originalLocalRecipe = assets.read(localRecipe).unwrap();
  const r7Recipe = (
    await assets.load(guid('fluid/coast-r7-shallow'), 'water-simulation-recipe')
  ).unwrap();
  const ironBallEntryEffect = (
    await assets.load(guid('effect/iron-ball-entry'), 'particle-effect')
  ).unwrap();
  (await vfxHost.attachWorld({ world, assets })).unwrap();
  const vfxControl = vfxHost.acquireControl(world).unwrap();
  // Prepare the canonical entry effect before native time and local-wave history advance.
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0] } },
      {
        component: ParticleEffectPlayer,
        data: {
          effect: ironBallEntryEffect,
          playing: false,
          preparePipelines: true,
          seed: 731,
          timeScale: 1,
        },
      },
    )
    .unwrap();
  element('state').textContent = '正在载入环境';
  Object.assign(window, { __waterR8Boot: { app, assets, world, guid } });
  const skies = await Promise.all(
    ['day', 'sunset', 'overcast'].map((name) =>
      assets.load(guid(`environment/${name}`), 'equirect').then((result) => result.unwrap()),
    ),
  );
  const clearSkies = await Promise.all(
    ['day', 'sunset', 'overcast'].map((name) =>
      assets.load(guid(`environment/${name}-clear`), 'equirect').then((result) => result.unwrap()),
    ),
  );
  let cloudsEnabled = element<HTMLInputElement>('clouds').checked;
  const initialSky = requireDemoValue(
    (cloudsEnabled ? skies : clearSkies)[0],
    'accepted authored scene member',
  );
  const sky = world
    .spawn({
      component: SkyboxBackground,
      data: { equirect: initialSky, mode: SKYBOX_MODE_CUBEMAP },
    })
    .unwrap();
  const ambient = world
    .spawn({
      component: Skylight,
      data: { equirect: initialSky, color: [1, 1, 1], intensity: 0.8 },
    })
    .unwrap();
  const sunlight = world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: SUN_DIRECTION,
        color: [1, 0.97, 0.89],
        intensity: 2.4,
        castShadow: true,
        mapSize: 1024,
        cascadeCount: 3,
      },
    })
    .unwrap();
  let eye: Vector = [29, 10, 40],
    target: Vector = [-1, 5, -3],
    view: View = 'middle';
  const applySkyVariant = (index: number) => {
    const equirect = requireDemoValue(
      (cloudsEnabled ? skies : clearSkies)[index],
      'accepted authored scene member',
    );
    world.set(sky, SkyboxBackground, { equirect }).unwrap();
    world.set(ambient, Skylight, { equirect }).unwrap();
  };
  const acceptedSkyIndex = () => {
    const current = world.get(sky, SkyboxBackground).unwrap().equirect;
    const index = skies.indexOf(current);
    return index >= 0 ? index : clearSkies.indexOf(current);
  };
  const camera = world
    .spawn(
      {
        component: Transform,
        data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, target, [0, 1, 0]) },
      },
      {
        component: Camera,
        data: {
          ...perspective({
            fov: Math.PI / 3.6,
            aspect: canvas.clientWidth / Math.max(1, canvas.clientHeight),
            near: 0.06,
            far: 2200,
          }),
          clearColor: [0.42, 0.66, 0.76, 1],
          antialias: ANTIALIAS_TAA,
          tonemap: TONEMAP_ACES_FILMIC,
          exposure: 1,
        },
      },
      {
        component: ScreenSpaceReflection,
        data: { maxDistance: 180, thickness: 0.3, maxRoughness: 0.65 },
      },
    )
    .unwrap();
  vfxCamera = camera;
  const water = () => world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE);
  const buoyancy = () => world.getResource<WaterBuoyancyState>(WATER_BUOYANCY_RESOURCE);
  const physics = () => world.getResource<PhysicsWorld>(PhysicsWorldResource);
  const contacts = () => world.getResource<WaterVisualContactState>(WATER_VISUAL_CONTACTS_RESOURCE);
  const shipRoute = COAST_SHIP_ROUTE;
  const shipNavigation = {
    running: false,
    braking: false,
    path: 'circle' as 'circle' | 'straight',
    straightDirectionXZ: [1, 0] as readonly [number, number],
    speedMps: 6,
    loop: true,
    completedLaps: 0,
    distanceRadians: 0,
    previousAngle: undefined as number | undefined,
    lastCommand: undefined as
      | {
          fixedStep: number;
          forceN: Vector;
          torqueNm: Vector;
          radialErrorM: number;
          waterDragSource: {
            entity: number;
            generation: number;
            physicsStep: number;
            accelerationMps2: readonly number[];
          } | null;
          nativeDampingPerSecond: number;
          propulsionPowerW: number;
          yawPowerW: number;
        }
      | undefined,
  };
  const handling = { ...DEFAULT_SHIP_HANDLING };
  const helm = { throttle: 0, rudder: 0 };
  const releasedHelmCodes = new Set<string>();
  let manualDriving = false;
  let qualityPreset: WaterQualityPreset | 'custom' = 'custom';
  let qualitySettings = {
    tessellationFactor: originalZone.tessellationFactor,
    waterInfoResolution: originalZone.waterInfo.resolution.widthPx,
    waveCount: authoredWaveCount,
    pontoonCount: world.get(ship, WaterPontoonSet).unwrap().radiiM.length,
    contactProbeCount: world.get(ship, WaterContactProbeSet).unwrap().radiiM.length,
    localResolution:
      originalLocalRecipe.system === 'water-advanced'
        ? (originalLocalRecipe.oceanPatchConfig?.fftResolution ?? 512)
        : 512,
  } as {
    tessellationFactor: number;
    waterInfoResolution: number;
    waveCount: number;
    pontoonCount: number;
    contactProbeCount: number;
    localResolution: number;
  };
  const originalPontoons = structuredClone(world.get(ship, WaterPontoonSet).unwrap());
  const originalContacts = structuredClone(world.get(ship, WaterContactProbeSet).unwrap());
  const parameterForms: ReturnType<typeof runtimeForm>[] = [];
  let refreshControlSummary = () => {};
  const diagnosticDimensionOpen = () => {
    const section = document.getElementById('diagnostic-dimension');
    return section !== null && runtimeFormVisible(section);
  };
  const cannon = {
    horizontalSpeedMps: 11,
    upwardSpeedMps: 3.5,
    radiusM: IRON_BALL_RADIUS_M,
    massKg: IRON_BALL_MASS_KG,
    muzzleOffsetM: [11.5, 2.8, 0],
    playerTimeScale: 1,
    playerSeed: COAST_SEED,
  };
  let shipResetRequested = false;
  let fireRequested = false;
  let localSimulation: WaterOceanPatch | undefined;
  let r7Simulation: WaterAdvancedSimulation | undefined;
  let localBindingIdentity: string | undefined;
  const splashSettings: { -readonly [Key in keyof typeof waterEntrySplashDefaults]: number } = {
    ...waterEntrySplashDefaults,
  };
  const balls: {
    entity: EntityHandle;
    launch: { positionM: Vector; velocityMps: Vector; fixedStep?: number; timeSeconds?: number };
    entryPlayer: EntityHandle;
    radiusM: number;
    massKg: number;
    entryRetireTime?: number;
    entryPlayerRetired?: boolean;
    attachment?: WaterEntryAttachment;
    submerged?: boolean;
    entry?: {
      fixedStep: number;
      bodyGeneration: number;
      positionM: readonly number[];
      normalYUp: readonly number[];
      velocityMps: readonly number[];
    };
    trajectory: {
      fixedStep: number;
      positionM: readonly number[];
      velocityMps: readonly number[];
    }[];
  }[] = [];
  const retireIronBall = (ball: (typeof balls)[number]) => {
    world.despawn(ball.entity).unwrap();
    if (!ball.entryPlayerRetired) {
      world.despawn(ball.entryPlayer).unwrap();
      ball.entryPlayerRetired = true;
    }
  };
  const retireIronBalls = () => {
    for (const ball of balls) retireIronBall(ball);
    balls.length = 0;
  };
  window.addEventListener(
    'pagehide',
    () => {
      retireIronBalls();
      void vfxHost.detachWorld({ world });
    },
    { once: true },
  );
  water().setUnderwaterTraceFilterMask(0x0001_0002).unwrap();
  const position = (): Vector => {
    const matrix = readPresentationWorldMatrix(world, ship);
    return matrix
      ? [
          requireDemoValue(matrix[12], 'accepted authored scene member'),
          requireDemoValue(matrix[13], 'accepted authored scene member'),
          requireDemoValue(matrix[14], 'accepted authored scene member'),
        ]
      : [0, COAST_SHIP_MASS_RIG.buoyancy.loadedRootYM, 0];
  };
  const applyCamera = () => {
    world
      .set(camera, Transform, {
        pos: eye,
        quat: quat.fromLookAt(quat.create(), eye, target, [0, 1, 0]),
      })
      .unwrap();
    world.set(camera, Camera, { projectionOffset: [0, 0] }).unwrap();
  };
  const setView = (next: View) => {
    view = next;
    const center =
      regions[element<HTMLSelectElement>('region').value] ??
      requireDemoValue(regions.ship, 'accepted authored scene member');
    target = [...center];
    const offset: Vector =
      next === 'near'
        ? [21, 6, 29]
        : next === 'far'
          ? [75, 34, 96]
          : next === 'underwater'
            ? [8, -2.4 - center[1], 16]
            : [24, 7, 33];
    eye = center.map(
      (v, i) => v + requireDemoValue(offset[i], 'accepted authored scene member'),
    ) as Vector;
    if (next === 'underwater') target = [center[0] - 3, -1.2, center[2] - 8];
    if (element<HTMLSelectElement>('region').value === 'ship') {
      if (next === 'middle') {
        eye = [7.5, 9.7, 32];
        target = [-1.2, 4.5, -3];
      } else if (next === 'near') {
        eye = [8, 6.5, 25];
        target = [-2, 3.2, 0];
      } else if (next === 'underwater') {
        eye = [5, -2.4, 8];
        target = [-13, 13, -12];
      }
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-view]'))
      button.setAttribute('aria-pressed', String(button.dataset.view === next));
    applyCamera();
  };
  const errors: unknown[] = [],
    operations: Record<string, unknown>[] = [];
  const fixedTrace: unknown[] = [],
    cpuTrace: unknown[] = [],
    renderTrace: unknown[] = [],
    gpuTimings: unknown[] = [];
  const diagnostics = {
    enabled: false,
    startedAtMs: null as number | null,
    inspectionIntervalMs: 500,
  };
  let lastInspectionMs = -Infinity;
  const setDiagnostics = (enabled: boolean) => {
    diagnostics.enabled = enabled;
    diagnostics.startedAtMs = enabled ? performance.now() : null;
    lastInspectionMs = -Infinity;
    fixedTrace.length = 0;
    cpuTrace.length = 0;
    renderTrace.length = 0;
    gpuTimings.length = 0;
    completedFrameTimes.length = 0;
  };
  const record = (kind: string, detail: unknown) => {
    operations.push({ kind, wallTime: performance.now(), detail });
    if (operations.length > 100) operations.shift();
  };
  const message = (text: string) => {
    element('message').textContent = text;
    element('message').hidden = false;
  };
  let rollbackConfiguration: ((reason: unknown) => void) | undefined;
  const report = (error: unknown) => {
    const candidate = transaction !== undefined;
    errors.push(error);
    if (errors.length > 64) errors.shift();
    console.error(error);
    rollbackConfiguration?.(error);
    message(
      typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : String(error),
    );
    if (
      !candidate &&
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'app-system-update-failed'
    )
      app.pause();
  };
  app.onError(report);
  let requestedMode: Mode = 'Q0',
    activeMode: Mode = 'Q0';
  let meshProfile: keyof typeof COAST_MESH_PROFILES = 'coast64';
  let completedFrames = 0,
    completedReceipt:
      | Pick<FrameReceipt, 'frameId' | 'deviceGeneration' | 'graphGeneration'>
      | undefined;
  let latest: RenderInspection | undefined,
    lastRefresh = 0,
    modeRevision = 0;
  const configurationSnapshot = () => ({
    qualityPreset,
    qualitySettings: { ...qualitySettings },
    waveCount: authoredWaveCount,
    waves: windSources.map(({ handle }) => assets.read(handle).unwrap()),
    pontoons: structuredClone(world.get(ship, WaterPontoonSet).unwrap()),
    contacts: structuredClone(world.get(ship, WaterContactProbeSet).unwrap()),
    localRecipe: assets.read(localRecipe).unwrap(),
    meshProfile,
    zone: assets.read(zoneAsset).unwrap(),
    bodies: bodies.map((body) => assets.read(body.handle).unwrap()),
    materials: materials.map((handle) => assets.read(handle).unwrap()),
    fluid: world.get(oceanFoam, WaterFluidSimulation).unwrap(),
    ssr: world.get(camera, ScreenSpaceReflection),
    asyncEnabled: buoyancy().asyncEnabled,
    useAsyncPath: world.get(ship, WaterPontoonSet).unwrap().useAsyncPath,
  });
  let transaction:
    | {
        revision: number;
        mode: Mode;
        previous: Mode;
        frameAfter: number;
        deviceGeneration: number;
        zoneRevision: number;
        zoneGenerationBefore: number;
        expectedZone: typeof originalZone;
        waveSetGuid: string;
        bodyRevisions: readonly number[];
        materialHandles: readonly WaterMaterialHandle[];
        materialRevisions: readonly number[];
        legacyFluidEnabled: boolean;
        asyncCompletedBefore: number;
        status: 'preparing' | 'awaiting-completion';
        blockers: readonly string[];
        before: ReturnType<typeof configurationSnapshot>;
        beforeGraph: unknown;
      }
    | undefined;
  let zoneRemoved = false,
    materialMissing = false,
    oceanChanged = false,
    smallResolution = false;
  const physicsFacts = () => inspectPhysicsCapabilities(physics());
  const bodySnapshot = (body: (typeof bodies)[number]) => waterSceneSnapshot(world, body.entity);
  const transactionEvidence = (candidate: NonNullable<typeof transaction>) => {
    const { before: _before, ...evidence } = candidate;
    return evidence;
  };
  const lockConfiguration = (locked: boolean) => {
    for (const form of parameterForms) form.setDisabled(locked);
    const preset = document.getElementById('quality-preset') as HTMLSelectElement | null;
    if (preset) preset.disabled = locked;
    for (const id of [
      'quality',
      'waves',
      'region',
      'water-color',
      'crests-enabled',
      'depth-foam-enabled',
      'contacts-enabled',
      'buoyancy-enabled',
    ])
      element<HTMLSelectElement | HTMLInputElement>(id).disabled = locked;
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-fault]'))
      button.disabled = locked;
  };
  rollbackConfiguration = (reason) => {
    const failed = transaction;
    if (!failed) return;
    transaction = undefined;
    const failures: unknown[] = [];
    const restore = (operation: () => void) => {
      try {
        operation();
      } catch (error) {
        failures.push(error);
      }
    };
    restore(() => {
      assets.replace(zoneAsset, failed.before.zone).unwrap();
    });
    restore(() => {
      world.set(ship, WaterPontoonSet, failed.before.pontoons).unwrap();
    });
    restore(() => {
      world.set(ship, WaterContactProbeSet, failed.before.contacts).unwrap();
    });
    restore(() => {
      assets.replace(localRecipe, failed.before.localRecipe).unwrap();
    });
    windSources.forEach(({ handle }, index) => {
      restore(() => {
        assets
          .replace(
            handle,
            requireDemoValue(failed.before.waves[index], 'accepted authored scene member'),
          )
          .unwrap();
      });
    });
    authoredWaveCount = failed.before.waveCount;
    qualityPreset = failed.before.qualityPreset;
    qualitySettings = { ...failed.before.qualitySettings };
    for (const [index, body] of bodies.entries())
      restore(() => {
        assets
          .replace(
            body.handle,
            requireDemoValue(failed.before.bodies[index], 'accepted authored scene member'),
          )
          .unwrap();
      });
    for (const [index, handle] of materials.entries())
      restore(() => {
        assets
          .replace(
            handle,
            requireDemoValue(failed.before.materials[index], 'accepted authored scene member'),
          )
          .unwrap();
      });
    restore(() => {
      world.set(oceanFoam, WaterFluidSimulation, failed.before.fluid).unwrap();
    });
    restore(() => {
      const ssr = world.get(camera, ScreenSpaceReflection);
      if (failed.before.ssr.ok) {
        if (ssr.ok) world.set(camera, ScreenSpaceReflection, failed.before.ssr.value).unwrap();
        else
          world
            .addComponent(camera, {
              component: ScreenSpaceReflection,
              data: failed.before.ssr.value,
            })
            .unwrap();
      } else if (ssr.ok) world.removeComponent(camera, ScreenSpaceReflection).unwrap();
    });
    restore(() => {
      buoyancy().asyncEnabled = failed.before.asyncEnabled;
    });
    restore(() => {
      world.set(ship, WaterPontoonSet, { useAsyncPath: failed.before.useAsyncPath }).unwrap();
    });
    requestedMode = failed.previous;
    meshProfile = failed.before.meshProfile;
    element<HTMLSelectElement>('quality').value = failed.previous;
    lockConfiguration(false);
    record('configuration-rolled-back', {
      transaction: transactionEvidence(failed),
      reason,
      failures,
      restored: failures.length === 0,
    });
    element('transition').textContent = failures.length
      ? '候选配置失败，恢复未完成'
      : '候选配置失败，已恢复上一配置';
    for (const form of parameterForms) form.rejectPending(reason);
    if (failures.length) {
      errors.push(...failures);
      app.pause().unwrap();
    }
  };
  const completedCpuMesh = (inspection: RenderInspection) =>
    completedCpuWaterMesh(
      inspection,
      completedReceipt,
      waterSceneZoneSnapshot(world, guid('zone/coast')),
      bodies.map(bodySnapshot),
      (zone, view) => water().zoneMeshView(zone, view),
    );
  const completedConfigurationEvidence = (
    candidate: NonNullable<typeof transaction>,
    receipt: FrameReceipt,
    inspection: RenderInspection,
  ) => {
    const zone = waterSceneZoneSnapshot(world, guid('zone/coast')),
      snapshots = bodies.map(bodySnapshot);
    return configurationEvidence(candidate, receipt, inspection, {
      zone,
      bodies: snapshots,
      readMesh: (zoneGuid, viewIdentity) => water().zoneMeshView(zoneGuid, viewIdentity),
      get async() {
        return buoyancy().async;
      },
      get legacy() {
        return water().fluid.inspect()[`scene-entity:${oceanFoam}`];
      },
      appearanceProducts: qualityMaterialGuids,
      appearanceSourceVersion: () => qualitySourceVersion('Q4'),
    });
  };
  const requiresFoamValidation = () =>
    materials.some((handle) => assets.read(handle).unwrap().staticSwitches?.waterFoam === true);
  const capabilities = (mode: Mode, inspection: RenderInspection) => {
    const settings = assets.read(zoneAsset).unwrap(),
      async = buoyancy().async,
      rendererFacts = inspectWaterRenderCapabilities(inspection),
      cpuMesh =
        mode === 'Q3' && activeMode === 'Q3' && transaction === undefined
          ? completedCpuMesh(inspection) !== undefined
          : false,
      q4Draws =
        mode === 'Q4' &&
        activeMode === 'Q4' &&
        transaction === undefined &&
        completedReceipt !== undefined &&
        completedReceipt.frameId === inspection.frame.frameId &&
        completedReceipt.deviceGeneration === inspection.frame.deviceGeneration
          ? materialDrawEvidence(
              inspection,
              qualityMaterialHandles.Q4,
              qualityMaterialHandles.Q4.map((handle) => assets.revision(handle).unwrap()),
              true,
            )
          : [],
      renderer = configurationRendererFacts(
        mode,
        inspection,
        cpuMesh,
        q4Draws,
        () => qualitySourceClosureAccepted('Q4'),
        () => qualitySourceVersion('Q4'),
        rendererFacts,
      );
    return configurationCapabilityReport(
      mode,
      selections[mode],
      JSON.stringify([
        sourceKey,
        COAST_SEED,
        mode,
        meshProfile,
        assets.revision(zoneAsset).unwrap(),
        windStrength,
        element<HTMLInputElement>('local-water-enabled').checked,
        assets.revision(localRecipe).unwrap(),
        assets.revision(r7Recipe).unwrap(),
        bodies.map((body) => assets.revision(body.handle).unwrap()),
        materials.map((handle) => [
          assets.revision(handle).unwrap(),
          assets.read(handle).unwrap().staticSwitches,
        ]),
        qualityMaterialHandles.Q3.map((handle) => assets.revision(handle).unwrap()),
        qualityMaterialHandles.Q4.map((handle) => assets.revision(handle).unwrap()),
      ]),
      settings,
      async.execution,
      inspectRhiDeviceFacts(inspection.capabilities, inspection.limits ?? {}),
      renderer,
      physicsFacts(),
      element<HTMLInputElement>('local-water-enabled').checked,
    );
  };
  const readRuntimeParameters = () => ({
    qualityPreset,
    qualitySettings,
    authoredWaveCount,
    windStrength,
    manualDriving,
    helm: { ...helm },
    handling: { ...handling },
    cannon: { ...cannon },
    pontoons: world.get(ship, WaterPontoonSet).unwrap(),
    contacts: world.get(ship, WaterContactProbeSet).unwrap(),
    localRecipe: assets.read(localRecipe).unwrap(),
  });
  const readState = () => ({
    version: 2,
    scene: sceneEvidence(
      sourceKey,
      guid('scene/coast'),
      COAST_SEED,
      [canvas.width, canvas.height],
      eye,
      target,
      element<HTMLSelectElement>('weather').value,
      cloudsEnabled,
      guid(
        `environment/${element<HTMLSelectElement>('weather').value}${cloudsEnabled ? '' : '-clear'}`,
      ),
      Number(element<HTMLInputElement>('exposure').value),
      meshProfile,
      COAST_MESH_PROFILES[meshProfile],
      assets.read(zoneAsset).unwrap().tessellationFactor,
    ),
    timeSeconds: world.getResource(Time).elapsed,
    shipDynamics: physics().getCommittedBodyDynamics?.(ship),
    shipMassRig: {
      ...COAST_SHIP_MASS_RIG,
      admission: shipRigAdmission,
      publication: physics().getDerivedPublication?.(ship),
    },
    shipNavigation: { ...shipNavigation, route: shipRoute },
    wind: {
      strength: windStrength,
      pending: pendingWindStrength ?? null,
      maximum: maximumWindStrength,
      unit: 'authored-spectrum-multiplier',
      sources: windSources.map(({ handle }) => ({
        revision: assets.revision(handle).unwrap(),
        payload: assets.read(handle).unwrap(),
      })),
    },
    localDisturbance: {
      model: requestedMode === 'R7-shallow' ? 'water-body-shallow/2' : 'mode-projected-gravity/1',
      composition: 'additive-residual',
      cpuBuoyancyFeedback:
        requestedMode !== 'R7-shallow' && element<HTMLInputElement>('local-water-enabled').checked,
      config: assets.read(requestedMode === 'R7-shallow' ? r7Recipe : localRecipe).unwrap(),
      enabled: element<HTMLInputElement>('local-water-enabled').checked,
      state: (requestedMode === 'R7-shallow' ? r7Simulation : localSimulation)?.inspect() ?? null,
    },
    ironBalls: balls.map((ball) => ({
      ...ball,
      ...readIronBallParticipation(world, ball.entity, Boolean(ball.entry)),
      radiusM: ball.radiusM,
      massKg: ball.massKg,
      dynamics: physics().getCommittedBodyDynamics?.(ball.entity),
    })),
    requestedMode,
    activeMode,
    transaction: transaction ? transactionEvidence(transaction) : null,
    producerFaults: { waterInfoCapture: waterInfoProbe.inspect() },
    completedFrames,
    completedReceipt,
    capability: latest ? capabilities(requestedMode, latest) : null,
    budget: latest ? logicalBudget(latest) : null,
    ...waterTelemetry(
      bodies,
      bodySnapshot,
      water(),
      latest,
      completedReceipt,
      () => world.getResource(Time).elapsed,
      () => requireDemoMethod(physics(), 'getSolverClock', 'getSolverClock')(),
      (handle) => assets.source(handle),
      regions,
      materials,
      (handle) => assets.revision(handle).unwrap(),
      (handle) => assets.read(handle).unwrap().staticSwitches,
      requiresFoamValidation,
      COAST_FOAM_DECAY_PER_SECOND,
    ),
    unavailableModes,
    buoyancy: buoyancy(),
    visualContacts: contacts(),
    composition: waterComposition(
      activeMode,
      selections[activeMode],
      element<HTMLInputElement>('local-water-enabled').checked,
      materials.map((handle) => assets.read(handle).unwrap()),
      world.get(oceanFoam, WaterFluidSimulation).unwrap().enabled,
      water().fluid.inspect()[`scene-entity:${oceanFoam}`] ?? null,
      world.get(ship, WaterContactProbeSet).unwrap().enabled,
    ),
    timelines: { fixed: fixedTrace, cpu: cpuTrace, render: renderTrace, gpu: gpuTimings },
    diagnostics: {
      ...diagnostics,
      sampledInspectionFrame: latest?.frame ?? null,
      completedFrameTimes,
    },
    operations,
    errors,
    inspection: latest,
    liveRenderer: app.renderer.inspect({ fields: ['state', 'frame', 'recovery'] }),
  });
  const applyCrestComposition = (mode: Mode) => {
    const enabled = element<HTMLInputElement>('crests-enabled').checked;
    for (const handle of modeMaterialHandles(mode)) {
      const material = assets.read(handle).unwrap();
      assets
        .update(handle, {
          values: {
            ...material.values,
            surfaceCrestFoamAmount:
              enabled && mode !== 'R6' && material.staticSwitches?.waterOceanFoam === true ? 1 : 0,
          },
        })
        .unwrap();
    }
    const legacyFluidEnabled = enabled && mode === 'R6';
    world.set(oceanFoam, WaterFluidSimulation, { enabled: legacyFluidEnabled }).unwrap();
    return legacyFluidEnabled;
  };
  const setMode = (
    mode: Mode,
    nextMeshProfile = meshProfile,
    preset?: { name: WaterQualityPreset | 'custom'; settings: typeof qualitySettings },
  ) => {
    if (transaction) {
      message('正在等待候选配置完成帧');
      return;
    }
    const acceptUnchangedQualityPreset = () => {
      if (preset && mode === activeMode && nextMeshProfile === meshProfile) {
        const acceptedZone = assets.read(zoneAsset).unwrap(),
          acceptedRecipe = assets.read(localRecipe).unwrap();
        const accepted = {
          tessellationFactor: acceptedZone.tessellationFactor,
          waterInfoResolution: acceptedZone.waterInfo.resolution.widthPx,
          waveCount: authoredWaveCount,
          pontoonCount: world.get(ship, WaterPontoonSet).unwrap().radiiM.length,
          contactProbeCount: world.get(ship, WaterContactProbeSet).unwrap().radiiM.length,
          localResolution:
            acceptedRecipe.system === 'water-advanced'
              ? acceptedRecipe.oceanPatchConfig?.fftResolution
              : undefined,
        };
        if (
          Object.entries(preset.settings).every(
            ([key, value]) => accepted[key as keyof typeof accepted] === value,
          )
        ) {
          qualityPreset = preset.name;
          qualitySettings = { ...preset.settings };
          const select = document.querySelector<HTMLSelectElement>('#quality-preset');
          if (select) select.value = qualityPreset;
          refreshRuntimeForms(parameterForms);
          return;
        }
      }
      return false;
    };
    if (acceptUnchangedQualityPreset() === undefined) return;
    const current = app.renderer.inspect();
    const facts = inspectRhiDeviceFacts(current.capabilities, current.limits ?? {});
    const admitConfigurationMode = () => {
      const prerequisite = unavailableModes[mode];
      if (prerequisite) {
        element<HTMLSelectElement>('quality').value = requestedMode;
        record('configuration-unavailable', { mode, prerequisite });
        message(prerequisite);
        return;
      }
      if (
        mode === 'R1' &&
        [facts.compute, facts.indirectDraw, facts.storageBuffer].some(
          (status) => status !== 'supported',
        )
      ) {
        element<HTMLSelectElement>('quality').value = requestedMode;
        message('GPU 网格所需设备能力不可用');
        return;
      }
      if ((mode === 'Q3' || mode === 'Q4') && !qualitySourceClosureAccepted(mode)) {
        element<HTMLSelectElement>('quality').value = requestedMode;
        const missing = `${mode} saved appearance Pack closure is missing or stale`;
        record('configuration-unavailable', {
          mode,
          prerequisite: missing,
        });
        message(missing);
        return;
      }
      const admitCpuMeshMode = () => {
        if (mode === 'Q3') {
          const waterFormat =
              originalZone.waterInfo.format === 'rgba32f' ? 'rgba32float' : 'rgba16float',
            maximumDimension = facts.limits.maxTextureDimension2D ?? 0,
            maximumLayers = facts.limits.maxTextureArrayLayers ?? 0,
            q3DeviceReady =
              facts.compute === 'supported' &&
              facts.formats[waterFormat].renderSample === 'supported' &&
              facts.formats[waterFormat].arrayRenderSample === 'supported' &&
              facts.formats[waterFormat].storageSample === 'supported' &&
              facts.formats.depth32float.renderSample === 'supported' &&
              facts.formats.rg16float.renderSample === 'supported' &&
              originalZone.waterInfo.resolution.widthPx <= maximumDimension &&
              originalZone.waterInfo.resolution.heightPx <= maximumDimension &&
              maximumLayers >= 1;
          if (!q3DeviceReady || originalZone.gpuMesh !== undefined) {
            element<HTMLSelectElement>('quality').value = requestedMode;
            message('Q3 所需 CPU 网格与 WaterInfo 设备闭合不可用');
            record('configuration-unavailable', {
              mode,
              prerequisite:
                'CPU WaterMesh source, compute, storage and texture limits must be admitted before the candidate frame',
              device: facts,
            });
            return;
          }
        }
        return false;
      };
      if (admitCpuMeshMode() === undefined) return;
      if (mode === 'Q4' && current.state !== 'alive') {
        element<HTMLSelectElement>('quality').value = requestedMode;
        message('Q4 外观适配需要就绪的 Renderer');
        return;
      }
      return true;
    };
    if (!admitConfigurationMode()) return;
    const before = configurationSnapshot(),
      zoneGenerationBefore = waterSceneZoneSnapshot(world, guid('zone/coast'))?.generation ?? 0;
    const qualityProduct = mode === 'Q3' || mode === 'Q4' ? qualityMaterialGuids[mode] : undefined;
    const settings = configurationZoneSettings(
      originalZone,
      mode,
      COAST_MESH_PROFILES[nextMeshProfile].tessellationFactor,
      qualityProduct?.far,
      preset?.settings,
    );
    const candidate = assets.replace(zoneAsset, settings);
    if (!candidate.ok) {
      element<HTMLSelectElement>('quality').value = requestedMode;
      report(candidate.error);
      return;
    }
    requestedMode = mode;
    meshProfile = nextMeshProfile;
    transaction = {
      revision: ++modeRevision,
      mode,
      previous: activeMode,
      frameAfter: current.frame.frameId,
      deviceGeneration: current.frame.deviceGeneration,
      zoneRevision: assets.revision(zoneAsset).unwrap(),
      zoneGenerationBefore,
      expectedZone: settings,
      waveSetGuid: guid(`waves/${mode === 'Q1' ? 'q1' : 'breeze'}`),
      bodyRevisions: bodies.map((body) => assets.revision(body.handle).unwrap()),
      materialHandles: modeMaterialHandles(mode),
      materialRevisions: modeMaterialHandles(mode).map((handle) =>
        assets.revision(handle).unwrap(),
      ),
      legacyFluidEnabled: false,
      asyncCompletedBefore: buoyancy().async.completed,
      status: 'preparing',
      blockers: [],
      before,
      beforeGraph: current.renderGraphGenerationAllocation,
    };
    lockConfiguration(true);
    try {
      const applyQualityWorkload = () => {
        if (preset) {
          qualitySettings = { ...preset.settings };
          qualityPreset = preset.name;
          authoredWaveCount = qualitySettings.waveCount;
          applyWindStrength(windStrength);
          const count = qualitySettings.pontoonCount;
          world
            .set(ship, WaterPontoonSet, {
              ...shipPontoonLayout(count),
              dampingNPerMps: originalPontoons.dampingNPerMps,
              dampingNPerMpsSquared: originalPontoons.dampingNPerMpsSquared,
              maxBuoyantForceN: originalPontoons.maxBuoyantForceN,
            })
            .unwrap();
          const indices = Array.from({ length: qualitySettings.contactProbeCount }, (_, index) =>
            Math.min(
              originalContacts.radiiM.length - 1,
              Math.floor(
                (index * originalContacts.radiiM.length) / qualitySettings.contactProbeCount,
              ),
            ),
          );
          world
            .set(ship, WaterContactProbeSet, {
              centersM: indices.flatMap((index) =>
                Array.from(originalContacts.centersM.slice(index * 3, index * 3 + 3)),
              ),
              radiiM: indices.map((index) =>
                requireDemoValue(originalContacts.radiiM[index], 'accepted authored scene member'),
              ),
            })
            .unwrap();
          const recipe = assets.read(localRecipe).unwrap();
          if (recipe.system !== 'water-advanced' || !recipe.oceanPatchConfig)
            throw new Error('Expected an OceanPatch recipe');
          assets
            .replace(localRecipe, {
              ...recipe,
              oceanPatchConfig: {
                ...recipe.oceanPatchConfig,
                fftResolution: qualitySettings.localResolution,
              },
            } as WaterSimulationRecipeAsset)
            .unwrap();
        }
      };
      applyQualityWorkload();
      const bindConfigurationBodies = (candidate: NonNullable<typeof transaction>) => {
        for (const [index, body] of bodies.entries()) {
          const original = requireDemoValue(
              originalBodies[index],
              'accepted authored scene member',
            ),
            productBody = qualityProduct?.bodies.ocean,
            surfaceMaterialGuid = productBody?.surface ?? original.surfaceMaterialGuid,
            lodMaterialGuid =
              productBody?.lod ??
              requireDemoValue(original.lodMaterialGuid, 'accepted authored scene member');
          assets
            .update(body.handle, {
              waveSetGuid: candidate.waveSetGuid,
              surfaceMaterialGuid,
              lodMaterialGuid,
            })
            .unwrap();
        }
        candidate.bodyRevisions = bodies.map((body) => assets.revision(body.handle).unwrap());
      };
      bindConfigurationBodies(transaction);
      const ssr = world.get(camera, ScreenSpaceReflection);
      if (mode === 'Q2') {
        if (ssr.ok) world.removeComponent(camera, ScreenSpaceReflection).unwrap();
      } else if (!ssr.ok)
        world
          .addComponent(camera, {
            component: ScreenSpaceReflection,
            data: { maxDistance: 180, thickness: 0.3, maxRoughness: 0.65 },
          })
          .unwrap();
      buoyancy().asyncEnabled = mode === 'R5';
      world.set(ship, WaterPontoonSet, { useAsyncPath: mode === 'R5' }).unwrap();
      transaction.legacyFluidEnabled = applyCrestComposition(mode);
      transaction.materialRevisions = transaction.materialHandles.map((handle) =>
        assets.revision(handle).unwrap(),
      );
    } catch (error) {
      report(error);
      return;
    }
    record('configuration-requested', transactionEvidence(transaction));
    element('transition').textContent = '正在准备候选资源与图';
  };
  const resetShip = () => {
    helm.throttle = 0;
    helm.rudder = 0;
    shipResetRequested = true;
    shipNavigation.running = false;
    shipNavigation.braking = false;
    shipNavigation.previousAngle = undefined;
    shipNavigation.distanceRadians = 0;
    shipNavigation.completedLaps = 0;
  };
  const fault = async (kind: string) => {
    if (transaction) {
      message('正在等待候选配置完成帧');
      return;
    }
    if (kind === 'zone') {
      if (zoneRemoved)
        world
          .addComponent(zone, { component: WaterZoneInstance, data: { zone: zoneAsset } })
          .unwrap();
      else world.removeComponent(zone, WaterZoneInstance).unwrap();
      zoneRemoved = !zoneRemoved;
    } else if (kind === 'water-info-delay') {
      const publication = latest?.waterGraph?.waterInfo?.[0];
      if (!publication) {
        record('water-info-delay-unavailable', { reason: 'no-completed-water-info' });
        return;
      }
      waterInfoProbe.deferNextCapture({
        viewIdentity: publication.viewIdentity,
        deviceGeneration: publication.deviceGeneration,
      });
      await fault('ocean');
      record('water-info-delay-requested', waterInfoProbe.inspect());
    } else if (kind === 'ocean') {
      const ocean = requireDemoValue(bodies[0], 'accepted authored scene member'),
        source = requireDemoValue(originalBodies[0], 'accepted authored scene member');
      const replacement = oceanChanged
        ? source
        : assets
            .read((await assets.load(guid('body/ocean-edited'), 'water-body')).unwrap())
            .unwrap();
      assets.replace(ocean.handle, replacement).unwrap();
      assets
        .replace(
          localRecipe,
          oceanChanged
            ? originalLocalRecipe
            : assets
                .read(
                  (
                    await assets.load(guid('fluid/coast-local-edited'), 'water-simulation-recipe')
                  ).unwrap(),
                )
                .unwrap(),
        )
        .unwrap();
      oceanChanged = !oceanChanged;
      record('ocean-source-replacement', {
        revision: assets.revision(ocean.handle).unwrap(),
        variant: oceanChanged ? guid('body/ocean-edited') : guid('body/ocean'),
      });
    } else if (kind === 'body') {
      const ocean = requireDemoValue(bodies[0], 'accepted authored scene member'),
        previous = ocean.entity;
      world.despawn(previous).unwrap();
      ocean.entity = world
        .spawn(
          { component: Transform, data: {} },
          {
            component: WaterBodyInstance,
            data: { body: ocean.handle },
          },
        )
        .unwrap();
      record('body-reuse', { previous, current: ocean.entity });
    } else if (kind === 'material') {
      materialMissing = !materialMissing;
      assets
        .update(requireDemoValue(bodies[0], 'accepted authored scene member').handle, {
          surfaceMaterialGuid: materialMissing
            ? guid('material/missing-injection')
            : requireDemoValue(originalBodies[0], 'accepted authored scene member')
                .surfaceMaterialGuid,
        })
        .unwrap();
    } else if (kind === 'resize') {
      smallResolution = !smallResolution;
      canvas.style.width = smallResolution ? '75vw' : '100vw';
      canvas.style.height = smallResolution ? '75dvh' : '100dvh';
      applyCamera();
    } else if (kind === 'loss') {
      const before = app.renderer.inspect({ fields: ['state', 'frame', 'recovery'] });
      if (before.state !== 'alive') {
        record('device-loss-unavailable', { before });
        message('渲染器当前状态不允许受控设备丢失');
        return;
      }
      const native = app.renderer.nativeDevice();
      if (!native.ok) {
        report(native.error);
        return;
      }
      native.value.destroy();
      await native.value.lost;
      record('device-loss-observed', {
        before,
        after: app.renderer.inspect({ fields: ['state', 'frame', 'recovery'] }),
      });
      const recovery = await app.renderer.recover();
      record('device-recovery', {
        result: recovery,
        inspection: app.renderer.inspect({ fields: ['state', 'frame', 'recovery'] }),
      });
      if (!recovery.ok) report(recovery.error);
    }
    record('fault', {
      kind,
      zoneRemoved,
      oceanChanged,
      materialMissing,
      smallResolution,
      completedReceipt,
    });
  };
  const capture = async () => {
    if (!app.rhiCapture) throw new Error('RHI capture unavailable');
    const result = await app.rhiCapture.captureFrame();
    record(
      'rhi-capture',
      result.ok
        ? { ok: true, byteLength: result.value.byteLength, digest: result.value.digest }
        : result,
    );
    if (!result.ok) report(result.error);
    return result;
  };
  const refresh = () => {
    refreshRuntimeForms(parameterForms);
    if (element('controls-panel').hidden) return;
    refreshControlSummary();
    const presetSelect = document.getElementById('quality-preset') as HTMLSelectElement | null;
    if (presetSelect) presetSelect.value = qualityPreset;
    element('mode-badge').textContent =
      `${activeMode} · ${element<HTMLInputElement>('local-water-enabled').checked ? '局部水波开启' : '局部水波关闭'}`;
    element('frame').textContent = String(completedFrames);
    element('receipt').textContent = completedReceipt
      ? `D${completedReceipt.deviceGeneration} / F${completedReceipt.frameId}`
      : '--';
    if (!latest || !diagnosticDimensionOpen()) return;
    const capability = capabilities(requestedMode, latest),
      budget = logicalBudget(latest);
    element('implementation').textContent = capability.implementation;
    element('requirements').textContent = capability.requirements
      .filter((row) => row.status !== 'supported')
      .map((row) => `${row.owner}.${row.name}: ${row.status}`)
      .join(' · ');
    element('mode-badge').textContent = `${activeMode} 光学${
      element<HTMLInputElement>('local-water-enabled').checked
        ? activeMode === 'R7-shallow'
          ? ' + 浅水'
          : ' + 色散水波'
        : ''
    }`;
    element('frame').textContent = String(completedFrames);
    element('memory').textContent = budget.estimate.ok
      ? `${(budget.estimate.value.concurrentBytes / 1048576).toFixed(1)} MiB · 当前图估算`
      : '未知';
    element('receipt').textContent = completedReceipt
      ? `D${completedReceipt.deviceGeneration} / F${completedReceipt.frameId}`
      : '--';
    if (element('facts').closest('details')?.open)
      element('facts').textContent = JSON.stringify(
        {
          capability,
          unknownBudgetResources: budget.unknown,
          budgetCoverage: budget.coverage,
          budgetLifetimeCoverage: budget.lifetimeCoverage,
          graphGenerationAllocation: budget.generationAllocation,
          async: buoyancy().async,
          shipPosition: position(),
          zone: water().zoneSnapshots(),
          producerFaults: { waterInfoCapture: waterInfoProbe.inspect() },
        },
        json,
        2,
      );
  };
  createWaterCameraControls({
    app,
    canvas,
    readPose: () => ({ eye, target }),
    speedMps: 12,
    enabled: () => !manualDriving && !element<HTMLInputElement>('follow').checked,
    writePose: (pose) => {
      eye = [...pose.eye];
      target = [...pose.target];
      applyCamera();
    },
  });
  world
    .addSystem(
      Update,
      defineSystem({
        name: 'waterR8CameraAndTrace',
        after: [WaterSceneReconcile, WaterContactProbes, InputFrameStartScan],

        queries: [],
        fn: () => {
          const retireEntryPlayersAndCommitWind = () => {
            for (const ball of balls)
              if (
                !ball.entryPlayerRetired &&
                ball.entryRetireTime !== undefined &&
                world.getResource(Time).elapsed >= ball.entryRetireTime
              ) {
                world.despawn(ball.entryPlayer).unwrap();
                ball.entryPlayerRetired = true;
              }
            if (pendingWindStrength !== undefined && !transaction) {
              const requested = pendingWindStrength;
              pendingWindStrength = undefined;
              try {
                applyWindStrength(requested);
              } catch (error) {
                element<HTMLInputElement>('waves').value = String(windStrength);
                element('wind-value').textContent = `${windStrength.toFixed(2)} ×`;
                report(error);
              }
            }
          };
          retireEntryPlayersAndCommitWind();
          if (
            !localSimulation ||
            localSimulation.recipe.contentVersion !== String(assets.revision(localRecipe).unwrap())
          ) {
            water().removeOceanPatch();
            const asset = assets.read(localRecipe).unwrap();
            if (asset.system !== 'water-advanced')
              throw new Error('The local recipe is not water-advanced');
            localSimulation = water()
              .requestOceanPatch({
                guid: guid('fluid/coast-local'),
                contentVersion: String(assets.revision(localRecipe).unwrap()),
                asset,
              })
              .unwrap();
          }
          const reconcileShallowSimulation = () => {
            const r7Selected = requestedMode === 'R7-shallow';
            const body = bodySnapshot(
              requireDemoValue(bodies[0], 'accepted authored scene member'),
            );
            if (r7Selected && body && r7Simulation?.body.generation !== body.sceneGeneration) {
              if (r7Simulation) water().removeAdvancedSimulation(r7Simulation);
              const asset = assets.read(r7Recipe).unwrap();
              if (asset.system !== 'water-advanced')
                throw new Error('The R7 recipe is not water-advanced');
              r7Simulation = water()
                .createAdvancedSimulation(
                  {
                    guid: guid('fluid/coast-r7-shallow'),
                    contentVersion: String(assets.revision(r7Recipe).unwrap()),
                    asset,
                  },
                  body.guid,
                )
                .unwrap();
            } else if (!body && r7Simulation) {
              water().removeAdvancedSimulation(r7Simulation);
              r7Simulation = undefined;
            }
            return { r7Selected, body };
          };
          const { r7Selected, body } = reconcileShallowSimulation();
          const bindLocalSimulationOutputs = () => {
            const bindingIdentity = r7Selected ? `r7:${body?.guid ?? ''}` : 'dispersive';
            if (bindingIdentity !== localBindingIdentity && (!r7Selected || body)) {
              const names =
                r7Selected && body
                  ? waterAdvancedOutputNames(
                      guid('fluid/coast-r7-shallow'),
                      body.guid,
                      world.identity,
                    )
                  : waterOceanPatchOutputNames(guid('fluid/coast-local'), world.identity);
              for (const handle of materials) {
                const material = assets.read(handle).unwrap();
                if (material.staticSwitches?.waterShallowSimulation !== true) continue;
                assets
                  .update(handle, {
                    values: {
                      ...material.values,
                      waterShallowGridTexture: {
                        source: renderFeatureTextureSource(names.materialGrid),
                      },
                      waterShallowNormalTexture: {
                        source: renderFeatureTextureSource(names.materialNormal),
                      },
                      waterShallowFoamTexture: { source: renderFeatureTextureSource(names.foam) },
                      waterShallowMappingTexture: {
                        source: renderFeatureTextureSource(names.mapping),
                      },
                    },
                  })
                  .unwrap();
              }
              localBindingIdentity = bindingIdentity;
              if (transaction)
                transaction.materialRevisions = materials.map((handle) =>
                  assets.revision(handle).unwrap(),
                );
            }
          };
          bindLocalSimulationOutputs();
          const updateLocalSimulations = () => {
            const localEnabled = element<HTMLInputElement>('local-water-enabled').checked;
            requireDemoValue(localSimulation, 'admitted local simulation').setEnabled(
              !r7Selected && localEnabled,
            );
            water()
              .configureOceanPatchQueries(
                !r7Selected && localEnabled && body
                  ? {
                      worldIdentity: world.identity,
                      bodyGuid: body.guid,
                      bodyGeneration: body.sceneGeneration,
                      maximumAgeSeconds: 0.25,
                    }
                  : undefined,
              )
              .unwrap();
            requireDemoValue(localSimulation, 'admitted local simulation')
              .update(world.getResource(Time).delta)
              .unwrap();
            r7Simulation?.setEnabled(r7Selected && localEnabled);
            if (r7Selected && r7Simulation) {
              const dynamics = physics().getCommittedBodyDynamics?.(ship);
              if (dynamics?.ok) {
                const forward = rotateWaterVector(dynamics.value.rotation, [1, 0, 0]);
                const centerXZ = [
                  Math.round((dynamics.value.positionM[0] + forward[0] * 8) * 2) / 2,
                  Math.round((dynamics.value.positionM[2] + forward[2] * 8) * 2) / 2,
                ] as const;
                r7Simulation
                  .update({
                    deltaSeconds: world.getResource(Time).delta,
                    timeSeconds: world.getResource(Time).elapsed,
                    centerXZ,
                    yawRadians: 0,
                  })
                  .unwrap();
              }
            }
          };
          updateLocalSimulations();
          for (const ball of balls) {
            if (!ball.attachment || ball.entryPlayerRetired) continue;
            const values = sampleWaterEntryAttachment(
              water(),
              ball.attachment,
              world.getResource(Time).elapsed,
              physics().getSolverClock?.(),
            );
            if (values) {
              const patched = vfxControl.patchPlayerParameters({
                player: ball.entryPlayer,
                values,
              });
              if (!patched.ok) report(patched.error);
            }
          }
          if (element<HTMLInputElement>('follow').checked) {
            const p = position();
            eye = [p[0] + 29, p[1] + 9, p[2] + 40];
            target = [p[0], p[1] + 4, p[2]];
            applyCamera();
          }
          if (diagnostics.enabled || transaction) {
            cpuTrace.push({
              time: world.getResource(Time).elapsed,
              zones: water().zoneSnapshots(),
              bodies: bodies.map((body) => ({
                type: body.type,
                snapshot: bodyEvidence(bodySnapshot(body)),
              })),
            });
            if (cpuTrace.length > 180) cpuTrace.shift();
          }
          const drawBuoyancyAndContacts = () => {
            if (element<HTMLInputElement>('debug-pontoons').checked) {
              for (const step of buoyancy().steps) {
                if (!step.result.ok) continue;
                for (const pontoon of step.result.value.pontoons)
                  app.debugDraw?.sphere(
                    vec3.create(...pontoon.centerM),
                    pontoon.radiusM,
                    [1, 0.75, 0.1, 1],
                    12,
                  );
              }
            }
            if (element<HTMLInputElement>('debug-contacts').checked) {
              for (const { contact } of contacts().contacts) {
                for (let segment = 0; segment < 20; segment++) {
                  const point = (index: number): Vector => [
                    contact.positionM[0] + Math.cos((index * Math.PI) / 10) * contact.radiusM,
                    contact.positionM[1] + 0.03,
                    contact.positionM[2] + Math.sin((index * Math.PI) / 10) * contact.radiusM,
                  ];
                  app.debugDraw?.line(
                    vec3.create(...point(segment)),
                    vec3.create(...point(segment + 1)),
                    [0.2, 1, 0.65, 1],
                  );
                }
              }
            }
          };
          drawBuoyancyAndContacts();
          const drawNativeForces = () => {
            if (element<HTMLInputElement>('debug-forces').checked) {
              for (const event of buoyancy().forceEvents) {
                const length = Math.hypot(...event.forceN);
                const scale = length === 0 ? 0 : Math.min(length / 12000, 8) / length;
                app.debugDraw?.arrow(
                  vec3.create(...event.positionM),
                  vec3.create(
                    ...(event.positionM.map(
                      (value, axis) =>
                        value +
                        requireDemoValue(event.forceN[axis], 'accepted authored scene member') *
                          scale,
                    ) as Vector),
                  ),
                  [1, 0.3, 0.12, 1],
                );
              }
            }
            const forceData = element('force-data');
            forceData.hidden = !element<HTMLInputElement>('debug-forces').checked;
            if (!forceData.hidden)
              forceData.textContent = buoyancy()
                .forceEvents.map(
                  (event) =>
                    `${event.pontoonId}: ${(Math.hypot(...event.forceN) / 1000).toFixed(1)} kN`,
                )
                .join('\n');
          };
          drawNativeForces();
          const drawWaterNormals = () => {
            if (element<HTMLInputElement>('debug-normals').checked) {
              const body = bodySnapshot(
                requireDemoValue(bodies[0], 'accepted authored scene member'),
              );
              if (body !== undefined) {
                const center = position();
                for (let x = -4; x <= 4; x++)
                  for (let z = -4; z <= 4; z++) {
                    const sample = water().queryBody(body.guid, {
                      positionM: [center[0] + x * 2, 0, center[2] + z * 2],
                      timeSeconds: world.getResource(Time).elapsed,
                      expectedBodyGeneration: body.sceneGeneration,
                      nativePhysics: {
                        completedStep: requireDemoMethod(
                          physics(),
                          'getSolverClock',
                          'getSolverClock',
                        )().completedStep,
                        timeSeconds: requireDemoMethod(
                          physics(),
                          'getSolverClock',
                          'getSolverClock',
                        )().simulationTimeSeconds,
                      },
                      flags:
                        WaterQueryFlags.ComputeLocation |
                        WaterQueryFlags.ComputeNormal |
                        WaterQueryFlags.IncludeWaves,
                    });
                    if (
                      sample.ok &&
                      !sample.value.excluded &&
                      sample.value.surfaceM &&
                      sample.value.normalYUp
                    )
                      app.debugDraw?.arrow(
                        vec3.create(...sample.value.surfaceM),
                        vec3.create(
                          ...(sample.value.surfaceM.map(
                            (value, axis) =>
                              value +
                              requireDemoValue(
                                requireDemoValue(sample.value.normalYUp, 'sample.value.normalYUp')[
                                  axis
                                ],
                                'accepted authored scene member',
                              ) *
                                1.3,
                          ) as Vector),
                        ),
                        [0.2, 0.8, 1, 1],
                      );
                  }
              }
            }
          };
          drawWaterNormals();
        },
      }),
    )
    .unwrap();
  world
    .addSystem(
      FixedUpdate,
      defineSystem({
        name: 'waterR8ShipMotion',
        after: [PhysicsSync],
        before: [WaterBuoyancy, PhysicsSimulation],
        queries: [],
        fn: () => {
          const owner = physics();
          const admitShipMassRig = () => {
            if (shipRigAdmission.kind !== 'ready') {
              if (shipRigAdmission.kind === 'unrequested') {
                if (!owner.hasBody(ship)) return;
                if (!owner.prepareDerivedShapeCandidate || !owner.admitDerivedShapeCandidate)
                  throw new Error('Ship mass rig requires explicit native mass admission');
                const candidate = owner
                  .prepareDerivedShapeCandidate({
                    entity: ship,
                    sourceKey: 'water-r8:ship-mass-rig',
                    revision: COAST_SHIP_MASS_RIG.revision,
                    shapes: [],
                    massProperties: COAST_SHIP_MASS_RIG.properties,
                    velocityPolicy: 'preserve',
                  })
                  .unwrap();
                owner.admitDerivedShapeCandidate(candidate).unwrap();
                shipRigAdmission = { kind: 'queued', candidateId: candidate.candidateId };
                return;
              }
              const failure = owner.getDerivedFailure?.(ship);
              if (failure) throw failure.error;
              const publication = owner.getDerivedPublication?.(ship);
              if (publication?.candidateId !== shipRigAdmission.candidateId) return;
              // The first coefficient solve must see the admitted COM and inertia.
              world
                .set(ship, WaterPontoonSet, {
                  enabled: element<HTMLInputElement>('buoyancy-enabled').checked,
                })
                .unwrap();
              shipRigAdmission = { ...shipRigAdmission, kind: 'ready' };
              record('ship-mass-rig-admitted', {
                publication,
                dynamics: owner.getCommittedBodyDynamics?.(ship),
              });
            }
            return false;
          };
          if (admitShipMassRig() === undefined) return;
          const launchPendingIronBalls = () => {
            for (const ball of balls) {
              if (ball.launch.fixedStep !== undefined || !owner.setBodyMotion) continue;
              const accepted = owner.getCommittedBodyDynamics?.(ball.entity);
              if (!accepted?.ok) continue;
              owner
                .setBodyMotion(ball.entity, {
                  position: ball.launch.positionM,
                  rotation: [0, 0, 0, 1],
                  linearVelocity: ball.launch.velocityMps,
                  angularVelocity: [0, 0, 0],
                })
                .unwrap();
              ball.launch.fixedStep = accepted.value.nextFixedStep;
              ball.launch.timeSeconds =
                world.getResource(FixedTime).tick * world.getResource(FixedTime).delta;
              record('iron-ball-launched', { entity: ball.entity, ...ball.launch });
            }
            if (fireRequested) {
              const accepted = owner.getCommittedBodyDynamics?.(ship);
              if (accepted?.ok) {
                const dynamics = accepted.value;
                const muzzle = rotateWaterVector(dynamics.rotation, cannon.muzzleOffsetM as Vector);
                const direction = rotateWaterVector(dynamics.rotation, [1, 0, 0]);
                const horizontalLength = Math.max(0.001, Math.hypot(direction[0], direction[2]));
                const positionM = dynamics.positionM.map(
                  (value, axis) =>
                    value + requireDemoValue(muzzle[axis], 'accepted authored scene member'),
                ) as Vector;
                const velocityMps: Vector = [
                  (direction[0] / horizontalLength) * cannon.horizontalSpeedMps +
                    dynamics.linearVelocityMps[0],
                  cannon.upwardSpeedMps + dynamics.linearVelocityMps[1],
                  (direction[2] / horizontalLength) * cannon.horizontalSpeedMps +
                    dynamics.linearVelocityMps[2],
                ];
                if (balls.length >= 8)
                  retireIronBall(requireDemoValue(balls.shift(), 'accepted authored scene member'));
                const entity = world
                  .spawn(
                    {
                      component: Transform,
                      data: {
                        pos: positionM,
                        scale: Array(3).fill(cannon.radiusM / IRON_BALL_RADIUS_M),
                      },
                    },
                    { component: MeshFilter, data: { assetHandle: ironBallMesh } },
                    { component: MeshRenderer, data: { materials: [ironBallMaterial] } },
                    { component: Visibility, data: {} },
                    ...ironBallPhysics(cannon.massKg, IRON_BALL_RADIUS_M),
                  )
                  .unwrap();
                const entryPlayer = world
                  .spawn(
                    { component: Transform, data: { pos: positionM } },
                    {
                      component: ParticleEffectPlayer,
                      data: {
                        effect: ironBallEntryEffect,
                        playing: false,
                        preparePipelines: true,
                        seed: cannon.playerSeed,
                        timeScale: cannon.playerTimeScale,
                      },
                    },
                  )
                  .unwrap();
                balls.push({
                  entity,
                  entryPlayer,
                  radiusM: cannon.radiusM,
                  massKg: cannon.massKg,
                  launch: { positionM, velocityMps },
                  trajectory: [],
                });
                fireRequested = false;
              }
            }
          };
          launchPendingIronBalls();
          if (shipResetRequested) {
            retireIronBalls();
            if (!owner.setBodyMotion) return;
            owner
              .setBodyMotion(ship, {
                position: [0, COAST_SHIP_MASS_RIG.buoyancy.loadedRootYM, 0],
                rotation: [0, 0, 0, 1],
                linearVelocity: [0, 0, 0],
                angularVelocity: [0, 0, 0],
              })
              .unwrap();
            shipResetRequested = false;
            record('ship-reset', { physicsStep: world.getResource(FixedTime).tick });
            return;
          }
          if (!manualDriving && !shipNavigation.running && !shipNavigation.braking) return;
          const committed = owner.getCommittedBodyDynamics?.(ship);
          if (!committed?.ok || !owner.applyBodyForceAtPoint || !owner.applyBodyTorque) return;
          const dynamics = committed.value;
          const driveManualHelm = () => {
            if (manualDriving) {
              const keyboard = world.getResource<InputSnapshot>(
                INPUT_SNAPSHOT_RESOURCE_KEY,
              ).keyboard;
              const focused = document.activeElement === canvas && document.hasFocus();
              const forward = rotateWaterVector(dynamics.rotation, [1, 0, 0]);
              const length = Math.max(0.001, Math.hypot(forward[0], forward[2]));
              const fx = forward[0] / length,
                fz = forward[2] / length;
              const forwardSpeed =
                dynamics.linearVelocityMps[0] * fx + dynamics.linearVelocityMps[2] * fz;
              const lateralSpeed =
                -dynamics.linearVelocityMps[0] * fz + dynamics.linearVelocityMps[2] * fx;
              const command = stepShipHelm(
                helm,
                readShipHelmInput(keyboard, focused, releasedHelmCodes),
                world.getResource(FixedTime).delta,
                forwardSpeed,
                handling,
              );
              const side = -lateralSpeed * handling.lateralResistancePerSecond;
              const forceN: Vector = [
                dynamics.massKg * (fx * command.thrustAccelerationMps2 - fz * side),
                0,
                dynamics.massKg * (fz * command.thrustAccelerationMps2 + fx * side),
              ];
              const inverse = [
                -dynamics.rotation[0],
                -dynamics.rotation[1],
                -dynamics.rotation[2],
                dynamics.rotation[3],
              ] as const;
              const principal = dynamics.principalInertiaLocalRotation;
              const up = rotateWaterVector(
                [-principal[0], -principal[1], -principal[2], principal[3]],
                rotateWaterVector(inverse, [0, 1, 0]),
              );
              const localTorque = [0, 1, 2].map(
                (axis) =>
                  requireDemoValue(up[axis], 'accepted authored scene member') *
                  requireDemoValue(
                    dynamics.principalInertiaKgM2[axis],
                    'accepted authored scene member',
                  ) *
                  command.yawAccelerationRadps2,
              ) as Vector;
              const torqueNm = rotateWaterVector(
                dynamics.rotation,
                rotateWaterVector(principal, localTorque),
              );
              requireDemoMethod(
                owner,
                'applyBodyForceAtPoint',
                'admitted native force owner',
              )({
                entity: ship,
                generation: dynamics.generation,
                fixedStep: dynamics.nextFixedStep,
                pointM: dynamics.centerOfMassM,
                forceN,
              }).unwrap();
              requireDemoMethod(
                owner,
                'applyBodyTorque',
                'admitted native torque owner',
              )({
                entity: ship,
                generation: dynamics.generation,
                fixedStep: dynamics.nextFixedStep,
                torqueNm,
              }).unwrap();
              return;
            }
          };
          if (manualDriving) {
            driveManualHelm();
            return;
          }
          const advanceNavigationLap = () => {
            const dx = dynamics.positionM[0] - shipRoute.centerXZ[0];
            const dz = dynamics.positionM[2] - shipRoute.centerXZ[1];
            const radius = Math.max(1, Math.hypot(dx, dz));
            const angle = Math.atan2(dz, dx);
            if (
              shipNavigation.path === 'circle' &&
              shipNavigation.running &&
              shipNavigation.previousAngle !== undefined
            ) {
              const delta = Math.atan2(
                Math.sin(shipNavigation.previousAngle - angle),
                Math.cos(shipNavigation.previousAngle - angle),
              );
              shipNavigation.distanceRadians += delta;
              const laps = Math.floor(Math.max(0, shipNavigation.distanceRadians) / (Math.PI * 2));
              if (laps > shipNavigation.completedLaps) {
                shipNavigation.completedLaps = laps;
                record('ship-lap-completed', { laps, physicsStep: dynamics.completedStep });
                if (!shipNavigation.loop) {
                  shipNavigation.running = false;
                  shipNavigation.braking = true;
                }
              }
            }
            return { dx, dz, radius, angle };
          };
          const { dx, dz, radius, angle } = advanceNavigationLap();
          shipNavigation.previousAngle = angle;
          const radialErrorM = radius - shipRoute.radiusM;
          const correction = Math.max(-0.65, Math.min(0.65, radialErrorM * 0.06));
          const navigationCourse = () => {
            const courseX =
              shipNavigation.path === 'straight'
                ? shipNavigation.straightDirectionXZ[0]
                : dz / radius - (dx / radius) * correction;
            const courseZ =
              shipNavigation.path === 'straight'
                ? shipNavigation.straightDirectionXZ[1]
                : -dx / radius - (dz / radius) * correction;
            const courseLength = Math.hypot(courseX, courseZ);
            const speed = shipNavigation.running ? shipNavigation.speedMps : 0;
            return { courseX, courseZ, courseLength, speed };
          };
          const { courseX, courseZ, courseLength, speed } = navigationCourse();
          const buoyancyStep = buoyancy().steps.find((step) => step.entity === ship)?.result;
          const dragSource =
            buoyancyStep?.ok && buoyancyStep.value.rootGeneration === dynamics.generation
              ? buoyancyStep.value
              : undefined;
          const waterDrag = dragSource?.dragAccelerationMps2 ?? [0, 0, 0];
          const damping = world.get(ship, RigidBody).unwrap().linearDamping;
          const accelerationX =
            ((courseX / courseLength) * speed - dynamics.linearVelocityMps[0]) / 1.5 -
            requireDemoValue(waterDrag[0], 'accepted authored scene member') +
            damping * dynamics.linearVelocityMps[0];
          const accelerationZ =
            ((courseZ / courseLength) * speed - dynamics.linearVelocityMps[2]) / 1.5 -
            requireDemoValue(waterDrag[2], 'accepted authored scene member') +
            damping * dynamics.linearVelocityMps[2];
          const accelerationScale = Math.min(
            1,
            2.4 / Math.max(1e-6, Math.hypot(accelerationX, accelerationZ)),
          );
          const forceN: Vector = [
            accelerationX * accelerationScale * dynamics.massKg,
            0,
            accelerationZ * accelerationScale * dynamics.massKg,
          ];
          const forward = rotateWaterVector(dynamics.rotation, [1, 0, 0]);
          const yawError = Math.atan2(
            forward[2] * courseX - forward[0] * courseZ,
            forward[0] * courseX + forward[2] * courseZ,
          );
          const bodyInverse = [
            -dynamics.rotation[0],
            -dynamics.rotation[1],
            -dynamics.rotation[2],
            dynamics.rotation[3],
          ] as const;
          const frame = dynamics.principalInertiaLocalRotation;
          const principalUp = rotateWaterVector(
            [-frame[0], -frame[1], -frame[2], frame[3]],
            rotateWaterVector(bodyInverse, [0, 1, 0]),
          );
          const yawRate =
            shipNavigation.running && shipNavigation.path === 'circle' ? speed / radius : 0;
          const yawAcceleration = Math.max(
            -0.25,
            Math.min(
              0.25,
              (shipNavigation.running ? yawError * 0.7 : 0) +
                (yawRate - dynamics.angularVelocityRadps[1]) * 1.8,
            ),
          );
          const principalTorque: Vector = [
            principalUp[0] * dynamics.principalInertiaKgM2[0] * yawAcceleration,
            principalUp[1] * dynamics.principalInertiaKgM2[1] * yawAcceleration,
            principalUp[2] * dynamics.principalInertiaKgM2[2] * yawAcceleration,
          ];
          const torqueNm: Vector = [
            ...rotateWaterVector(dynamics.rotation, rotateWaterVector(frame, principalTorque)),
          ];
          owner
            .applyBodyForceAtPoint({
              entity: ship,
              generation: dynamics.generation,
              fixedStep: dynamics.nextFixedStep,
              pointM: dynamics.centerOfMassM,
              forceN,
            })
            .unwrap();
          owner
            .applyBodyTorque({
              entity: ship,
              generation: dynamics.generation,
              fixedStep: dynamics.nextFixedStep,
              torqueNm,
            })
            .unwrap();
          shipNavigation.lastCommand = {
            fixedStep: dynamics.nextFixedStep,
            forceN,
            torqueNm,
            radialErrorM,
            waterDragSource:
              dragSource === undefined
                ? null
                : {
                    entity: dragSource.rootEntity,
                    generation: dragSource.rootGeneration,
                    physicsStep: dragSource.physicsStep,
                    accelerationMps2: [...waterDrag],
                  },
            nativeDampingPerSecond: damping,
            propulsionPowerW:
              forceN[0] * dynamics.linearVelocityMps[0] + forceN[2] * dynamics.linearVelocityMps[2],
            yawPowerW: torqueNm.reduce(
              (sum, value, axis) =>
                sum +
                value *
                  requireDemoValue(
                    dynamics.angularVelocityRadps[axis],
                    'accepted authored scene member',
                  ),
              0,
            ),
          };
          if (
            !shipNavigation.running &&
            Math.hypot(dynamics.linearVelocityMps[0], dynamics.linearVelocityMps[2]) < 0.03
          )
            shipNavigation.braking = false;
        },
      }),
    )
    .unwrap();
  world
    .addSystem(
      FixedUpdate,
      defineSystem({
        name: 'waterR8CompletedPhysicsTrace',
        after: [WaterBuoyancyCompletion],
        queries: [],
        fn: () => {
          const body = bodySnapshot(requireDemoValue(bodies[0], 'accepted authored scene member'));
          if (body)
            for (const ball of balls) {
              if (ball.launch.fixedStep === undefined) continue;
              const accepted = physics().getCommittedBodyDynamics?.(ball.entity);
              if (!accepted?.ok) continue;
              const dynamics = accepted.value;
              const recordBallTrajectory = () => {
                if (ball.trajectory.length < 240 && dynamics.completedStep % 6 === 0)
                  ball.trajectory.push({
                    fixedStep: dynamics.completedStep,
                    positionM: [...dynamics.positionM],
                    velocityMps: [...dynamics.linearVelocityMps],
                  });
                if (ball.entry) {
                  if (
                    !ball.submerged &&
                    ironBallSubmerged(
                      dynamics.positionM,
                      ball.radiusM,
                      requireDemoValue(ball.entry.positionM[1], 'recorded iron-ball entry surface'),
                    )
                  ) {
                    world
                      .set(ball.entity, Visibility, { state: VisibilityStateValue.hidden })
                      .unwrap();
                    ball.submerged = true;
                  }
                  return true;
                }
                return false;
              };
              if (recordBallTrajectory()) continue;
              const solverClock = physics().getSolverClock?.();
              if (!solverClock) continue;
              const sample = sampleIronBallEntry(
                water(),
                body,
                dynamics,
                solverClock,
                Boolean(ball.entry),
              );
              if (sample === undefined) continue;
              if (
                sample.ok &&
                !sample.value.excluded &&
                sample.value.surfaceM &&
                sample.value.normalYUp &&
                dynamics.positionM[1] - ball.radiusM <= sample.value.surfaceM[1]
              ) {
                ball.entry = {
                  fixedStep: dynamics.completedStep,
                  bodyGeneration: body.sceneGeneration,
                  positionM: [...sample.value.surfaceM],
                  normalYUp: [...sample.value.normalYUp],
                  velocityMps: [...dynamics.linearVelocityMps],
                };
                releaseIronBallWaterCollider(world, ball.entity).unwrap();
                record('iron-ball-water-entry', {
                  entity: ball.entity,
                  input: 'native-water-shallow-collider',
                  ...ball.entry,
                });
                ball.attachment = {
                  collision: {
                    entryPosition: ball.entry.positionM,
                    entryVelocity: ball.entry.velocityMps,
                    surfaceNormal: ball.entry.normalYUp,
                    entryRadiusM: ball.radiusM,
                  },
                  bodyGuid: body.guid,
                  bodyGeneration: body.sceneGeneration,
                  startedAtSeconds: world.getResource(Time).elapsed,
                  timeScale: cannon.playerTimeScale,
                };
                const entryParameters = waterEntrySplashParameters(
                  {
                    entryPosition: ball.entry.positionM,
                    entryVelocity: ball.entry.velocityMps,
                    surfaceNormal: ball.entry.normalYUp,
                    entryRadiusM: ball.radiusM,
                  },
                  splashSettings,
                );
                if (localSimulation && localSimulation.inspect().state.status !== 'disabled') {
                  const impulse = localSimulation.enqueueWaveImpulse({
                    ...waterEntryWaveImpulse({
                      entryPosition: ball.entry.positionM,
                      entryVelocity: ball.entry.velocityMps,
                      surfaceNormal: ball.entry.normalYUp,
                      entryRadiusM: ball.radiusM,
                    }),
                    timeSeconds: solverClock.simulationTimeSeconds,
                    sourceReceiver: { entity: ball.entity, generation: dynamics.generation },
                  });
                  record('iron-ball-entry-wave', { entity: ball.entity, result: impulse });
                  if (!impulse.ok) report(impulse.error);
                }
                const startEntryPresentation = () => {
                  const patched = vfxControl.patchPlayerParameters({
                    player: ball.entryPlayer,
                    values: entryParameters,
                  });
                  if (!patched.ok) {
                    record('iron-ball-entry-vfx-failed', {
                      entity: ball.entity,
                      entry: ball.entry,
                      error: patched.error,
                    });
                    report(patched.error);
                    const retired = world.despawn(ball.entryPlayer);
                    if (retired.ok) ball.entryPlayerRetired = true;
                    if (!retired.ok) {
                      record('iron-ball-entry-vfx-retirement-failed', {
                        entity: ball.entity,
                        error: retired.error,
                      });
                      report(retired.error);
                    }
                    return false;
                  }
                  const started = world.set(ball.entryPlayer, ParticleEffectPlayer, {
                    playing: true,
                  });
                  if (!started.ok) {
                    record('iron-ball-entry-vfx-start-failed', {
                      entity: ball.entity,
                      entry: ball.entry,
                      error: started.error,
                    });
                    report(started.error);
                    const retired = world.despawn(ball.entryPlayer);
                    if (retired.ok) ball.entryPlayerRetired = true;
                    if (!retired.ok) {
                      record('iron-ball-entry-vfx-retirement-failed', {
                        entity: ball.entity,
                        error: retired.error,
                      });
                      report(retired.error);
                    }
                    return false;
                  }
                  return true;
                };
                if (!startEntryPresentation()) continue;
                ball.entryRetireTime =
                  world.getResource(Time).elapsed +
                  (entryParameters.lifetime + 0.25) / cannon.playerTimeScale;
              }
            }
          if (diagnostics.enabled || transaction) {
            if (fixedTrace.length >= 180) fixedTrace.shift();
            fixedTrace.push(
              structuredClone({
                step: world.getResource(FixedTime).tick,
                delta: world.getResource(FixedTime).delta,
                steps: buoyancy().steps.map((row) => ({
                  entity: row.entity,
                  result: row.result.ok
                    ? { ok: true, value: snapshotWaterBuoyancyStepForTrace(row.result.value) }
                    : { ok: false, error: json('', row.result.error) },
                })),
                async: buoyancy().async,
              }),
            );
          }
        },
      }),
    )
    .unwrap();
  const completionTimes: number[] = [];
  const completedFrameTimes: {
    frameId: number;
    wallTimeMs: number;
    simulationTimeSeconds: number;
  }[] = [];
  const submittedSamples = new Map<
    string,
    {
      readonly receipt: FrameReceipt;
      readonly sample: R8SubmittedFrameSample;
      readonly inspection: RenderInspection | undefined;
      readonly candidateEvidence: unknown;
      readonly issuedTransaction: number | undefined;
      readonly profileRun: R8ProfileRun | undefined;
      readonly profileReceipt: R8ProfileReceipt | undefined;
    }
  >();
  const observeGpuTiming = (receipt: FrameReceipt, run: R8ProfileRun | undefined) =>
    profileCapture.observeGpuTiming(
      app.renderer,
      receipt,
      run,
      () => diagnostics.enabled,
      (result) => {
        gpuTimings.push(result);
        if (gpuTimings.length > 120) gpuTimings.shift();
      },
      report,
    );

  onReceiptCompleted = (completion) => {
    const key = receiptKey(completion.frameId, completion.deviceGeneration);
    const submitted = submittedSamples.get(key);
    if (submitted === undefined) return;
    submittedSamples.delete(key);
    const {
      receipt,
      sample,
      inspection,
      candidateEvidence,
      issuedTransaction,
      profileRun: run,
      profileReceipt,
    } = submitted;
    sample.completion = 'fulfilled';
    const currentGeneration = app.renderer.currentDeviceGeneration?.();
    const sameGeneration =
      currentGeneration === undefined || currentGeneration === completion.deviceGeneration;
    const sameToken = exactProfileToken(receipt.profileFrame, completion.profileFrame);
    profileCapture.completeReceipt(run, profileReceipt, key, completion, sameToken, sameGeneration);
    if (!sameGeneration) return;
    const profileMatch = run !== undefined && !run.finalized && sameToken && sameGeneration;
    if (completion.presentation !== 'ready') return;
    if (profileMatch && run !== undefined) observeGpuTiming(receipt, run);
    else if (diagnostics.enabled) observeGpuTiming(receipt, undefined);

    completedFrames++;
    completedReceipt = {
      frameId: completion.frameId,
      deviceGeneration: completion.deviceGeneration,
      ...(receipt.graphGeneration === undefined
        ? {}
        : { graphGeneration: receipt.graphGeneration }),
    };
    if (inspection) latest = inspection;
    if (
      diagnostics.enabled ||
      transaction ||
      (renderTrace.length > 0 &&
        (renderTrace[renderTrace.length - 1] as typeof sample).graphGeneration !==
          sample.graphGeneration)
    ) {
      renderTrace.push(sample);
      if (renderTrace.length > 45) renderTrace.shift();
    }
    const acceptCompletedConfiguration = () => {
      if (transaction && transaction.revision === issuedTransaction && candidateEvidence) {
        const accepted = transaction;
        activeMode = transaction.mode;
        transaction = undefined;
        lockConfiguration(false);
        record('configuration-completed', {
          transaction: transactionEvidence(accepted),
          receipt: completedReceipt,
          evidence: candidateEvidence,
          allocation: inspection?.renderGraphGenerationAllocation,
          sources: bodies.map((body) => assets.source(body.handle)),
        });
        element('transition').textContent = `候选配置已完成 · 帧 ${completion.frameId}`;
      }
    };
    acceptCompletedConfiguration();
    const refreshCompletedFrameReadout = () => {
      const now = performance.now();
      if (diagnostics.enabled) {
        completedFrameTimes.push({
          frameId: completion.frameId,
          wallTimeMs: now,
          simulationTimeSeconds: world.getResource(Time).elapsed,
        });
        if (completedFrameTimes.length > 2048) completedFrameTimes.shift();
      }
      completionTimes.push(now);
      while ((completionTimes[0] ?? now) < now - 1200) completionTimes.shift();
      if (now - lastRefresh > 250) {
        const duration = now - (completionTimes[0] ?? now);
        element('fps').textContent =
          duration > 400
            ? `${(((completionTimes.length - 1) * 1000) / duration).toFixed(1)} FPS`
            : '-- FPS';
        element('state').textContent = '实时渲染';
        refresh();
        lastRefresh = now;
      }
    };
    refreshCompletedFrameReadout();
  };

  app.renderer.subscribe((event) => {
    if (event.kind === 'error') {
      report(event.error);
      return;
    }
    if (event.kind === 'state-changed') {
      record('renderer-state', event);
      element('state').textContent = event.current;
      return;
    }
    if (event.kind !== 'frame-submitted') return;
    const submittedAtMs = performance.now();
    const needsInspection =
      diagnostics.enabled ||
      transaction !== undefined ||
      profileCapture.run !== undefined ||
      (diagnosticDimensionOpen() &&
        submittedAtMs - lastInspectionMs >= diagnostics.inspectionIntervalMs);
    const inspection = needsInspection ? app.renderer.inspect() : undefined,
      issuedTransaction = transaction?.revision;
    if (inspection) lastInspectionMs = submittedAtMs;
    const candidateEvidence =
      transaction && inspection
        ? completedConfigurationEvidence(transaction, event.receipt, inspection)
        : undefined;
    const sample = submittedFrameSample(event.receipt, inspection);
    if (transaction && candidateEvidence) transaction.status = 'awaiting-completion';
    const key = receiptKey(event.receipt.frameId, event.receipt.deviceGeneration);
    const run = profileCapture.run;
    const profileReceipt = profileCapture.retainSubmittedReceipt(event.receipt, key, run);
    submittedSamples.set(key, {
      receipt: event.receipt,
      sample,
      inspection,
      candidateEvidence,
      issuedTransaction,
      profileRun: run,
      profileReceipt,
    });
    while (submittedSamples.size > 16) {
      const oldest = submittedSamples.keys().next().value;
      if (oldest === undefined) break;
      const evicted = submittedSamples.get(oldest);
      profileCapture.evictReceipt(evicted?.profileRun, evicted?.profileReceipt);
      submittedSamples.delete(oldest);
    }
    void event.receipt.completed.then(
      (result) => {
        if (result.ok) {
          // App registers its onCompleted reaction immediately after emitting
          // frame-submitted. This handler therefore records the Result only;
          // the App callback owns closing the pending completion notification.
          profileCapture.fulfillReceipt(run, profileReceipt);
          return;
        }
        sample.completion = 'rejected';
        profileCapture.rejectReceipt(run, profileReceipt, key);
        record('frame-failed', { sample, error: result.error });
        report(result.error);
      },
      (cause) => {
        sample.completion = 'rejected';
        profileCapture.rejectReceipt(run, profileReceipt, key);
        report(cause);
      },
    );
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-view]'))
    button.addEventListener('click', () => setView(button.dataset.view as View));
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-fault]'))
    button.addEventListener('click', () => {
      void fault(requireDemoValue(button.dataset.fault, 'accepted authored scene member')).catch(
        report,
      );
    });
  element('region').addEventListener('change', () => {
    setView(view);
  });
  element('quality').addEventListener('change', () => {
    try {
      setMode(element<HTMLSelectElement>('quality').value as Mode);
    } catch (error) {
      element<HTMLSelectElement>('quality').value = activeMode;
      report(error);
    }
  });
  element('waves').addEventListener('input', () => {
    element('wind-value').textContent =
      `${Number(element<HTMLInputElement>('waves').value).toFixed(2)} × · 松手应用`;
  });
  element('waves').addEventListener('change', () => {
    if (transaction) return;
    pendingWindStrength = Number(element<HTMLInputElement>('waves').value);
    element('wind-value').textContent = `${pendingWindStrength.toFixed(2)} × · 等待接纳`;
  });
  element('weather').addEventListener('change', () => {
    const index = ['day', 'sunset', 'overcast'].indexOf(
      element<HTMLSelectElement>('weather').value,
    );
    const previousSky = acceptedSkyIndex();
    const previousSun = world.get(sunlight, DirectionalLight).unwrap();
    try {
      applySkyVariant(index);
      world
        .set(sunlight, DirectionalLight, {
          color: index === 1 ? [1, 0.64, 0.35] : [1, 0.97, 0.89],
          intensity: index === 2 ? 1.5 : 2.4,
        })
        .unwrap();
    } catch (error) {
      if (previousSky >= 0) applySkyVariant(previousSky);
      world.set(sunlight, DirectionalLight, previousSun).unwrap();
      report(error);
    } finally {
      refreshControlSummary();
    }
  });
  element('clouds').addEventListener('change', () => {
    const previous = cloudsEnabled;
    cloudsEnabled = element<HTMLInputElement>('clouds').checked;
    const index = ['day', 'sunset', 'overcast'].indexOf(
      element<HTMLSelectElement>('weather').value,
    );
    try {
      applySkyVariant(index);
    } catch (error) {
      cloudsEnabled = previous;
      applySkyVariant(index);
      report(error);
    } finally {
      element<HTMLInputElement>('clouds').checked = cloudsEnabled;
    }
  });
  element('water-color').addEventListener('change', () => {
    const color = element<HTMLInputElement>('water-color').value;
    const rgb = [1, 3, 5].map((start) => Number.parseInt(color.slice(start, start + 2), 16) / 255);
    try {
      updateVisibleWater((values) => {
        const scattering = rgbValue(values.scatteringPerM);
        const strength = Math.max(...scattering);
        const peak = Math.max(...rgb);
        if (peak === 0)
          throw new Error('Choose a non-black scattering tint; use clarity to control extinction');
        return { ...values, scatteringPerM: rgb.map((channel) => (channel / peak) * strength) };
      });
      markCustom();
    } catch (error) {
      report(error);
    } finally {
      const value = observeWaterMaterial(
        requireDemoValue(modeMaterialHandles(activeMode)[0], 'active scattering material'),
      ).values.scatteringPerM;
      if (value !== undefined) {
        const scattering = rgbValue(value);
        const peak = Math.max(...scattering, 0.000001);
        element<HTMLInputElement>('water-color').value =
          '#' +
          scattering
            .map((channel) =>
              Math.round(Math.min(1, Math.max(0, channel / peak)) * 255)
                .toString(16)
                .padStart(2, '0'),
            )
            .join('');
      }
      refreshControlSummary();
    }
  });
  element('exposure').addEventListener('input', () => {
    const multiplier = Number(element<HTMLInputElement>('exposure').value);
    world.set(camera, Camera, { exposure: multiplier }).unwrap();
    element('exposure-value').textContent = multiplier.toFixed(2);
  });
  element('pause').addEventListener('change', () => {
    if (element<HTMLInputElement>('pause').checked) app.pause().unwrap();
    else app.resume().unwrap();
  });
  element('reset-ship').addEventListener('click', resetShip);
  element('ship-go').addEventListener('click', () => {
    shipNavigation.path =
      element<HTMLSelectElement>('ship-route').value === 'straight' ? 'straight' : 'circle';
    const dynamics = physics().getCommittedBodyDynamics?.(ship);
    if (dynamics?.ok) {
      const forward = rotateWaterVector(dynamics.value.rotation, [1, 0, 0]);
      const horizontalLength = Math.hypot(forward[0], forward[2]);
      if (horizontalLength > 1e-6)
        shipNavigation.straightDirectionXZ = [
          forward[0] / horizontalLength,
          forward[2] / horizontalLength,
        ];
    }
    shipNavigation.running = true;
    shipNavigation.braking = false;
    shipNavigation.previousAngle = undefined;
    record('ship-navigation-started', {
      speedMps: shipNavigation.speedMps,
      loop: shipNavigation.loop,
      path: shipNavigation.path,
      route: shipRoute,
      straightDirectionXZ: shipNavigation.straightDirectionXZ,
    });
  });
  element('ship-stop').addEventListener('click', () => {
    shipNavigation.running = false;
    shipNavigation.braking = true;
    record('ship-navigation-stopped', { physicsStep: world.getResource(FixedTime).tick });
  });
  element('fire-ball').addEventListener('click', () => {
    fireRequested = true;
  });
  element<HTMLInputElement>('ship-loop').addEventListener('change', (event) => {
    shipNavigation.loop = (event.currentTarget as HTMLInputElement).checked;
  });
  element<HTMLInputElement>('ship-speed').addEventListener('input', (event) => {
    shipNavigation.speedMps = Number((event.currentTarget as HTMLInputElement).value);
    element('ship-speed-value').textContent = `${shipNavigation.speedMps} m/s`;
  });
  for (const [id, entity, component] of [['buoyancy-enabled', ship, WaterPontoonSet]] as const) {
    element<HTMLInputElement>(id).addEventListener('change', (event) => {
      const enabled = (event.currentTarget as HTMLInputElement).checked;
      world
        .set(entity, component, { enabled: enabled && shipRigAdmission.kind === 'ready' })
        .unwrap();
      record(id, { enabled });
    });
  }
  element<HTMLInputElement>('contacts-enabled').addEventListener('change', (event) => {
    const enabled = (event.currentTarget as HTMLInputElement).checked;
    const previous = world.get(ship, WaterContactProbeSet).unwrap();
    try {
      if (transaction) throw new Error('Wait for configuration completion');
      world.set(ship, WaterContactProbeSet, { enabled }).unwrap();
      updateVisibleWater((values, accepted) =>
        accepted.switches.waterFoam === false || values.contactFoamAmount === undefined
          ? values
          : { ...values, contactFoamAmount: Number(enabled) },
      );
      record('contacts-enabled', { enabled });
    } catch (error) {
      world.set(ship, WaterContactProbeSet, { enabled: previous.enabled }).unwrap();
      report(error);
    } finally {
      element<HTMLInputElement>('contacts-enabled').checked = world
        .get(ship, WaterContactProbeSet)
        .unwrap().enabled;
    }
  });
  element<HTMLInputElement>('depth-foam-enabled').addEventListener('change', (event) => {
    const enabled = (event.currentTarget as HTMLInputElement).checked;
    try {
      const source = observeWaterMaterial(
        requireDemoValue(modeMaterialHandles(activeMode)[0], 'active waterline material'),
      );
      if (source.switches.waterFoam === false || source.switches.waterOceanFoam !== true)
        throw new Error('The active rendering branch disables waterline foam');
      updateVisibleWater((values, accepted) =>
        accepted.switches.waterFoam === false ||
        accepted.switches.waterOceanFoam !== true ||
        values.sceneDepthFoamAmount === undefined
          ? values
          : { ...values, sceneDepthFoamAmount: enabled ? 1.2 : 0 },
      );
      record('depth-foam-enabled', { enabled });
    } catch (error) {
      report(error);
    } finally {
      refreshControlSummary();
    }
  });
  element<HTMLInputElement>('crests-enabled').addEventListener('change', (event) => {
    const enabled = (event.currentTarget as HTMLInputElement).checked;
    try {
      if (transaction) throw new Error('Wait for configuration completion');
      const source = observeWaterMaterial(
        requireDemoValue(modeMaterialHandles(activeMode)[0], 'active crest material'),
      );
      if (source.switches.waterFoam === false || source.switches.waterOceanFoam !== true)
        throw new Error('The active rendering branch disables crest foam');
      applyCrestComposition(activeMode);
      record('crests-enabled', { enabled });
    } catch (error) {
      report(error);
    } finally {
      refreshControlSummary();
    }
  });
  element('capture').addEventListener('click', () => {
    void capture().catch(report);
  });
  element('panel-toggle').addEventListener('click', () => {
    const panel = element('controls-panel');
    panel.hidden = !panel.hidden;
    document.body.classList.toggle('panel-closed', panel.hidden);
    element('panel-toggle').setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) refresh();
    applyCamera();
  });
  element('export').addEventListener('click', () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(readState(), json, 2)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `water-r8-${activeMode}-frame-${completedReceipt?.frameId ?? 0}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
  const parameterPanel = document.createElement('section');
  const qualityLabel = document.createElement('label');
  qualityLabel.textContent = '质量预设 · 实际运行负载';
  const qualitySelect = document.createElement('select');
  qualitySelect.id = 'quality-preset';
  for (const [value, label] of [
    ['low', '低'],
    ['balanced', '均衡'],
    ['high', '高'],
    ['ultra', '极高'],
    ['custom', '自定义'],
  ] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    qualitySelect.append(option);
  }
  qualitySelect.value = qualityPreset;
  qualitySelect.addEventListener('change', () => {
    if (qualitySelect.value === 'custom') return;
    const name = qualitySelect.value as WaterQualityPreset;
    try {
      setMode(activeMode, meshProfile, { name, settings: { ...WATER_QUALITY_PRESETS[name] } });
    } catch (error) {
      qualitySelect.value = transaction?.before.qualityPreset ?? qualityPreset;
      report(error);
    }
  });
  qualityLabel.append(qualitySelect);
  parameterPanel.append(qualityLabel);
  const markCustom = () => {
    const zone = assets.read(zoneAsset).unwrap(),
      recipe = assets.read(localRecipe).unwrap();
    qualitySettings = {
      tessellationFactor: zone.tessellationFactor,
      waterInfoResolution: zone.waterInfo.resolution.widthPx,
      waveCount: authoredWaveCount,
      pontoonCount: world.get(ship, WaterPontoonSet).unwrap().radiiM.length,
      contactProbeCount: world.get(ship, WaterContactProbeSet).unwrap().radiiM.length,
      localResolution:
        recipe.system === 'water-advanced'
          ? (recipe.oceanPatchConfig?.fftResolution ?? qualitySettings.localResolution)
          : qualitySettings.localResolution,
    };
    qualityPreset = 'custom';
    qualitySelect.value = 'custom';
    refreshRuntimeForms(parameterForms);
  };
  const manualLabel = document.createElement('label');
  const manualInput = document.createElement('input');
  manualInput.type = 'checkbox';
  manualInput.id = 'manual-driving';
  manualLabel.append(manualInput, '人工驾驶 · WASD / 方向键 · Space 加速');
  manualInput.addEventListener('change', () => {
    manualDriving = manualInput.checked;
    helm.throttle = 0;
    helm.rudder = 0;
    shipNavigation.running = false;
    shipNavigation.braking = false;
    if (manualDriving) {
      element<HTMLInputElement>('follow').checked = true;
      canvas.focus();
    }
  });
  parameterPanel.append(manualLabel);
  const hint = document.createElement('p');
  hint.textContent =
    'W / ↑ 前进，S / ↓ 倒车，A / ← 左舵，D / → 右舵，Space 加速。松开后惯性滑行；点击场景接管，表单焦点释放操纵。';
  parameterPanel.append(hint);
  parameterForms.push(
    runtimeForm(
      parameterPanel,
      '质量负载与探针数量',
      Object.entries(qualitySettings).map(([name, value]) => ({
        name,
        value,
        read: () =>
          (transaction?.before.qualitySettings ?? qualitySettings)[
            name as keyof typeof qualitySettings
          ],
        set: (next) => {
          const settings = { ...qualitySettings, [name]: Number(next) };
          shipPontoonLayout(settings.pontoonCount);
          if (
            !Number.isInteger(settings.waveCount) ||
            settings.waveCount < 1 ||
            settings.waveCount > 64 ||
            !Number.isInteger(settings.contactProbeCount) ||
            settings.contactProbeCount < 4 ||
            settings.contactProbeCount > 88 ||
            ![128, 256, 512].includes(settings.localResolution) ||
            ![256, 512, 1024, 2048].includes(settings.waterInfoResolution) ||
            !Number.isInteger(settings.tessellationFactor) ||
            settings.tessellationFactor < 3 ||
            settings.tessellationFactor > 8
          )
            throw new Error(
              'Use 1..64 waves, 4..88 probes, FFT 128/256/512, WaterInfo 256/512/1024/2048, tessellation 3..8',
            );
          setMode(activeMode, meshProfile, { name: 'custom', settings });
        },
      })),
    ),
  );
  parameterForms.push(
    runtimeForm(
      parameterPanel,
      '原生浮力与阻尼',
      runtimeObjectFields(
        () => ({ ...world.get(ship, WaterPontoonSet).unwrap() }),
        (value) => {
          if (transaction) throw new Error('Wait for configuration completion');
          world.set(ship, WaterPontoonSet, pontoonInput(value)).unwrap();
          markCustom();
        },
      ),
    ),
  );
  parameterForms.push(
    runtimeForm(
      parameterPanel,
      '船体刚体：质量与原生阻尼',
      runtimeObjectFields(
        () => {
          const native = physics().getCommittedBodyDynamics?.(ship);
          const component = world.get(ship, RigidBody).unwrap();
          return {
            ...component,
            mass: native?.ok ? native.value.massKg : COAST_SHIP_MASS_RIG.properties.mass,
          };
        },
        (value) => {
          if (transaction) throw new Error('Wait for configuration completion');
          const requestedMass = Number(value.mass);
          if (!Number.isFinite(requestedMass) || requestedMass <= 0)
            throw new Error('Mass must be positive');
          const owner = physics();
          const base = COAST_SHIP_MASS_RIG.properties;
          const ratio = requestedMass / base.mass;
          const candidate = requireDemoMethod(
            owner,
            'prepareDerivedShapeCandidate',
            'prepareDerivedShapeCandidate',
          )({
            entity: ship,
            sourceKey: 'water-r8:ship-mass-rig',
            revision:
              (owner.getDerivedPublication?.(ship)?.revision ?? COAST_SHIP_MASS_RIG.revision) + 1,
            shapes: [],
            massProperties: {
              ...base,
              mass: requestedMass,
              principalInertia: base.principalInertia.map(
                (entry) => entry * ratio,
              ) as unknown as typeof base.principalInertia,
            },
            velocityPolicy: 'preserve',
          }).unwrap();
          const { mass: _mass, ...component } = value;
          const previousComponent = { ...world.get(ship, RigidBody).unwrap() };
          world
            .set(ship, RigidBody, component as InputShapeOf<SchemaOf<typeof RigidBody>>)
            .unwrap();
          const admitted = requireDemoMethod(
            owner,
            'admitDerivedShapeCandidate',
            'admitDerivedShapeCandidate',
          )(candidate);
          if (!admitted.ok) {
            world.set(ship, RigidBody, previousComponent).unwrap();
            throw admitted.error;
          }
          markCustom();
        },
      ),
    ),
  );
  parameterForms.push(
    runtimeForm(
      parameterPanel,
      '船体接触探针',
      runtimeObjectFields(
        () => ({ ...world.get(ship, WaterContactProbeSet).unwrap() }),
        (value) => {
          if (transaction) throw new Error('Wait for configuration completion');
          world.set(ship, WaterContactProbeSet, contactProbeInput(value)).unwrap();
          markCustom();
        },
      ),
    ),
  );
  parameterForms.push(
    runtimeForm(
      parameterPanel,
      '动力与舵效',
      runtimeObjectFields(
        () => ({ ...handling }),
        (value) => {
          if (
            Object.values(value).some(
              (entry) => typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0,
            )
          )
            throw new Error('Handling requires finite nonnegative values');
          Object.assign(handling, value);
          markCustom();
        },
      ),
    ),
  );
  parameterForms.push(
    runtimeForm(
      parameterPanel,
      '局部水波与泡沫配方',
      runtimeObjectFields(
        () => ({ ...assets.read(localRecipe).unwrap() }),
        (value) => {
          if (transaction) throw new Error('Wait for configuration completion');
          assets.replace(localRecipe, value as unknown as typeof originalLocalRecipe).unwrap();
          markCustom();
        },
        {
          'oceanPatchConfig.collisions.kind': ['simple', 'distance-field'],
          'oceanPatchConfig.boundary.kind': ['periodic', 'absorbing'],
          'oceanPatchConfig.normalRtFormat': ['rgba16float', 'rgba32float'],
        },
      ),
    ),
  );
  for (const [index, material] of [
    ...materials,
    ...qualityMaterialHandles.Q3,
    ...qualityMaterialHandles.Q4,
  ].entries())
    parameterForms.push(
      runtimeForm(
        parameterPanel,
        `水体材质 · ${index < 3 ? '光学' : index < 6 ? 'Q3' : 'Q4'} · ${index}`,
        runtimeObjectFields(
          () => ({ ...assets.read(material).unwrap().values }),
          (values) => {
            if (transaction) throw new Error('Wait for configuration completion');
            assets.update(material, { values: values as Record<string, MaterialValue> }).unwrap();
            markCustom();
          },
        ),
      ),
    );
  for (const [index, material] of [
    ...materials,
    ...qualityMaterialHandles.Q3,
    ...qualityMaterialHandles.Q4,
  ].entries())
    parameterForms.push(
      runtimeForm(
        parameterPanel,
        `材质编译选择与绘制契约 · ${index}`,
        runtimeObjectFields(
          () => {
            const accepted = assets.read(material).unwrap();
            return {
              staticSwitches: accepted.staticSwitches ?? {},
              passes: accepted.passes,
              parameters: accepted.parameters,
            };
          },
          (value) => {
            if (transaction) throw new Error('Wait for configuration completion');
            assets.update(material, value).unwrap();
            markCustom();
          },
          {},
          ['passes', 'parameters'],
        ),
      ),
    );
  parameterForms.push(
    runtimeForm(
      parameterPanel,
      '摄影机与光学',
      runtimeObjectFields(
        () => ({ ...world.get(camera, Camera).unwrap() }),
        (value) => {
          world.set(camera, Camera, value as InputShapeOf<SchemaOf<typeof Camera>>).unwrap();
          markCustom();
        },
      ),
    ),
  );
  parameterForms.push(
    runtimeForm(
      parameterPanel,
      '发射器与炮弹（下次发射生效）',
      runtimeObjectFields(
        () => ({ ...cannon }),
        (value) => {
          if (
            !Array.isArray(value.muzzleOffsetM) ||
            value.muzzleOffsetM.length !== 3 ||
            value.muzzleOffsetM.some(
              (entry) => typeof entry !== 'number' || !Number.isFinite(entry),
            ) ||
            Object.entries(value).some(
              ([key, entry]) =>
                key !== 'muzzleOffsetM' &&
                (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0),
            ) ||
            Number(value.radiusM) <= 0 ||
            Number(value.radiusM) > 3 ||
            Number(value.massKg) <= 0 ||
            Number(value.playerTimeScale) <= 0 ||
            !Number.isInteger(value.playerSeed) ||
            Number(value.playerSeed) > 0xffffffff
          )
            throw new Error(
              'Use finite launch values, radius (0,3] m, positive mass/time scale and uint32 seed',
            );
          Object.assign(cannon, value);
        },
      ),
    ),
  );
  parameterForms.push(
    runtimeForm(
      parameterPanel,
      '落水水花：喷射 / 尺寸 / 生命周期',
      runtimeObjectFields(
        () => ({ ...splashSettings }),
        (value) => {
          if (
            Object.values(value).some(
              (entry) => typeof entry !== 'number' || !Number.isFinite(entry) || entry <= 0,
            ) ||
            Number(value.opacity) > 1
          )
            throw new Error('Positive finite splash values; opacity must be in (0,1]');
          Object.assign(splashSettings, value);
        },
      ),
    ),
  );
  parameterForms.push(
    runtimeForm(
      parameterPanel,
      '落水粒子：调度、容量与边界',
      runtimeObjectFields(
        () => {
          const emitter = requireDemoValue(
            assets.read(ironBallEntryEffect).unwrap().program.emitters[0],
            'accepted authored scene member',
          );
          return {
            capacity: emitter.capacity,
            schedule: emitter.schedule,
            bounds: emitter.bounds,
            space: emitter.space,
            simulationWhenCulled: emitter.simulationWhenCulled,
          };
        },
        (value) => {
          const effect = assets.read(ironBallEntryEffect).unwrap();
          const emitters = effect.program.emitters.map((emitter, index) =>
            index === 0 ? { ...emitter, ...value } : emitter,
          );
          assets
            .replace(ironBallEntryEffect, {
              ...effect,
              program: { ...effect.program, emitters },
            } as ParticleEffectAsset)
            .unwrap();
        },
        {
          space: ['local', 'world'],
          simulationWhenCulled: ['continue', 'pause', 'restart-on-visible'],
        },
      ),
    ),
  );
  const entryMaterial = (
    await assets.load(guid('material/water-entry-splash'), 'material')
  ).unwrap();
  parameterForms.push(
    runtimeForm(
      parameterPanel,
      '落水粒子材质',
      runtimeObjectFields(
        () => ({ ...assets.read(entryMaterial).unwrap().values }),
        (values) => {
          assets
            .update(entryMaterial, { values: values as Record<string, MaterialValue> })
            .unwrap();
        },
      ),
    ),
  );
  parameterForms.push(
    runtimeForm(
      parameterPanel,
      '水域 / WaterInfo / GPU 网格',
      runtimeObjectFields(
        () => ({ ...assets.read(zoneAsset).unwrap() }),
        (value) => {
          if (transaction) throw new Error('Wait for configuration completion');
          assets.replace(zoneAsset, value as unknown as WaterZoneAsset).unwrap();
          markCustom();
        },
        {
          'waterInfo.format': ['rgba16f', 'rgba32f'],
          'gpuMesh.occlusion': ['disabled', 'hzb', 'precise', 'hzb-precise'],
        },
      ),
    ),
  );
  for (const body of bodies)
    parameterForms.push(
      runtimeForm(
        parameterPanel,
        '水体：形状、水位与查询标记',
        runtimeObjectFields(
          () => ({ ...assets.read(body.handle).unwrap() }),
          (value) => {
            if (transaction) throw new Error('Wait for configuration completion');
            assets.replace(body.handle, value as unknown as WaterBodyAsset).unwrap();
            markCustom();
          },
          {
            type: ['river', 'lake', 'ocean', 'custom'],
            'collision.type': ['river-prism', 'polygon'],
          },
        ),
      ),
    );
  const acceptedSsr = world.get(camera, ScreenSpaceReflection).unwrap();
  const ssrFields = runtimeObjectFields(
    () => {
      const current = world.get(camera, ScreenSpaceReflection);
      return { ...(current.ok ? current.value : acceptedSsr) };
    },
    (value) => {
      if (!world.hasComponent(camera, ScreenSpaceReflection))
        throw new Error('The active rendering branch disables screen-space reflection');
      world
        .set(
          camera,
          ScreenSpaceReflection,
          value as InputShapeOf<SchemaOf<typeof ScreenSpaceReflection>>,
        )
        .unwrap();
      markCustom();
    },
  );
  const readSsrFields = ssrFields.readFields;
  ssrFields.readFields = () =>
    (readSsrFields?.() ?? [...ssrFields]).map((field) => ({
      ...field,
      readonly: Boolean(field.readonly) || !world.hasComponent(camera, ScreenSpaceReflection),
      ...(!world.hasComponent(camera, ScreenSpaceReflection)
        ? {
            help: '当前分支关闭屏幕反射；选择支持 SSR 的分支后可调。',
          }
        : {}),
    }));
  parameterForms.push(runtimeForm(parameterPanel, '屏幕空间反射', ssrFields));
  parameterForms.push(
    runtimeForm(
      parameterPanel,
      '风浪方向',
      runtimeObjectFields(
        () => ({
          windDirectionDegrees,
          wavelengthScale,
          directionSpreadDegrees,
          spectrumRandomness,
        }),
        (value) => {
          if (transaction) throw new Error('Wait for configuration completion');
          const direction = Number(value.windDirectionDegrees);
          const length = Number(value.wavelengthScale);
          const spread = Number(value.directionSpreadDegrees);
          const randomness = Number(value.spectrumRandomness);
          if (
            ![direction, length, spread, randomness].every(Number.isFinite) ||
            direction < 0 ||
            direction > 360 ||
            length < 0.25 ||
            length > 3 ||
            spread < 0 ||
            spread > 180 ||
            randomness < 0 ||
            randomness > 1
          )
            throw new Error(
              'Use direction 0..360 degrees, wavelength scale 0.25..3, spread 0..180 and randomness 0..1',
            );
          const prior = {
            windDirectionDegrees,
            wavelengthScale,
            directionSpreadDegrees,
            spectrumRandomness,
          };
          windDirectionDegrees = direction;
          wavelengthScale = length;
          directionSpreadDegrees = spread;
          spectrumRandomness = randomness;
          try {
            applyWindStrength(windStrength);
          } catch (error) {
            windDirectionDegrees = prior.windDirectionDegrees;
            wavelengthScale = prior.wavelengthScale;
            directionSpreadDegrees = prior.directionSpreadDegrees;
            spectrumRandomness = prior.spectrumRandomness;
            throw error;
          }
        },
      ),
    ),
    runtimeForm(
      parameterPanel,
      '单次落水喷溅',
      runtimeObjectFields(
        () => {
          const emitter = requireDemoValue(
            assets.read(ironBallEntryEffect).unwrap().program.emitters[0],
            'accepted splash emitter',
          );
          const schedule = emitter.schedule as {
            rate?: number;
            loopDuration?: number;
            bursts?: readonly { time: number; count: number }[];
          };
          return {
            burstCount: schedule.bursts?.find((burst) => burst.time === 0)?.count ?? 0,
            capacity: emitter.capacity,
            scheduleSupported:
              Number(schedule.rate ?? 0) === 0 &&
              schedule.loopDuration === undefined &&
              (schedule.bursts ?? []).filter((burst) => burst.time === 0).length <= 1,
          };
        },
        (value) => {
          if (transaction) throw new Error('Wait for configuration completion');
          const effect = assets.read(ironBallEntryEffect).unwrap();
          const emitter = requireDemoValue(effect.program.emitters[0], 'accepted splash emitter');
          const count = Number(value.burstCount);
          const capacity = Number(value.capacity);
          if (
            !Number.isInteger(capacity) ||
            capacity <= 0 ||
            !Number.isInteger(count) ||
            count < 0 ||
            count > capacity
          )
            throw new Error(
              'Burst count must be a nonnegative integer within the positive integer capacity',
            );
          const schedule = emitter.schedule as {
            rate?: number;
            loopDuration?: number;
            bursts?: readonly { time: number; count: number }[];
          };
          const bursts = schedule.bursts ?? [];
          if (
            Number(schedule.rate ?? 0) !== 0 ||
            schedule.loopDuration !== undefined ||
            bursts.filter((burst) => burst.time === 0).length > 1
          )
            throw new Error(
              'Primary entry controls require a non-looping zero-rate schedule with at most one time-zero burst; edit custom schedules in Advanced',
            );
          const laterBursts = bursts.filter((burst) => burst.time !== 0);
          assets
            .replace(ironBallEntryEffect, {
              ...effect,
              program: {
                ...effect.program,
                emitters: effect.program.emitters.map((entry, index) =>
                  index === 0
                    ? {
                        ...entry,
                        capacity,
                        schedule: {
                          ...entry.schedule,
                          bursts: count === 0 ? laterBursts : [{ time: 0, count }, ...laterBursts],
                        },
                      }
                    : entry,
                ),
              },
            } as ParticleEffectAsset)
            .unwrap();
        },
        {},
        ['scheduleSupported'],
      ),
    ),
  );
  const splashForm = requireDemoValue(
    parameterForms.find((form) => form.title === '单次落水喷溅'),
    'entry schedule form',
  );
  const readSplashFields = splashForm.fields.readFields;
  splashForm.fields.readFields = () => {
    const fields = readSplashFields?.() ?? [...splashForm.fields];
    const supported = fields.find((field) => field.name === 'scheduleSupported')?.value === true;
    return fields.map((field) => ({
      ...field,
      readonly: field.readonly || !supported,
      ...(!supported
        ? { help: '当前高级排程为连续、循环或多个零时刻爆发；请在高级对象参数中编辑排程。' }
        : {}),
    }));
  };
  const mountObservedControls = (title: string, observe: () => RuntimeFormField[]) => {
    const fields: RuntimeFormFields = Object.assign(observe(), { readFields: observe });
    parameterForms.push(runtimeForm(parameterPanel, title, fields));
  };
  const observedField = (
    name: string,
    value: unknown,
    read: () => unknown,
    set: (value: unknown) => void,
    readonly = false,
    help?: string,
  ): RuntimeFormField => ({
    name,
    value,
    read,
    set,
    readonly,
    ...(help === undefined ? {} : { help }),
  });
  const visibleMaterialValue = (name: string) => {
    const handle = requireDemoValue(modeMaterialHandles(activeMode)[0], 'active surface material');
    const source = observeWaterMaterial(handle);
    if (name === 'clarityPercent')
      return source.values.absorptionPerM === undefined ||
        source.values.scatteringPerM === undefined
        ? '当前分支未发布消光参数'
        : Math.exp(-5 * extinction(source.values)) * 100;
    return source.values[name];
  };
  mountObservedControls('当前海面观感', () => {
    const handle = requireDemoValue(modeMaterialHandles(activeMode)[0], 'active surface material');
    const source = observeWaterMaterial(handle);
    const hasExtinction =
      source.values.absorptionPerM !== undefined && source.values.scatteringPerM !== undefined;
    const controls = materialControlNames.map((name) => {
      const foam = name.toLowerCase().includes('foam');
      const normal = name.startsWith('normal');
      const disabled =
        source.values[name] === undefined ||
        (foam && source.switches.waterFoam === false) ||
        (normal && source.switches.waterNormalTexture === false) ||
        ((name.startsWith('surfaceCrest') || name.startsWith('sceneDepth')) &&
          source.switches.waterOceanFoam !== true);
      const value = source.values[name] ?? '当前分支未发布此参数';
      return observedField(
        name,
        value,
        () => visibleMaterialValue(name),
        (next) => {
          const accepted = observeWaterMaterial(
            requireDemoValue(modeMaterialHandles(activeMode)[0], 'active surface material'),
          );
          if (
            accepted.values[name] === undefined ||
            (foam && accepted.switches.waterFoam === false) ||
            (normal && accepted.switches.waterNormalTexture === false) ||
            ((name.startsWith('surfaceCrest') || name.startsWith('sceneDepth')) &&
              accepted.switches.waterOceanFoam !== true)
          )
            throw new Error('The active rendering branch does not admit this effect');
          const number = finiteNumber(
            next,
            0,
            ['roughness', 'specular', 'fresnelRoughness', 'foamRoughness'].includes(name)
              ? 1
              : Infinity,
          );
          updateVisibleWater((values, accepted) => {
            if (
              accepted.values[name] === undefined ||
              (foam && accepted.switches.waterFoam === false) ||
              (normal && accepted.switches.waterNormalTexture === false) ||
              ((name.startsWith('surfaceCrest') || name.startsWith('sceneDepth')) &&
                accepted.switches.waterOceanFoam !== true)
            )
              return values;
            return { ...values, [name]: number };
          });
          markCustom();
        },
        disabled,
        disabled ? '当前渲染分支关闭此效果；切回支持分支后可调。' : undefined,
      );
    });
    controls.unshift(
      observedField(
        'clarityPercent',
        hasExtinction ? Math.exp(-5 * extinction(source.values)) * 100 : '当前分支未发布消光参数',
        () => visibleMaterialValue('clarityPercent'),
        (next) => {
          const transmission = finiteNumber(next, 1, 99) / 100;
          const targetExtinction = -Math.log(transmission) / 5;
          updateVisibleWater((values, accepted) => {
            const inherited = accepted.values;
            if (inherited.absorptionPerM === undefined || inherited.scatteringPerM === undefined)
              return values;
            const factor = targetExtinction / Math.max(0.000001, extinction(inherited));
            return {
              ...values,
              absorptionPerM: rgbValue(inherited.absorptionPerM).map((value) => value * factor),
              scatteringPerM: rgbValue(inherited.scatteringPerM).map((value) => value * factor),
            };
          });
          markCustom();
        },
        !hasExtinction,
        hasExtinction
          ? undefined
          : '当前渲染分支没有吸收与散射参数；选择支持水体光学的分支后可调。',
      ),
    );
    return controls;
  });
  mountObservedControls('船体探针尺度', () => {
    const pontoons = world.get(ship, WaterPontoonSet).unwrap();
    const contacts = world.get(ship, WaterContactProbeSet).unwrap();
    const average = (radii: ArrayLike<number>) =>
      Array.from(radii).reduce((sum, radius) => sum + radius, 0) / Math.max(1, radii.length);
    return [
      observedField(
        'pontoonRadiusM',
        average(pontoons.radiiM),
        () => average(world.get(ship, WaterPontoonSet).unwrap().radiiM),
        (next) => {
          if (transaction) throw new Error('Wait for configuration completion');
          const owner = world.get(ship, WaterPontoonSet).unwrap();
          const radius = finiteNumber(next, 0.05, 5);
          world
            .set(
              ship,
              WaterPontoonSet,
              pontoonInput({ ...owner, radiiM: Array.from(owner.radiiM, () => radius) }),
            )
            .unwrap();
          markCustom();
        },
      ),
      observedField(
        'contactRadiusM',
        average(contacts.radiiM),
        () => average(world.get(ship, WaterContactProbeSet).unwrap().radiiM),
        (next) => {
          if (transaction) throw new Error('Wait for configuration completion');
          const owner = world.get(ship, WaterContactProbeSet).unwrap();
          const radius = finiteNumber(next, 0.02, 5);
          world
            .set(
              ship,
              WaterContactProbeSet,
              contactProbeInput({ ...owner, radiiM: Array.from(owner.radiiM, () => radius) }),
            )
            .unwrap();
          markCustom();
        },
      ),
    ];
  });
  mountObservedControls('入水响应强度', () => [
    observedField(
      'crownResponseRatio',
      splashSettings.jetSpeed / waterEntrySplashDefaults.jetSpeed,
      () => splashSettings.jetSpeed / waterEntrySplashDefaults.jetSpeed,
      (next) => {
        splashSettings.jetSpeed =
          waterEntrySplashDefaults.jetSpeed * finiteNumber(next, 0.01, 1.25);
      },
    ),
  ]);
  mountObservedControls('接触泡沫历史', () => [
    observedField(
      'fadeToFivePercentSeconds',
      -Math.log(0.05) / COAST_FOAM_DECAY_PER_SECOND,
      () => -Math.log(0.05) / COAST_FOAM_DECAY_PER_SECOND,
      () => {
        throw new Error('Contact history decay is immutable renderer creation configuration');
      },
      true,
      '接触历史的创建期配置，停止接触后衰减到 5%；当前 owner 没有运行时修改接口。',
    ),
  ]);
  mountObservedControls('天空光照表现', () => {
    const sun = world.get(sunlight, DirectionalLight).unwrap();
    const environment = world.get(ambient, Skylight).unwrap();
    const direction = Array.from(sun.direction);
    const sunTint = () =>
      '#' +
      Array.from(world.get(sunlight, DirectionalLight).unwrap().color)
        .map((value) =>
          Math.round(Math.min(1, Math.max(0, value)) * 255)
            .toString(16)
            .padStart(2, '0'),
        )
        .join('');
    const azimuth = (Math.atan2(direction[0] ?? 0, direction[2] ?? 0) * 180) / Math.PI;
    const elevation =
      (Math.asin(-(direction[1] ?? 0) / Math.max(0.00001, Math.hypot(...direction))) * 180) /
      Math.PI;
    return [
      observedField('sunTint', sunTint(), sunTint, (next) => {
        if (typeof next !== 'string' || !/^#[0-9a-f]{6}$/i.test(next))
          throw new Error('Expected an RGB color');
        world
          .set(sunlight, DirectionalLight, {
            color: [1, 3, 5].map(
              (start) => Number.parseInt(next.slice(start, start + 2), 16) / 255,
            ),
          })
          .unwrap();
      }),
      observedField(
        'sunIntensity',
        sun.intensity,
        () => world.get(sunlight, DirectionalLight).unwrap().intensity,
        (next) => {
          world.set(sunlight, DirectionalLight, { intensity: finiteNumber(next, 0, 20) }).unwrap();
        },
      ),
      observedField(
        'ambientIntensity',
        environment.intensity,
        () => world.get(ambient, Skylight).unwrap().intensity,
        (next) => {
          world.set(ambient, Skylight, { intensity: finiteNumber(next, 0, 4) }).unwrap();
        },
      ),
      ...(['sunAzimuth', 'sunElevation'] as const).map((name) =>
        observedField(
          name,
          name === 'sunAzimuth' ? azimuth : elevation,
          () => {
            const vector = world.get(sunlight, DirectionalLight).unwrap().direction;
            return name === 'sunAzimuth'
              ? (Math.atan2(vector[0] ?? 0, vector[2] ?? 0) * 180) / Math.PI
              : (Math.asin(-(vector[1] ?? 0) / Math.max(0.00001, Math.hypot(...vector))) * 180) /
                  Math.PI;
          },
          (next) => {
            const vector = world.get(sunlight, DirectionalLight).unwrap().direction;
            const angle =
              name === 'sunAzimuth'
                ? (finiteNumber(next, -180, 180) * Math.PI) / 180
                : Math.atan2(vector[0] ?? 0, vector[2] ?? 0);
            const altitude =
              name === 'sunElevation'
                ? (finiteNumber(next, 1, 89) * Math.PI) / 180
                : Math.asin(-(vector[1] ?? 0) / Math.max(0.00001, Math.hypot(...vector)));
            world
              .set(sunlight, DirectionalLight, {
                direction: [
                  Math.sin(angle) * Math.cos(altitude),
                  -Math.sin(altitude),
                  Math.cos(angle) * Math.cos(altitude),
                ],
              })
              .unwrap();
          },
        ),
      ),
    ];
  });
  parameterForms.push(
    runtimeForm(
      parameterPanel,
      '太阳完整参数',
      runtimeObjectFields(
        () => ({ ...world.get(sunlight, DirectionalLight).unwrap() }),
        (value) => {
          world
            .set(
              sunlight,
              DirectionalLight,
              value as InputShapeOf<SchemaOf<typeof DirectionalLight>>,
            )
            .unwrap();
        },
      ),
    ),
    runtimeForm(
      parameterPanel,
      '环境完整参数',
      runtimeObjectFields(
        () => ({ ...world.get(ambient, Skylight).unwrap() }),
        (value) => {
          world.set(ambient, Skylight, value as InputShapeOf<SchemaOf<typeof Skylight>>).unwrap();
        },
        {},
        ['equirect'],
      ),
    ),
  );
  mountObservedControls('镜头取景', () => [
    observedField(
      'fovDegrees',
      (world.get(camera, Camera).unwrap().fov * 180) / Math.PI,
      () => (world.get(camera, Camera).unwrap().fov * 180) / Math.PI,
      (next) => {
        world.set(camera, Camera, { fov: (finiteNumber(next, 20, 100) * Math.PI) / 180 }).unwrap();
      },
    ),
  ]);
  element('advanced-controls').append(parameterPanel);
  mountCoastControls(
    [...parameterForms],
    parameterForms,
    parameterPanel,
    qualityLabel,
    manualLabel,
    hint,
  );
  refreshControlSummary = () => {
    const accepted = transaction?.before.qualitySettings ?? qualitySettings;
    const names = { low: '轻量', balanced: '均衡', high: '高', ultra: '极高', custom: '自定义' };
    const preset = transaction?.before.qualityPreset ?? qualityPreset;
    element('accepted-quality').textContent = names[preset];
    element('accepted-workload').textContent =
      `${accepted.waveCount} 波 · ${accepted.pontoonCount} 浮力 / ${accepted.contactProbeCount} 接触 · FFT ${accepted.localResolution}`;
    element('drive-status').textContent = manualDriving
      ? '手动驾驶'
      : shipNavigation.running
        ? '自动航行'
        : '惯性 / 停泊';
    const pending =
      transaction !== undefined ||
      pendingWindStrength !== undefined ||
      parameterForms.some((form) => form.pending);
    const rejected = parameterForms.find((form) => form.rejection)?.rejection;
    element('control-status').textContent = rejected
      ? '参数被拒绝 · 已读回接纳值'
      : pending
        ? '参数提交中 · 等待运行时接纳'
        : '当前参数已接纳';
    element('control-status').dataset.pending = String(pending);
    element('control-status').dataset.rejected = String(Boolean(rejected));
    element('control-status').title = rejected ?? '';
    if (pendingWindStrength === undefined && document.activeElement !== element('waves')) {
      element<HTMLInputElement>('waves').value = String(windStrength);
      element('wind-value').textContent = `${windStrength.toFixed(2)} ×`;
    }
    element('panel-fps').textContent = element('fps').textContent;
    if (!transaction) element<HTMLSelectElement>('quality').value = activeMode;
    qualitySelect.value = transaction?.before.qualityPreset ?? qualityPreset;
    manualInput.checked = manualDriving;
    const syncCheck = (id: string, value: boolean) => {
      const input = element<HTMLInputElement>(id);
      input.checked = value;
    };
    if (runtimeFormVisible(element('dimension-hull')))
      syncCheck('buoyancy-enabled', world.get(ship, WaterPontoonSet).unwrap().enabled);
    const refreshSeaControls = () => {
      if (
        runtimeFormVisible(element('dimension-sea')) &&
        document.activeElement !== element('water-color')
      ) {
        const values = observeWaterMaterial(
          requireDemoValue(modeMaterialHandles(activeMode)[0], 'active scattering material'),
        ).values;
        const picker = element<HTMLInputElement>('water-color');
        picker.disabled = Boolean(transaction) || values.scatteringPerM === undefined;
        if (values.scatteringPerM !== undefined) {
          const scattering = rgbValue(values.scatteringPerM);
          const peak = Math.max(...scattering, 0.000001);
          picker.value =
            '#' +
            scattering
              .map((channel) =>
                Math.round(Math.min(1, Math.max(0, channel / peak)) * 255)
                  .toString(16)
                  .padStart(2, '0'),
              )
              .join('');
        }
      }
    };
    refreshSeaControls();
    const refreshFoamControls = () => {
      if (runtimeFormVisible(element('dimension-foam'))) {
        const material = observeWaterMaterial(
          requireDemoValue(modeMaterialHandles(activeMode)[0], 'active foam material'),
        );
        const enabled = material.switches.waterFoam !== false;
        for (const id of ['crests-enabled', 'depth-foam-enabled'])
          element<HTMLInputElement>(id).disabled =
            Boolean(transaction) || !enabled || material.switches.waterOceanFoam !== true;
        syncCheck('contacts-enabled', world.get(ship, WaterContactProbeSet).unwrap().enabled);
        syncCheck('depth-foam-enabled', Number(material.values.sceneDepthFoamAmount) > 0);
        syncCheck(
          'crests-enabled',
          activeMode === 'R6'
            ? world.get(oceanFoam, WaterFluidSimulation).unwrap().enabled
            : Number(material.values.surfaceCrestFoamAmount) > 0,
        );
      }
    };
    refreshFoamControls();
    if (
      runtimeFormVisible(element('dimension-weather')) &&
      document.activeElement !== element('exposure')
    ) {
      const exposure = world.get(camera, Camera).unwrap().exposure;
      element<HTMLInputElement>('exposure').value = String(exposure);
      element('exposure-value').textContent = exposure.toFixed(2);
    }
    syncCheck('clouds', cloudsEnabled);
    if (runtimeFormVisible(element('dimension-weather'))) {
      const index = acceptedSkyIndex();
      const name = ['day', 'sunset', 'overcast'][index];
      if (name !== undefined) element<HTMLSelectElement>('weather').value = name;
    }
  };
  refreshControlSummary();
  element('controls-panel').addEventListener('toggle', () => refresh(), true);
  const releaseHelm = () => {
    helm.throttle = 0;
    helm.rudder = 0;
    for (const code of [
      'KeyW',
      'ArrowUp',
      'KeyS',
      'ArrowDown',
      'KeyA',
      'ArrowLeft',
      'KeyD',
      'ArrowRight',
      'Space',
    ])
      releasedHelmCodes.add(code);
  };
  window.addEventListener('blur', releaseHelm);
  element('controls-panel').addEventListener('focusin', releaseHelm);
  element('quality').addEventListener('change', releaseHelm);
  element('ship-go').addEventListener('click', () => {
    manualDriving = false;
    manualInput.checked = false;
    releaseHelm();
  });
  element('ship-stop').addEventListener('click', () => {
    manualDriving = false;
    manualInput.checked = false;
    releaseHelm();
  });
  window.addEventListener('resize', applyCamera);
  Object.assign(window, {
    __waterR8: {
      app,
      profiler,
      world,
      assets,
      ship,
      camera,
      bodies,
      zoneAsset,
      readState,
      readEntryState: () => ({
        requestedRadiusM: cannon.radiusM,
        balls: balls.map((ball) => ({
          entity: ball.entity,
          ...readIronBallParticipation(world, ball.entity, Boolean(ball.entry)),
          submerged: Boolean(ball.submerged),
          radiusM: ball.radiusM,
          visualRadiusM:
            requireDemoValue(world.get(ball.entity, Transform).unwrap().scale[0], 'ball scale') *
            IRON_BALL_RADIUS_M,
          entry: ball.entry,
          launch: ball.launch,
          primitives: physics().getCommittedColliderPrimitives?.(ball.entity),
        })),
      }),
      readRuntimeParameters,
      setMode,
      setQualityPreset: (name: WaterQualityPreset) =>
        setMode(activeMode, meshProfile, { name, settings: { ...WATER_QUALITY_PRESETS[name] } }),
      setView,
      fault,
      capture,
      startProfileCapture,
      finishProfileCapture,
      exportProfileCapture,
      downloadProfileCapture,
      errors,
      operations,
      setDiagnostics,
      setMeshProfile: (profile: keyof typeof COAST_MESH_PROFILES) => {
        if (transaction) throw new Error('A configuration is already preparing');
        if (!(profile in COAST_MESH_PROFILES)) throw new Error('Unknown coast mesh profile');
        setMode(activeMode, profile);
      },
      localSimulation: () => (requestedMode === 'R7-shallow' ? r7Simulation : localSimulation),
      setCameraPose: (pose: { eye: Vector; target: Vector }) => {
        eye = [...pose.eye];
        target = [...pose.target];
        applyCamera();
      },
    },
  });
  applyWindStrength(1);
  setView('middle');
  app.start().unwrap();
}

void main().catch((error) => {
  console.error(error);
  element('state').textContent = '启动失败';
  element('message').hidden = false;
  element('message').textContent =
    typeof error === 'object' && error !== null && 'code' in error
      ? `${String(error.code)} · ${JSON.stringify(error)}`
      : String(error);
});

import { FORGEAX_FRAME_SUBMITTED_EVENT, type BrowserFrameSubmitted } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import { AUTO_EXPOSURE_TAA_FIXTURE } from '@forgeax/apps-shared/auto-exposure-fixture';
import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { Time, Update } from '@forgeax/engine-ecs';
import { createProfiler } from '@forgeax/engine-profiler';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { Transform } from '@forgeax/engine-scene';
import {
  Camera,
  BLOOM_ENABLED,
  DirectionalLight,
  DynamicResolution,
  ANTIALIAS_TAA,
  ANTIALIAS_NONE,
  Materials,
  MeshFilter,
  MeshRenderer,
  MotionBlur,
  TONEMAP_ACES_FILMIC,
  perspective,
} from '@forgeax/engine-render';
import type { MaterialAsset, TextureAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import lutMeta from '../assets/auto-exposure-positive-lut.cube.meta.json' with { type: 'json' };

const canvas = document.querySelector<HTMLCanvasElement>('#app');
const inspection = document.querySelector<HTMLElement>('#inspection');
const pauseToggle = document.querySelector<HTMLButtonElement>('#pause-toggle');
const taaToggle = document.querySelector<HTMLButtonElement>('#taa-toggle');
const dynamicResolutionToggle = document.querySelector<HTMLButtonElement>('#dynamic-resolution-toggle');
const motionBlurToggle = document.querySelector<HTMLButtonElement>('#motion-blur-toggle');
const rendererRetry = document.querySelector<HTMLButtonElement>('#renderer-retry');
const shutterAngleInput = document.querySelector<HTMLInputElement>('#shutter-angle');
const shutterAngleValue = document.querySelector<HTMLOutputElement>('#shutter-angle-value');
const controlStatus = document.querySelector<HTMLElement>('#control-status');
const colorGradingProof = document.querySelector<HTMLElement>('#color-grading-proof');
const legendLeft = document.querySelector<HTMLElement>('#legend-left');
const legendRight = document.querySelector<HTMLElement>('#legend-right');
const params = new URLSearchParams(location.search);
const visualCase = params.get('taa-case') ?? 'moving-rigid';
const colorGradingCases = new Set([
  'exposure-adaptation-card',
  'exposure-manual-reference',
  'white-balance-card',
  'lut-output-card',
]);
const isColorGradingCase = colorGradingCases.has(visualCase);
const requestedWorkloadKind = params.get('taa-workload');
const workloadKind = requestedWorkloadKind ?? (
  visualCase === 'exposure-adaptation-card'
    ? 'auto'
    : visualCase === 'lut-output-card'
      ? 'positive-lut'
      : isColorGradingCase
        ? 'manual'
        : 'none'
);
const lightweightSmoke = new URLSearchParams(location.search).get('taa-profile') === 'ci';
const timingMode = new URLSearchParams(location.search).get('taa-timing') ?? 'off';
const timingResolutionId = new URLSearchParams(location.search).get('taa-timing-resolution') ?? '1080p';
const timingCaptureEnabled = timingMode === '1';
const requestedTemperature = Number(params.get('taa-temperature') ?? (visualCase === 'white-balance-card' ? 3200 : 6504));
const requestedTint = Number(params.get('taa-tint') ?? 0);
const colorTemperature = Number.isFinite(requestedTemperature) ? Math.min(40000, Math.max(1000, requestedTemperature)) : 6504;
const colorTint = Number.isFinite(requestedTint) ? Math.min(1, Math.max(-1, requestedTint)) : 0;
const requestedExposureMultiplier = Number(params.get('taa-exposure') ?? 1);
const manualExposureMultiplier = Number.isFinite(requestedExposureMultiplier)
  ? Math.min(64, Math.max(0.01, requestedExposureMultiplier))
  : 1;
const requestedSceneScale = Number(params.get('taa-scene-scale') ?? 1);
const sceneScale = Number.isFinite(requestedSceneScale)
  ? Math.min(16, Math.max(0.01, requestedSceneScale))
  : 1;
const dynamicResolutionRequested = params.get('taa-dynamic-resolution') === '1';
const motionBlurRequested = params.get('taa-motion-blur') === '1';
// The renderer/App assembly starts its catalog replica during createApp. In
// development it must receive the Pack-owned scoped binding at that boundary;
// configuring the registry after createApp is too late and briefly probes the
// intentionally disabled global /pack-index.json route. Production keeps the
// emitted static catalog path selected by configureRuntimeAssetCatalog below.
const runtimeDevBinding = import.meta.env.DEV ? runtimeBinding : undefined;
const timingResolution = timingResolutionId === '4K'
  ? { id: '4K', width: 3840, height: 2160 }
  : { id: '1080p', width: 1920, height: 1080 };
const isStaticCase = visualCase === 'static' || visualCase === 'reactive' || isColorGradingCase;
const isCameraPanCase = visualCase === 'camera-pan';
if (
  canvas === null ||
  inspection === null ||
  pauseToggle === null ||
  taaToggle === null ||
  dynamicResolutionToggle === null ||
  motionBlurToggle === null ||
  rendererRetry === null ||
  shutterAngleInput === null ||
  shutterAngleValue === null ||
  controlStatus === null ||
  colorGradingProof === null ||
  legendLeft === null ||
  legendRight === null
)
  throw new Error('TAA carrier elements are missing');

// The timing adapter owns the requested physical attachment size.  CSS pixels
// and devicePixelRatio remain browser-owned; setting the authored canvas size
// before App construction makes the renderer's actual surface dimensions an
// observed fact rather than a host-side label.
if (timingMode !== 'off') {
  canvas.style.width = `${timingResolution.width}px`;
  canvas.style.height = `${timingResolution.height}px`;
  canvas.width = timingResolution.width;
  canvas.height = timingResolution.height;
}
// Browser/Dawn feature evidence uses the same bounded software surface. Keep
// the workload-local capture extent identical across backends instead of
// inheriting the demo's presentation canvas (1920x1080), which would make the
// exact join reject otherwise identical fixture/frame identities.
if (timingMode === 'off' && workloadKind !== 'none' && !isColorGradingCase) {
  canvas.style.width = '200px';
  canvas.style.height = '150px';
  canvas.width = 200;
  canvas.height = 150;
}
if (timingMode === 'off' && isColorGradingCase) {
  canvas.style.width = lightweightSmoke ? '640px' : '960px';
  canvas.style.height = lightweightSmoke ? '360px' : '540px';
  canvas.width = lightweightSmoke ? 640 : 960;
  canvas.height = lightweightSmoke ? 360 : 540;
}
if (lightweightSmoke && !isColorGradingCase) {
  canvas.style.width = '256px';
  canvas.style.height = '144px';
  canvas.width = 256;
  canvas.height = 144;
}

const timingProfiler = createProfiler();

const created = await createApp(canvas, {
  ...(timingCaptureEnabled
    ? {
        gpuPassTiming: { maxPassesPerFrame: 64, maxFramesInFlight: 8, retentionFrames: 8 },
        profiler: timingProfiler,
      }
    : {}),
  ...(runtimeDevBinding === undefined ? {} : { assetRuntimeBinding: runtimeDevBinding }),
}, {
  ...forgeaxBundlerAdapter(),
  importTransport: createRuntimeAssetImportTransport(runtimeDevBinding),
});
if (!created.ok) throw created.error;
const app = created.value;
const assets = app.assets;
if (assets === undefined) throw new Error('hello-taa: runtime AssetRegistry is unavailable');
if (runtimeDevBinding === undefined) configureRuntimeAssetCatalog(assets, runtimeBinding);
const lutSubAsset = lutMeta.subAssets?.find((entry) => entry.kind === 'texture');
if (lutSubAsset === undefined) throw new Error('hello-taa: LUT sidecar has no texture sub-asset');
const parsedLutGuid = AssetGuid.parse(lutSubAsset.guid);
if (!parsedLutGuid.ok) throw parsedLutGuid.error;
const lutAssetResult = await assets.loadByGuid<TextureAsset>(parsedLutGuid.value);
if (!lutAssetResult.ok) throw lutAssetResult.error;
const lutAsset = lutAssetResult.value;
const lutGuid = assets.guidOf(lutAsset);
const lutCatalogEntry = assets.listCatalog().find((entry) => entry.guid === lutGuid);
if (lutGuid === undefined || lutCatalogEntry?.sourceKey === undefined) {
  throw new Error('hello-taa: loaded LUT is missing its authoritative Catalog sourceKey');
}
const lutHandle = workloadKind === 'positive-lut'
  ? app.world.allocSharedRef<'TextureAsset', TextureAsset>('TextureAsset', lutAsset)
  : undefined;
const lutSourceKey = lutCatalogEntry.sourceKey;
const workloadExposure = workloadKind === 'auto'
  ? { kind: 'auto' as const, fallback: 1, compensationEv: 0, rangeEv: [-8, 8] as const, rates: [3, 1] as const }
  : { kind: 'manual' as const, multiplier: manualExposureMultiplier };

// The upper row is a sharp, stationary reference. The lower row is the same
// high-contrast pattern with renderer-owned motion blur. Keeping both rows in
// one frame makes the blur readable without changing the production effect.
const cameraPanBarLayout = [
  { offset: -1.2, color: [0.95, 0.95, 0.95, 1] as const, scaleX: 0.12 },
  { offset: -0.9, color: [0.04, 0.04, 0.04, 1] as const, scaleX: 0.12 },
  { offset: -0.6, color: [0.95, 0.95, 0.95, 1] as const, scaleX: 0.12 },
  { offset: -0.3, color: [0.04, 0.04, 0.04, 1] as const, scaleX: 0.12 },
  { offset: 0, color: [0.95, 0.95, 0.95, 1] as const, scaleX: 0.12 },
  { offset: 0.3, color: [0.04, 0.04, 0.04, 1] as const, scaleX: 0.12 },
  { offset: 0.6, color: [0.95, 0.95, 0.95, 1] as const, scaleX: 0.12 },
  { offset: 0.9, color: [0.04, 0.04, 0.04, 1] as const, scaleX: 0.12 },
  { offset: 1.2, color: [0.95, 0.95, 0.95, 1] as const, scaleX: 0.12 },
] as const;
const hdrColorGradingBarLayout = [
  { offset: -1.2, color: [0.018, 0.008, 0.006, 1] as const, scaleX: 0.12, label: 'shadow' },
  { offset: -0.9, color: [0.08, 0.018, 0.01, 1] as const, scaleX: 0.12, label: 'low' },
  { offset: -0.6, color: [0.35, 0.06, 0.015, 1] as const, scaleX: 0.12, label: 'mid-low' },
  { offset: -0.3, color: [0.9, 0.16, 0.03, 1] as const, scaleX: 0.12, label: 'mid' },
  { offset: 0, color: [2, 0.42, 0.06, 1] as const, scaleX: 0.12, label: 'bright' },
  { offset: 0.3, color: [4, 1, 0.12, 1] as const, scaleX: 0.12, label: 'highlight' },
  { offset: 0.6, color: [8, 2, 0.3, 1] as const, scaleX: 0.12, label: 'specular' },
  { offset: 0.9, color: [1, 1, 1, 1] as const, scaleX: 0.12, label: 'white' },
  { offset: 1.2, color: [0.1, 0.35, 1.5, 1] as const, scaleX: 0.12, label: 'blue' },
] as const;
const barLayout = isCameraPanCase
  ? cameraPanBarLayout
  : isColorGradingCase
    ? hdrColorGradingBarLayout
    : AUTO_EXPOSURE_TAA_FIXTURE.asset.barLayout;
const caseColor = (color: readonly [number, number, number, number]) =>
  [
    color[0] * (isColorGradingCase ? sceneScale : 1),
    color[1] * (isColorGradingCase ? sceneScale : 1),
    color[2] * (isColorGradingCase ? sceneScale : 1),
    visualCase === 'reactive' ? 0.6 : color[3],
  ] as const;

const spawnBar = (
  offset: number,
  y: number,
  color: readonly [number, number, number, number],
  z = 0,
  scaleX = 0.5,
) => {
  const material = app.world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.unlit(color),
  );
  const entity = app.world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [offset, y, z],
          quat: [0, 0, 0, 1],
          // The three half-unit faces touch edge-to-edge. A temporal sample
          // can therefore cross the high-contrast colour boundaries without
          // being rejected as a background-depth sample.
          scale: [scaleX, 0.45, 1],
        },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  return entity;
};

barLayout.forEach(({ offset, color, ...layout }) => {
  spawnBar(
    offset,
    AUTO_EXPOSURE_TAA_FIXTURE.asset.transform.y,
    caseColor(color),
    AUTO_EXPOSURE_TAA_FIXTURE.asset.transform.z,
    'scaleX' in layout ? layout.scaleX : AUTO_EXPOSURE_TAA_FIXTURE.asset.transform.scale[0],
  );
});
const motionBars = barLayout.map(({ offset, color }) => ({
  entity: spawnBar(
    offset,
    -0.8,
    caseColor(color),
    visualCase === 'depth-edge' && offset === 0.5 ? 0.65 : 0,
    'scaleX' in barLayout[0] ? 0.12 : 0.5,
  ),
  offset,
}));

app.world
  .spawn({
    component: DirectionalLight,
    data: {
      direction: AUTO_EXPOSURE_TAA_FIXTURE.light.direction,
      color: AUTO_EXPOSURE_TAA_FIXTURE.light.color,
      intensity: AUTO_EXPOSURE_TAA_FIXTURE.light.intensity,
      castShadow: true,
      ...(lightweightSmoke ? { cascadeCount: 1, mapSize: 64 } : {}),
    },
  })
  .unwrap();

const cameraEntity = app.world
  .spawn(
    { component: Transform, data: { pos: AUTO_EXPOSURE_TAA_FIXTURE.camera.position, quat: AUTO_EXPOSURE_TAA_FIXTURE.camera.rotation, scale: [1, 1, 1] } },
    {
      component: Camera,
      data: {
        ...perspective({
          fov: AUTO_EXPOSURE_TAA_FIXTURE.camera.fov,
          aspect: AUTO_EXPOSURE_TAA_FIXTURE.camera.aspect,
          near: AUTO_EXPOSURE_TAA_FIXTURE.camera.near,
          far: AUTO_EXPOSURE_TAA_FIXTURE.camera.far,
          exposure: workloadExposure,
          temperature: isColorGradingCase ? colorTemperature : 6504,
          tint: isColorGradingCase ? colorTint : 0,
          colorLutStrength: workloadKind === 'positive-lut' ? 0.75 : 0,
          ...(lutHandle === undefined ? {} : { colorLut: lutHandle }),
        }),
        clearColor: AUTO_EXPOSURE_TAA_FIXTURE.clearColor,
        antialias: ANTIALIAS_TAA,
        ...(isColorGradingCase ? { tonemap: TONEMAP_ACES_FILMIC } : {}),
        ...(visualCase === 'taa-motion-blur-bloom'
          ? {
              tonemap: TONEMAP_ACES_FILMIC,
              bloom: BLOOM_ENABLED,
              bloomThreshold: 0.7,
              bloomIntensity: 0.35,
              bloomSoftKnee: 0.5,
              bloomScatter: 0.7,
            }
          : {}),
      },
    },
  )
  .unwrap();

let appPaused = false;
let taaEnabled = true;
let dynamicResolutionEnabled = false;
let motionBlurEnabled = false;
let shutterAngle = Number(shutterAngleInput.value);
const maxRadiusPixels = lightweightSmoke ? 8 : 24;

const motionBlurData = () => ({
  shutterAngle,
  maxRadiusPixels,
  sampleCount: lightweightSmoke ? 4 : 12,
});

if (dynamicResolutionRequested) {
  const result = app.world.addComponent(cameraEntity, {
    component: DynamicResolution,
    data: { targetGpuMs: 16.67, minScale: 0.67, maxScale: 0.67 },
  });
  if (!result.ok) throw result.error;
  dynamicResolutionEnabled = true;
}
if (motionBlurRequested) {
  const result = app.world.addComponent(cameraEntity, {
    component: MotionBlur,
    data: motionBlurData(),
  });
  if (!result.ok) throw result.error;
  motionBlurEnabled = true;
}

const updateColorGradingProof = (
  renderInspection: ReturnType<typeof app.renderer.inspect>,
) => {
  if (!isColorGradingCase) {
    colorGradingProof.hidden = true;
    return;
  }
  const autoExposure = renderInspection.output.autoExposure;
  const standardLut = renderInspection.output.standardLut;
  const lutState = workloadKind !== 'positive-lut'
    ? 'off'
    : standardLut === undefined || standardLut.resident === null
      ? 'waiting for committed resident texture'
      : `${standardLut.sourceKey} / generation ${standardLut.targetGeneration} / frame ${standardLut.receipt.frameId}`;
  const exposureState = autoExposure === undefined
    ? workloadKind === 'auto' ? 'waiting for renderer receipt' : 'manual control'
    : `target ${autoExposure.targetGeneration} / frame ${autoExposure.receipt.frameId} / committed ${autoExposure.receipt.committed}`;
  colorGradingProof.hidden = false;
  colorGradingProof.textContent = [
    `case: ${visualCase}`,
    `input: linear-HDR chart (${(0.018 * sceneScale).toFixed(3)} .. ${(8 * sceneScale).toFixed(2)}) | scene scale ${sceneScale.toFixed(2)}x`,
    'pipeline: linear-HDR → linear-LDR → final-sRGB',
    `ACES tone map: enabled | exposure: ${workloadKind === 'auto' ? 'auto' : `manual ${manualExposureMultiplier.toFixed(2)}x`} | ${exposureState}`,
    `white balance: ${colorTemperature}K | tint ${colorTint.toFixed(2)}`,
    `LUT: ${lutState}`,
    `stages: ${renderInspection.perFramePassNames.filter((name) => name.includes('exposure') || name.includes('lut') || name.includes('output')).join(', ') || 'inspection pending'}`,
  ].join('\n');
};

const readMotionBlurParams = () => {
  const result = app.world.get(cameraEntity, MotionBlur);
  if (!result.ok) return undefined;
  return result.value;
};

const updateControlLabels = () => {
  pauseToggle.textContent = appPaused ? 'Resume' : 'Pause';
  pauseToggle.setAttribute('aria-pressed', String(appPaused));
  taaToggle.textContent = `TAA: ${taaEnabled ? 'On' : 'Off'}`;
  taaToggle.setAttribute('aria-pressed', String(taaEnabled));
  dynamicResolutionToggle.textContent = `Dynamic Resolution: ${dynamicResolutionEnabled ? 'On (0.67)' : 'Off'}`;
  dynamicResolutionToggle.setAttribute('aria-pressed', String(dynamicResolutionEnabled));
  motionBlurToggle.textContent = `Motion Blur: ${motionBlurEnabled ? 'On' : 'Off'}`;
  motionBlurToggle.setAttribute('aria-pressed', String(motionBlurEnabled));
  shutterAngleValue.textContent = `${shutterAngle}°`;
  controlStatus.textContent = isColorGradingCase
    ? `${appPaused ? 'Paused' : 'Running'} | ${visualCase} | ACES | ${colorTemperature}K / tint ${colorTint.toFixed(2)}`
    : `${appPaused ? 'Paused' : 'Running'} | TAA ${taaEnabled ? 'On' : 'Off'} | Dynamic Resolution ${dynamicResolutionEnabled ? '0.67' : 'Off'} | Motion Blur ${motionBlurEnabled ? 'On' : 'Off'}`;
  legendLeft.textContent = isColorGradingCase ? 'LINEAR HDR INPUT | HIGH-DYNAMIC-RANGE COLOR CHART' : 'TAA / TAAU WITNESS';
  legendRight.textContent = isColorGradingCase ? 'FINAL sRGB OUTPUT | ACES + COLOR GRADING' : 'MOTION BLUR IS AN INDEPENDENT TOGGLE';
};

pauseToggle.addEventListener('click', () => {
  const result = appPaused ? app.resume() : app.pause();
  if (!result.ok) {
    console.error(`[hello-taa] could not ${appPaused ? 'resume' : 'pause'} App: ${result.error.code}`);
    return;
  }
  appPaused = !appPaused;
  updateControlLabels();
  updateInspection();
});

taaToggle.addEventListener('click', () => {
  const nextEnabled = !taaEnabled;
  if (!nextEnabled && dynamicResolutionEnabled) {
    const removed = app.world.removeComponent(cameraEntity, DynamicResolution);
    if (!removed.ok) {
      console.error(`[hello-taa] could not remove Dynamic Resolution before disabling TAA: ${removed.error.code}`);
      return;
    }
    dynamicResolutionEnabled = false;
  }
  const result = app.world.set(cameraEntity, Camera, {
    antialias: nextEnabled ? ANTIALIAS_TAA : ANTIALIAS_NONE,
  });
  if (!result.ok) {
    console.error(`[hello-taa] could not toggle TAA: ${result.error.code}`);
    return;
  }
  taaEnabled = nextEnabled;
  updateControlLabels();
  updateInspection();
});

dynamicResolutionToggle.addEventListener('click', () => {
  const nextEnabled = !dynamicResolutionEnabled;
  if (nextEnabled && !taaEnabled) {
    console.error('[hello-taa] Dynamic Resolution requires TAA; enable TAA before retrying');
    return;
  }
  const result = nextEnabled
    ? app.world.addComponent(cameraEntity, {
        component: DynamicResolution,
        data: { targetGpuMs: 16.67, minScale: 0.67, maxScale: 0.67 },
      })
    : app.world.removeComponent(cameraEntity, DynamicResolution);
  if (!result.ok) {
    console.error(`[hello-taa] could not toggle Dynamic Resolution: ${result.error.code}`);
    return;
  }
  dynamicResolutionEnabled = nextEnabled;
  updateControlLabels();
  updateInspection();
});

motionBlurToggle.addEventListener('click', () => {
  const nextEnabled = !motionBlurEnabled;
  const result = nextEnabled
    ? app.world.addComponent(cameraEntity, {
        component: MotionBlur,
        data: motionBlurData(),
      })
    : app.world.removeComponent(cameraEntity, MotionBlur);
  if (!result.ok) {
    console.error(`[hello-taa] could not toggle Motion Blur: ${result.error.code}`);
    return;
  }
  motionBlurEnabled = nextEnabled;
  updateControlLabels();
  updateInspection();
});

shutterAngleInput.addEventListener('input', () => {
  shutterAngle = Number(shutterAngleInput.value);
  if (motionBlurEnabled) {
    const result = app.world.set(cameraEntity, MotionBlur, motionBlurData());
    if (!result.ok) {
      console.error(`[hello-taa] could not update Motion Blur: ${result.error.code}`);
      return;
    }
  }
  updateControlLabels();
  updateInspection();
});

rendererRetry.addEventListener('click', () => {
  void app.renderer.recover().then((result) => {
    if (!result.ok) console.error(`[hello-taa] renderer recovery unavailable: ${result.error.code}`);
    updateInspection();
  });
});

// A dt-based speed keeps the comparison stable across refresh rates. At 60 Hz
// this is about 0.12 world units (roughly 14–18 canvas pixels) per frame: a
// readable streak rather than a full-frame jump. The motion is deliberately
// authored in the scene so the renderer's temporal producer is the only
// history owner.
let horizontalPosition = 0;
let horizontalDirection = 1;
const motionSpeedUnitsPerSecond = 7.2;
let visualFrame = 0;
type FrameDomainMetadata = {
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly backendId?: string;
  readonly format: string;
  readonly graphGeneration: number;
  readonly textureIdentity: number;
  readonly readbackIdentity: number;
  readonly width: number;
  readonly height: number;
  readonly bytesPerRow: number;
  readonly footprint: { readonly resourceCount: number; readonly bindGroupCount: number };
};

type ObservationChannelSummary = {
  readonly min: number;
  readonly max: number;
  readonly mean: number;
};

type ObservationSummary = {
  readonly sampleCount: number;
  readonly finite: boolean;
  readonly channels: {
    readonly r: ObservationChannelSummary;
    readonly g: ObservationChannelSummary;
    readonly b: ObservationChannelSummary;
    readonly a: ObservationChannelSummary;
  };
  readonly luminance: {
    readonly min: number;
    readonly max: number;
    readonly mean: number;
    readonly positiveMin: number | null;
    readonly dynamicRange: number | null;
  };
};

const FEATURE_FRAME_WINDOW = 60;
const TIMING_FRAME_WINDOW = 420;
const stageObservationEnabled = isColorGradingCase || workloadKind === 'auto' || workloadKind === 'positive-lut';
const submittedFrameIds: number[] = [];
const footprintSamples: {
  readonly frameId: number;
  readonly liveByteLength: number;
  readonly liveResourceCount: number;
  readonly allocationCount: number;
  readonly peakLiveCount: number;
  readonly mapCount: number;
  readonly readbackCount: number;
}[] = [];
let observationQueue: Promise<void> = Promise.resolve();
const EMPTY_SEQUENCE_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
let frameSequenceSha256 = EMPTY_SEQUENCE_SHA256;
let frameSequenceReadyCount = 0;
let frameSequenceRequest = 0;
let finalObservationRequested = false;

type TimingState = {
  status: 'disabled' | 'running' | 'ready' | 'blocked';
  workload: string;
  resolution: { readonly id: string; readonly width: number; readonly height: number };
  frames: unknown[];
  error?: string;
  manual?: {
    readonly executed: boolean;
    readonly zeroCost: boolean;
    readonly timestampSlots: number;
    readonly receipt: { readonly frameId: number };
  };
};

const timingState: TimingState = {
  status: timingMode === 'off' ? 'disabled' : timingCaptureEnabled ? 'running' : 'ready',
  workload: workloadKind,
  resolution: timingResolution,
  frames: [],
};
let timingObservationQueue: Promise<void> = Promise.resolve();

let browserObservation:
  | {
      readonly receiptFrame: number;
      readonly stages: readonly {
        readonly id: string;
        readonly domain: string;
        readonly readback: { readonly rawHash: string; readonly frame: number };
        readonly metadata: FrameDomainMetadata;
        readonly summary: ObservationSummary;
      }[];
      readonly frameIdentity: {
        readonly first: number;
        readonly last: number;
        readonly count: number;
        readonly contiguous: boolean;
        readonly sequenceSha256: string;
      };
      readonly resourceGrowth?: {
        readonly stableFrames: number;
        readonly byteLengthDelta: number;
        readonly bindGroupDelta: number;
        readonly resourceCountDelta: number;
        readonly liveResourceDelta: number;
        readonly allocationCount: number;
        readonly peakLiveCount: number;
        readonly mapCount: number;
        readonly readbackCount: number;
      };
      readonly error?: string;
    }
  | undefined;

async function hashBytes(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', input.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function decodeFloat16(bits: number): number {
  const sign = (bits & 0x8000) === 0 ? 1 : -1;
  const exponent = (bits >>> 10) & 0x1f;
  const fraction = bits & 0x03ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function channelSummary(values: readonly number[]): ObservationChannelSummary {
  if (values.length === 0) return { min: Number.NaN, max: Number.NaN, mean: Number.NaN };
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const value of values) {
    min = Math.min(min, value);
    max = Math.max(max, value);
    sum += value;
  }
  return { min, max, mean: sum / values.length };
}

function summarizeObservation(observation: {
  readonly bytes: Uint8Array;
  readonly metadata: FrameDomainMetadata;
}): ObservationSummary {
  const { bytes, metadata } = observation;
  const width = metadata.width;
  const height = metadata.height;
  const bytesPerPixel = metadata.format === 'rgba16float' ? 8 : 4;
  const sampleStep = Math.max(1, Math.ceil(Math.sqrt((width * height) / 4096)));
  const red: number[] = [];
  const green: number[] = [];
  const blue: number[] = [];
  const alpha: number[] = [];
  const luminance: number[] = [];
  let finite = true;
  for (let y = 0; y < height; y += sampleStep) {
    for (let x = 0; x < width; x += sampleStep) {
      const offset = y * metadata.bytesPerRow + x * bytesPerPixel;
      if (offset < 0 || offset + bytesPerPixel > bytes.byteLength) continue;
      let r: number;
      let g: number;
      let b: number;
      let a: number;
      if (metadata.format === 'rgba16float') {
        const view = new DataView(bytes.buffer, bytes.byteOffset + offset, bytesPerPixel);
        r = decodeFloat16(view.getUint16(0, true));
        g = decodeFloat16(view.getUint16(2, true));
        b = decodeFloat16(view.getUint16(4, true));
        a = decodeFloat16(view.getUint16(6, true));
      } else {
        // The final attachment is normally BGRA8.  Keep the reorder explicit,
        // while accepting an RGBA8 readback for null/software surfaces.
        const bgra = metadata.format.startsWith('bgra');
        r = (bytes[offset + (bgra ? 2 : 0)] ?? 0) / 255;
        g = (bytes[offset + 1] ?? 0) / 255;
        b = (bytes[offset + (bgra ? 0 : 2)] ?? 0) / 255;
        a = (bytes[offset + 3] ?? 0) / 255;
      }
      const samples = [r, g, b, a];
      if (samples.some((value) => !Number.isFinite(value))) finite = false;
      red.push(r);
      green.push(g);
      blue.push(b);
      alpha.push(a);
      luminance.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
    }
  }
  const luminanceSummary = channelSummary(luminance);
  const positive = luminance.filter((value) => Number.isFinite(value) && value > 0);
  const positiveMin = positive.length === 0 ? null : Math.min(...positive);
  return {
    sampleCount: luminance.length,
    finite: finite && luminance.length > 0,
    channels: {
      r: channelSummary(red),
      g: channelSummary(green),
      b: channelSummary(blue),
      a: channelSummary(alpha),
    },
    luminance: {
      ...luminanceSummary,
      positiveMin,
      dynamicRange:
        positiveMin === null || !Number.isFinite(luminanceSummary.max)
          ? null
          : luminanceSummary.max / Math.max(positiveMin, Number.EPSILON),
    },
  };
}

function frameWindow() {
  const first = submittedFrameIds[0];
  const last = submittedFrameIds.at(-1);
  return {
    first: first ?? -1,
    last: last ?? -1,
    count: submittedFrameIds.length,
    sequenceSha256:
      frameSequenceReadyCount === submittedFrameIds.length ? frameSequenceSha256 : EMPTY_SEQUENCE_SHA256,
    contiguous:
      first !== undefined &&
      submittedFrameIds.length > 0 &&
      submittedFrameIds.every((frameId, index) => {
        if (index === 0) return true;
        const previous = submittedFrameIds[index - 1];
        return previous !== undefined && frameId === previous + 1;
      }),
  };
}

function refreshFrameSequenceDigest(): void {
  const request = ++frameSequenceRequest;
  const count = submittedFrameIds.length;
  void hashBytes(new TextEncoder().encode(JSON.stringify(submittedFrameIds))).then((digest) => {
    if (request !== frameSequenceRequest) return;
    frameSequenceSha256 = digest;
    frameSequenceReadyCount = count;
    updateInspection();
  });
}

function resourceGrowth() {
  const first = footprintSamples[0];
  const last = footprintSamples.at(-1);
  if (first === undefined || last === undefined) return undefined;
  return {
    stableFrames: footprintSamples.length,
    byteLengthDelta: last.liveByteLength - first.liveByteLength,
    bindGroupDelta: 0,
    resourceCountDelta: last.liveResourceCount - first.liveResourceCount,
    liveResourceDelta: last.liveResourceCount - first.liveResourceCount,
    allocationCount: last.allocationCount,
    peakLiveCount: last.peakLiveCount,
    mapCount: last.mapCount,
    readbackCount: last.readbackCount,
  };
}

function recordResourceSample(frameId: number, renderInspection: ReturnType<typeof app.renderer.inspect>): void {
  const stats = renderInspection.observation.resourceStats;
  if (stats === undefined) return;
  const sample = {
    frameId,
    liveByteLength: stats.liveByteLength,
    liveResourceCount: stats.liveCount,
    allocationCount: stats.allocationCount,
    peakLiveCount: stats.peakLiveCount,
    mapCount: stats.mapCount,
    readbackCount: stats.readbackCount,
  };
  const index = footprintSamples.findIndex((entry) => entry.frameId === frameId);
  if (index >= 0) footprintSamples[index] = sample;
  else footprintSamples.push(sample);
  footprintSamples.sort((left, right) => left.frameId - right.frameId);
}

function isSubmittedReceipt(value: unknown): value is Parameters<typeof app.renderer.observe>[0] {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { readonly frameId?: unknown; readonly deviceGeneration?: unknown; readonly completed?: unknown };
  return (
    Number.isSafeInteger(candidate.frameId) &&
    (candidate.frameId as number) >= 0 &&
    Number.isSafeInteger(candidate.deviceGeneration) &&
    (candidate.deviceGeneration as number) >= 0 &&
    candidate.completed !== null &&
    (typeof candidate.completed === 'object' || typeof candidate.completed === 'function') &&
    typeof (candidate.completed as { then?: unknown }).then === 'function'
  );
}

function enqueueSubmittedReceipt(receipt: Parameters<typeof app.renderer.observe>[0]): void {
  const receiptWindow = timingCaptureEnabled ? TIMING_FRAME_WINDOW : FEATURE_FRAME_WINDOW;
  if (submittedFrameIds.length >= receiptWindow) return;
  submittedFrameIds.push(receipt.frameId);
  refreshFrameSequenceDigest();
  const inspection = app.renderer.inspect();
  recordResourceSample(receipt.frameId, inspection);
  if (timingMode !== 'off' && !timingCaptureEnabled && timingState.manual === undefined) {
    timingState.manual = {
      executed: true,
      zeroCost: true,
      timestampSlots: 0,
      receipt: { frameId: receipt.frameId },
    };
    timingState.status = 'ready';
  }
  if (timingCaptureEnabled) {
    timingObservationQueue = timingObservationQueue
      .then(async () => {
        const completed = await receipt.completed;
        if (!completed.ok) {
          timingState.status = 'blocked';
          timingState.error = completed.error.code;
          updateInspection();
          return;
        }
        const observed = await app.renderer.observe(receipt, { include: ['timings'] });
        if (!observed.ok) {
          timingState.status = 'blocked';
          timingState.error = observed.error.code;
          updateInspection();
          return;
        }
        const timings = observed.value.timings;
        if (timings === undefined || timings.status !== 'complete') {
          timingState.status = 'blocked';
          timingState.error =
            timings === undefined
              ? 'renderer-timing-unavailable'
              : timings.status === 'failed'
                ? timings.error.code
                : timings.status === 'partial'
                  ? timings.reason.code
                  : timings.reason.code;
          updateInspection();
          return;
        }
        timingState.frames.push(timings.frame);
        if (timingState.frames.length >= TIMING_FRAME_WINDOW) timingState.status = 'ready';
        updateInspection();
      })
      .catch((cause: unknown) => {
        timingState.status = 'blocked';
        timingState.error = cause instanceof Error ? cause.message : String(cause);
        updateInspection();
      });
  }
  if (
    timingMode === 'off' &&
    stageObservationEnabled &&
    submittedFrameIds.length === FEATURE_FRAME_WINDOW - 1 &&
    !finalObservationRequested
  ) {
    const requested = app.renderer.requestObservation?.([
      'linear-hdr',
      'linear-ldr',
      'final-display',
    ]);
    if (requested === undefined || !requested.ok) {
      browserObservation = {
        receiptFrame: receipt.frameId,
        stages: [],
        frameIdentity: frameWindow(),
        error: requested === undefined ? 'observation-request-unavailable' : requested.error.code,
      };
    } else {
      finalObservationRequested = true;
    }
  }
  if (
    timingMode === 'off' &&
    stageObservationEnabled &&
    finalObservationRequested &&
    submittedFrameIds.length === FEATURE_FRAME_WINDOW
  ) {
    observationQueue = observationQueue.then(() => observeSubmittedReceipt(receipt));
  }
}

async function observeSubmittedReceipt(
  receipt: Parameters<typeof app.renderer.observe>[0],
): Promise<void> {
  if (browserObservation?.error !== undefined) return;
  try {
    const completed = await receipt.completed;
    if (!completed.ok) {
      browserObservation = { receiptFrame: receipt.frameId, stages: [], frameIdentity: frameWindow(), error: completed.error.code };
      return;
    }
    const observed = await app.renderer.observe(receipt, {
      include: ['linear-hdr', 'linear-ldr', 'final-display'],
    });
    if (!observed.ok) {
      browserObservation = { receiptFrame: receipt.frameId, stages: [], frameIdentity: frameWindow(), error: observed.error.code };
      return;
    }
    const observations = observed.value.observations ?? [];
    const stages = await Promise.all(
      observations.map(async (observation) => ({
        id: observation.domain,
        domain: observation.domain,
        readback: {
          rawHash: await hashBytes(observation.bytes),
          frame: observation.metadata.frameId,
        },
        metadata: observation.metadata,
        summary: summarizeObservation(observation),
      })),
    );
    recordResourceSample(receipt.frameId, app.renderer.inspect());
    const growth = resourceGrowth();
    browserObservation = {
      receiptFrame: receipt.frameId,
      stages,
      frameIdentity: frameWindow(),
      ...(growth === undefined ? {} : { resourceGrowth: growth }),
    };
  } catch (cause) {
    browserObservation = {
      receiptFrame: receipt.frameId,
      stages: [],
      frameIdentity: frameWindow(),
      error: cause instanceof Error ? cause.message : String(cause),
    };
  } finally {
    updateInspection();
  }
}

app.world
  .addSystem(Update, {
    name: 'taa-carrier-horizontal-motion',
    queries: [],
    fn: (world) => {
      const deltaSeconds = Math.min(world.getResource(Time).delta, 1 / 20);
      visualFrame += 1;
      if (visualCase === 'cut-reset' && visualFrame === 90) horizontalPosition = -1.1;
      if (!isStaticCase) {
        horizontalPosition += horizontalDirection * motionSpeedUnitsPerSecond * deltaSeconds;
      }
      if (horizontalPosition >= 1.25 || horizontalPosition <= -1.25) {
        horizontalDirection *= -1;
        horizontalPosition = Math.max(-1.25, Math.min(1.25, horizontalPosition));
      }
      if (isCameraPanCase) {
        app.world.set(cameraEntity, Transform, {
          pos: [horizontalPosition * 0.35, 0, 2.5],
        });
      } else {
        for (const { entity, offset } of motionBars) {
          app.world.set(entity, Transform, {
            pos: [horizontalPosition + offset, -0.8, visualCase === 'depth-edge' && offset === 0.5 ? 0.65 : 0],
          });
        }
      }
    },
  })
  .unwrap();

const updateInspection = () => {
  const renderInspection = app.renderer.inspect();
  const observedResourceGrowth = resourceGrowth();
  const motionBlurParams = readMotionBlurParams();
  const temporalTargetDescriptor = renderInspection.temporalTarget?.descriptor;
  const standardLut = renderInspection.output.standardLut;
  const lutReceipt =
    workloadKind === 'positive-lut' &&
    standardLut !== undefined &&
    standardLut.resident !== null &&
    standardLut.sourceKey === lutSourceKey
      ? {
          // This is the renderer-owned generation, not the runtime asset
          // scope generation. Keep the receipt blocked until the same
          // submitted LUT state is resident and committed.
          generation: standardLut.targetGeneration,
          deviceEpoch: standardLut.deviceEpoch,
          frameId: standardLut.receipt.frameId,
          committed: standardLut.receipt.committed,
          resident: standardLut.resident,
          sourceKey: standardLut.sourceKey,
        }
      : null;
  updateColorGradingProof(renderInspection);
  inspection.textContent = JSON.stringify({
    paused: appPaused,
    antialias: taaEnabled ? 'taa' : 'none',
    taa: {
      enabled: taaEnabled,
      historyOwner: 'renderer-temporal',
      independentFromMotionBlur: true,
    },
    dynamicResolution: {
      enabled: dynamicResolutionEnabled,
      contract: 'fixed-scale',
      scale: dynamicResolutionEnabled ? 0.67 : 1,
      output: { width: canvas.width, height: canvas.height },
      internal: !dynamicResolutionEnabled || temporalTargetDescriptor === undefined
        ? null
        : {
            width: temporalTargetDescriptor.width,
            height: temporalTargetDescriptor.height,
          },
      coverageProducer:
        dynamicResolutionEnabled && renderInspection.perFramePassNames.includes('standard-scene-coverage'),
      status: dynamicResolutionEnabled ? renderInspection.dynamicResolution?.status ?? 'warming' : 'off',
    },
    recovery: {
      state: renderInspection.state,
      recoverable: renderInspection.state === 'device-lost',
      phase: renderInspection.recovery.phase,
      lastOutcome: renderInspection.recovery.lastOutcome,
    },
    backend: renderInspection.capabilities.backendKind,
    capabilities: {
      compute: renderInspection.capabilities.compute,
      storageBuffer: renderInspection.capabilities.storageBuffer,
      rgba16floatRenderable: renderInspection.capabilities.rgba16floatRenderable,
      timestampQuery: renderInspection.capabilities.timestampQuery,
      timestampPeriodNanoseconds: renderInspection.capabilities.timestampPeriodNanoseconds,
    },
    timing:
      timingMode === 'off'
        ? null
        : {
            status: timingState.status,
            workload: timingState.workload,
            resolution: timingState.resolution,
            // Keep the live inspection payload bounded while a 420-frame
            // capture is in flight.  The producer needs the complete raw
            // receipt array only after the terminal ready/blocked state; the
            // per-frame count remains available for the browser wait gate.
            frames: timingState.status === 'running' ? [] : timingState.frames,
            frameCount: timingState.frames.length,
            capability: {
              timestampQuery: renderInspection.capabilities.timestampQuery === true,
              timestampPeriodNanoseconds: renderInspection.capabilities.timestampPeriodNanoseconds ?? null,
            },
            ...(timingState.error === undefined ? {} : { error: timingState.error }),
            ...(timingState.manual === undefined ? {} : { manual: timingState.manual }),
          },
    frame: renderInspection.frame,
    temporal:
      renderInspection.temporal === undefined
        ? null
        : {
            status: renderInspection.temporal.status,
            historyValid: renderInspection.temporal.historyValid,
            historyAttempt: renderInspection.temporal.historyAttempt,
            epoch: renderInspection.temporal.epoch,
          },
    temporalTarget: renderInspection.temporalTarget ?? null,
    motionBlur: {
      enabled:
        motionBlurParams !== undefined &&
        motionBlurParams.shutterAngle > 0 &&
        motionBlurParams.maxRadiusPixels > 0,
      shutterAngle: motionBlurParams?.shutterAngle ?? 0,
      maxRadiusPixels: motionBlurParams?.maxRadiusPixels ?? 0,
      sampleCount: motionBlurParams?.sampleCount ?? 0,
      targetFps: motionBlurParams?.targetFps ?? 60,
      effectiveSampleCount: renderInspection.motionBlur?.effectiveSampleCount ?? null,
      lane: renderInspection.motionBlur?.lane ?? null,
      passCount: renderInspection.motionBlur?.passCount ?? null,
      tapBudget: renderInspection.motionBlur?.tapBudget ?? null,
      resetReason: renderInspection.motionBlur?.resetReason ?? null,
      lastFailure: renderInspection.motionBlur?.lastFailure ?? null,
      demoMotionSpeed: `${motionSpeedUnitsPerSecond} world units/s (dt-based)`,
      status: motionBlurEnabled ? (renderInspection.motionBlur?.status ?? null) : 'off',
      temporalDemand: motionBlurEnabled
        ? (renderInspection.motionBlur?.temporalDemand ?? null)
        : null,
      historyWrites: renderInspection.motionBlur?.historyWrites ?? 0,
    },
    workload: {
      kind: workloadKind,
      executed: workloadKind !== 'none',
      exposureMode: workloadExposure.kind,
      colorLutStrength: workloadKind === 'positive-lut' ? 0.75 : 0,
      sourceKey: workloadKind === 'positive-lut' ? lutSourceKey : null,
      catalogProvenance:
        workloadKind === 'positive-lut' ? { guid: lutGuid, sourceKey: lutSourceKey } : null,
      autoExposure: renderInspection.output.autoExposure ?? null,
      lutReceipt,
      frameGeneration: browserObservation?.receiptFrame ?? renderInspection.frame.frameId,
      frameIdentity: browserObservation?.frameIdentity ?? frameWindow(),
      resourceGrowth: browserObservation?.resourceGrowth ?? (workloadKind === 'none' ? null : observedResourceGrowth ?? null),
    },
    visualProof: isColorGradingCase
      ? {
          case: visualCase,
        input: {
          colorSpace: 'linear-HDR',
          minimumLinearValue: 0.018 * sceneScale,
          maximumLinearValue: 8 * sceneScale,
          chartBars: hdrColorGradingBarLayout.map(({ label, color }) => ({
            label,
            color: [color[0] * sceneScale, color[1] * sceneScale, color[2] * sceneScale, color[3]],
          })),
        },
          pipeline: ['linear-HDR', 'linear-LDR', 'final-sRGB'],
        toneMap: 'ACES filmic',
        sceneScale,
          whiteBalance: { temperature: colorTemperature, tint: colorTint },
          lut: workloadKind === 'positive-lut'
            ? { sourceKey: lutSourceKey, strength: 0.75, receipt: lutReceipt }
            : { sourceKey: null, strength: 0, receipt: null },
        }
      : null,
    observations: browserObservation?.stages ?? [],
    observationError: browserObservation?.error ?? null,
    scene: {
      fullRebuilds: renderInspection.renderScene.fullRebuilds,
      deltaFrames: renderInspection.renderScene.deltaFrames,
      transformUpdates: renderInspection.renderScene.transformUpdates,
      projectionRecords: renderInspection.renderScene.projectionRecords,
      lastResyncReason: renderInspection.renderScene.lastResyncReason ?? null,
    },
    passes: renderInspection.perFramePassNames,
  });
};

canvas.addEventListener(FORGEAX_FRAME_SUBMITTED_EVENT, (event) => {
  const detail = (event as CustomEvent<BrowserFrameSubmitted>).detail;
  if (detail === null || typeof detail !== 'object' || !isSubmittedReceipt(detail.receipt)) return;
  enqueueSubmittedReceipt(detail.receipt);
  updateInspection();
});

app.renderer.subscribe((event) => {
  if (event.kind === 'error') {
    const detail = 'detail' in event.error ? event.error.detail : undefined;
    const detailText = detail === undefined ? '' : ` ${JSON.stringify(detail)}`;
    console.error(`[hello-taa] renderer error ${event.error.code}${detailText}`);
  }
});

// The initial snapshot is intentionally allowed to have no frame passes; the
// App-owned browser signal replaces it after the first real submitted receipt.
updateInspection();
updateControlLabels();
if (timingCaptureEnabled) {
  const started = timingProfiler?.startCapture({ frameLimit: TIMING_FRAME_WINDOW, eventLimit: 65_536 });
  if (started === undefined || !started.ok) {
    timingState.status = 'blocked';
    timingState.error = started === undefined ? 'profiler-unavailable' : started.error.code;
    updateInspection();
  }
}
app.start().unwrap();

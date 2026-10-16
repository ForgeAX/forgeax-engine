import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  configureRuntimeAssetCatalog,
  createRuntimeAssetImportTransport,
  runtimeBinding,
} from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine-app/browser';
import {
  createBoxGeometry,
  createPlaneGeometry,
  createTeapotGeometry,
} from '@forgeax/engine-geometry';
import { quat } from '@forgeax/engine-math';
import {
  ANTIALIAS_FXAA,
  BLOOM_DISABLED,
  Camera,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
  ShadowParticipation,
  Skylight,
  TONEMAP_NEUTRAL,
  VolumetricFog,
} from '@forgeax/engine-render';
import { ChildOf, Transform } from '@forgeax/engine-scene';
import { Skin, skinningPlugin } from '@forgeax/engine-skinning';
import type {
  Handle,
  MaterialAsset,
  MeshAsset,
  SceneAsset,
  TextureAsset,
} from '@forgeax/engine-types';
import { deriveOfficialScenePose } from './scene-pose';
import { spawnVolumetricSpot } from './spot-demo';
import { volumetricDensityLoader } from './volumetric-density-importer';

const DENSITY_GUID = '019f0000-0000-7000-8000-0000000003f1';
const PROJECTOR_GUID = '019f0000-0000-7000-8000-0000000003f2';
const FOX_SCENE_GUID = '019eb2ce-6232-74a0-8da7-00be6d2f8774';
const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('volumetric-fog: missing canvas');
const searchParams = new URLSearchParams(location.search);
const variant = searchParams.get('variant') ?? 'baseline';
const captureTimeRaw = searchParams.get('captureTime');
const captureOrdinalRaw = searchParams.get('captureOrdinal');
const captureTime = captureTimeRaw === null ? undefined : Number(captureTimeRaw);
const captureOrdinal = captureOrdinalRaw === null ? 0 : Number(captureOrdinalRaw);
if (captureTimeRaw !== null && !Number.isFinite(captureTime)) {
  throw new Error('volumetric-fog captureTime must be a finite number');
}
if (!Number.isInteger(captureOrdinal) || captureOrdinal < 0) {
  throw new Error('volumetric-fog captureOrdinal must be a non-negative integer');
}
const scenePose = captureTime === undefined ? undefined : deriveOfficialScenePose(captureTime);
const benchmark = new URLSearchParams(location.search).get('bench') === '1';
const diagnosticNoShadow = variant === 'diagnostic-no-shadow';
const shadowOff = variant === 'shadow-off';
const pointOff = variant === 'point-off';
const spotOff = variant === 'spot-off';
const diagnosticColumnNoShadow = variant === 'column-no-shadow';
const diagnosticOccluderNoShadow = variant === 'diagnostic-occluder-no-shadow';
const uniformDensityNoShadow = variant === 'uniform-density-no-shadow';
const diagnosticCeilingOnlyNoVolume = variant === 'diagnostic-ceiling-only-no-volume';
const diagnosticCeilingOccluderNoVolume = variant === 'diagnostic-ceiling-occluder-no-volume';
const diagnosticOccluderNoShadowNoVolume = variant === 'diagnostic-occluder-no-shadow-no-volume';
const volumeDisabled =
  variant === 'disable-volume' ||
  diagnosticCeilingOnlyNoVolume ||
  diagnosticCeilingOccluderNoVolume ||
  diagnosticOccluderNoShadowNoVolume;

const result = await createApp(
  canvas,
  { plugins: [skinningPlugin()] },
  {
    ...forgeaxBundlerAdapter(),
    importTransport: createRuntimeAssetImportTransport(runtimeBinding),
  },
);
if (!result.ok) {
  const reason = result.error instanceof Error ? result.error.message : String(result.error);
  throw new Error(`volumetric-fog bootstrap failed: ${reason}`);
}
const app = result.value;
const rendererErrors: Array<{
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail: unknown;
}> = [];
app.renderer.subscribe((event) => {
  if (event.kind !== 'error') return;
  rendererErrors.push({
    code: event.error.code,
    expected: event.error.expected,
    hint: event.error.hint,
    detail: 'detail' in event.error ? event.error.detail : null,
  });
});
const assets = app.assets;
if (assets === undefined) throw new Error('volumetric-fog asset registry unavailable');
assets.loaders.register(volumetricDensityLoader());
configureRuntimeAssetCatalog(assets, runtimeBinding);
let foxSkinEntityCount = 0;
if (variant === 'transparent-subject') {
  const foxSceneResult = await assets.loadByGuid<SceneAsset>(assets.parseGuid(FOX_SCENE_GUID));
  if (!foxSceneResult.ok) {
    throw new Error(`volumetric-fog Fox scene load failed: ${foxSceneResult.error.code}`);
  }
  const foxSceneHandle = app.world.allocSharedRef('SceneAsset', foxSceneResult.value);
  const foxInstance = assets.instantiate(foxSceneHandle, app.world);
  if (!foxInstance.ok) {
    throw new Error(`volumetric-fog Fox scene instantiate failed: ${foxInstance.error.code}`);
  }
  const foxRig = app.world
    .spawn({
      component: Transform,
      data: { pos: [-2.5, -1.4, 0], quat: [0, 0, 0, 1], scale: [0.02, 0.02, 0.02] },
    })
    .unwrap();
  app.world
    .addComponent(foxInstance.value, { component: ChildOf, data: { parent: foxRig } })
    .unwrap();
  foxSkinEntityCount = Array.from(app.world.query({ read: [Skin] }).unwrap()).length;
  if (foxSkinEntityCount === 0) {
    throw new Error('volumetric-fog Fox scene has no instantiated Skin component');
  }
}
const densityGuid = assets.parseGuid(DENSITY_GUID);
const densityResult = await assets.loadByGuid<TextureAsset>(densityGuid);
if (!densityResult.ok)
  throw new Error(`volumetric-fog density load failed: ${densityResult.error.code}`);
const density = densityResult.value;
const densityForVariant: TextureAsset = (() => {
  if (variant === 'empty-density' || variant === 'density-zero') {
    return { ...density, data: new Uint8Array(density.data.length) };
  }
  if (!uniformDensityNoShadow) return density;
  let total = 0;
  for (const value of density.data) total += value;
  const uniform = new Uint8Array(density.data.length);
  uniform.fill(Math.round(total / density.data.length));
  return { ...density, data: uniform };
})();
const densityHandle = app.world.allocSharedRef('TextureAsset', densityForVariant);
const projectorResult = await assets.loadByGuid<TextureAsset>(assets.parseGuid(PROJECTOR_GUID));
if (!projectorResult.ok)
  throw new Error(`volumetric-fog projector load failed: ${projectorResult.error.code}`);
// Three's SpotLight.map is a data cookie (its DataTexture keeps the source
// bytes in NoColorSpace), not a display-color texture. The vendored PNG Meta
// is intentionally sRGB for ordinary image consumers, so the parity scene
// derives the same byte-preserving linear upload at this owner boundary.
const projectorAsset: TextureAsset = {
  ...projectorResult.value,
  format: 'rgba8unorm',
  colorSpace: 'linear',
};
const projectorHandle = app.world.allocSharedRef('TextureAsset', projectorAsset);

const stoneMaterial = app.world.allocSharedRef<'MaterialAsset', MaterialAsset>(
  'MaterialAsset',
  Materials.standard({
    baseColor: [1, 1, 1, 1],
    metallic: 0,
    // Three's MeshStandardMaterial default for the teapot is roughness=1.0.
    // Keep the oracle's omitted roughness explicit at this owner boundary.
    roughness: 1,
    // The pinned Three.js oracle uses DoubleSide for the teapot. Keep both
    // patch windings visible while the procedural patch normals remain the
    // lighting authority.
    renderState: { cullMode: 'none' },
  }),
);
const straightAlphaBlend = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
} as const;
const transparentMaterial = app.world.allocSharedRef<'MaterialAsset', MaterialAsset>(
  'MaterialAsset',
  Materials.standard({
    baseColor: [0.18, 0.34, 0.62, 0.4],
    metallic: 0,
    roughness: 0.42,
    renderState: { blend: straightAlphaBlend, depthWriteEnabled: false },
  }),
);
const floorMaterial = app.world.allocSharedRef<'MaterialAsset', MaterialAsset>(
  'MaterialAsset',
  Materials.standard({
    baseColor: [1, 1, 1, 1],
    metallic: 0,
    // Three's MeshStandardMaterial default for the floor is roughness=1.
    roughness: 1,
  }),
);

const spawnMesh = (
  meshHandle: Handle<'MeshAsset', 'shared'>,
  pos: [number, number, number],
  scale: [number, number, number],
  material = stoneMaterial,
  rotation: [number, number, number, number] | ReturnType<typeof quat.fromEuler> = [0, 0, 0, 1],
) =>
  app.world
    .spawn(
      { component: Transform, data: { pos, quat: rotation, scale } },
      { component: MeshFilter, data: { assetHandle: meshHandle } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();

const teapotResult = createTeapotGeometry(0.8, 18);
if (!teapotResult.ok)
  throw new Error(`volumetric-fog teapot build failed: ${teapotResult.error.code}`);
const floorResult = createPlaneGeometry(100, 100);
if (!floorResult.ok)
  throw new Error(`volumetric-fog floor build failed: ${floorResult.error.code}`);
const teapotHandle = app.world.allocSharedRef<'MeshAsset', MeshAsset>(
  'MeshAsset',
  teapotResult.value,
);
const floorHandle = app.world.allocSharedRef<'MeshAsset', MeshAsset>(
  'MeshAsset',
  floorResult.value,
);
const diagnosticOccluderResult = createBoxGeometry(0.82, 0.45, 0.82);
if (!diagnosticOccluderResult.ok) {
  throw new Error(
    `volumetric-fog diagnostic occluder build failed: ${diagnosticOccluderResult.error.code}`,
  );
}
const diagnosticOccluderHandle = app.world.allocSharedRef<'MeshAsset', MeshAsset>(
  'MeshAsset',
  diagnosticOccluderResult.value,
);

const transparentSubject =
  variant === 'transparent-subject'
    ? spawnMesh(diagnosticOccluderHandle, [0.9, 0.1, 0.3], [1, 1, 1], transparentMaterial)
    : undefined;

// Official Three.js webgpu_volume_lighting subject and floor. The 20x10x20
// volume box is represented by VolumetricFog bounds below, not a second visible
// mesh or a synthetic beam.
// Three's PlaneGeometry is authored on XY with a +Z normal and then rotated
// -90 degrees around X for the horizontal floor used by the oracle scene.
const floorRotation: [number, number, number, number] = [
  Math.sin(-Math.PI / 4),
  0,
  0,
  Math.cos(-Math.PI / 4),
];
const floor = spawnMesh(floorHandle, [0, -3, 0], [1, 1, 1], floorMaterial, floorRotation);
// The oracle floor receives but does not cast a shadow.
app.world
  .addComponent(floor, { component: ShadowParticipation, data: { cast: false, receive: true } })
  .unwrap();
const teapotRotation = quat.fromEuler(quat.create(), 0, scenePose?.teapotRotationY ?? 0, 0, 'XYZ');
spawnMesh(teapotHandle, [0, 0, 0], [1, 1, 1], stoneMaterial, teapotRotation);
if (
  variant === 'diagnostic-ceiling-occluder' ||
  diagnosticOccluderNoShadow ||
  diagnosticCeilingOccluderNoVolume ||
  diagnosticOccluderNoShadowNoVolume
) {
  // The diagnostic-only blocker makes the spot shadow falsifier observable;
  // the pinned baseline remains the exact Teapot + floor scene.
  // Place the blocker on the pinned SpotLight ray (2.5,5,2.5) -> origin so
  // the shadow-off comparison exercises the real atlas visibility path.
  spawnMesh(diagnosticOccluderHandle, [1.65, 3.35, 1.65], [1, 1, 1], stoneMaterial);
}

const cameraPosition: [number, number, number] =
  variant === 'camera-drift' ? [-7.5, 1, -6] : [-8, 1, -6];
const cameraTarget: [number, number, number] = [0, 0, 0];
app.world
  .spawn(
    {
      component: Transform,
      data: {
        pos: cameraPosition,
        quat: quat.fromLookAt(quat.create(), cameraPosition, cameraTarget, [0, 1, 0]),
        scale: [1, 1, 1],
      },
    },
    {
      component: Camera,
      data: {
        ...perspective({ fov: Math.PI / 3, aspect: 16 / 9, near: 0.1, far: 100 }),
        tonemap: TONEMAP_NEUTRAL,
        exposure: 2,
        antialias: ANTIALIAS_FXAA,
        bloom: BLOOM_DISABLED,
        bloomThreshold: 0.75,
        bloomIntensity: 0.18,
        bloomSoftKnee: 0.5,
        bloomScatter: 0.7,
        clearColor: [0, 0, 0, 1],
      },
    },
  )
  .unwrap();
const selectedLights = spawnVolumetricSpot(
  app.world,
  !diagnosticNoShadow &&
    !shadowOff &&
    !diagnosticColumnNoShadow &&
    !diagnosticOccluderNoShadow &&
    !uniformDensityNoShadow,
  variant === 'projector-off' ? undefined : projectorHandle,
  {
    pointEnabled: !pointOff,
    spotEnabled: !spotOff,
  },
  scenePose,
);
app.world
  .spawn({
    component: Skylight,
    data: { color: [1, 1, 1], intensity: 0 },
  })
  .unwrap();
if (!volumeDisabled) {
  app.world
    .spawn({
      component: VolumetricFog,
      data: {
        light: selectedLights.point,
        spotLight: selectedLights.spot,
        density: densityHandle,
        boundsMin: [-10, -3, -10],
        boundsMax: [10, 7, 10],
        // Three's VolumeNodeMaterial uses smokeAmount=2 and multiplies the
        // consumed density by 0.01 for both Beer-Lambert extinction and
        // single-scatter accumulation. The authored density texture is the
        // same normalized [0,1] source, so .01 is the parity fixture's optical
        // depth rather than a post-process brightness multiplier.
        extinction: [0.01, 0.01, 0.01],
        albedo: [1, 1, 1],
        emission: [0, 0, 0],
        anisotropy: 0,
        maxDistance: 100,
      },
    })
    .unwrap();
}

Object.assign(globalThis, {
  __forgeaxFogEvidence: {
    variant,
    renderer: app.renderer,
    world: app.world,
    rendererErrors,
    transparentSubject,
    foxSkinEntityCount,
    capture:
      captureTime === undefined
        ? undefined
        : {
            frozenTime: captureTime,
            normalizedFrame: captureOrdinal,
            sceneTimeMode: 'frozen-official-animation',
            sceneTimeScale: 2.4,
          },
  },
});
app.start();
Object.assign(globalThis, { __forgeaxApp: app });
if (benchmark) {
  const benchLeaseResult = app.renderer.attach(app.world);
  if (!benchLeaseResult.ok)
    throw new Error(`volumetric-fog benchmark attach failed: ${benchLeaseResult.error.code}`);
  const benchLease = benchLeaseResult.value;
  Object.assign(globalThis, {
    __forgeaxFogBench: async () => {
      app.stop();
      const base = app.renderer.inspect().profile;
      const profiles = [
        { quality: 'low', depth: 48, tileSize: 16, thresholdMs: 2 },
        { quality: 'high', depth: 64, tileSize: 4, thresholdMs: 4 },
      ] as const;
      const results = [];
      for (const volumetricFog of profiles) {
        const { thresholdMs, ...profile } = volumetricFog;
        const set = app.renderer.setProfile({ ...base, volumetricFog: profile });
        if (!set.ok) throw new Error(`volumetric-fog benchmark profile failed: ${set.error.code}`);
        const drawFrame = async () => {
          const drawn = app.renderer.draw({
            leases: [benchLease],
            camera: { lease: benchLease },
            environment: { lease: benchLease },
          });
          if (!drawn.ok)
            throw new Error(`volumetric-fog benchmark draw failed: ${drawn.error.code}`);
          return app.renderer.observe(drawn.value, { include: ['timings'] });
        };
        for (let frame = 0; frame < 30; frame += 1) await drawFrame();
        const timings = [];
        for (let frame = 0; frame < 60; frame += 1) {
          const observed = await drawFrame();
          if (observed.ok && observed.value.volumeTimings?.status === 'ready') {
            timings.push(observed.value.volumeTimings.totalMs);
          }
        }
        const ordered = [...timings].sort((a, b) => a - b);
        const p95Ms =
          ordered.length === 0 ? null : (ordered[Math.ceil(ordered.length * 0.95) - 1] ?? null);
        const measurementComplete = timings.length === 60;
        const withinBudget = p95Ms !== null && p95Ms <= thresholdMs;
        results.push({
          profile,
          renderer: app.renderer.inspect(),
          expectedSampleCount: 60,
          sampleCount: timings.length,
          measurementComplete,
          p95Ms,
          thresholdMs,
          withinBudget,
          timings,
        });
      }
      return results;
    },
  });
}

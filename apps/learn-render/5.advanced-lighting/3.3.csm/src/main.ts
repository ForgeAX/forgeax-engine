// apps/learn-render/5.advanced-lighting/3.3.csm/src/main.ts
// LearnOpenGL section 5.3 -- cascaded shadow maps (CSM / PSSM).
// Large wood floor (scale ~50) + 10 cubes spanning 0-40m depth + directional
// light with a 4-cascade castShadow. Walk forward (first-person)
// to see near cubes lit by tight near-cascade shadows and far cubes by the
// coarse far cascade. Keys 1-4 highlight a single cascade band, key 0 turns
// the cascade-overlay debug-viz off, Space toggles the shadow on/off.
//
// The cascade overlay is a demo-local debug-viz post-process (the only
// demo-local GPU code; the shadows themselves ride the engine URP default
// pipeline). It is layered ON TOP of URP via the engine post-URP hook:
// ./cascade-overlay.ts registers the tint shader id and re-installs URP with
// `config.postEffects: [id]` (AUGMENT, not REPLACE -- URP keeps its shadow
// cascades). That wiring lives in ./cascade-overlay.ts so this entry file
// stays scene-spawn + key handlers.
//
// GREP anchors for AI users:
//   - "// 1. engine usage"    public engine API consumed
//   - "// 2. scene constants" D5 scene-specific constants + GUIDs
//   - "// 3. bootstrap"       entry point wiring (1)+(2)

// 1. engine usage
import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { type App } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { AssetRegistry, HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';

import {
  Camera,
  DirectionalLight,
  DirectionalShadowFilterValue,
  MeshFilter,
  MeshRenderer,
  type RenderWorldLease,
} from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';

import { Materials } from '@forgeax/engine-render';

import { createPlaneGeometry } from '@forgeax/engine-geometry';
import type { MaterialAsset, TextureAsset } from '@forgeax/engine-types';
import { unwrapHandle } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { replayCapturedFrameInBrowser } from '@forgeax/apps-shared/rhi-debug-browser-replay';
import { addFirstPersonSystem } from '../../../../shared/src/learn-render-first-person';
import {
  computeCsmSplits,
  csmOverlayFeature,
  csmOverlayModeForKey,
  installCsmOverlay,
  setCsmOverlaySplits,
  setCsmOverlayMode,
} from './cascade-overlay';

/** Closed MVD profile vocabulary owned by the Engine-facing demo control. */
export type CsmMvdProfile = 'off' | 'pcf3' | 'pcf5' | 'pcssMedium' | 'pcssHigh';

/** Scene variables used by the MVD visual oracle matrix. */
export type CsmMvdScene =
  | 'near'
  | 'far'
  | 'seam'
  | 'motion'
  | 'alpha'
  | 'transparent'
  | 'fallback';

const CSM_MVD_SHADOW_DISTANCE = {
  near: 18,
  far: 50,
  seam: 50,
  motion: 32,
  alpha: 26,
  transparent: 38,
  fallback: 50,
} as const satisfies Readonly<Record<CsmMvdScene, number>>;

export function csmMvdShadowDistance(scene: CsmMvdScene): number {
  return CSM_MVD_SHADOW_DISTANCE[scene];
}

export type CsmMvdBackend = 'webgpu' | 'wgpu-native' | 'wgpu-webgl2' | 'null';

export type CsmMvdVisualExpectationId =
  | 'off'
  | 'pcf3'
  | 'pcf5'
  | 'pcss-medium'
  | 'pcss-high'
  | 'near-far'
  | 'seam'
  | 'motion-alpha-transparent-fallback';

/** A visual expectation bound to one observed renderer generation. */
export interface CsmMvdVisualExpectation {
  readonly id: CsmMvdVisualExpectationId;
  readonly binding: {
    readonly profile: CsmMvdProfile;
    readonly scene: CsmMvdScene;
    readonly backend: CsmMvdBackend;
    readonly deviceGeneration: number;
    readonly graphGeneration: number;
  };
  readonly expected: string;
  readonly sceneFact: string;
  readonly observed: string;
  readonly verdict: 'pass' | 'fail' | 'not-run';
  readonly confidence: 'high' | 'medium' | 'low';
}

export const CSM_MVD_VISUAL_EXPECTATION_IDS = Object.freeze([
  'off',
  'pcf3',
  'pcf5',
  'pcss-medium',
  'pcss-high',
  'near-far',
  'seam',
  'motion-alpha-transparent-fallback',
] as const);

type CsmMvdGenerationBinding = Pick<
  CsmMvdVisualExpectation['binding'],
  'backend' | 'deviceGeneration' | 'graphGeneration'
>;

type CsmMvdObservedFacts = {
  readonly profile: CsmMvdProfile;
  readonly scene: CsmMvdScene;
  readonly directionalShadow: {
    readonly requested: string;
    readonly effective: string;
    readonly status: string;
    readonly cascadeCount: number;
    readonly mapSize: number;
    readonly writerPasses: number;
    readonly shadowAngularRadius: number | undefined;
    readonly maxPenumbraTexels: number | undefined;
    readonly graphGeneration: number;
    readonly deviceGeneration: number;
  };
};

/**
 * Bind the eight MVD expectations to the generation returned by renderer.inspect().
 * The carrier supplies observed identity; it never invents a device or graph
 * generation and never computes a shadow factor.
 */
export function bindCsmMvdVisualExpectations(
  observed: CsmMvdGenerationBinding,
  facts?: CsmMvdObservedFacts,
): readonly CsmMvdVisualExpectation[] {
  const make = (
    id: CsmMvdVisualExpectationId,
    profile: CsmMvdProfile,
    scene: CsmMvdScene,
    expected: string,
    sceneFact: string,
  ): CsmMvdVisualExpectation => {
    const current = facts?.profile === profile && facts.scene === scene;
    const actual = current ? facts.directionalShadow : undefined;
    const verdict =
      actual === undefined
        ? 'not-run'
        : actual.requested === profile &&
            (profile === 'off' || actual.effective === profile) &&
            actual.graphGeneration > 0 &&
            actual.deviceGeneration >= 0
          ? 'pass'
          : 'fail';
    return {
      id,
      binding: { ...observed, profile, scene },
      expected,
      sceneFact,
      observed: actual === undefined ? 'not-run' : JSON.stringify(actual),
      verdict,
      confidence:
        actual === undefined
          ? 'low'
          : actual.graphGeneration > 0 && actual.deviceGeneration >= 0
            ? 'high'
            : 'medium',
    };
  };
  return Object.freeze([
    make('off', 'off', 'near', 'no shadow pass; scene remains observable', 'castShadow=false; Directional shadow topology must be off'),
    make('pcf3', 'pcf3', 'near', 'fixed PCF3; near blocker remains visible', 'near shadowDistance=18; PCF3 author fact'),
    make('pcf5', 'pcf5', 'far', 'fixed PCF5; far blocker remains visible', 'far shadowDistance=50; PCF5 author fact'),
    make('pcss-medium', 'pcssMedium', 'near', 'bounded medium PCSS penumbra', 'near; medium radius and penumbra limit'),
    make('pcss-high', 'pcssHigh', 'far', 'bounded high PCSS penumbra', 'far; high radius and penumbra limit'),
    make('near-far', 'pcssMedium', 'far', 'continuous near/far cascade coverage', 'far scene covers 50m shadowDistance'),
    make('seam', 'pcssMedium', 'seam', 'continuous cascade seam blend', 'seam cascadeBlend=0.45'),
    make(
      'motion-alpha-transparent-fallback',
      'pcssHigh',
      'motion',
      'motion, alpha, transparent, and fallback share one control and inspection entry',
      'motion uses a distinct author control; alpha/transparent/fallback use the same inspection entry',
    ),
  ]);
}

const CSM_MVD_FILTER_BY_PROFILE = {
  pcf3: DirectionalShadowFilterValue.pcf3,
  pcf5: DirectionalShadowFilterValue.pcf5,
  pcssMedium: DirectionalShadowFilterValue.pcssMedium,
  pcssHigh: DirectionalShadowFilterValue.pcssHigh,
} as const;

/** Apply only the DirectionalLight author fact; the renderer owns all policy. */
export function applyCsmMvdProfile(
  world: Pick<World, 'set'>,
  lightEntity: EntityHandle,
  profile: CsmMvdProfile,
): void {
  if (profile === 'off') {
    world.set(lightEntity, DirectionalLight, { castShadow: false });
    return;
  }
  world.set(lightEntity, DirectionalLight, {
    castShadow: true,
    ...SHADOW_CONFIG,
    shadowFilter: CSM_MVD_FILTER_BY_PROFILE[profile],
  });
}

/** Apply scene author facts without creating an app-local shadow algorithm. */
export function applyCsmMvdScene(
  world: Pick<World, 'set'>,
  lightEntity: EntityHandle,
  scene: CsmMvdScene,
): number {
  const shadowDistance = csmMvdShadowDistance(scene);
  switch (scene) {
    case 'near':
      world.set(lightEntity, DirectionalLight, { shadowDistance, cascadeBlend: 0.2 });
      return shadowDistance;
    case 'far':
      world.set(lightEntity, DirectionalLight, { shadowDistance, cascadeBlend: 0.2 });
      return shadowDistance;
    case 'seam':
      world.set(lightEntity, DirectionalLight, { shadowDistance, cascadeBlend: 0.45 });
      return shadowDistance;
    case 'motion':
      world.set(lightEntity, DirectionalLight, { shadowDistance, cascadeBlend: 0.3 });
      return shadowDistance;
    case 'alpha':
      world.set(lightEntity, DirectionalLight, { shadowDistance, cascadeBlend: 0.25 });
      return shadowDistance;
    case 'transparent':
      world.set(lightEntity, DirectionalLight, { shadowDistance, cascadeBlend: 0.15 });
      return shadowDistance;
    case 'fallback':
      world.set(lightEntity, DirectionalLight, { castShadow: false });
      return shadowDistance;
  }
}

/** Test-only author-fact mutations used by the falsifier harness. */
export function applyCsmMvdFalsifier(
  world: Pick<World, 'set'>,
  lightEntity: EntityHandle,
  falsifier: string | null,
): void {
  switch (falsifier) {
    case 'force-csm-fixed-radius':
      world.set(lightEntity, DirectionalLight, { shadowAngularRadius: 0.0001 });
      return;
    case 'force-csm-remove-tile-clamp':
      world.set(lightEntity, DirectionalLight, { mapSize: 1 });
      return;
    case 'force-csm-capable-backend-pcf':
      world.set(lightEntity, DirectionalLight, {
        shadowFilter: DirectionalShadowFilterValue.pcf3,
      });
      return;
    case 'force-csm-pcf5-pretends-pcss':
      world.set(lightEntity, DirectionalLight, {
        shadowFilter: DirectionalShadowFilterValue.pcssMedium,
      });
      return;
    case 'force-csm-shadow-off-build-pass':
      applyCsmMvdProfile(world, lightEntity, 'off');
      return;
    case 'force-csm-clear-blocker-raw':
      // The Browser overlay receives its depth fixture from the same scene;
      // this author mutation shortens the fixture so raw blocker samples are
      // no longer representative of the original scene.
      world.set(lightEntity, DirectionalLight, { shadowDistance: 0.2 });
      return;
    default:
      return;
  }
}

// 2. scene constants



// Wood texture GUID from forgeax-engine-assets/learn-opengl/textures/wood.png.meta.json.
const WOOD_GUID_STR = '019e3969-1d48-7c3b-ac24-6d68f457065f';
// Metal texture GUID -- the second tileable material in the cube rotation
// (the LearnOpenGL marble asset is not in the engine-assets set; metal is the
// closest tileable stand-in already carved into learn-opengl/textures).
const METAL_GUID_STR = '019e3969-1d47-760f-982e-7bad1ffd969c';

// Floor: large plane (~50 units) on XZ at y=-0.5, normal +Y. createPlaneGeometry
// produces an XY plane facing +Z, so rotate -90 deg about X to lay it flat.
const FLOOR_SIZE = 50;
const FLOOR_Y = -0.5;
const FLOOR_QUAT_X = Math.sin(-Math.PI / 4);
const FLOOR_QUAT_W = Math.cos(-Math.PI / 4);

// Camera: first-person starting at (0, 1.5, 6) looking -Z down the row.
const CAMERA_POS_Z = 6;
const CAMERA_POS_Y = 1.5;
const CAMERA_FOV = Math.PI / 4;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 50.0;

// Directional light shadow: 4-cascade CSM. splitLambda=0.75 blends log + uniform
// PSSM splits; cascadeBlend=0.2 softens cascade seams; mapSize=2048 per tile.
const SHADOW_CONFIG = {
  cascadeCount: 4,
  splitLambda: 0.75,
  cascadeBlend: 0.2,
  mapSize: 2048,
  // Coverage: [camera near, shadowDistance]. Cubes span 0-40m depth, so 50m
  // reach covers the scene while keeping cascade-0 resolution tight.
  shadowDistance: 50,
};

// 10 cubes spanning 0-40m depth at varied positions + heights. `tex` selects
// the material: 'wood' / 'metal' load a GUID texture, a color triple is a solid
// Materials.standard. The depth spread exercises all four cascade bands.
const CUBES = [
  { pos: [-2, 0.5, -1], scale: [1, 1, 1],tex: 'wood' },
  { pos: [2, 1, -4], scale: [1, 2, 1],tex: 'metal' },
  { pos: [-3, 0.75, -8], scale: [1.5, 1.5, 1.5],tex: [1, 0.3, 0.3] },
  { pos: [3, 0.5, -12], scale: [1, 1, 1],tex: 'wood' },
  { pos: [-1, 1.5, -16], scale: [1, 3, 1],tex: [0.3, 1, 0.3] },
  { pos: [4, 1, -22], scale: [2, 2, 2],tex: 'metal' },
  { pos: [-4, 0.75, -28], scale: [1.5, 1.5, 1.5],tex: [0.3, 0.3, 1] },
  { pos: [1, 1, -33], scale: [1, 2, 1],tex: 'wood' },
  { pos: [-2, 1.5, -38], scale: [2, 3, 2],tex: 'metal' },
  { pos: [3, 1, -40], scale: [1.5, 2, 1.5],tex: [1, 1, 0.3] },
] as const;

// 3. bootstrap

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 5.3.3 csm] missing <canvas id='app'> in index.html");
}

void bootstrap(canvas).catch((error: unknown) => {
  failBootstrap('csm.bootstrap.unhandled-rejection', error);
});

function failBootstrap(stage: string, error: unknown): void {
  markBootstrapStage(stage);
  const detail = error instanceof Error ? error.message : String(error);
  const scope = globalThis as typeof globalThis & {
    __forgeaxBootstrapFailure?: { stage: string; detail: string };
  };
  scope.__forgeaxBootstrapFailure = { stage, detail };
  console.error(`[learn-render 5.3.3 csm] bootstrap failed at ${stage}: ${detail}`);
}

function markBootstrapStage(name: string): void {
  const scope = globalThis as typeof globalThis & {
    __forgeaxBootstrapStage?: { name: string; startedAt: number; previousElapsedMs: number };
  };
  const now = performance.now();
  const previous = scope.__forgeaxBootstrapStage;
  scope.__forgeaxBootstrapStage = {
    name,
    startedAt: now,
    previousElapsedMs: previous === undefined ? 0 : now - previous.startedAt,
  };
}

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  markBootstrapStage('csm.createApp');
  const appRes = await createApp(
    target,
    {
      features: [csmOverlayFeature],
      ...(runtimeBinding === undefined ? {} : { assetRuntimeBinding: runtimeBinding }),
    },
    { ...forgeaxBundlerAdapter(), importTransport: createRuntimeAssetImportTransport(runtimeBinding) },
  );
  markBootstrapStage('csm.createApp.complete');
  if (!appRes.ok) {
    failBootstrap('csm.createApp.failed', appRes.error);
    return;
  }
  const app = appRes.value;
  const renderer = app.renderer;
  const world = app.world;

  app.onError((error) => {
    console.error('[learn-render 5.3.3 csm] app.onError:', error.code, error.hint);
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string | undefined }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: error.code, hint: error.hint });
  });

  const assets = app.assets;
  if (assets === undefined) {
    failBootstrap('csm.assets.owner-unavailable', 'App asset owner is unavailable');
    return;
  }
  configureRuntimeAssetCatalog(assets, runtimeBinding);
  markBootstrapStage('csm.assets.loadByGuid');

  // Load the two tileable textures (wood floor + metal cube accent) by GUID.
  markBootstrapStage('csm.assets.wood.loadByGuid');
  const woodTex = await loadTextureByGuid(assets, WOOD_GUID_STR);
  markBootstrapStage('csm.assets.wood.loadByGuid.complete');
  markBootstrapStage('csm.assets.metal.loadByGuid');
  const metalTex = await loadTextureByGuid(assets, METAL_GUID_STR);
  markBootstrapStage('csm.assets.metal.loadByGuid.complete');
  markBootstrapStage('csm.assets.loadByGuid.complete');
  if (woodTex === null || metalTex === null) {
    failBootstrap('csm.assets.loadByGuid.failed', 'texture load returned no asset');
    return;
  }

  // Wood floor material POJO.
  const floorMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      { name: 'Forward', program: { module: 'forgeax::default-standard-pbr', fragmentEntry: 'fs_main' }, renderState: { tags: { LightMode: 'Forward' }, passKind: 'forward' } },
      { name: 'ShadowCaster', program: { module: 'forgeax::default-shadow-caster' }, renderState: { tags: { LightMode: 'ShadowCaster' }, passKind: 'shadow-caster' } },
    ],
    values: {
      baseColorTexture: unwrapHandle(world.allocSharedRef('TextureAsset', woodTex)),
    },
  });
  const woodCubeTexHandle = unwrapHandle(world.allocSharedRef('TextureAsset', woodTex));
  const metalCubeTexHandle = unwrapHandle(world.allocSharedRef('TextureAsset', metalTex));

  // Large floor plane.
  const floorRes = createPlaneGeometry(FLOOR_SIZE, FLOOR_SIZE);
  if (!floorRes.ok) {
    console.error('[learn-render 5.3.3 csm] createPlaneGeometry failed:', floorRes.error);
    return;
  }
  const floorMesh = world.allocSharedRef('MeshAsset', floorRes.value);
  world.spawn(
    {
      component: Transform,
      data: { pos: [0, FLOOR_Y, 0], quat: [FLOOR_QUAT_X, 0, 0, FLOOR_QUAT_W]},
    },
    { component: MeshFilter, data: { assetHandle: floorMesh } },
    { component: MeshRenderer, data: { materials: [floorMat] } },
  ).unwrap();

  // 10 cubes spanning 0-40m. Materials rotate through wood / metal / solid.
  for (const c of CUBES) {
    const matHandle = world.allocSharedRef('MaterialAsset', cubeMaterial(c.tex, woodCubeTexHandle, metalCubeTexHandle));
    world.spawn(
      {
        component: Transform,
        data: {
          pos: c.pos,
          quat: [0, 0, 0, 1],
          scale: c.scale,
        },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [matHandle] } },
    ).unwrap();
  }

  // Directional light with a 4-cascade CSM shadow.
  const lightEntity = world.spawn(
    {
      component: DirectionalLight,
      data: {
        direction: [0.3, -0.9, -0.3],
        color: [1, 1, 1], intensity: 1,
        castShadow: true,
        shadowFilter: DirectionalShadowFilterValue.pcf3,
        ...SHADOW_CONFIG,
      },
    },
  ).unwrap();

  let shadowEnabled = true;
  let mvdProfile = csmMvdProfileFromQuery(new URLSearchParams(window.location.search)) ?? 'pcf3';
  let mvdScene = csmMvdSceneFromQuery(new URLSearchParams(window.location.search)) ?? 'near';
  const mvdFalsifier = new URLSearchParams(window.location.search).get('mvd-falsify');
  shadowEnabled = mvdProfile !== 'off';
  applyCsmMvdProfile(world, lightEntity, mvdProfile);
  const initialShadowDistance = applyCsmMvdScene(world, lightEntity, mvdScene);
  applyCsmMvdFalsifier(world, lightEntity, mvdFalsifier);

  // First-person camera.
  const cameraEntity = world.spawn(
    { component: Transform, data: { pos: [0, CAMERA_POS_Y, CAMERA_POS_Z]} },
    {
      component: Camera,
      data: perspective({
        fov: CAMERA_FOV,
        aspect: target.width / target.height,
        near: CAMERA_NEAR,
        far: CAMERA_FAR,
      }),
    },
  ).unwrap();

  addFirstPersonSystem(app.world, {
    name: 'learn-render-5.3.3-csm-first-person',
    overrideBackend: undefined,
  });

  markBootstrapStage('csm.app.start');
  const startRes = app.start();
  markBootstrapStage('csm.app.start.complete');
  if (!startRes.ok) {
    failBootstrap('csm.app.start.failed', startRes.error);
    return;
  }

  // Install the cascade-overlay debug-viz. The overlay is now a single
  // shader registered once with structured reads + uniform params; mode
  // changes write the PostProcessParams component UBO (D-8). The call passes
  // `world` so cascade-overlay.ts can spawn the params entity.
  const splits = installCsmOverlay(world, initialShadowDistance);
  console.warn(
    `[learn-render 5.3.3 csm] PSSM splits (demo recompute) = ${Array.from(splits).map((s) => s.toFixed(2)).join(', ')}`,
  );

  // The RHI-debug Browser lane can select one cascade through the same public
  // overlay mode used by the keyboard path, proving that the selected layer
  // reaches the post-process UBO without adding a debug-only engine seam.
  const queryOverlayMode = csmOverlayModeForKey(
    new URLSearchParams(window.location.search).get('csm-highlight') ?? '',
  );
  if (queryOverlayMode !== null) {
    setCsmOverlayMode(queryOverlayMode);
    console.warn(`[learn-render 5.3.3 csm] query cascade overlay -> ${queryOverlayMode}`);
  }

  // Key handlers: 1-4 highlight a single cascade band, 0 turns the overlay
  // off; Space toggles the shadow on/off via ECS structural change (the engine
  // has no runtime setShadowEnabled API).
  window.addEventListener('keydown', (e) => {
    const overlayMode = csmOverlayModeForKey(e.key);
    if (overlayMode !== null) {
      e.preventDefault();
      setCsmOverlayMode(overlayMode);
      console.warn(`[learn-render 5.3.3 csm] cascade overlay -> ${overlayMode}`);
      return;
    }
    if (e.key === ' ' || e.key === 'Space') {
      e.preventDefault();
      if (shadowEnabled) {
        applyCsmMvdProfile(world, lightEntity, 'off');
        shadowEnabled = false;
        console.warn('[learn-render 5.3.3 csm] shadow disabled via Space toggle');
      } else {
        applyCsmMvdProfile(world, lightEntity, mvdProfile);
        applyCsmMvdScene(world, lightEntity, mvdScene);
        shadowEnabled = true;
        console.warn('[learn-render 5.3.3 csm] shadow enabled via Space toggle');
      }
      return;
    }
    const profileByKey: Readonly<Record<string, CsmMvdProfile>> = {
      p: 'pcssMedium',
      o: 'off',
      '3': 'pcf3',
      '5': 'pcf5',
      m: 'pcssMedium',
      h: 'pcssHigh',
    };
    const profile = profileByKey[e.key.toLowerCase()];
    if (profile !== undefined) {
      mvdProfile = profile;
      applyCsmMvdProfile(world, lightEntity, profile);
      applyCsmMvdScene(world, lightEntity, mvdScene);
      shadowEnabled = profile !== 'off';
      console.warn(`[learn-render 5.3.3 csm] MVD profile -> ${profile}`);
      return;
    }
    const sceneByKey: Readonly<Record<string, CsmMvdScene>> = {
      n: 'near',
      f: 'far',
      s: 'seam',
      v: 'motion',
      a: 'alpha',
      t: 'transparent',
      b: 'fallback',
    };
    const scene = sceneByKey[e.key.toLowerCase()];
    if (scene !== undefined) {
      mvdScene = scene;
      applyCsmMvdScene(world, lightEntity, scene);
      console.warn(`[learn-render 5.3.3 csm] MVD scene -> ${scene}`);
    }
  });

  window.addEventListener('resize', () => {
    const dpr = devicePixelRatio;
    target.width = window.innerWidth * dpr;
    target.height = window.innerHeight * dpr;
    world.set(cameraEntity, Camera, { aspect: window.innerWidth / window.innerHeight });
  });

  // Sanity: the demo-recomputed splits should match the engine PSSM formula
  // baked into cascade-overlay.wgsl (logged above for AI users to compare).
  void computeCsmSplits;

  console.warn(`[learn-render 5.3.3 csm] backend=${renderer.inspect().capabilities.backendKind}`);

  const attached = renderer.attach(world);
  if (!attached.ok) {
    failBootstrap('csm.renderer.attach.failed', attached.error);
    return;
  }
  installCaptureHook(target, app, world, attached.value, lightEntity);
  markBootstrapStage('csm.capture-hooks.complete');
  installCsmMvdControls(app, () => mvdProfile, () => mvdScene, (profile) => {
    mvdProfile = profile;
    applyCsmMvdProfile(world, lightEntity, profile);
    const shadowDistance = applyCsmMvdScene(world, lightEntity, mvdScene);
    setCsmOverlaySplits(shadowDistance);
    shadowEnabled = profile !== 'off';
  }, (scene) => {
    mvdScene = scene;
    const shadowDistance = applyCsmMvdScene(world, lightEntity, scene);
    setCsmOverlaySplits(shadowDistance);
  });
}

export function csmMvdProfileFromQuery(params: URLSearchParams): CsmMvdProfile | null {
  const value = params.get('mvd-profile');
  if (value === 'off' || value === 'pcf3' || value === 'pcf5' || value === 'pcssMedium' || value === 'pcssHigh') {
    return value;
  }
  return null;
}

export function csmMvdSceneFromQuery(params: URLSearchParams): CsmMvdScene | null {
  const value = params.get('mvd-scene');
  if (value === 'near' || value === 'far' || value === 'seam' || value === 'motion' || value === 'alpha' || value === 'transparent' || value === 'fallback') {
    return value;
  }
  return null;
}

function installCsmMvdControls(
  app: App,
  getProfile: () => CsmMvdProfile,
  getScene: () => CsmMvdScene,
  setProfile: (profile: CsmMvdProfile) => void,
  setScene: (scene: CsmMvdScene) => void,
): void {
  const win = window as unknown as {
    __setCsmMvdProfile?: (profile: CsmMvdProfile) => void;
    __setCsmMvdScene?: (scene: CsmMvdScene) => void;
    __inspectCsmMvd?: () => {
      readonly binding: CsmMvdVisualExpectation['binding'];
      readonly expectations: readonly CsmMvdVisualExpectation[];
      readonly directionalShadow: unknown;
    };
  };
  win.__setCsmMvdProfile = setProfile;
  win.__setCsmMvdScene = setScene;
  win.__inspectCsmMvd = () => {
    const inspection = app.renderer.inspect();
    const binding = {
      profile: getProfile(),
      scene: getScene(),
      backend: inspection.capabilities.backendKind,
      deviceGeneration: inspection.frame.deviceGeneration,
      graphGeneration: inspection.directionalShadow.graphGeneration,
    } satisfies CsmMvdVisualExpectation['binding'];
    return {
      binding,
      expectations: bindCsmMvdVisualExpectations(binding, {
        profile: getProfile(),
        scene: getScene(),
        directionalShadow: inspection.directionalShadow,
      }),
      directionalShadow: inspection.directionalShadow,
    };
  };
}

// RHI-debug live-pixel hook for the capture smoke harness (pixel mode). The
// prepare hook only prewarms the demo; captureFrame owns the recorded frame's
// update + draw. The live hook must therefore only read the canvas after
// captureFrame resolves, without update/draw/rAF side effects. Only meaningful
// when the page is served with FORGEAX_ENGINE_RHI_DEBUG=1; harmless otherwise.
function installCaptureHook(
  target: HTMLCanvasElement,
  app: App,
  world: App['world'],
  lease: RenderWorldLease,
  lightEntity: EntityHandle,
): void {
  type CaptureHook = () => Promise<Uint8Array>;
  type CapturePrepareHook = () => Promise<void>;
  const win = window as unknown as {
    __captureCsm?: CaptureHook;
    __prepareCsmCapture?: CapturePrepareHook;
    __replayCsmCapture?: typeof replayCapturedFrameInBrowser;
  };
  const renderer = app.renderer;
  const drawCsmFrame = (): void => {
    world.update(1 / 60).unwrap();
    const drawn = renderer.draw({
      leases: [lease],
      camera: { lease },
      environment: { lease },
    });
    if (!drawn.ok) throw drawn.error;
  };
  win.__prepareCsmCapture = async (): Promise<void> => {
    // Stable frames intentionally reuse the populated directional atlas. The
    // capture contract, however, must observe the real raster work of a fresh
    // shadow graph rather than an empty cache-hit frame. Nudge the authored
    // light direction for one unrecorded warm-up draw, then restore it before
    // the recorder arms; the next captured frame therefore gets a genuine
    // shadow-view invalidation without changing the scene's final author fact.
    world.set(lightEntity, DirectionalLight, {
      direction: [0.300001, -0.9, -0.3],
    });
    drawCsmFrame();
    world.set(lightEntity, DirectionalLight, {
      direction: [0.3, -0.9, -0.3],
    });
  };
  win.__captureCsm = async (): Promise<Uint8Array> => {
    const bitmap = await createImageBitmap(target);
    const captureCanvas = new OffscreenCanvas(target.width, target.height);
    const captureContext = captureCanvas.getContext('2d');
    if (captureContext === null) throw new Error('[learn-render 5.3.3 csm] capture context missing');
    captureContext.drawImage(bitmap, 0, 0);
    bitmap.close();
    const r = new Uint8Array(captureContext.getImageData(0, 0, target.width, target.height).data);
    return r;
  };
  win.__replayCsmCapture = replayCapturedFrameInBrowser;
}

async function loadTextureByGuid(
  assets: AssetRegistry,
  guidStr: string,
): Promise<TextureAsset | null> {
  const guidRes = AssetGuid.parse(guidStr);
  if (!guidRes.ok) {
    console.error('[learn-render 5.3.3 csm] GUID parse failed:', guidStr);
    return null;
  }
  const texRes = await assets.loadByGuid<TextureAsset>(guidRes.value);
  if (!texRes.ok) {
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string | undefined }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: texRes.error.code, hint: texRes.error.hint });
    console.error('[learn-render 5.3.3 csm] loadByGuid failed:', texRes.error.code);
    return null;
  }
  return texRes.value;
}

function cubeMaterial(
  tex: 'wood' | 'metal' | readonly [number, number, number],
  woodHandle: ReturnType<typeof unwrapHandle>,
  metalHandle: ReturnType<typeof unwrapHandle>,
): MaterialAsset {
  if (tex === 'wood' || tex === 'metal') {
    return {
      kind: 'material',
      passes: [
        { name: 'Forward', program: { module: 'forgeax::default-standard-pbr', fragmentEntry: 'fs_main' }, renderState: { tags: { LightMode: 'Forward' }, passKind: 'forward' } },
        { name: 'ShadowCaster', program: { module: 'forgeax::default-shadow-caster' }, renderState: { tags: { LightMode: 'ShadowCaster' }, passKind: 'shadow-caster' } },
      ],
      values: {
        baseColorTexture: tex === 'wood' ? woodHandle : metalHandle,
      },
    };
  }
  const [r, g, b] = tex;
  return Materials.standard({ baseColor: [r, g, b, 1] });
}

declare global {
  interface Window {
    __learnRenderErrors?: Array<{ code: string; hint?: string | undefined }>;
    __captureCsm?: () => Promise<Uint8Array>;
    __replayCsmCapture?: typeof replayCapturedFrameInBrowser;
    __setCsmMvdProfile?: (profile: CsmMvdProfile) => void;
    __setCsmMvdScene?: (scene: CsmMvdScene) => void;
    __inspectCsmMvd?: () => unknown;
  }
}

// apps/learn-render/5.advanced-lighting/3.1.shadow-mapping/3.full/src/main.ts
// LearnOpenGL section 5.3.1 — directional production shadow.
// Wood-textured floor + 5+ cubes with directional light shadow (cascadeCount=1).
// Space toggles shadow on/off; P toggles PCF kernel size between 1 (hard) and 3 (soft).
//
// GREP anchors for AI users:
//   - "// 1. engine usage"    public engine API consumed
//   - "// 2. scene constants" D3 scene-specific constants + GUIDs
//   - "// 3. bootstrap"       entry point wiring (1)+(2)

// 1. engine usage
import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { type App } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import { AssetGuid } from '@forgeax/engine-pack/guid';

import { Transform } from '@forgeax/engine-scene';

import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';

import { Materials } from '@forgeax/engine-render';

import { createPlaneGeometry } from '@forgeax/engine-geometry';


import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { addFirstPersonSystem } from '../../../../../shared/src/learn-render-first-person';
import { captureCanvasPixels } from '../../../../../shared/src/canvas-capture';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';


// 2. scene constants



// Wood texture GUID from forgeax-engine-assets/learn-opengl/textures/wood.png.meta.json.
const WOOD_GUID_STR = '019e3969-1d48-7c3b-ac24-6d68f457065f';

// Floor: 20x20 plane on XZ at y=-0.5, normal +Y. createPlaneGeometry produces XY plane
// facing +Z, so rotate -90 deg about X to lay it flat.
const FLOOR_SIZE = 20;
const FLOOR_Y = -0.5;
const FLOOR_QUAT_X = Math.sin(-Math.PI / 4);
const FLOOR_QUAT_W = Math.cos(-Math.PI / 4);

// Camera: first-person starting at (0, 1.5, 8) looking -Z.
const CAMERA_POS_Z = 8;
const CAMERA_POS_Y = 1.5;
const CAMERA_FOV = Math.PI / 4;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 50.0;

// Directional light shadow: single cascade (degenerate CSM), 2048 atlas, PCF soft.
const SHADOW_CONFIG = {
  cascadeCount: 1,
  mapSize: 2048,
  depthBias: 0.00001,
  shadowDistance: 50,
  shadowFilter: 2,
  shadowAngularRadius: 0.00465,
  maxPenumbraTexels: 32,
};

// Cube scene objects: position, scale, color.
const CUBES = [
  { pos: [-3, 1.5, -2], scale: [1, 2, 1],color: [1, 0.3, 0.3] },
  { pos: [0, 0.5, -4], scale: [1, 1, 1],color: [0.3, 1, 0.3] },
  { pos: [3, 0.75, -1], scale: [1.5, 0.5, 1.5],color: [0.3, 0.3, 1] },
  { pos: [-4, 1, -5], scale: [0.5, 1.5, 0.5],color: [1, 1, 0.3] },
  { pos: [2, 0.5, -6], scale: [2, 1, 0.5],color: [1, 0.3, 1] },
  { pos: [-1, 0.5, -3], scale: [0.8, 0.8, 0.8],color: [0.3, 1, 1] },
] as const;

// 3. bootstrap

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 5.3.1 directional shadow] missing <canvas id='app'> in index.html");
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter(), importTransport: createRuntimeAssetImportTransport(runtimeBinding) },
  );
  if (!appRes.ok) {
    console.error('[learn-render 5.3.1 directional shadow] createApp failed:', appRes.error);
    return;
  }
  const app = appRes.value;
if (app.assets === undefined) throw new Error('This scene requires the App asset owner');

  const world = app.world;
const primitiveCube = app.assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();


  app.onError((error) => {
    console.error('[learn-render 5.3.1 directional shadow] app.onError:', error.code, error.hint);
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: error.code, hint: error.hint });
  });

  const assets = app.assets;
  if (assets === undefined) {
    console.error('[learn-render 5.3.1 directional shadow] AssetRegistry is null');
    return;
  }

  configureRuntimeAssetCatalog(assets, runtimeBinding);

  // Load wood texture through GUID pipeline.
  const woodGuidRes = AssetGuid.parse(WOOD_GUID_STR);
  if (!woodGuidRes.ok) {
    console.error('[learn-render 5.3.1 directional shadow] GUID parse failed');
    return;
  }
  const texRes = await assets.load(woodGuidRes.value, 'texture');
  if (!texRes.ok) {
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: texRes.error.code, hint: texRes.error.hint });
    console.error('[learn-render 5.3.1 directional shadow] loadByGuid failed:', texRes.error.code);
    return;
  }
  const woodTex = texRes.value;

  // Construct wood floor material POJO.
  const floorMat = assets.create({
    kind: 'material',
    passes: [
      { name: 'Forward', program: { module: 'forgeax::default-standard-pbr', fragmentEntry: 'fs_main' }, renderState: { tags: { LightMode: 'Forward' }, passKind: 'forward' } },
      { name: 'ShadowCaster', program: { module: 'forgeax::default-shadow-caster' }, renderState: { tags: { LightMode: 'ShadowCaster' }, passKind: 'shadow-caster' } },
    ],
    values: {
      baseColorTexture: Number(woodTex),
    },
  }).unwrap();

  // Floor plane: 20x20 on XZ plane at y=-0.5, normal +Y.
  const floorRes = createPlaneGeometry(FLOOR_SIZE, FLOOR_SIZE);
  if (!floorRes.ok) {
    console.error('[learn-render 5.3.1 directional shadow] createPlaneGeometry failed:', floorRes.error);
    return;
  }
  const floorMesh = assets.create(floorRes.value).unwrap();
  world.spawn(
    {
      component: Transform,
      data: { pos: [0, FLOOR_Y, 0], quat: [FLOOR_QUAT_X, 0, 0, FLOOR_QUAT_W]},
    },
    { component: MeshFilter, data: { assetHandle: floorMesh } },
    { component: MeshRenderer, data: { materials: [floorMat] } },
  ).unwrap();

  // Spawn cubes with pure-color Materials.standard.
  for (const c of CUBES) {
    const [r, g, b] = c.color;
    const mat = Materials.standard({ baseColor: [r, g, b, 1] });
    const matHandle = assets.create(mat).unwrap();
    world.spawn(
      {
        component: Transform,
        data: {
          pos: c.pos,
          quat: [0, 0, 0, 1],
          scale: c.scale,
        },
      },
      { component: MeshFilter, data: { assetHandle: primitiveCube } },
      { component: MeshRenderer, data: { materials: [matHandle] } },
    ).unwrap();
  }

  // Directional light with shadow (cascadeCount=1 degenerate CSM).
  const lightEntity = world.spawn(
    {
      component: DirectionalLight,
      data: {
        direction: [0.2, -0.98, 0],
        color: [1, 1, 1], intensity: 1,
        castShadow: true,
        ...SHADOW_CONFIG,
      },
    },
  ).unwrap();

  // Camera: first-person starting at (0, 1.5, 8).
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
    name: 'learn-render-5.3.1-first-person',
    overrideBackend: undefined,
  });

  // Shadow toggle.
  let shadowEnabled = true;

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Space') {
      e.preventDefault();
      if (shadowEnabled) {
        world.set(lightEntity, DirectionalLight, { castShadow: false });
        shadowEnabled = false;
        console.warn('[learn-render 5.3.1 directional shadow] shadow disabled via Space toggle');
      } else {
        world.set(lightEntity, DirectionalLight, {
          castShadow: true,
          cascadeCount: 1,
          mapSize: 2048,
          depthBias: 0.00001,
          shadowDistance: 50,
          shadowFilter: 2,
          shadowAngularRadius: 0.00465,
          maxPenumbraTexels: 32,
        });
        shadowEnabled = true;
        console.warn('[learn-render 5.3.1 directional shadow] shadow enabled via Space toggle');
      }
    }
  });

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 5.3.1 directional shadow] app.start failed:', startRes.error);
    return;
  }

  window.addEventListener('resize', () => {
    const dpr = devicePixelRatio;
    target.width = window.innerWidth * dpr;
    target.height = window.innerHeight * dpr;
    world.set(cameraEntity, Camera, { aspect: window.innerWidth / window.innerHeight });
  });

  installCaptureHook(app, world, target);
}

// RHI-debug live-pixel hook for the capture smoke harness (pixel mode). Drives
// one update + draw + readPixels so the live canvas read is anchored to the same
// frame the capture records. Only meaningful when the page is served with
// FORGEAX_ENGINE_RHI_DEBUG=1; harmless otherwise.
function installCaptureHook(app: App, world: App['world'], target: HTMLCanvasElement): void {
  type CaptureHook = () => Promise<Uint8Array>;
  const win = window as unknown as { __captureShadowFull?: CaptureHook };
  const renderer = app.renderer;
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const lease = attached.value;
  win.__captureShadowFull = async (): Promise<Uint8Array> => {
    world.update(1 / 60).unwrap();
    const frame = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
    if (!frame.ok) throw frame.error;
    const observed = await renderer.observe(frame.value, { include: ['draws'] });
    if (!observed.ok) throw observed.error;
    const captured = await captureCanvasPixels(target);
    if (!captured.ok) throw captured.error;
    return captured.value;
  };
}

declare global {
  interface Window {
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
    __captureShadowFull?: () => Promise<Uint8Array>;
  }
}

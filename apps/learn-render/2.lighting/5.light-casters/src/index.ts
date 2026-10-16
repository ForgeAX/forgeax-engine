import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { Update } from '@forgeax/engine-ecs';
// 1. engine usage
import { createApp } from '@forgeax/engine-app/browser';
import type { App, CanvasAppError } from '@forgeax/engine-app';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputBackend, type InputSnapshot } from '@forgeax/engine-input';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { HANDLE_CUBE, resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';

import {
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
} from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { Materials } from '@forgeax/engine-render';
import { PointLight, SpotLight } from '@forgeax/engine-render';

import { createPlaneGeometry } from '@forgeax/engine-geometry';
import type {
  MaterialAsset,
  MaterialValue,
  MeshAsset,
  TextureAsset,
} from '@forgeax/engine-types';
import { unwrapHandle } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import materialPackJson from '../assets/material-container2.pack.json';
import {
  addFirstPersonSystem,
  CAMERA_FOV_RADIANS,
  captureCanvasPixels,
  createFirstPersonControls,
  createScrollFovAccumulator,
} from '../../../../shared/src/learn-render-first-person';

// 2. example-specific glue
const CONTAINER2_TEXTURE_GUID = '019e3969-1d46-7945-a75a-ef97d537531e';
const CONTAINER2_SPECULAR_GUID = '019e3969-1d46-76ca-9a46-2168b746a292';
const CUBE_MESH_GUID = '019e3968-6007-71ae-856e-1fd6c9728cfb';
const CUBE_MATERIAL_GUID = '019e3969-2000-7000-8000-000000000002';

const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 100;
const CAMERA_PROJECTION_PERSPECTIVE = 0;

const CUBE_POSITIONS: ReadonlyArray<readonly [number, number, number]> = [
  [0.0, 0.0, 0.0],
  [2.0, 5.0, -15.0],
  [-1.5, -2.2, -2.5],
  [-3.8, -2.0, -12.3],
  [2.4, -0.4, -3.5],
  [-1.7, 3.0, -7.5],
  [1.3, -2.0, -2.5],
  [1.5, 2.0, -2.5],
  [1.5, 0.2, -1.5],
  [-1.3, 1.0, -1.5],
];

const POINT_LIGHT_POSITIONS: ReadonlyArray<readonly [number, number, number]> = [
  [0.7, 0.2, 2.0],
  [2.3, -3.3, -4.0],
  [-4.0, 2.0, -12.0],
  [0.0, 0.0, -3.0],
];

const POINT_LIGHT_COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [1.0, 1.0, 1.0],
  [1.0, 0.0, 0.0],
  [0.0, 1.0, 0.0],
  [0.0, 0.0, 1.0],
];

const CUBE_AXIS_RAW = [1.0, 0.3, 0.5] as const;
const CUBE_AXIS_LEN = Math.sqrt(
  CUBE_AXIS_RAW[0] * CUBE_AXIS_RAW[0] +
    CUBE_AXIS_RAW[1] * CUBE_AXIS_RAW[1] +
    CUBE_AXIS_RAW[2] * CUBE_AXIS_RAW[2],
);
const CUBE_AXIS = [
  CUBE_AXIS_RAW[0] / CUBE_AXIS_LEN,
  CUBE_AXIS_RAW[1] / CUBE_AXIS_LEN,
  CUBE_AXIS_RAW[2] / CUBE_AXIS_LEN,
] as const;
const CUBE_TILT_RADIANS_PER_INDEX = (20 * Math.PI) / 180;

interface MaterialPackEntry {
  readonly guid: string;
  readonly kind: string;
  readonly payload: MaterialAsset;
}

interface MaterialPackFile {
  readonly assets: ReadonlyArray<MaterialPackEntry>;
}

// 3. bootstrap
const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 2.5 light-casters] missing <canvas id='app'> in index.html");
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const winExt = window as unknown as {
    __lightCastersInputBackend?: () => InputBackend;
  };
  const overrideBackend = winExt.__lightCastersInputBackend?.();

  const bundler = {
    ...forgeaxBundlerAdapter(),
    importTransport: createRuntimeAssetImportTransport(runtimeBinding),
  };
  const appRes: { ok: true; value: App } | { ok: false; error: CanvasAppError } =
      overrideBackend === undefined
      ? await createApp(target, {}, bundler)
      : await createFirstPersonControls(target, overrideBackend, bundler);
  if (!appRes.ok) {
    reportBootstrapError(appRes.error);
    return;
  }

  const app = appRes.value;
  const world = app.world;
  const inspection = app.renderer.inspect();
  target.dataset.renderPath = inspection.profile.renderPath;
  target.dataset.backend = inspection.capabilities.backendKind;
  target.dataset.passCount = String(inspection.perFramePassNames.length);
  console.warn(
    `[learn-render 2.5 light-casters] renderPath=${inspection.profile.renderPath} ` +
      `backend=${inspection.capabilities.backendKind} passes=${inspection.perFramePassNames.length}`,
  );
  app.onError((error) => {
    console.error('[learn-render 2.5 light-casters] app.onError:', error.code, error.hint);
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: error.code, hint: error.hint });
  });

  const assets = app.assets;
  if (assets === undefined) {
    console.error('[learn-render 2.5] asset owner unavailable');
    return;
  }
  configureRuntimeAssetCatalog(assets, runtimeBinding);

  const diffuseGuid = parseGuidOrAbort('container2 texture', CONTAINER2_TEXTURE_GUID);
  const specularGuid = parseGuidOrAbort('container2 specular texture', CONTAINER2_SPECULAR_GUID);
  const cubeGuid = parseGuidOrAbort('cube mesh', CUBE_MESH_GUID);
  const materialGuid = parseGuidOrAbort('cube material', CUBE_MATERIAL_GUID);
  if (diffuseGuid === null || specularGuid === null || cubeGuid === null || materialGuid === null) {
    return;
  }

  const diffuseTextureRes = await assets.loadByGuid<TextureAsset>(diffuseGuid);
  const specularTextureRes = await assets.loadByGuid<TextureAsset>(specularGuid);
  const useTextures = diffuseTextureRes.ok && specularTextureRes.ok;
  if (!diffuseTextureRes.ok) {
    console.warn(
      '[learn-render 2.5 light-casters] continuing untextured after diffuse loadByGuid failure:',
      diffuseTextureRes.error.code,
      diffuseTextureRes.error.hint,
    );
  }
  if (!specularTextureRes.ok) {
    console.warn(
      '[learn-render 2.5 light-casters] continuing untextured after specular loadByGuid failure:',
      specularTextureRes.error.code,
      specularTextureRes.error.hint,
    );
  }

  const cubeAssetRes = resolveAssetHandle<MeshAsset>(world, HANDLE_CUBE);
  if (!cubeAssetRes.ok) {
    console.error('[learn-render 2.5 light-casters] HANDLE_CUBE asset unavailable');
    return;
  }
  assets.catalog<MeshAsset>(cubeGuid, cubeAssetRes.value);

  const materialEntry = readMaterialPackEntry(materialPackJson);
  if (materialEntry === null) {
    return;
  }
  // feat-20260523 M8-T03: the pack stores texture slots as GUID strings, but
  // the render-system extract stage binds a texture only when the slot is a
  // resolved numeric Handle. loadByGuid returns the texture PAYLOAD (M8 D-17);
  // mint a user-tier column handle via allocSharedRef for the diffuse/specular
  // slots; drop the slot on texture-load failure so the schema-driven path
  // falls back to placeholders.
  const passes = materialEntry.payload.passes;
  if (passes === undefined) {
    console.error('[learn-render 2.5 light-casters] material entry has no passes');
    return;
  }
  const valuesIn = materialEntry.payload.values ?? {};
  const filteredValues: Record<string, MaterialValue | null> = {};
  for (const [k, v] of Object.entries(valuesIn)) {
    if (k === 'baseColorTexture') {
      if (!diffuseTextureRes.ok) continue;
      filteredValues[k] = unwrapHandle(
        world.allocSharedRef('TextureAsset', diffuseTextureRes.value),
      );
      continue;
    }
    if (k === 'metallicRoughnessTexture') {
      if (!specularTextureRes.ok) continue;
      filteredValues[k] = unwrapHandle(
        world.allocSharedRef('TextureAsset', specularTextureRes.value),
      );
      continue;
    }
    filteredValues[k] = v;
  }
  const materialAsset: MaterialAsset = {
    kind: 'material',
    passes,
    values: filteredValues,
  };
  const materialHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    materialAsset,
  );
  void materialGuid;
  const cubeHandleRes = await assets.loadByGuid<MeshAsset>(cubeGuid);
  if (!cubeHandleRes.ok) {
    console.error(
      '[learn-render 2.5 light-casters] loadByGuid mesh failed:',
      cubeHandleRes.error.code,
    );
    return;
  }
  // loadByGuid returns the payload (M8 D-17); mint a user-tier column handle.
  const cubeHandle = world.allocSharedRef('MeshAsset', cubeHandleRes.value);
  void useTextures;

  for (let i = 0; i < CUBE_POSITIONS.length; i++) {
    const pos = CUBE_POSITIONS[i];
    if (pos === undefined) continue;
    const angle = i * CUBE_TILT_RADIANS_PER_INDEX;
    const halfAngle = angle * 0.5;
    const sinH = Math.sin(halfAngle);
    const cosH = Math.cos(halfAngle);
    world
      .spawn(
        {
          component: Transform,
          data: {
            pos: [pos[0], pos[1], pos[2]], quat: [CUBE_AXIS[0] * sinH, CUBE_AXIS[1] * sinH, CUBE_AXIS[2] * sinH, cosH], scale: [1, 1, 1],},
        },
        { component: MeshFilter, data: { assetHandle: cubeHandle } },
        { component: MeshRenderer, data: { materials: [materialHandle] } },
      )
      .unwrap();
  }

  // feat-20260625 spot-shadow w16: the LO 2.5 scene is 10 floating cubes with
  // no receiver surface, so a spot shadow has nowhere to land. Add a large
  // floor plane below the scene + one obstructing cube sitting on it, then a
  // FIXED SpotLight aimed at the cube so its shadow falls on the floor (AC-01).
  // The floor + obstructing cube use Materials.standard, which ships a
  // ShadowCaster pass by default, so the cube writes the spot depth atlas and
  // the floor receives via fragment binding 8/9. The existing camera-coupled
  // flashlight SpotLight is kept (AC-07 no regression); the fixed spot
  // guarantees a deterministic, camera-independent shadow.
  //
  // The sub-scene sits at x=SHADOW_X, well clear of the LO 2.5 point-light
  // cluster (x in {0.7,2.3,-4,0}, intensity 100) so the strong point-light
  // floor glow does not wash out the spot shadow. The spot is offset to the +X
  // side and angled toward -X so the cube's shadow is cast laterally (not
  // hidden directly under the cube). These coordinates match the dawn smoke
  // (scripts/smoke-dawn.mjs) so the smoke validates the real demo scene.
  const SHADOW_X = -9;
  const SHADOW_Z = -3;
  const floorMeshRes = createPlaneGeometry(30, 30);
  if (!floorMeshRes.ok) {
    console.error(
      '[learn-render 2.5 light-casters] createPlaneGeometry failed:',
      floorMeshRes.error.code,
    );
    return;
  }
  const floorMeshHandle = world.allocSharedRef('MeshAsset', floorMeshRes.value);
  const floorMatHandle = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.55, 0.55, 0.6, 1], metallic: 0, roughness: 0.9 }),
  );
  // Lay the XY plane flat on XZ (rotate -90deg about X) at y=-2.
  const FLOOR_QUAT_X = Math.sin(-Math.PI / 4);
  const FLOOR_QUAT_W = Math.cos(-Math.PI / 4);
  world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [0, -2, SHADOW_Z], quat: [FLOOR_QUAT_X, 0, 0, FLOOR_QUAT_W], scale: [1, 1, 1],},
      },
      { component: MeshFilter, data: { assetHandle: floorMeshHandle } },
      { component: MeshRenderer, data: { materials: [floorMatHandle] } },
    )
    .unwrap();

  // Obstructing cube sitting on the floor; the fixed spot casts its shadow
  // laterally onto the floor beside it.
  const obstructorMatHandle = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.85, 0.5, 0.25, 1], metallic: 0, roughness: 0.6 }),
  );
  world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [SHADOW_X, -0.6, SHADOW_Z], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [obstructorMatHandle] } },
    )
    .unwrap();

  // Fixed SpotLight offset to the +X side of the cube, angled down-and-toward
  // -X so the shadow is cast laterally onto the floor (castShadow defaults
  // true). intensity 40 keeps the spot dominant over the distant point-light
  // glow so the shadow reads clearly.
  const SPOT_DIR_LEN = Math.hypot(-0.6, -1, 0);
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [SHADOW_X + 2.2, 4, SHADOW_Z], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
    },
    {
      component: SpotLight,
      data: {
        direction: [-0.6 / SPOT_DIR_LEN, -1 / SPOT_DIR_LEN, 0],
        color: [1, 1, 1],
        intensity: 40,
        range: 50,
        innerConeDeg: 22,
        outerConeDeg: 32,
      },
    },
  );

  world.spawn(
    {
      component: Transform,
      data: {
        pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
    },
    {
      component: Camera,
      data: {
        fov: CAMERA_FOV_RADIANS,
        aspect: target.width / target.height,
        near: CAMERA_NEAR,
        far: CAMERA_FAR,
        projection: CAMERA_PROJECTION_PERSPECTIVE,
        left: -1,
        right: 1,
        bottom: -1,
        top: 1,
      },
    },
  );

  world.spawn({
    component: DirectionalLight,
    data: {
      direction: [-0.2, -1, -0.3],
      color: [1, 1, 1],
      intensity: 0.5,
    },
  });

  for (let i = 0; i < POINT_LIGHT_POSITIONS.length; i++) {
    const plPos = POINT_LIGHT_POSITIONS[i];
    const plColor = POINT_LIGHT_COLORS[i];
    if (plPos === undefined || plColor === undefined) continue;
    world.spawn(
      {
        component: Transform,
        data: {
          pos: [plPos[0], plPos[1], plPos[2]], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
      },
      {
        component: PointLight,
        data: {
          color: [plColor[0], plColor[1], plColor[2]],
          intensity: 100.0,
          range: 50,
        },
      },
    );
  }

  world.spawn(
    {
      component: Transform,
      data: {
        pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
    },
    {
      component: SpotLight,
      data: {
        direction: [0, 0, -1],
        color: [1, 1, 1],
        intensity: 4,
        range: 50,
        innerConeDeg: 12.5,
        outerConeDeg: 17.5,
      },
    },
  );

  addFirstPersonSystem(world, {
    name: 'learn-render-light-casters-first-person',
    overrideBackend,
    flashlight: { spotLightQuery: true },
  });
  addScrollFovSystem(world);

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 2.5 light-casters] app.start failed:', startRes.error.code, startRes.error.hint);
  }

  installCaptureHook(target, world);
}

// RHI-debug live-pixel hook for the capture smoke harness (pixel mode). Drives
// one update so the host canvas read is anchored to the same
// frame the capture records. Only meaningful when the page is served with
// FORGEAX_ENGINE_RHI_DEBUG=1; harmless otherwise.
function installCaptureHook(target: HTMLCanvasElement, world: App['world']): void {
  type CaptureHook = () => Promise<Uint8Array>;
  const win = window as unknown as { __captureLightCasters?: CaptureHook };
  win.__captureLightCasters = async (): Promise<Uint8Array> => {
    world.update(1 / 60).unwrap();
    const r = await captureCanvasPixels(target);
    if (!r.ok) {
      throw new Error(
        `[learn-render 2.5 light-casters] canvas capture failed: ${r.error.hint}`,
      );
    }
    return r.value;
  };
}

function addScrollFovSystem(world: App['world']): void {
  const scrollFov = createScrollFovAccumulator();
  world.addSystem(Update, {
    name: 'learn-render-light-casters-scroll-fov',
    after: ['input-frame-start-scan'],
    queries: [{ write: [Camera] }],
    fn: (world, queryResults) => {
      const snapshot = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      if (snapshot === undefined) {
        return;
      }
      scrollFov.apply(snapshot.mouse.wheelDelta);
      for (const row of queryResults[0]) row.mut(Camera).fov = scrollFov.fovRad;
    },
  });
}

function readMaterialPackEntry(rawPack: unknown): MaterialPackEntry | null {
  const materialPack = rawPack as MaterialPackFile;
  const materialEntry = materialPack.assets.find((entry) => entry.kind === 'material');
  if (materialEntry === undefined) {
    console.error('[learn-render 2.5 light-casters] material-container2.pack.json missing material entry');
    return null;
  }
  return materialEntry;
}

function parseGuidOrAbort(label: string, guidLiteral: string): AssetGuid | null {
  const guidRes = AssetGuid.parse(guidLiteral);
  if (!guidRes.ok) {
    console.error(
      `[learn-render 2.5 light-casters] invalid ${label} GUID:`,
      guidLiteral,
      guidRes.error.code,
      guidRes.error.hint,
    );
    return null;
  }
  return guidRes.value;
}

function reportBootstrapError(error: CanvasAppError): void {
  if (error instanceof EngineEnvironmentError) {
    const webgpuError = error.detail.webgpuError;
    const innerCode = webgpuError !== undefined && 'code' in webgpuError ? webgpuError.code : '<none>';
    console.error(`[learn-render 2.5 light-casters] EngineEnvironmentError: webgpu inner=${innerCode}`);
    return;
  }
  console.error(`[learn-render 2.5 light-casters] ${error.code}: ${error.hint}`);
}

declare global {
  interface Window {
    __captureLightCasters?: () => Promise<Uint8Array>;
    __lightCastersInputBackend?: () => InputBackend;
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
  }
}

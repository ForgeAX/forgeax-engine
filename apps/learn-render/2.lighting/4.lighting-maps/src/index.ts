import { createBoxGeometry } from '@forgeax/engine-geometry';
import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { Update } from '@forgeax/engine-ecs';
// LearnOpenGL section 2.lighting 4.1/4.2 lighting_maps (forgeax mapping).
//
// LO 4.x uses `vec3 lightDir = normalize(light.position - FragPos);` -- the
// source is a point light at world-space `lightPos = (1.2, 1.0, 2.0)`. forgeax
// expresses this with a `PointLight` component co-located on a small unlit
// lamp cube; the lamp's `Transform` provides both the visible marker position
// and the light's world-space position via the `[Transform, PointLight]`
// extract query. forgeax `pbr.wgsl` always applies 1/d^2 attenuation (LO 4.x
// does not), so the cube renders darker than the LO reference -- physically
// correct, not a rendering bug.
// 1. engine usage
import { createApp } from '@forgeax/engine-app/browser';
import type { App, CanvasAppError } from '@forgeax/engine-app';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputBackend, type InputSnapshot } from '@forgeax/engine-input';
import { AssetGuid } from '@forgeax/engine-pack/guid';

import { Transform } from '@forgeax/engine-scene';

import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { PointLight } from '@forgeax/engine-render';

import type { MaterialAsset, MaterialValue } from '@forgeax/engine-types';

import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import materialPackJson from '../assets/material-container2.pack.json';
import {
  addFirstPersonSystem,
  CAMERA_FOV_RADIANS,
  captureCanvasPixels,
  createFirstPersonControls,
  createScrollFovAccumulator,
} from '../../../../shared/src/learn-render-first-person';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';


// 2. example-specific glue
const CONTAINER2_TEXTURE_GUID = '019e3969-1d46-7945-a75a-ef97d537531e';
const CONTAINER2_SPECULAR_GUID = '019e3969-1d46-76ca-9a46-2168b746a292';
const CUBE_MESH_GUID = '019e3968-6007-71ae-856e-1fd6c9728cfb';
const CUBE_MATERIAL_GUID = '019e3969-2000-7000-8000-000000000001';

const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 100;
const CAMERA_PROJECTION_PERSPECTIVE = 0;
const OMIT_SPECULAR_MAP = new URLSearchParams(window.location.search).has(
  'rhi-debug-no-specular-map',
);
const OMIT_POINT_LIGHT = new URLSearchParams(window.location.search).has(
  'rhi-debug-no-light',
);

// LO canonical lamp position (`glm::vec3 lightPos(1.2f, 1.0f, 2.0f)` in
// 4.2.lighting_maps_specular_map.cpp). PointLight reads its world-space
// position from the companion Transform.
const LIGHT_POS_X = 1.2;
const LIGHT_POS_Y = 1.0;
const LIGHT_POS_Z = 2.0;
const LAMP_SCALE = 0.2;

interface MaterialPackEntry {
  readonly guid: string;
  readonly kind: string;
  // feat-20260527 M1 / w4: MaterialAsset payload from pack file (pass-based).
  readonly payload: MaterialAsset;
}

interface MaterialPackFile {
  readonly assets: ReadonlyArray<MaterialPackEntry>;
}

// 3. bootstrap
const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 2.4 lighting-maps] missing <canvas id='app'> in index.html");
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const winExt = window as unknown as {
    __lightingMapsInputBackend?: () => InputBackend;
  };
  const overrideBackend = winExt.__lightingMapsInputBackend?.();

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
if (app.assets === undefined) throw new Error('This scene requires the App asset owner');

  const world = app.world;
const primitiveCube = app.assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();

  app.onError((error) => {
    console.error('[learn-render 2.4 lighting-maps] app.onError:', error.code, error.hint);
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: error.code, hint: error.hint });
  });

  const assets = app.assets;
  if (assets === undefined) {
    console.error('[learn-render 2.4] asset owner unavailable');
    return;
  }
  configureRuntimeAssetCatalog(assets, runtimeBinding);

  const diffuseGuid = parseGuidOrAbort('container2 texture', CONTAINER2_TEXTURE_GUID);
  const specularGuid = parseGuidOrAbort('container2 specular texture', CONTAINER2_SPECULAR_GUID);
  const cubeGuid = parseGuidOrAbort('cube mesh', CUBE_MESH_GUID);
  const materialGuid = parseGuidOrAbort('container2 material', CUBE_MATERIAL_GUID);
  if (diffuseGuid === null || specularGuid === null || cubeGuid === null || materialGuid === null) {
    return;
  }

  const diffuseTextureRes = await assets.load(diffuseGuid, 'texture');
  const specularTextureRes = await assets.load(specularGuid, 'texture');
  const useTextures = diffuseTextureRes.ok && specularTextureRes.ok;
  if (!diffuseTextureRes.ok) {
    console.warn(
      '[learn-render 2.4 lighting-maps] continuing untextured after diffuse loadByGuid failure:',
      diffuseTextureRes.error.code,
      diffuseTextureRes.error.hint,
    );
  }
  if (!specularTextureRes.ok) {
    console.warn(
      '[learn-render 2.4 lighting-maps] continuing untextured after specular loadByGuid failure:',
      specularTextureRes.error.code,
      specularTextureRes.error.hint,
    );
  }

  const cubeAssetRes = createBoxGeometry(1, 1, 1);
  if (!cubeAssetRes.ok) {
    console.error('[learn-render 2.4 lighting-maps] HANDLE_CUBE asset unavailable');
    return;
  }


  const materialEntry = readMaterialPackEntry(materialPackJson);
  if (materialEntry === null) {
    return;
  }
  // feat-20260527 M1 / w4: pack payload is already pass-based MaterialAsset
  // shape. The pack stores texture slots as GUID strings; the render-system
  // extract stage only binds a texture when values.<slot> is a resolved
  // numeric Handle (string GUIDs fall through to the 1x1 white placeholder).
  // loadByGuid returns the texture PAYLOAD (M8 D-17); mint a user-tier column
  // handle via allocSharedRef for the diffuse/specular slots. On texture-load
  // failure drop the slot so the shader falls back to the placeholder.
  const passes = materialEntry.payload.passes;
  if (passes === undefined) {
    console.error('[learn-render 2.4 lighting-maps] material entry has no passes');
    return;
  }
  const valuesIn = materialEntry.payload.values ?? {};
  const filteredValues: Record<string, MaterialValue | null> = {};
  for (const [k, v] of Object.entries(valuesIn)) {
    if (k === 'baseColorTexture') {
      if (!diffuseTextureRes.ok) continue;
      filteredValues[k] = Number(
        diffuseTextureRes.value,
      );
      continue;
    }
    if (k === 'metallicRoughnessTexture') {
      if (OMIT_SPECULAR_MAP) continue;
      if (!specularTextureRes.ok) continue;
      filteredValues[k] = Number(
        specularTextureRes.value,
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
  const materialHandle = assets.create(materialAsset).unwrap();
  // The materialGuid round-trip is no longer needed — the demo uses the
  // minted handle directly.
  void materialGuid;
  const cubeHandleRes = assets.create(cubeAssetRes.value);
  if (!cubeHandleRes.ok) {
    console.error(
      '[learn-render 2.4 lighting-maps] loadByGuid mesh failed:',
      cubeHandleRes.error.code,
    );
    return;
  }
  // loadByGuid returns the payload (M8 D-17); mint a user-tier column handle.
  const cubeHandle = cubeHandleRes.value;
  void useTextures;

  world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
      },
      { component: MeshFilter, data: { assetHandle: cubeHandle } },
      { component: MeshRenderer, data: { materials: [materialHandle] } },
    )
    .unwrap();

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

  // Lamp marker + co-located PointLight (single entity). LO 4.2
  // renders a small white cube at lightPos via lightCubeShader; here the
  // unlit baseColor=(1,1,1) cube fills the same role, while the PointLight
  // on the same entity reads its position from the companion Transform.
  const lampMatHandle = assets.create({
    kind: 'material',
    passes: [{ name: 'Forward', program: { module: 'forgeax::default-unlit' }, renderState: { tags: { LightMode: 'Forward' }, queue: 2000 } }],
    values: { baseColor: [1, 1, 1, 1] },
  }).unwrap();

  const lampComponents = [
    {
      component: Transform,
      data: {
        pos: [LIGHT_POS_X, LIGHT_POS_Y, LIGHT_POS_Z],
        quat: [0, 0, 0, 1],
        scale: [LAMP_SCALE, LAMP_SCALE, LAMP_SCALE],
      },
    },
    { component: MeshFilter, data: { assetHandle: primitiveCube } },
    { component: MeshRenderer, data: { materials: [lampMatHandle] } },
    ...(OMIT_POINT_LIGHT
      ? []
      : [{ component: PointLight, data: { color: [1, 1, 1], intensity: 100.0, range: 50 } }]),
  ];
  world.spawn(...lampComponents).unwrap();

  addFirstPersonSystem(world, {
    name: 'learn-render-lighting-maps-first-person',
    overrideBackend,
  });
  addScrollFovSystem(world);

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 2.4 lighting-maps] app.start failed:', startRes.error.code, startRes.error.hint);
  }

  installCaptureHook(target, world);
}

// RHI-debug live-pixel hook for the capture smoke harness (pixel mode). Drives
// one update so the host canvas read is anchored to the same
// frame the capture records. Only meaningful when the page is served with
// FORGEAX_ENGINE_RHI_DEBUG=1; harmless otherwise.
function installCaptureHook(target: HTMLCanvasElement, world: App['world']): void {
  type CaptureHook = () => Promise<Uint8Array>;
  const win = window as unknown as { __captureLightingMaps?: CaptureHook };
  win.__captureLightingMaps = async (): Promise<Uint8Array> => {
    world.update(1 / 60).unwrap();
    const r = await captureCanvasPixels(target);
    if (!r.ok) {
      throw new Error(
        `[learn-render 2.4 lighting-maps] canvas capture failed: ${r.error.hint}`,
      );
    }
    return r.value;
  };
}

function readMaterialPackEntry(rawPack: unknown): MaterialPackEntry | null {
  const materialPack = rawPack as MaterialPackFile;
  const materialEntry = materialPack.assets.find((entry) => entry.kind === 'material');
  if (materialEntry === undefined) {
    console.error('[learn-render 2.4 lighting-maps] material-container2.pack.json missing material entry');
    return null;
  }
  return materialEntry;
}

function parseGuidOrAbort(label: string, guidLiteral: string): AssetGuid | null {
  const guidRes = AssetGuid.parse(guidLiteral);
  if (!guidRes.ok) {
    console.error(
      `[learn-render 2.4 lighting-maps] invalid ${label} GUID:`,
      guidLiteral,
      guidRes.error.code,
      guidRes.error.hint,
    );
    return null;
  }
  return guidRes.value;
}

function addScrollFovSystem(world: App['world']): void {
  const scrollFov = createScrollFovAccumulator();
  world.addSystem(Update, {
    name: 'learn-render-lighting-maps-scroll-fov',
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

function reportBootstrapError(error: CanvasAppError): void {
  if (error instanceof EngineEnvironmentError) {
    const webgpuError = error.detail.webgpuError;
    const innerCode = webgpuError !== undefined && 'code' in webgpuError ? webgpuError.code : '<none>';
    console.error(`[learn-render 2.4 lighting-maps] EngineEnvironmentError: webgpu inner=${innerCode}`);
    return;
  }
  console.error(`[learn-render 2.4 lighting-maps] ${error.code}: ${error.hint}`);
}

declare global {
  interface Window {
    __captureLightingMaps?: () => Promise<Uint8Array>;
    __lightingMapsInputBackend?: () => InputBackend;
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
  }
}

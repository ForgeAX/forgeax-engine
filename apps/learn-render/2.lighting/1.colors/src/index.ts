import { createBoxGeometry } from '@forgeax/engine-geometry';
import { Update } from '@forgeax/engine-ecs';
// apps/learn-render/2.lighting/1.colors/src/index.ts
// LearnOpenGL section 2.lighting 1.colors (forgeax mapping).
//
// LO 2.1 covers the concept that object color and light color combine
// via per-component multiplication in the fragment shader. The LO scene
// places a colored cube at origin, a white lamp cube at the light
// position, and computes `ambient + diffuse` in Phong style.
//
// In forgeax, the same concept is expressed through the engine PBR
// pipeline (standard material + DirectionalLight component + unlit
// lamp marker). The visual differs from the LO Phong implementation,
// but the conceptual lesson -- object color interacts with light color
// -- is preserved.
// 1. engine usage
import { createApp } from '@forgeax/engine-app/browser';
import type { App, CanvasAppError } from '@forgeax/engine-app';
import { World } from '@forgeax/engine-ecs';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputBackend, type InputSnapshot } from '@forgeax/engine-input';
import { vec3 } from '@forgeax/engine-math';

import { Transform } from '@forgeax/engine-scene';

import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { Materials } from '@forgeax/engine-render';

import type { AssetRegistry, SamplerAsset, TextureAsset } from '@forgeax/engine-assets-runtime';
import type { AssetHandle, MaterialAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  addFirstPersonSystem,
  CAMERA_FOV_RADIANS,
  captureCanvasPixels,
  createFirstPersonControls,
  createScrollFovAccumulator,
} from '../../../../shared/src/learn-render-first-person';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';


// 2. example-specific glue

// Object color (LO: `glm::vec3(1.0f, 0.5f, 0.31f)`)
const OBJECT_BASE_COLOR = [1.0, 0.5, 0.31, 1.0] as const;

// Light color (LO: `glm::vec3(1.0f, 1.0f, 1.0f)`)
const LIGHT_COLOR_R = 1.0;
const LIGHT_COLOR_G = 1.0;
const LIGHT_COLOR_B = 1.0;

// Light position (LO: `glm::vec3 lightPos(1.2f, 1.0f, 2.0f)`)
const LIGHT_POS_X = 1.2;
const LIGHT_POS_Y = 1.0;
const LIGHT_POS_Z = 2.0;

// Light direction (from light position toward origin, normalized).
// LO computes `normalize(lightPos - FragPos)`; forgeax DirectionalLight
// .direction points FROM light TOWARD surface, hence `normalize(-lightPos)`.
const LIGHT_DIR = vec3.normalize(vec3.create(), [-LIGHT_POS_X, -LIGHT_POS_Y, -LIGHT_POS_Z]);

const LAMP_SCALE = 0.2;
const CAMERA_POS_Z = 3;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 100;
const FALSIFY_BASE_COLOR_TEXTURE_SAMPLER =
  import.meta.env.VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_SAMPLER ?? '';
const USE_BASE_COLOR_TEXTURE_SAMPLER = FALSIFY_BASE_COLOR_TEXTURE_SAMPLER !== '';
const FALSIFY_BASE_COLOR_TEXTURE_UV_TRANSFORM =
  import.meta.env.VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_TRANSFORM ?? '';
const USE_BASE_COLOR_TEXTURE_UV_TRANSFORM = FALSIFY_BASE_COLOR_TEXTURE_UV_TRANSFORM !== '';
const FALSIFY_BASE_COLOR_TEXTURE_UV_SET =
  import.meta.env.VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_SET ?? '';
const USE_BASE_COLOR_TEXTURE_UV_SET = FALSIFY_BASE_COLOR_TEXTURE_UV_SET !== '';
const FALSIFY_BASE_COLOR_TEXTURE_RED =
  import.meta.env.VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RED ?? '';
const USE_BASE_COLOR_TEXTURE_RED = FALSIFY_BASE_COLOR_TEXTURE_RED !== '';
const FALSIFY_BASE_COLOR_TEXTURE_GREEN =
  import.meta.env.VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_GREEN ?? '';
const USE_BASE_COLOR_TEXTURE_GREEN = FALSIFY_BASE_COLOR_TEXTURE_GREEN !== '';
const FALSIFY_BASE_COLOR_TEXTURE_BLUE =
  import.meta.env.VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_BLUE ?? '';
const USE_BASE_COLOR_TEXTURE_BLUE = FALSIFY_BASE_COLOR_TEXTURE_BLUE !== '';
const FALSIFY_BASE_COLOR_TEXTURE_RGB =
  import.meta.env.VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RGB ?? '';
const USE_BASE_COLOR_TEXTURE_RGB = FALSIFY_BASE_COLOR_TEXTURE_RGB !== '';
const FALSIFY_BASE_COLOR_TEXTURE_ALPHA =
  import.meta.env.VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_ALPHA ?? '';
const USE_BASE_COLOR_TEXTURE_ALPHA = FALSIFY_BASE_COLOR_TEXTURE_ALPHA !== '';
const FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_MIN_FILTER =
  import.meta.env.VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_SAMPLER_MIN_FILTER ?? '';
const USE_BASE_COLOR_TEXTURE_SAMPLER_MIN_FILTER =
  FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_MIN_FILTER !== '';
const FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_MIPMAP_FILTER =
  import.meta.env.VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_SAMPLER_MIPMAP_FILTER ?? '';
const USE_BASE_COLOR_TEXTURE_SAMPLER_MIPMAP_FILTER =
  FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_MIPMAP_FILTER !== '';
const FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_LOD_MAX_CLAMP =
  import.meta.env.VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_SAMPLER_LOD_MAX_CLAMP ?? '';
const USE_BASE_COLOR_TEXTURE_SAMPLER_LOD_MAX_CLAMP =
  FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_LOD_MAX_CLAMP !== '';
const FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_LOD_MIN_CLAMP =
  import.meta.env.VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_SAMPLER_LOD_MIN_CLAMP ?? '';
const USE_BASE_COLOR_TEXTURE_SAMPLER_LOD_MIN_CLAMP =
  FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_LOD_MIN_CLAMP !== '';
const FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_ADDRESS =
  import.meta.env.VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_SAMPLER_ADDRESS ?? '';
const USE_BASE_COLOR_TEXTURE_SAMPLER_ADDRESS =
  FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_ADDRESS !== '';
const FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_MAG_FILTER =
  import.meta.env.VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_SAMPLER_MAG_FILTER ?? '';
const USE_BASE_COLOR_TEXTURE_SAMPLER_MAG_FILTER =
  FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_MAG_FILTER !== '';
const FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_MAX_ANISOTROPY =
  import.meta.env.VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_SAMPLER_MAX_ANISOTROPY ?? '';
const USE_BASE_COLOR_TEXTURE_SAMPLER_MAX_ANISOTROPY =
  FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_MAX_ANISOTROPY !== '';
const USE_BASE_COLOR_TEXTURE_SAMPLER_FORENSICS =
  USE_BASE_COLOR_TEXTURE_SAMPLER ||
  USE_BASE_COLOR_TEXTURE_SAMPLER_ADDRESS ||
  USE_BASE_COLOR_TEXTURE_SAMPLER_MAG_FILTER ||
  USE_BASE_COLOR_TEXTURE_SAMPLER_MIN_FILTER ||
  USE_BASE_COLOR_TEXTURE_SAMPLER_MIPMAP_FILTER ||
  USE_BASE_COLOR_TEXTURE_SAMPLER_LOD_MAX_CLAMP ||
  USE_BASE_COLOR_TEXTURE_SAMPLER_LOD_MIN_CLAMP ||
  USE_BASE_COLOR_TEXTURE_SAMPLER_MAX_ANISOTROPY;
const FALSIFY_BASE_COLOR_TEXTURE_SRGB =
  import.meta.env.VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_SRGB ?? '';
const USE_BASE_COLOR_TEXTURE_SRGB = FALSIFY_BASE_COLOR_TEXTURE_SRGB !== '';
const FALSIFY_BASE_COLOR_TEXTURE_MIPMAP =
  import.meta.env.VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_MIPMAP ?? '';
const USE_BASE_COLOR_TEXTURE_MIPMAP = FALSIFY_BASE_COLOR_TEXTURE_MIPMAP !== '';
const FALSIFY_MATERIAL_ROUGHNESS_CHANNEL =
  import.meta.env.VITE_FALSIFY_MATERIAL_ROUGHNESS_CHANNEL ?? '';
const USE_MATERIAL_ROUGHNESS_CHANNEL = FALSIFY_MATERIAL_ROUGHNESS_CHANNEL !== '';
const FALSIFY_MATERIAL_METALLIC_CHANNEL =
  import.meta.env.VITE_FALSIFY_MATERIAL_METALLIC_CHANNEL ?? '';
const USE_MATERIAL_METALLIC_CHANNEL = FALSIFY_MATERIAL_METALLIC_CHANNEL !== '';
const FALSIFY_MATERIAL_CLEARCOAT = import.meta.env.VITE_FALSIFY_MATERIAL_CLEARCOAT ?? '';
const USE_MATERIAL_CLEARCOAT = FALSIFY_MATERIAL_CLEARCOAT !== '';
const FALSIFY_MATERIAL_CLEARCOAT_ROUGHNESS =
  import.meta.env.VITE_FALSIFY_MATERIAL_CLEARCOAT_ROUGHNESS ?? '';
const USE_MATERIAL_CLEARCOAT_ROUGHNESS = FALSIFY_MATERIAL_CLEARCOAT_ROUGHNESS !== '';
const FALSIFY_MATERIAL_EMISSIVE_INTENSITY =
  import.meta.env.VITE_FALSIFY_MATERIAL_EMISSIVE_INTENSITY ?? '';
const USE_MATERIAL_EMISSIVE_INTENSITY = FALSIFY_MATERIAL_EMISSIVE_INTENSITY !== '';
const FALSIFY_MATERIAL_ALPHA_CUTOFF = import.meta.env.VITE_FALSIFY_MATERIAL_ALPHA_CUTOFF ?? '';
const USE_MATERIAL_ALPHA_CUTOFF = FALSIFY_MATERIAL_ALPHA_CUTOFF !== '';
const FALSIFY_MATERIAL_OCCLUSION_STRENGTH =
  import.meta.env.VITE_FALSIFY_MATERIAL_OCCLUSION_STRENGTH ?? '';
const USE_MATERIAL_OCCLUSION_STRENGTH = FALSIFY_MATERIAL_OCCLUSION_STRENGTH !== '';
const FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_UV_TRANSFORM =
  import.meta.env.VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_UV_TRANSFORM ?? '';
const USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_UV_TRANSFORM =
  FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_UV_TRANSFORM !== '';
const FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_UV_SET =
  import.meta.env.VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_UV_SET ?? '';
const USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_UV_SET =
  FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_UV_SET !== '';
const FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER =
  import.meta.env.VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER ?? '';
const USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER =
  FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER !== '';
const FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAG_FILTER =
  import.meta.env.VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAG_FILTER ?? '';
const USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAG_FILTER =
  FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAG_FILTER !== '';
const FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIN_FILTER =
  import.meta.env.VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIN_FILTER ?? '';
const USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIN_FILTER =
  FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIN_FILTER !== '';
const FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS =
  import.meta.env.VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS ?? '';
const USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS =
  FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS !== '';
const FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIPMAP_FILTER =
  import.meta.env.VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIPMAP_FILTER ?? '';
const USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIPMAP_FILTER =
  FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIPMAP_FILTER !== '';
const FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MIN_CLAMP =
  import.meta.env.VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MIN_CLAMP ?? '';
const USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MIN_CLAMP =
  FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MIN_CLAMP !== '';
const FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MAX_CLAMP =
  import.meta.env.VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MAX_CLAMP ?? '';
const USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MAX_CLAMP =
  FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MAX_CLAMP !== '';
const FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAX_ANISOTROPY =
  import.meta.env.VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAX_ANISOTROPY ?? '';
const USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAX_ANISOTROPY =
  FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAX_ANISOTROPY !== '';
const FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_MIPMAP =
  import.meta.env.VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_MIPMAP ?? '';
const USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_MIPMAP =
  FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_MIPMAP !== '';
const USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_COORDINATES =
  USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_UV_TRANSFORM ||
  USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_UV_SET;
const USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE =
  USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_COORDINATES ||
  USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER ||
  USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAG_FILTER ||
  USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIN_FILTER ||
  USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS ||
  USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIPMAP_FILTER ||
  USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MIN_CLAMP ||
  USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MAX_CLAMP ||
  USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAX_ANISOTROPY ||
  USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_MIPMAP;
/** Any metallic-roughness lane that binds an explicit sampler. */
const USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_OVERRIDE =
  USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER ||
  USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAG_FILTER ||
  USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIN_FILTER ||
  USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS ||
  USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIPMAP_FILTER ||
  USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MIN_CLAMP ||
  USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MAX_CLAMP ||
  USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAX_ANISOTROPY ||
  USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_MIPMAP;
/** Metallic-roughness lanes that sample the mipmapped 4x4 forensic texture. */
const USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_4X4 =
  USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_MIPMAP ||
  USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIPMAP_FILTER ||
  USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIN_FILTER ||
  USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MIN_CLAMP ||
  USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MAX_CLAMP ||
  USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAX_ANISOTROPY;
/** Filter lanes that clamp to LOD 0.5 and drive roughness to 1. */
const USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_LOD_HALF =
  USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIPMAP_FILTER ||
  USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIN_FILTER;
const METALLIC_ROUGHNESS_TEXTURE_UV_TRANSFORM = {
  offset: [0.25, 0.25] as [number, number],
  scale: [0, 0] as [number, number],
  rotation: 0,
};
const METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MAX_CLAMP_COORDINATES = {
  offset: [0.375, 0.375] as [number, number],
  scale: [192, 192] as [number, number],
  rotation: 0,
};
const METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAX_ANISOTROPY_COORDINATES = {
  offset: [0.375, 0.375] as [number, number],
  scale: [192, 8] as [number, number],
  rotation: 0,
};
const METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS_UV = [1.25, 0.75] as [number, number];
const BASE_COLOR_TEXTURE_UV_TRANSFORM = {
  offset: [0.25, 0.25] as [number, number],
  scale: [0, 0] as [number, number],
  rotation: 0,
};
const BASE_COLOR_TEXTURE_SAMPLER_MAX_ANISOTROPY_COORDINATES = {
  offset: [0.375, 0.375] as [number, number],
  scale: [192, 8] as [number, number],
  rotation: 0,
};
const BASE_COLOR_TEXTURE_SAMPLER_LOD_MAX_CLAMP_COORDINATES = {
  offset: [0.375, 0.375] as [number, number],
  scale: [192, 192] as [number, number],
  rotation: 0,
};
const BASE_COLOR_TEXTURE_SAMPLER_LOD_MIN_CLAMP_COORDINATES = {
  offset: [0, 0] as [number, number],
  scale: [1, 1] as [number, number],
  rotation: 0,
};


// 3. bootstrap

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 2.lighting 1.colors] missing <canvas id='app'> in index.html");
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const winExt = window as unknown as { __colorsInputBackend?: () => InputBackend };
  const overrideBackend = winExt.__colorsInputBackend?.();

  const bundler = forgeaxBundlerAdapter();
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
  const assets = app.assets;

  const renderer = app.renderer;
  const world = app.world;
  const primitiveCube = assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();

  app.onError((e) => {
    console.error('[learn-render 2.lighting 1.colors] app.onError:', e.code, e.hint);
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: e.code, hint: e.hint });
  });

  // The engine ships HANDLE_CUBE as the procedural cube; MeshFilter uses it
  // directly below (no per-demo GUID round-trip needed).

  // feat-20260523 M8-T03: schema-driven material; paramSchema declared inline
  // so the demo stays self-contained without a .pack.json sidecar.
  const baseColorTexture = baseColorTextureAsset();
  const baseColorTextureHandle = baseColorTexture === undefined ? undefined : assets.create(baseColorTexture).unwrap();
  const baseColorSampler = baseColorSamplerAsset();
  const baseColorSamplerHandle = baseColorSampler === undefined ? undefined : assets.create(baseColorSampler).unwrap();
  const standardMaterial = objectStandardMaterial();
  const occlusionTextureHandle = USE_MATERIAL_OCCLUSION_STRENGTH
    ? assets.create(occlusionTextureAsset()).unwrap()
    : undefined;
  const metallicRoughnessTexture = metallicRoughnessTextureAsset();
  const metallicRoughnessTextureHandle =
    metallicRoughnessTexture === undefined ? undefined : assets.create(metallicRoughnessTexture).unwrap();
  const metallicRoughnessSampler = metallicRoughnessSamplerAsset();
  const metallicRoughnessSamplerHandle =
    metallicRoughnessSampler === undefined ? undefined : assets.create(metallicRoughnessSampler).unwrap();
  const textureValues =
    metallicRoughnessMaterialValues(
      occlusionTextureHandle,
      metallicRoughnessTextureHandle,
      metallicRoughnessSamplerHandle,
    ) ?? baseColorMaterialValues(baseColorTextureHandle, baseColorSamplerHandle);
  const objectMaterial: MaterialAsset =
    textureValues === undefined ? standardMaterial : withTextureValues(standardMaterial, textureValues);
  logBaseColorTextureFalsifiers();
  logBaseColorChannelFalsifiers();
  logBaseColorSamplerFalsifiers();
  logMaterialScalarFalsifiers();
  logMetallicRoughnessTextureFalsifiers();
  logMetallicRoughnessSamplerFalsifiers();
  const objectMeshHandle = createObjectMesh(assets, primitiveCube);
  if (objectMeshHandle === undefined) return;
  const objectMatHandle = assets.create(objectMaterial).unwrap();

  // Unlit material for the lamp cube (always renders white, like LO's
  // separate light cube shader).
  const lampMatHandle = assets.create(Materials.unlit([1.0, 1.0, 1.0, 1.0])).unwrap();

  // Spawn the colored object cube at origin (LO: cube at origin).
  world
    .spawn(
      {
        component: Transform,
        data: {},
      },
      { component: MeshFilter, data: { assetHandle: objectMeshHandle } },
      { component: MeshRenderer, data: { materials: [objectMatHandle] } },
    )
    .unwrap();

  // Spawn the lamp cube at the light position (LO: separate white cube).
  world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [LIGHT_POS_X, LIGHT_POS_Y, LIGHT_POS_Z], scale: [LAMP_SCALE, LAMP_SCALE, LAMP_SCALE],},
      },
      { component: MeshFilter, data: { assetHandle: primitiveCube } },
      { component: MeshRenderer, data: { materials: [lampMatHandle] } },
    )
    .unwrap();

  // Spawn a directional light pointing from lamp position toward the cube
  // (LO: Phong diffuse formula with `normalize(lightPos - FragPos)`).
  world.spawn({
    component: DirectionalLight,
    data: { castShadow: true,
      direction: [LIGHT_DIR[0] ?? 0, LIGHT_DIR[1] ?? 0, LIGHT_DIR[2] ?? 0],
      color: [LIGHT_COLOR_R, LIGHT_COLOR_G, LIGHT_COLOR_B],
      intensity: 1.0,
    },
  });

  // Spawn camera at LO initial pose (0,0,3) yaw=-90 deg pitch=0; first-person
  // system below drives WASD/mouse/scroll on top of this spawn.
  const cameraAspect = target.width / target.height;
  world.spawn(
    {
      component: Transform,
      data: { pos: [0, 0, CAMERA_POS_Z]},
    },
    {
      component: Camera,
      data: perspective({
        fov: CAMERA_FOV_RADIANS,
        aspect: cameraAspect,
        near: CAMERA_NEAR,
        far: CAMERA_FAR,
      }),
    },
  ).unwrap();

  addFirstPersonSystem(world, {
    name: 'learn-render-colors-first-person',
    overrideBackend,
  });
  addScrollFovSystem(world);

  installCaptureHook(target, world);

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 2.lighting 1.colors] app.start failed:', startRes.error);
    return;
  }
  console.warn(`[learn-render 2.lighting 1.colors] backend=${renderer.inspect().capabilities.backendKind}`);
  if (USE_BASE_COLOR_TEXTURE_SAMPLER_MAX_ANISOTROPY) {
    console.warn(
      `[learn-render 2.lighting 1.colors] sampler maxAnisotropy=${FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_MAX_ANISOTROPY === '1' ? 16 : 1}`,
    );
  }
}

type TextureHandle = AssetHandle<'texture'>;
type SamplerHandle = AssetHandle<'sampler'>;
type MaterialTextureValues = Record<string, unknown>;

function linearRgba8Texture(
  width: number,
  height: number,
  data: readonly number[],
  mips: TextureAsset['mips'],
): TextureAsset {
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width, height } },
    format: 'rgba8unorm',
    data: new Uint8Array(data),
    colorSpace: 'linear',
    mips,
  };
}

/** 4x4 black texture whose single white texel (row 1, column 1) exposes mip/filter selection. */
const BASE_COLOR_4X4_CENTER_WHITE = [
  0, 0, 0, 255,
  0, 0, 0, 255,
  0, 0, 0, 255,
  0, 0, 0, 255,
  0, 0, 0, 255,
  255, 255, 255, 255,
  0, 0, 0, 255,
  0, 0, 0, 255,
  0, 0, 0, 255,
  0, 0, 0, 255,
  0, 0, 0, 255,
  0, 0, 0, 255,
  0, 0, 0, 255,
  0, 0, 0, 255,
  0, 0, 0, 255,
  0, 0, 0, 255,
];

/** 2x2 black texture whose first texel is white. */
const BASE_COLOR_2X2_FIRST_WHITE = [
  255, 255, 255, 255,
  0, 0, 0, 255,
  0, 0, 0, 255,
  0, 0, 0, 255,
];

/** Uniform 2x2 payload for the per-channel base-color falsifiers, or undefined when none is selected. */
function baseColorChannelTextureTexel(): readonly number[] | undefined {
  if (USE_BASE_COLOR_TEXTURE_RED) return [128, 255, 255, 255];
  if (USE_BASE_COLOR_TEXTURE_GREEN) return [255, 128, 255, 255];
  if (USE_BASE_COLOR_TEXTURE_BLUE) return [255, 255, 128, 255];
  if (USE_BASE_COLOR_TEXTURE_RGB) return [128, 128, 128, 255];
  if (USE_BASE_COLOR_TEXTURE_ALPHA) return [255, 255, 255, FALSIFY_BASE_COLOR_TEXTURE_ALPHA === '0.5' ? 128 : 0];
  return undefined;
}

function baseColorTextureAsset(): TextureAsset | undefined {
  if (USE_BASE_COLOR_TEXTURE_MIPMAP) {
    return linearRgba8Texture(
      4,
      4,
      BASE_COLOR_4X4_CENTER_WHITE,
      FALSIFY_BASE_COLOR_TEXTURE_MIPMAP === '1' ? { kind: 'generate' } : { kind: 'none' },
    );
  }
  if (USE_BASE_COLOR_TEXTURE_SRGB) {
    return {
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
      format: FALSIFY_BASE_COLOR_TEXTURE_SRGB === '1' ? 'rgba8unorm-srgb' : 'rgba8unorm',
      data: new Uint8Array([128, 128, 128, 255]),
      colorSpace: FALSIFY_BASE_COLOR_TEXTURE_SRGB === '1' ? 'srgb' : 'linear',
      mips: { kind: 'none' },
    };
  }
  if (USE_BASE_COLOR_TEXTURE_UV_TRANSFORM) {
    return linearRgba8Texture(2, 2, BASE_COLOR_2X2_FIRST_WHITE, { kind: 'none' });
  }
  if (USE_BASE_COLOR_TEXTURE_UV_SET) {
    return linearRgba8Texture(2, 2, [0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255], {
      kind: 'none',
    });
  }
  const channelTexel = baseColorChannelTextureTexel();
  if (channelTexel !== undefined) {
    return linearRgba8Texture(2, 2, [...channelTexel, ...channelTexel, ...channelTexel, ...channelTexel], {
      kind: 'none',
    });
  }
  if (USE_BASE_COLOR_TEXTURE_SAMPLER || USE_BASE_COLOR_TEXTURE_SAMPLER_ADDRESS || USE_BASE_COLOR_TEXTURE_SAMPLER_MAG_FILTER) {
    return linearRgba8Texture(2, 2, BASE_COLOR_2X2_FIRST_WHITE, { kind: 'none' });
  }
  if (USE_BASE_COLOR_TEXTURE_SAMPLER_FORENSICS) {
    return linearRgba8Texture(4, 4, BASE_COLOR_4X4_CENTER_WHITE, { kind: 'generate' });
  }
  return undefined;
}

function baseColorSamplerAsset(): SamplerAsset | undefined {
  if (USE_BASE_COLOR_TEXTURE_MIPMAP) {
    return {
      kind: 'sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      addressModeW: 'repeat',
      lodMinClamp: 2,
      lodMaxClamp: 2,
    };
  }
  if (USE_BASE_COLOR_TEXTURE_SAMPLER) {
    return {
      kind: 'sampler',
      magFilter: 'nearest',
      minFilter: 'nearest',
      mipmapFilter: 'nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
    };
  }
  if (USE_BASE_COLOR_TEXTURE_SAMPLER_LOD_MIN_CLAMP) {
    return {
      kind: 'sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      addressModeW: 'repeat',
      lodMinClamp: FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_LOD_MIN_CLAMP === '1' ? 1 : 0,
      lodMaxClamp: 1,
    };
  }
  if (USE_BASE_COLOR_TEXTURE_SAMPLER_LOD_MAX_CLAMP) {
    return {
      kind: 'sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      addressModeW: 'repeat',
      lodMinClamp: 0,
      lodMaxClamp: FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_LOD_MAX_CLAMP === '1' ? 0 : 1,
    };
  }
  return baseColorFilterSamplerAsset();
}

/** Base-color samplers for the mipmap/address/mag/min filter and anisotropy falsifiers. */
function baseColorFilterSamplerAsset(): SamplerAsset | undefined {
  if (USE_BASE_COLOR_TEXTURE_SAMPLER_MIPMAP_FILTER) {
    return {
      kind: 'sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_MIPMAP_FILTER === '1' ? 'linear' : 'nearest',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      addressModeW: 'repeat',
    };
  }
  if (USE_BASE_COLOR_TEXTURE_SAMPLER_ADDRESS) {
    const address = FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_ADDRESS === '1' ? 'clamp-to-edge' : 'repeat';
    return {
      kind: 'sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'nearest',
      addressModeU: address,
      addressModeV: address,
      addressModeW: address,
    };
  }
  if (USE_BASE_COLOR_TEXTURE_SAMPLER_MAG_FILTER) {
    return {
      kind: 'sampler',
      magFilter: FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_MAG_FILTER === '1' ? 'nearest' : 'linear',
      minFilter: 'linear',
      mipmapFilter: 'nearest',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      addressModeW: 'repeat',
    };
  }
  if (USE_BASE_COLOR_TEXTURE_SAMPLER_MIN_FILTER) {
    return {
      kind: 'sampler',
      magFilter: 'linear',
      minFilter: FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_MIN_FILTER === '1' ? 'nearest' : 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
      lodMinClamp: 1,
      lodMaxClamp: 1,
    };
  }
  if (USE_BASE_COLOR_TEXTURE_SAMPLER_MAX_ANISOTROPY) {
    return {
      kind: 'sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      addressModeW: 'repeat',
      ...(FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_MAX_ANISOTROPY === '1' ? { maxAnisotropy: 16 } : {}),
    };
  }
  return undefined;
}

function objectStandardMaterial(): MaterialAsset {
  return Materials.standard({
    baseColor: [
      OBJECT_BASE_COLOR[0],
      OBJECT_BASE_COLOR[1],
      OBJECT_BASE_COLOR[2],
      FALSIFY_MATERIAL_ALPHA_CUTOFF === '1' ? 0.25 : 1,
    ],
    metallic: USE_MATERIAL_METALLIC_CHANNEL ? 1.0 : 0.0,
    roughness: USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_LOD_HALF ? 1.0 : 0.5,
    ...(USE_MATERIAL_ROUGHNESS_CHANNEL
      ? { roughnessChannel: Number.parseInt(FALSIFY_MATERIAL_ROUGHNESS_CHANNEL, 10) }
      : {}),
    ...(USE_MATERIAL_METALLIC_CHANNEL
      ? { metallicChannel: Number.parseInt(FALSIFY_MATERIAL_METALLIC_CHANNEL, 10) }
      : {}),
    ...(USE_MATERIAL_CLEARCOAT
      ? { clearcoat: Number.parseFloat(FALSIFY_MATERIAL_CLEARCOAT) }
      : {}),
    ...(USE_MATERIAL_CLEARCOAT_ROUGHNESS
      ? {
          clearcoat: 1.0,
          clearcoatRoughness: Number.parseFloat(FALSIFY_MATERIAL_CLEARCOAT_ROUGHNESS),
        }
      : {}),
    ...(USE_MATERIAL_EMISSIVE_INTENSITY
      ? {
          emissive: [1.0, 0.1, 0.1],
          emissiveIntensity: Number.parseFloat(FALSIFY_MATERIAL_EMISSIVE_INTENSITY),
        }
      : {}),
    ...(USE_MATERIAL_ALPHA_CUTOFF
      ? {
          alphaCutoff:
            FALSIFY_MATERIAL_ALPHA_CUTOFF === '1'
              ? 0.5
              : Number.parseFloat(FALSIFY_MATERIAL_ALPHA_CUTOFF),
        }
      : {}),
    ...(USE_MATERIAL_OCCLUSION_STRENGTH
      ? { occlusionStrength: Number.parseFloat(FALSIFY_MATERIAL_OCCLUSION_STRENGTH) }
      : {}),
  });
}

function occlusionTextureAsset(): TextureAsset {
  return linearRgba8Texture(1, 1, [0, 0, 0, 255], { kind: 'none' });
}

function metallicRoughnessTextureData(): readonly number[] {
  if (USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_4X4) {
    return [
      0, 255, 0, 255,
      0, 255, 0, 255,
      0, 255, 0, 255,
      0, 255, 0, 255,
      0, 255, 0, 255,
      0, 0, 0, 255,
      0, 0, 0, 255,
      0, 255, 0, 255,
      0, 255, 0, 255,
      0, 0, 0, 255,
      0, 0, 0, 255,
      0, 255, 0, 255,
      0, 255, 0, 255,
      0, 255, 0, 255,
      0, 255, 0, 255,
      0, 255, 0, 255,
    ];
  }
  if (
    USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAG_FILTER ||
    USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS
  ) {
    return [0, 0, 0, 255, 0, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 255];
  }
  if (FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_UV_SET !== '') {
    return [0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 255, 0, 255];
  }
  return [0, 255, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255];
}

function metallicRoughnessTextureMips(): TextureAsset['mips'] {
  return USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIPMAP_FILTER ||
    USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIN_FILTER ||
    USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MIN_CLAMP ||
    USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MAX_CLAMP ||
    USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAX_ANISOTROPY ||
    (USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_MIPMAP &&
      FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_MIPMAP === '1')
    ? { kind: 'generate' }
    : { kind: 'none' };
}

function metallicRoughnessTextureAsset(): TextureAsset | undefined {
  if (USE_MATERIAL_METALLIC_CHANNEL) {
    return linearRgba8Texture(1, 1, [255, 255, 0, 255], { kind: 'none' });
  }
  if (USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE) {
    const size = USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_4X4 ? 4 : 2;
    return linearRgba8Texture(size, size, metallicRoughnessTextureData(), metallicRoughnessTextureMips());
  }
  if (USE_MATERIAL_ROUGHNESS_CHANNEL) {
    return linearRgba8Texture(1, 1, [0, 255, 0, 255], { kind: 'none' });
  }
  return undefined;
}

function metallicRoughnessSamplerMagFilter(): GPUFilterMode {
  if (USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAG_FILTER) {
    return FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAG_FILTER === '1' ? 'nearest' : 'linear';
  }
  return USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS ||
    FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER === '1'
    ? 'nearest'
    : 'linear';
}

function metallicRoughnessSamplerMinFilter(): GPUFilterMode {
  if (USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIN_FILTER) {
    return FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIN_FILTER === '1' ? 'nearest' : 'linear';
  }
  return USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS ||
    FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER === '1'
    ? 'nearest'
    : 'linear';
}

function metallicRoughnessSamplerMipmapFilter(): GPUMipmapFilterMode {
  if (USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAG_FILTER) return 'nearest';
  if (USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIPMAP_FILTER) {
    return FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIPMAP_FILTER === '1' ? 'nearest' : 'linear';
  }
  return USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS ||
    FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER === '1'
    ? 'nearest'
    : 'linear';
}

function metallicRoughnessSamplerAddressMode(): GPUAddressMode {
  if (!USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS) return 'clamp-to-edge';
  return FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS === '1' ? 'clamp-to-edge' : 'repeat';
}

function metallicRoughnessSamplerLodAndAnisotropy(): Pick<SamplerAsset, 'lodMinClamp' | 'lodMaxClamp' | 'maxAnisotropy'> {
  if (USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_LOD_HALF) return { lodMinClamp: 0.5, lodMaxClamp: 0.5 };
  if (USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MAX_CLAMP) {
    return {
      lodMinClamp: 0,
      lodMaxClamp: FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MAX_CLAMP === '1' ? 0 : 1,
    };
  }
  if (USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MIN_CLAMP) {
    return {
      lodMinClamp: FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MIN_CLAMP === '1' ? 1 : 0,
      lodMaxClamp: 1,
    };
  }
  if (USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAX_ANISOTROPY) {
    return FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAX_ANISOTROPY === '1' ? { maxAnisotropy: 16 } : {};
  }
  if (USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_MIPMAP) return { lodMinClamp: 1, lodMaxClamp: 1 };
  return {};
}

function metallicRoughnessSamplerAsset(): SamplerAsset | undefined {
  if (!USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_OVERRIDE) return undefined;
  const address = metallicRoughnessSamplerAddressMode();
  return {
    kind: 'sampler',
    magFilter: metallicRoughnessSamplerMagFilter(),
    minFilter: metallicRoughnessSamplerMinFilter(),
    mipmapFilter: metallicRoughnessSamplerMipmapFilter(),
    addressModeU: address,
    addressModeV: address,
    addressModeW: address,
    ...metallicRoughnessSamplerLodAndAnisotropy(),
  };
}

function metallicRoughnessCoordinates(): MaterialTextureValues {
  if (USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAX_ANISOTROPY) {
    return { coordinates: { transform: METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAX_ANISOTROPY_COORDINATES } };
  }
  if (USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MAX_CLAMP) {
    return { coordinates: { transform: METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MAX_CLAMP_COORDINATES } };
  }
  if (FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_UV_TRANSFORM === '1') {
    return { coordinates: { transform: METALLIC_ROUGHNESS_TEXTURE_UV_TRANSFORM } };
  }
  if (FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_UV_SET === '1') return { coordinates: { set: 1 } };
  return {};
}

/** Occlusion / metallic-roughness texture values; these take precedence over base-color lanes. */
function metallicRoughnessMaterialValues(
  occlusionTexture: TextureHandle | undefined,
  metallicRoughnessTexture: TextureHandle | undefined,
  metallicRoughnessSampler: SamplerHandle | undefined,
): MaterialTextureValues | undefined {
  if (USE_MATERIAL_OCCLUSION_STRENGTH) return { occlusionTexture: { texture: occlusionTexture! } };
  if (USE_MATERIAL_METALLIC_CHANNEL || USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE) {
    return {
      metallicRoughnessTexture: {
        texture: metallicRoughnessTexture!,
        ...(USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_OVERRIDE ? { sampler: metallicRoughnessSampler! } : {}),
        ...metallicRoughnessCoordinates(),
      },
    };
  }
  if (USE_MATERIAL_ROUGHNESS_CHANNEL) return { metallicRoughnessTexture: { texture: metallicRoughnessTexture! } };
  return undefined;
}

function baseColorMaterialValues(
  texture: TextureHandle | undefined,
  sampler: SamplerHandle | undefined,
): MaterialTextureValues | undefined {
  const binding = baseColorTextureBinding(texture, sampler);
  return binding === undefined ? undefined : { baseColorTexture: binding };
}

function baseColorTextureBinding(
  texture: TextureHandle | undefined,
  sampler: SamplerHandle | undefined,
): MaterialTextureValues | undefined {
  if (USE_BASE_COLOR_TEXTURE_MIPMAP) return { texture: texture!, sampler: sampler! };
  if (USE_BASE_COLOR_TEXTURE_UV_TRANSFORM) {
    return { texture: texture!, coordinates: { transform: BASE_COLOR_TEXTURE_UV_TRANSFORM } };
  }
  if (USE_BASE_COLOR_TEXTURE_UV_SET) return { texture: texture!, coordinates: { set: 1 } };
  if (
    USE_BASE_COLOR_TEXTURE_RED ||
    USE_BASE_COLOR_TEXTURE_GREEN ||
    USE_BASE_COLOR_TEXTURE_BLUE ||
    USE_BASE_COLOR_TEXTURE_RGB ||
    USE_BASE_COLOR_TEXTURE_ALPHA
  ) {
    return { texture: texture! };
  }
  return baseColorSamplerBinding(texture, sampler);
}

function baseColorSamplerBinding(
  texture: TextureHandle | undefined,
  sampler: SamplerHandle | undefined,
): MaterialTextureValues | undefined {
  if (USE_BASE_COLOR_TEXTURE_SAMPLER) return { texture: texture!, sampler: sampler! };
  if (USE_BASE_COLOR_TEXTURE_SAMPLER_LOD_MIN_CLAMP) {
    return {
      texture: texture!,
      sampler: sampler!,
      coordinates: { transform: BASE_COLOR_TEXTURE_SAMPLER_LOD_MIN_CLAMP_COORDINATES },
    };
  }
  if (USE_BASE_COLOR_TEXTURE_SAMPLER_LOD_MAX_CLAMP) {
    return {
      texture: texture!,
      sampler: sampler!,
      coordinates: { transform: BASE_COLOR_TEXTURE_SAMPLER_LOD_MAX_CLAMP_COORDINATES },
    };
  }
  if (USE_BASE_COLOR_TEXTURE_SAMPLER_MIPMAP_FILTER) return { texture: texture!, sampler: sampler! };
  if (USE_BASE_COLOR_TEXTURE_SRGB) return { texture: texture! };
  if (
    USE_BASE_COLOR_TEXTURE_SAMPLER_ADDRESS ||
    USE_BASE_COLOR_TEXTURE_SAMPLER_MAG_FILTER ||
    USE_BASE_COLOR_TEXTURE_SAMPLER_MIN_FILTER
  ) {
    return { texture: texture!, sampler: sampler! };
  }
  if (USE_BASE_COLOR_TEXTURE_SAMPLER_MAX_ANISOTROPY) {
    return {
      texture: texture!,
      sampler: sampler!,
      coordinates: { transform: BASE_COLOR_TEXTURE_SAMPLER_MAX_ANISOTROPY_COORDINATES },
    };
  }
  return undefined;
}

// Browser demo materials normally carry AssetGuid values; this forensic lane
// deliberately exercises the already-supported ECS-resident handle form.
function withTextureValues(standardMaterial: MaterialAsset, values: MaterialTextureValues): MaterialAsset {
  return {
    ...standardMaterial,
    values: {
      ...standardMaterial.values,
      ...values,
    },
  } as unknown as MaterialAsset;
}

function logBaseColorTextureFalsifiers(): void {
  if (USE_BASE_COLOR_TEXTURE_MIPMAP) {
    console.log(
      `[learn-render 2.lighting 1.colors] base-color texture mipmap=${FALSIFY_BASE_COLOR_TEXTURE_MIPMAP} format=rgba8unorm mipLevelCount=${FALSIFY_BASE_COLOR_TEXTURE_MIPMAP === '1' ? 3 : 1}`,
    );
  }
  if (USE_BASE_COLOR_TEXTURE_SRGB) {
    console.log(
      `[learn-render 2.lighting 1.colors] base-color texture format=${FALSIFY_BASE_COLOR_TEXTURE_SRGB === '1' ? 'rgba8unorm-srgb' : 'rgba8unorm'} colorSpace=${FALSIFY_BASE_COLOR_TEXTURE_SRGB === '1' ? 'srgb' : 'linear'}`,
    );
  }
  if (USE_BASE_COLOR_TEXTURE_SAMPLER_MIN_FILTER) {
    const filter = FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_MIN_FILTER === '1' ? 'nearest' : 'linear';
    console.log(
      `[learn-render 2.lighting 1.colors] base-color texture sampler minFilter=${filter} filters=linear/${filter}/linear address=clamp-to-edge lod=1/1 texture=rgba8unorm 4x4 mipmap=true`,
    );
  }
  if (USE_BASE_COLOR_TEXTURE_SAMPLER) {
    console.log(
      '[learn-render 2.lighting 1.colors] base-color texture sampler filters=nearest/nearest/nearest address=clamp-to-edge texture=rgba8unorm 2x2 mipmap=false',
    );
  }
  if (USE_BASE_COLOR_TEXTURE_UV_TRANSFORM) {
    console.log(
      `[learn-render 2.lighting 1.colors] base-color texture coordinates transform=${JSON.stringify(BASE_COLOR_TEXTURE_UV_TRANSFORM)} texture=rgba8unorm 2x2`,
    );
  }
  if (USE_BASE_COLOR_TEXTURE_UV_SET) {
    console.log(
      `[learn-render 2.lighting 1.colors] base-color texture UV set=${FALSIFY_BASE_COLOR_TEXTURE_UV_SET} texture=rgba8unorm 2x2 coordinates.set=1`,
    );
  }
}

function logBaseColorChannelFalsifiers(): void {
  if (USE_BASE_COLOR_TEXTURE_RED) {
    console.log(
      `[learn-render 2.lighting 1.colors] base-color texture red=${FALSIFY_BASE_COLOR_TEXTURE_RED} texture=rgba8unorm 2x2 [R=128,G=255,B=255,A=255]`,
    );
  }
  if (USE_BASE_COLOR_TEXTURE_GREEN) {
    console.log(
      `[learn-render 2.lighting 1.colors] base-color texture green=${FALSIFY_BASE_COLOR_TEXTURE_GREEN} texture=rgba8unorm 2x2 [R=255,G=128,B=255,A=255]`,
    );
  }
  if (USE_BASE_COLOR_TEXTURE_BLUE) {
    console.log(
      `[learn-render 2.lighting 1.colors] base-color texture blue=${FALSIFY_BASE_COLOR_TEXTURE_BLUE} texture=rgba8unorm 2x2 [R=255,G=255,B=128,A=255]`,
    );
  }
  if (USE_BASE_COLOR_TEXTURE_RGB) {
    console.log(
      `[learn-render 2.lighting 1.colors] base-color texture rgb=${FALSIFY_BASE_COLOR_TEXTURE_RGB} texture=rgba8unorm 2x2 [R=128,G=128,B=128,A=255]`,
    );
  }
  if (USE_BASE_COLOR_TEXTURE_ALPHA) {
    console.log(
      `[learn-render 2.lighting 1.colors] base-color texture alpha=${FALSIFY_BASE_COLOR_TEXTURE_ALPHA} texture=rgba8unorm 2x2 [R=255,G=255,B=255,A=${FALSIFY_BASE_COLOR_TEXTURE_ALPHA === '0.5' ? 128 : 0}]`,
    );
  }
}

function logBaseColorSamplerFalsifiers(): void {
  if (USE_BASE_COLOR_TEXTURE_SAMPLER_MAG_FILTER) {
    const filter = FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_MAG_FILTER === '1' ? 'nearest' : 'linear';
    console.log(
      `[learn-render 2.lighting 1.colors] base-color texture sampler magFilter=${filter} filters=${filter}/linear/nearest address=repeat texture=rgba8unorm 2x2 mipmap=false`,
    );
  }
  if (USE_BASE_COLOR_TEXTURE_SAMPLER_MIPMAP_FILTER) {
    const filter =
      FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_MIPMAP_FILTER === '1' ? 'linear' : 'nearest';
    console.log(
      `[learn-render 2.lighting 1.colors] base-color texture sampler mipmapFilter=${filter} filters=linear/linear/${filter} address=repeat texture=rgba8unorm 4x4 mipmap=true`,
    );
  }
  if (USE_BASE_COLOR_TEXTURE_SAMPLER_LOD_MAX_CLAMP) {
    const lodMaxClamp =
      FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_LOD_MAX_CLAMP === '1' ? 0 : 1;
    console.log(
      `[learn-render 2.lighting 1.colors] base-color texture sampler lodMinClamp=0 lodMaxClamp=${lodMaxClamp} filters=linear/linear/linear coordinates.scale=192/192 texture=rgba8unorm 4x4 mipmap=true`,
    );
  }
  if (USE_BASE_COLOR_TEXTURE_SAMPLER_LOD_MIN_CLAMP) {
    const lodMinClamp = FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_LOD_MIN_CLAMP === '1' ? 1 : 0;
    console.log(
      `[learn-render 2.lighting 1.colors] base-color texture sampler lodMinClamp=${lodMinClamp} lodMaxClamp=1 filters=linear/linear/linear coordinates.scale=1/1 texture=rgba8unorm 4x4 mipmap=true`,
    );
  }
  if (USE_BASE_COLOR_TEXTURE_SAMPLER_ADDRESS) {
    const address =
      FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_ADDRESS === '1' ? 'clamp-to-edge' : 'repeat';
    console.log(
      `[learn-render 2.lighting 1.colors] base-color texture sampler address=${address} filters=linear/linear/nearest texture=rgba8unorm 2x2 mipmap=false`,
    );
  }
}

function logMaterialScalarFalsifiers(): void {
  if (USE_MATERIAL_ROUGHNESS_CHANNEL) {
    console.log(
      `[learn-render 2.lighting 1.colors] roughness channel=${FALSIFY_MATERIAL_ROUGHNESS_CHANNEL} texture=rgba8unorm [R=0,G=1,B=0,A=1]`,
    );
  }
  if (USE_MATERIAL_METALLIC_CHANNEL) {
    console.log(
      `[learn-render 2.lighting 1.colors] metallic channel=${FALSIFY_MATERIAL_METALLIC_CHANNEL} texture=rgba8unorm [R=1,G=1,B=0,A=1]`,
    );
  }
  if (USE_MATERIAL_CLEARCOAT) {
    console.log(
      `[learn-render 2.lighting 1.colors] clearcoat=${FALSIFY_MATERIAL_CLEARCOAT} UBO byteOffset=72`,
    );
  }
  if (USE_MATERIAL_CLEARCOAT_ROUGHNESS) {
    console.log(
      `[learn-render 2.lighting 1.colors] clearcoatRoughness=${FALSIFY_MATERIAL_CLEARCOAT_ROUGHNESS} UBO byteOffset=76`,
    );
  }
  if (USE_MATERIAL_EMISSIVE_INTENSITY) {
    console.log(
      `[learn-render 2.lighting 1.colors] emissiveIntensity=${FALSIFY_MATERIAL_EMISSIVE_INTENSITY} UBO byteOffset=60`,
    );
  }
  if (USE_MATERIAL_OCCLUSION_STRENGTH) {
    console.log(
      `[learn-render 2.lighting 1.colors] occlusionStrength=${FALSIFY_MATERIAL_OCCLUSION_STRENGTH} UBO byteOffset=64 texture=rgba8unorm 1x1 black`,
    );
  }
  if (USE_MATERIAL_ALPHA_CUTOFF) {
    const alphaCutoff =
      FALSIFY_MATERIAL_ALPHA_CUTOFF === '1'
        ? 0.5
        : Number.parseFloat(FALSIFY_MATERIAL_ALPHA_CUTOFF);
    console.log(
      `[learn-render 2.lighting 1.colors] alphaCutoff=${FALSIFY_MATERIAL_ALPHA_CUTOFF} value=${alphaCutoff} UBO byteOffset=68 baseColorAlpha=${FALSIFY_MATERIAL_ALPHA_CUTOFF === '1' ? 0.25 : 1}`,
    );
  }
}

function logMetallicRoughnessTextureFalsifiers(): void {
  if (USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_UV_TRANSFORM) {
    console.log(
      `[learn-render 2.lighting 1.colors] metallic-roughness texture UV transform=${FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_UV_TRANSFORM} texture=rgba8unorm 2x2 transform=${JSON.stringify(METALLIC_ROUGHNESS_TEXTURE_UV_TRANSFORM)}`,
    );
  }
  if (FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_UV_SET === '1') {
    console.log(
      `[learn-render 2.lighting 1.colors] metallic-roughness texture UV set=${FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_UV_SET} texture=rgba8unorm 2x2 coordinates.set=1`,
    );
  }
  if (USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER) {
    const filter = FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER === '1' ? 'nearest' : 'linear';
    console.log(
      `[learn-render 2.lighting 1.colors] metallic-roughness texture sampler=${FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER} filters=${filter}/${filter}/${filter} address=clamp-to-edge`,
    );
  }
  if (USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAG_FILTER) {
    const filter =
      FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAG_FILTER === '1'
        ? 'nearest'
        : 'linear';
    console.log(
      `[learn-render 2.lighting 1.colors] metallic-roughness texture sampler magFilter=${filter} filters=${filter}/linear/nearest address=clamp-to-edge uv=default-cube-footprint`,
    );
  }
  if (USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIN_FILTER) {
    const filter =
      FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIN_FILTER === '1'
        ? 'nearest'
        : 'linear';
    console.log(
      `[learn-render 2.lighting 1.colors] metallic-roughness texture sampler minFilter=${filter} filters=linear/${filter}/linear address=clamp-to-edge uv=default-cube-footprint lod=0.5/0.5 roughness=1 texture=rgba8unorm 4x4 mipmap=true`,
    );
  }
  if (USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS) {
    const address = FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS === '1'
      ? 'clamp-to-edge'
      : 'repeat';
    console.log(
      `[learn-render 2.lighting 1.colors] metallic-roughness texture sampler address=${FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS} addressModeU/V/W=${address} uv=${JSON.stringify(METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS_UV)}`,
    );
  }
}

function logMetallicRoughnessSamplerFalsifiers(): void {
  if (USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIPMAP_FILTER) {
    const filter =
      FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIPMAP_FILTER === '1'
        ? 'nearest'
        : 'linear';
    console.log(
      `[learn-render 2.lighting 1.colors] metallic-roughness texture sampler mipmapFilter=${filter} filters=linear/linear/${filter} lod=0.5/0.5 roughness=1 texture=rgba8unorm 4x4 mipmap=true`,
    );
  }
  if (USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MIN_CLAMP) {
    console.log(
      `[learn-render 2.lighting 1.colors] metallic-roughness texture sampler lodMinClamp=${FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MIN_CLAMP === '1' ? 1 : 0} lodMaxClamp=1 filters=linear/linear/linear texture=rgba8unorm 4x4 mipmap=true`,
    );
  }
  if (USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MAX_CLAMP) {
    console.log(
      `[learn-render 2.lighting 1.colors] metallic-roughness texture sampler lodMinClamp=0 lodMaxClamp=${FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MAX_CLAMP === '1' ? 0 : 1} filters=linear/linear/linear coordinates.scale=192/192 texture=rgba8unorm 4x4 mipmap=true`,
    );
  }
  if (USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAX_ANISOTROPY) {
    console.log(
      `[learn-render 2.lighting 1.colors] metallic-roughness texture sampler maxAnisotropy=${FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAX_ANISOTROPY === '1' ? 16 : 1} filters=linear/linear/linear address=clamp-to-edge coordinates.scale=192/8 texture=rgba8unorm 4x4 mipmap=true`,
    );
  }
  if (USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_MIPMAP) {
    console.log(
      `[learn-render 2.lighting 1.colors] metallic-roughness texture mipmap=${FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_MIPMAP} texture=rgba8unorm 4x4 lod=1/1`,
    );
  }
}

/** The forensic object mesh: a UV-override or second-UV cube when a lane needs one, otherwise the primitive cube. */
function createObjectMesh(assets: AssetRegistry, primitiveCube: AssetHandle<'mesh'>): AssetHandle<'mesh'> | undefined {
  if (USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS) return createSamplerAddressCubeMesh(assets);
  if (FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_UV_SET === '1') {
    return createUv1CubeMesh(assets, 'metallic-roughness UV set');
  }
  if (USE_BASE_COLOR_TEXTURE_UV_SET && !USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_UV_SET) {
    return createUv1CubeMesh(assets, 'base-color UV set');
  }
  return primitiveCube;
}

function readCubeGeometry(purpose: string) {
  const cubeAssetRes = createBoxGeometry(1, 1, 1);
  if (!cubeAssetRes.ok) {
    console.error(`[learn-render 2.lighting 1.colors] HANDLE_CUBE asset unavailable for ${purpose}`);
    return undefined;
  }
  const cubeAsset = cubeAssetRes.value;
  const positions = cubeAsset.attributes.position;
  const normals = cubeAsset.attributes.normal;
  const uvs = cubeAsset.attributes.uv;
  const tangents = cubeAsset.attributes.tangent;
  const aabb = cubeAsset.aabb;
  if (
    positions === undefined ||
    normals === undefined ||
    uvs === undefined ||
    tangents === undefined ||
    aabb === undefined
  ) {
    console.error(
      `[learn-render 2.lighting 1.colors] HANDLE_CUBE lacks the attributes required for ${purpose}`,
    );
    return undefined;
  }
  const cubeVertexCount = positions.byteLength / Float32Array.BYTES_PER_ELEMENT / 3;
  const cubeBaseStride = cubeVertexCount > 0 ? cubeAsset.vertices.length / cubeVertexCount : 0;
  return { cubeAsset, positions, normals, uvs, tangents, aabb, cubeVertexCount, cubeBaseStride };
}

function createSamplerAddressCubeMesh(assets: AssetRegistry): AssetHandle<'mesh'> | undefined {
  const cube = readCubeGeometry('metallic-roughness sampler address');
  if (cube === undefined) return undefined;
  const { cubeAsset, positions, normals, uvs, tangents, aabb, cubeVertexCount, cubeBaseStride } = cube;
  const samplerAddressCubeVertices = new Float32Array(cubeAsset.vertices);
  const samplerAddressCubeUv = new Float32Array(uvs);
  for (let i = 0; i < cubeVertexCount; i++) {
    const offset = i * cubeBaseStride;
    samplerAddressCubeVertices[offset + 6] = METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS_UV[0];
    samplerAddressCubeVertices[offset + 7] = METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS_UV[1];
    samplerAddressCubeUv[i * 2] = METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS_UV[0];
    samplerAddressCubeUv[i * 2 + 1] = METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS_UV[1];
  }
  return assets.create({
    ...cubeAsset,
    vertices: samplerAddressCubeVertices,
    attributes: {
      position: new Float32Array(positions),
      normal: new Float32Array(normals),
      uv: samplerAddressCubeUv,
      tangent: new Float32Array(tangents),
    },
    aabb: new Float32Array(aabb),
  }).unwrap();
}

/** Cube with an appended constant uv1 = (0.75, 0.75) so second-UV-set sampling is observable. */
function createUv1CubeMesh(assets: AssetRegistry, purpose: string): AssetHandle<'mesh'> | undefined {
  const cube = readCubeGeometry(purpose);
  if (cube === undefined) return undefined;
  const { cubeAsset, positions, normals, uvs, tangents, aabb, cubeVertexCount, cubeBaseStride } = cube;
  const multiUvCubeVertices = new Float32Array(cubeVertexCount * (cubeBaseStride + 2));
  const multiUvCubeUv1 = new Float32Array(cubeVertexCount * 2);
  for (let i = 0; i < cubeVertexCount; i++) {
    const sourceOffset = i * cubeBaseStride;
    const targetOffset = i * (cubeBaseStride + 2);
    multiUvCubeVertices.set(
      cubeAsset.vertices.subarray(sourceOffset, sourceOffset + cubeBaseStride),
      targetOffset,
    );
    multiUvCubeVertices[targetOffset + cubeBaseStride] = 0.75;
    multiUvCubeVertices[targetOffset + cubeBaseStride + 1] = 0.75;
    multiUvCubeUv1[i * 2] = 0.75;
    multiUvCubeUv1[i * 2 + 1] = 0.75;
  }
  return assets.create({
    ...cubeAsset,
    vertices: multiUvCubeVertices,
    attributes: {
      position: new Float32Array(positions),
      normal: new Float32Array(normals),
      uv: new Float32Array(uvs),
      tangent: new Float32Array(tangents),
      uv1: multiUvCubeUv1,
    },
    aabb: new Float32Array(aabb),
  }).unwrap();
}

function installCaptureHook(
  target: HTMLCanvasElement,
  world: World,
): void {
  type CaptureHook = () => Promise<Uint8Array>;
  const win = window as unknown as { __captureColors?: CaptureHook };
  win.__captureColors = async (): Promise<Uint8Array> => {
    world.update(1 / 60).unwrap();
    const r = await captureCanvasPixels(target);
    if (!r.ok) {
      throw new Error(
        `[learn-render 2.lighting 1.colors] canvas capture failed: ${r.error.hint}`,
      );
    }
    return r.value;
  };
}

function addScrollFovSystem(world: App['world']): void {
  const scrollFov = createScrollFovAccumulator();
  world.addSystem(Update, {
    name: 'learn-render-colors-scroll-fov',
    after: ['input-frame-start-scan'],
    queries: [{ write: [Camera] }],
    fn: (world, queryResults) => {
      const snapshot = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      if (snapshot === undefined) return;
      scrollFov.apply(snapshot.mouse.wheelDelta);
      for (const row of queryResults[0]) row.mut(Camera).fov = scrollFov.fovRad;
    },
  });
}

function reportBootstrapError(err: CanvasAppError): void {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[learn-render 2.lighting 1.colors] EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  console.error(`[learn-render 2.lighting 1.colors] ${err.code}: ${err.hint}`);
}

declare global {
  interface Window {
    __captureColors?: () => Promise<Uint8Array>;
    __colorsInputBackend?: () => InputBackend;
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
  }
}

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
import { HANDLE_CUBE, resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';

import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { Materials } from '@forgeax/engine-render';

import type { MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  addFirstPersonSystem,
  CAMERA_FOV_RADIANS,
  captureCanvasPixels,
  createFirstPersonControls,
  createScrollFovAccumulator,
} from '../../../../shared/src/learn-render-first-person';

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
  const renderer = app.renderer;
  const world = app.world;

  app.onError((e) => {
    console.error('[learn-render 2.lighting 1.colors] app.onError:', e.code, e.hint);
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: e.code, hint: e.hint });
  });

  // The engine ships HANDLE_CUBE as the procedural cube; MeshFilter uses it
  // directly below (no per-demo GUID round-trip needed).

  // feat-20260523 M8-T03: schema-driven material; paramSchema declared inline
  // so the demo stays self-contained without a .pack.json sidecar.
  const baseColorTextureHandle = USE_BASE_COLOR_TEXTURE_MIPMAP
    ? world.allocSharedRef('TextureAsset', {
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
        format: 'rgba8unorm',
        data: new Uint8Array([
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
        ]),
        colorSpace: 'linear',
        mips: FALSIFY_BASE_COLOR_TEXTURE_MIPMAP === '1' ? { kind: 'generate' } : { kind: 'none' },
      })
    : USE_BASE_COLOR_TEXTURE_SRGB
    ? world.allocSharedRef('TextureAsset', {
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
        format: FALSIFY_BASE_COLOR_TEXTURE_SRGB === '1' ? 'rgba8unorm-srgb' : 'rgba8unorm',
        data: new Uint8Array([128, 128, 128, 255]),
        colorSpace: FALSIFY_BASE_COLOR_TEXTURE_SRGB === '1' ? 'srgb' : 'linear',
        mips: { kind: 'none' },
      })
    : USE_BASE_COLOR_TEXTURE_UV_TRANSFORM
    ? world.allocSharedRef('TextureAsset', {
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
        format: 'rgba8unorm',
        data: new Uint8Array([
          255, 255, 255, 255,
          0, 0, 0, 255,
          0, 0, 0, 255,
          0, 0, 0, 255,
        ]),
        colorSpace: 'linear',
        mips: { kind: 'none' },
      })
    : USE_BASE_COLOR_TEXTURE_UV_SET
    ? world.allocSharedRef('TextureAsset', {
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
        format: 'rgba8unorm',
        data: new Uint8Array([
          0, 0, 0, 255,
          0, 0, 0, 255,
          0, 0, 0, 255,
          255, 255, 255, 255,
        ]),
        colorSpace: 'linear',
        mips: { kind: 'none' },
      })
    : USE_BASE_COLOR_TEXTURE_RED
    ? world.allocSharedRef('TextureAsset', {
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
        format: 'rgba8unorm',
        data: new Uint8Array([
          128, 255, 255, 255,
          128, 255, 255, 255,
          128, 255, 255, 255,
          128, 255, 255, 255,
        ]),
        colorSpace: 'linear',
        mips: { kind: 'none' },
      })
    : USE_BASE_COLOR_TEXTURE_GREEN
    ? world.allocSharedRef('TextureAsset', {
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
        format: 'rgba8unorm',
        data: new Uint8Array([
          255, 128, 255, 255,
          255, 128, 255, 255,
          255, 128, 255, 255,
          255, 128, 255, 255,
        ]),
        colorSpace: 'linear',
        mips: { kind: 'none' },
      })
    : USE_BASE_COLOR_TEXTURE_BLUE
    ? world.allocSharedRef('TextureAsset', {
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
        format: 'rgba8unorm',
        data: new Uint8Array([
          255, 255, 128, 255,
          255, 255, 128, 255,
          255, 255, 128, 255,
          255, 255, 128, 255,
        ]),
        colorSpace: 'linear',
        mips: { kind: 'none' },
      })
    : USE_BASE_COLOR_TEXTURE_RGB
    ? world.allocSharedRef('TextureAsset', {
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
        format: 'rgba8unorm',
        data: new Uint8Array([
          128, 128, 128, 255,
          128, 128, 128, 255,
          128, 128, 128, 255,
          128, 128, 128, 255,
        ]),
        colorSpace: 'linear',
        mips: { kind: 'none' },
      })
    : USE_BASE_COLOR_TEXTURE_ALPHA
    ? world.allocSharedRef('TextureAsset', {
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
        format: 'rgba8unorm',
        data: new Uint8Array([
          255, 255, 255, FALSIFY_BASE_COLOR_TEXTURE_ALPHA === '0.5' ? 128 : 0,
          255, 255, 255, FALSIFY_BASE_COLOR_TEXTURE_ALPHA === '0.5' ? 128 : 0,
          255, 255, 255, FALSIFY_BASE_COLOR_TEXTURE_ALPHA === '0.5' ? 128 : 0,
          255, 255, 255, FALSIFY_BASE_COLOR_TEXTURE_ALPHA === '0.5' ? 128 : 0,
        ]),
        colorSpace: 'linear',
        mips: { kind: 'none' },
      })
    : USE_BASE_COLOR_TEXTURE_SAMPLER
    ? world.allocSharedRef('TextureAsset', {
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
        format: 'rgba8unorm',
        data: new Uint8Array([
          255, 255, 255, 255,
          0, 0, 0, 255,
          0, 0, 0, 255,
          0, 0, 0, 255,
        ]),
        colorSpace: 'linear',
        mips: { kind: 'none' },
      })
    : USE_BASE_COLOR_TEXTURE_SAMPLER_ADDRESS
    ? world.allocSharedRef('TextureAsset', {
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
        format: 'rgba8unorm',
        data: new Uint8Array([
          255, 255, 255, 255,
          0, 0, 0, 255,
          0, 0, 0, 255,
          0, 0, 0, 255,
        ]),
        colorSpace: 'linear',
        mips: { kind: 'none' },
      })
    : USE_BASE_COLOR_TEXTURE_SAMPLER_MAG_FILTER
    ? world.allocSharedRef('TextureAsset', {
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
        format: 'rgba8unorm',
        data: new Uint8Array([
          255, 255, 255, 255,
          0, 0, 0, 255,
          0, 0, 0, 255,
          0, 0, 0, 255,
        ]),
        colorSpace: 'linear',
        mips: { kind: 'none' },
      })
    : USE_BASE_COLOR_TEXTURE_SAMPLER_FORENSICS
    ? world.allocSharedRef('TextureAsset', {
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
        format: 'rgba8unorm',
        data: new Uint8Array([
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
        ]),
        colorSpace: 'linear',
        mips: { kind: 'generate' },
      })
    : undefined;
  const baseColorSamplerHandle = USE_BASE_COLOR_TEXTURE_MIPMAP
    ? world.allocSharedRef('SamplerAsset', {
        kind: 'sampler',
        magFilter: 'linear',
        minFilter: 'linear',
        mipmapFilter: 'linear',
        addressModeU: 'repeat',
        addressModeV: 'repeat',
        addressModeW: 'repeat',
        lodMinClamp: 2,
        lodMaxClamp: 2,
      })
    : USE_BASE_COLOR_TEXTURE_SAMPLER
    ? world.allocSharedRef('SamplerAsset', {
        kind: 'sampler',
        magFilter: 'nearest',
        minFilter: 'nearest',
        mipmapFilter: 'nearest',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
        addressModeW: 'clamp-to-edge',
      })
    : USE_BASE_COLOR_TEXTURE_SAMPLER_LOD_MIN_CLAMP
    ? world.allocSharedRef('SamplerAsset', {
        kind: 'sampler',
        magFilter: 'linear',
        minFilter: 'linear',
        mipmapFilter: 'linear',
        addressModeU: 'repeat',
        addressModeV: 'repeat',
        addressModeW: 'repeat',
        lodMinClamp: FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_LOD_MIN_CLAMP === '1' ? 1 : 0,
        lodMaxClamp: 1,
      })
    : USE_BASE_COLOR_TEXTURE_SAMPLER_LOD_MAX_CLAMP
    ? world.allocSharedRef('SamplerAsset', {
        kind: 'sampler',
        magFilter: 'linear',
        minFilter: 'linear',
        mipmapFilter: 'linear',
        addressModeU: 'repeat',
        addressModeV: 'repeat',
        addressModeW: 'repeat',
        lodMinClamp: 0,
        lodMaxClamp: FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_LOD_MAX_CLAMP === '1' ? 0 : 1,
      })
    : USE_BASE_COLOR_TEXTURE_SAMPLER_MIPMAP_FILTER
    ? world.allocSharedRef('SamplerAsset', {
        kind: 'sampler',
        magFilter: 'linear',
        minFilter: 'linear',
        mipmapFilter:
          FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_MIPMAP_FILTER === '1' ? 'linear' : 'nearest',
        addressModeU: 'repeat',
        addressModeV: 'repeat',
        addressModeW: 'repeat',
      })
    : USE_BASE_COLOR_TEXTURE_SAMPLER_ADDRESS
    ? world.allocSharedRef('SamplerAsset', {
        kind: 'sampler',
        magFilter: 'linear',
        minFilter: 'linear',
        mipmapFilter: 'nearest',
        addressModeU:
          FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_ADDRESS === '1' ? 'clamp-to-edge' : 'repeat',
        addressModeV:
          FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_ADDRESS === '1' ? 'clamp-to-edge' : 'repeat',
        addressModeW:
          FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_ADDRESS === '1' ? 'clamp-to-edge' : 'repeat',
      })
    : USE_BASE_COLOR_TEXTURE_SAMPLER_MAG_FILTER
    ? world.allocSharedRef('SamplerAsset', {
        kind: 'sampler',
        magFilter:
          FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_MAG_FILTER === '1' ? 'nearest' : 'linear',
        minFilter: 'linear',
        mipmapFilter: 'nearest',
        addressModeU: 'repeat',
        addressModeV: 'repeat',
        addressModeW: 'repeat',
      })
    : USE_BASE_COLOR_TEXTURE_SAMPLER_MIN_FILTER
    ? world.allocSharedRef('SamplerAsset', {
        kind: 'sampler',
        magFilter: 'linear',
        minFilter:
          FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_MIN_FILTER === '1' ? 'nearest' : 'linear',
        mipmapFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
        addressModeW: 'clamp-to-edge',
        lodMinClamp: 1,
        lodMaxClamp: 1,
      })
    : USE_BASE_COLOR_TEXTURE_SAMPLER_MAX_ANISOTROPY
    ? world.allocSharedRef('SamplerAsset', {
        kind: 'sampler',
        magFilter: 'linear',
        minFilter: 'linear',
        mipmapFilter: 'linear',
        addressModeU: 'repeat',
        addressModeV: 'repeat',
        addressModeW: 'repeat',
        maxAnisotropy:
          FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_MAX_ANISOTROPY === '1' ? 16 : undefined,
      })
    : undefined;
  const standardMaterial = Materials.standard({
    baseColor: [
      OBJECT_BASE_COLOR[0],
      OBJECT_BASE_COLOR[1],
      OBJECT_BASE_COLOR[2],
      FALSIFY_MATERIAL_ALPHA_CUTOFF === '1' ? 0.25 : 1,
    ],
    metallic: USE_MATERIAL_METALLIC_CHANNEL ? 1.0 : 0.0,
    roughness:
      USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIPMAP_FILTER ||
      USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIN_FILTER
        ? 1.0
        : 0.5,
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
  const occlusionTextureHandle = USE_MATERIAL_OCCLUSION_STRENGTH
    ? world.allocSharedRef('TextureAsset', {
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
        format: 'rgba8unorm',
        data: new Uint8Array([0, 0, 0, 255]),
        colorSpace: 'linear',
        mips: { kind: 'none' },
      })
    : undefined;
  const metallicRoughnessTextureHandle = USE_MATERIAL_METALLIC_CHANNEL
    ? world.allocSharedRef('TextureAsset', {
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
        format: 'rgba8unorm',
        data: new Uint8Array([255, 255, 0, 255]),
        colorSpace: 'linear',
        mips: { kind: 'none' },
      })
    : USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE
    ? world.allocSharedRef('TextureAsset', {
        kind: 'texture',
        shape: {
          viewDimension: '2d',
          extent: {
            width:
              USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_MIPMAP ||
              USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIPMAP_FILTER ||
              USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIN_FILTER ||
              USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MIN_CLAMP ||
              USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MAX_CLAMP ||
              USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAX_ANISOTROPY
                ? 4
                : 2,
            height:
              USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_MIPMAP ||
              USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIPMAP_FILTER ||
              USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIN_FILTER ||
              USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MIN_CLAMP ||
              USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MAX_CLAMP ||
              USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAX_ANISOTROPY
                ? 4
                : 2,
          },
        },
        format: 'rgba8unorm',
        data:
          USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_MIPMAP ||
          USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIPMAP_FILTER ||
          USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIN_FILTER ||
          USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MIN_CLAMP ||
          USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MAX_CLAMP ||
          USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAX_ANISOTROPY
            ? new Uint8Array([
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
              ])
            : USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAG_FILTER ||
                USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS
            ? new Uint8Array([
                0, 0, 0, 255,
                0, 0, 0, 255,
                0, 255, 0, 255,
                0, 0, 0, 255,
              ])
            : FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_UV_SET !== ''
            ? new Uint8Array([
                0, 0, 0, 255,
                0, 0, 0, 255,
                0, 0, 0, 255,
                0, 255, 0, 255,
              ])
            : new Uint8Array([
                0, 255, 0, 255,
                0, 0, 0, 255,
                0, 0, 0, 255,
                0, 0, 0, 255,
              ]),
        colorSpace: 'linear',
        mips:
          USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIPMAP_FILTER ||
          USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIN_FILTER ||
          USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MIN_CLAMP ||
          USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MAX_CLAMP ||
          USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAX_ANISOTROPY ||
          (USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_MIPMAP &&
            FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_MIPMAP === '1')
            ? { kind: 'generate' }
            : { kind: 'none' },
      })
    : USE_MATERIAL_ROUGHNESS_CHANNEL
    ? world.allocSharedRef('TextureAsset', {
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
        format: 'rgba8unorm',
        data: new Uint8Array([0, 255, 0, 255]),
        colorSpace: 'linear',
        mips: { kind: 'none' },
      })
    : undefined;
  const metallicRoughnessSamplerHandle =
    USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER ||
    USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAG_FILTER ||
    USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIN_FILTER ||
    USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS ||
    USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIPMAP_FILTER ||
    USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MIN_CLAMP ||
    USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MAX_CLAMP ||
    USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAX_ANISOTROPY ||
    USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_MIPMAP
    ? world.allocSharedRef('SamplerAsset', {
        kind: 'sampler',
        magFilter:
          USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAG_FILTER ||
          USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS ||
          FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER === '1'
            ? USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAG_FILTER
              ? FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAG_FILTER === '1'
                ? 'nearest'
                : 'linear'
              : 'nearest'
            : 'linear',
        minFilter:
          USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIN_FILTER
            ? FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIN_FILTER === '1'
              ? 'nearest'
              : 'linear'
            : USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS ||
                FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER === '1'
              ? 'nearest'
              : 'linear',
        mipmapFilter:
          USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAG_FILTER
            ? 'nearest'
            : USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIPMAP_FILTER
            ? FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIPMAP_FILTER === '1'
              ? 'nearest'
              : 'linear'
            : USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS ||
                FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER === '1'
              ? 'nearest'
              : 'linear',
        addressModeU: USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS
          ? FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS === '1'
            ? 'clamp-to-edge'
            : 'repeat'
          : 'clamp-to-edge',
        addressModeV: USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS
          ? FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS === '1'
            ? 'clamp-to-edge'
            : 'repeat'
          : 'clamp-to-edge',
        addressModeW: USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS
          ? FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS === '1'
            ? 'clamp-to-edge'
            : 'repeat'
          : 'clamp-to-edge',
        ...(USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIPMAP_FILTER ||
        USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIN_FILTER
          ? { lodMinClamp: 0.5, lodMaxClamp: 0.5 }
          : USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MAX_CLAMP
            ? {
                lodMinClamp: 0,
                lodMaxClamp:
                  FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MAX_CLAMP === '1'
                    ? 0
                    : 1,
              }
          : USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MIN_CLAMP
            ? {
                lodMinClamp:
                  FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MIN_CLAMP === '1'
                    ? 1
                    : 0,
                lodMaxClamp: 1,
              }
          : USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAX_ANISOTROPY
            ? { maxAnisotropy: FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAX_ANISOTROPY === '1' ? 16 : undefined }
          : USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_MIPMAP
            ? { lodMinClamp: 1, lodMaxClamp: 1 }
            : {}),
      })
    : undefined;
  // Browser demo materials normally carry AssetGuid values; this forensic lane
  // deliberately exercises the already-supported ECS-resident handle form.
  const objectMaterial: MaterialAsset =
    USE_MATERIAL_OCCLUSION_STRENGTH
    ? ({
        ...standardMaterial,
        values: {
          ...standardMaterial.values,
          occlusionTexture: { texture: occlusionTextureHandle! },
        },
      } as unknown as MaterialAsset)
    : USE_MATERIAL_METALLIC_CHANNEL || USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE
    ? ({
        ...standardMaterial,
        values: {
          ...standardMaterial.values,
          metallicRoughnessTexture: {
            texture: metallicRoughnessTextureHandle!,
            ...(USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER ||
            USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAG_FILTER ||
            USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIN_FILTER ||
            USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS ||
            USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIPMAP_FILTER ||
            USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MIN_CLAMP ||
            USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MAX_CLAMP ||
            USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAX_ANISOTROPY ||
            USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_MIPMAP
              ? { sampler: metallicRoughnessSamplerHandle! }
              : {}),
            ...(USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAX_ANISOTROPY
              ? { coordinates: { transform: METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAX_ANISOTROPY_COORDINATES } }
              : USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MAX_CLAMP
              ? { coordinates: { transform: METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MAX_CLAMP_COORDINATES } }
              : FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_UV_TRANSFORM === '1'
              ? { coordinates: { transform: METALLIC_ROUGHNESS_TEXTURE_UV_TRANSFORM } }
              : FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_UV_SET === '1'
                ? { coordinates: { set: 1 } }
                : {}),
          },
        },
      } as unknown as MaterialAsset)
    : USE_MATERIAL_ROUGHNESS_CHANNEL
    ? ({
        ...standardMaterial,
        values: {
          ...standardMaterial.values,
          metallicRoughnessTexture: { texture: metallicRoughnessTextureHandle! },
        },
      } as unknown as MaterialAsset)
    : USE_BASE_COLOR_TEXTURE_MIPMAP
    ? ({
        ...standardMaterial,
        values: {
          ...standardMaterial.values,
          baseColorTexture: {
            texture: baseColorTextureHandle!,
            sampler: baseColorSamplerHandle!,
          },
        },
      } as unknown as MaterialAsset)
    : USE_BASE_COLOR_TEXTURE_UV_TRANSFORM
    ? ({
        ...standardMaterial,
        values: {
          ...standardMaterial.values,
          baseColorTexture: {
            texture: baseColorTextureHandle!,
            coordinates: { transform: BASE_COLOR_TEXTURE_UV_TRANSFORM },
          },
        },
      } as unknown as MaterialAsset)
    : USE_BASE_COLOR_TEXTURE_UV_SET
    ? ({
        ...standardMaterial,
        values: {
          ...standardMaterial.values,
          baseColorTexture: {
            texture: baseColorTextureHandle!,
            coordinates: { set: 1 },
          },
        },
      } as unknown as MaterialAsset)
    : USE_BASE_COLOR_TEXTURE_RED
    ? ({
        ...standardMaterial,
        values: {
          ...standardMaterial.values,
          baseColorTexture: { texture: baseColorTextureHandle! },
        },
      } as unknown as MaterialAsset)
    : USE_BASE_COLOR_TEXTURE_GREEN
    ? ({
        ...standardMaterial,
        values: {
          ...standardMaterial.values,
          baseColorTexture: { texture: baseColorTextureHandle! },
        },
      } as unknown as MaterialAsset)
    : USE_BASE_COLOR_TEXTURE_BLUE
    ? ({
        ...standardMaterial,
        values: {
          ...standardMaterial.values,
          baseColorTexture: { texture: baseColorTextureHandle! },
        },
      } as unknown as MaterialAsset)
    : USE_BASE_COLOR_TEXTURE_RGB
    ? ({
        ...standardMaterial,
        values: {
          ...standardMaterial.values,
          baseColorTexture: { texture: baseColorTextureHandle! },
        },
      } as unknown as MaterialAsset)
    : USE_BASE_COLOR_TEXTURE_ALPHA
    ? ({
        ...standardMaterial,
        values: {
          ...standardMaterial.values,
          baseColorTexture: { texture: baseColorTextureHandle! },
        },
      } as unknown as MaterialAsset)
    : USE_BASE_COLOR_TEXTURE_SAMPLER
    ? ({
        ...standardMaterial,
        values: {
          ...standardMaterial.values,
          baseColorTexture: {
            texture: baseColorTextureHandle!,
            sampler: baseColorSamplerHandle!,
          },
        },
      } as unknown as MaterialAsset)
    : USE_BASE_COLOR_TEXTURE_SAMPLER_LOD_MIN_CLAMP
    ? ({
        ...standardMaterial,
        values: {
          ...standardMaterial.values,
          baseColorTexture: {
            texture: baseColorTextureHandle!,
            sampler: baseColorSamplerHandle!,
            coordinates: { transform: BASE_COLOR_TEXTURE_SAMPLER_LOD_MIN_CLAMP_COORDINATES },
          },
        },
      } as unknown as MaterialAsset)
    : USE_BASE_COLOR_TEXTURE_SAMPLER_LOD_MAX_CLAMP
    ? ({
        ...standardMaterial,
        values: {
          ...standardMaterial.values,
          baseColorTexture: {
            texture: baseColorTextureHandle!,
            sampler: baseColorSamplerHandle!,
            coordinates: { transform: BASE_COLOR_TEXTURE_SAMPLER_LOD_MAX_CLAMP_COORDINATES },
          },
        },
      } as unknown as MaterialAsset)
    : USE_BASE_COLOR_TEXTURE_SAMPLER_MIPMAP_FILTER
    ? ({
        ...standardMaterial,
        values: {
          ...standardMaterial.values,
          baseColorTexture: {
            texture: baseColorTextureHandle!,
            sampler: baseColorSamplerHandle!,
          },
        },
      } as unknown as MaterialAsset)
    : USE_BASE_COLOR_TEXTURE_SRGB
    ? ({
        ...standardMaterial,
        values: {
          ...standardMaterial.values,
          baseColorTexture: { texture: baseColorTextureHandle! },
        },
      } as unknown as MaterialAsset)
    : USE_BASE_COLOR_TEXTURE_SAMPLER_ADDRESS
    ? ({
        ...standardMaterial,
        values: {
          ...standardMaterial.values,
          baseColorTexture: {
            texture: baseColorTextureHandle!,
            sampler: baseColorSamplerHandle!,
          },
        },
      } as unknown as MaterialAsset)
    : USE_BASE_COLOR_TEXTURE_SAMPLER_MAG_FILTER
    ? ({
        ...standardMaterial,
        values: {
          ...standardMaterial.values,
          baseColorTexture: {
            texture: baseColorTextureHandle!,
            sampler: baseColorSamplerHandle!,
          },
        },
      } as unknown as MaterialAsset)
    : USE_BASE_COLOR_TEXTURE_SAMPLER_MIN_FILTER
    ? ({
        ...standardMaterial,
        values: {
          ...standardMaterial.values,
          baseColorTexture: {
            texture: baseColorTextureHandle!,
            sampler: baseColorSamplerHandle!,
          },
        },
      } as unknown as MaterialAsset)
    : USE_BASE_COLOR_TEXTURE_SAMPLER_MAX_ANISOTROPY
    ? ({
        ...standardMaterial,
        values: {
          ...standardMaterial.values,
          baseColorTexture: {
            texture: baseColorTextureHandle!,
            sampler: baseColorSamplerHandle!,
            coordinates: { transform: BASE_COLOR_TEXTURE_SAMPLER_MAX_ANISOTROPY_COORDINATES },
          },
        },
      } as unknown as MaterialAsset)
    : standardMaterial;
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
    console.log(
      `[learn-render 2.lighting 1.colors] base-color texture sampler minFilter=${FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_MIN_FILTER === '1' ? 'nearest' : 'linear'} filters=linear/${FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_MIN_FILTER === '1' ? 'nearest' : 'linear'}/linear address=clamp-to-edge lod=1/1 texture=rgba8unorm 4x4 mipmap=true`,
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
  if (USE_BASE_COLOR_TEXTURE_SAMPLER_MAG_FILTER) {
    console.log(
      `[learn-render 2.lighting 1.colors] base-color texture sampler magFilter=${FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_MAG_FILTER === '1' ? 'nearest' : 'linear'} filters=${FALSIFY_BASE_COLOR_TEXTURE_SAMPLER_MAG_FILTER === '1' ? 'nearest' : 'linear'}/linear/nearest address=repeat texture=rgba8unorm 2x2 mipmap=false`,
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
  let objectMeshHandle = HANDLE_CUBE;
  if (USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS) {
    const cubeAssetRes = resolveAssetHandle<MeshAsset>(world, HANDLE_CUBE);
    if (!cubeAssetRes.ok) {
      console.error(
        '[learn-render 2.lighting 1.colors] HANDLE_CUBE asset unavailable for metallic-roughness sampler address',
      );
      return;
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
        '[learn-render 2.lighting 1.colors] HANDLE_CUBE lacks the attributes required for metallic-roughness sampler address',
      );
      return;
    }
    const cubeVertexCount = positions.byteLength / Float32Array.BYTES_PER_ELEMENT / 3;
    const cubeBaseStride = cubeVertexCount > 0 ? cubeAsset.vertices.length / cubeVertexCount : 0;
    const samplerAddressCubeVertices = new Float32Array(cubeAsset.vertices);
    const samplerAddressCubeUv = new Float32Array(uvs);
    for (let i = 0; i < cubeVertexCount; i++) {
      const offset = i * cubeBaseStride;
      samplerAddressCubeVertices[offset + 6] = METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS_UV[0];
      samplerAddressCubeVertices[offset + 7] = METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS_UV[1];
      samplerAddressCubeUv[i * 2] = METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS_UV[0];
      samplerAddressCubeUv[i * 2 + 1] = METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS_UV[1];
    }
    objectMeshHandle = world.allocSharedRef('MeshAsset', {
      ...cubeAsset,
      vertices: samplerAddressCubeVertices,
      attributes: {
        position: new Float32Array(positions),
        normal: new Float32Array(normals),
        uv: samplerAddressCubeUv,
        tangent: new Float32Array(tangents),
      },
      aabb: new Float32Array(aabb),
    });
  }
  if (!USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS && FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_UV_SET === '1') {
    const cubeAssetRes = resolveAssetHandle<MeshAsset>(world, HANDLE_CUBE);
    if (!cubeAssetRes.ok) {
      console.error(
        '[learn-render 2.lighting 1.colors] HANDLE_CUBE asset unavailable for metallic-roughness UV set',
      );
      return;
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
        '[learn-render 2.lighting 1.colors] HANDLE_CUBE lacks the attributes required for metallic-roughness UV set',
      );
      return;
    }
    const cubeVertexCount = positions.byteLength / Float32Array.BYTES_PER_ELEMENT / 3;
    const cubeBaseStride = cubeVertexCount > 0 ? cubeAsset.vertices.length / cubeVertexCount : 0;
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
    objectMeshHandle = world.allocSharedRef('MeshAsset', {
      ...cubeAsset,
      vertices: multiUvCubeVertices,
      attributes: {
        position: new Float32Array(positions as Float32Array),
        normal: new Float32Array(normals as Float32Array),
        uv: new Float32Array(uvs as Float32Array),
        tangent: new Float32Array(tangents as Float32Array),
        uv1: multiUvCubeUv1,
      },
      aabb: new Float32Array(aabb),
    });
  }
  if (
    USE_BASE_COLOR_TEXTURE_UV_SET &&
    !USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS &&
    !USE_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_UV_SET
  ) {
    const cubeAssetRes = resolveAssetHandle<MeshAsset>(world, HANDLE_CUBE);
    if (!cubeAssetRes.ok) {
      console.error(
        '[learn-render 2.lighting 1.colors] HANDLE_CUBE asset unavailable for base-color UV set',
      );
      return;
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
        '[learn-render 2.lighting 1.colors] HANDLE_CUBE lacks the attributes required for base-color UV set',
      );
      return;
    }
    const cubeVertexCount = positions.byteLength / Float32Array.BYTES_PER_ELEMENT / 3;
    const cubeBaseStride = cubeVertexCount > 0 ? cubeAsset.vertices.length / cubeVertexCount : 0;
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
    objectMeshHandle = world.allocSharedRef('MeshAsset', {
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
    });
  }
  const objectMatHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    objectMaterial,
  );

  // Unlit material for the lamp cube (always renders white, like LO's
  // separate light cube shader).
  const lampMatHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.unlit([1.0, 1.0, 1.0, 1.0]),
  );

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
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
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

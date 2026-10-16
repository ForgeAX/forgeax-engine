// apps/hello/text -- world-space MSDF text demo
// (feat-20260531-world-space-msdf-text-rendering / tweak-20260610-hello-text-real-msdf-bake).
//
// What this demo exercises end-to-end (charter F1 progressive disclosure):
//   - createApp(canvas, opts) -- one-screen takeoff with rAF + auto
//     input-attach + Time resource.
//   - configureRuntimeAssetCatalog(assets, runtimeBinding) so loadByGuid
//     resolves against the scoped dev or static production catalog, which includes the pre-baked
//     forgeax-engine-assets/dejavu-fonts/ artifacts (atlas .png + font
//     .pack.json) wired through pluginPack roots in vite.config.ts.
//   - registerSharedSampler(assets) registers the SamplerAsset whose GUID
//     matches font.pack.json's `samplerGuid` field. The runtime fontLoader
//     resolves that ref at loadByGuid<FontAsset> time.
//   - The intended AI-user surface (requirements line 52 "one-line spawn =
//     visible"): spawn ONLY `GlyphText { fontHandle, text, fontSize, color }`
//     + `Transform`. The auto-wired `glyphTextLayoutSystem` lays out the
//     glyph quads, bakes a single unmanaged MeshAsset, and attaches
//     MeshFilter + MeshRenderer (AC-07 / AC-09 single mesh = single draw).
//
// Four scenes:
//   (a) static HUD-style label  ("PLAYER 1")        -- name-plate / damage style
//   (b) multi-line text (\n)     ("HP\nMANA")        -- AC-21
//   (c) HDR-bright text          (color components > 1 -> bloom)  -- AC-12
//   (d) depth-occluded text      (text behind an opaque cube)     -- AC-11
//
// MSDF bake source: dejavu-fonts/DejaVuSansMono.atlas.png is a 512x512 RGBA8
// MSDF atlas (94 ASCII printable codepoints) baked offline via @zappar/msdf-generator.
// See forgeax-engine-assets/dejavu-fonts/ATTRIBUTION.md for reproducibility steps.
// The runtime msdf-text shader uses the multi-channel signed-distance median to
// reconstruct sharp glyph outlines at any size.

import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine-app/browser';
import type { CanvasAppError } from '@forgeax/engine-app';

import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';

import { BLOOM_ENABLED, perspective, TONEMAP_REINHARD_EXTENDED } from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';

import { type FontAsset, type Handle, type MaterialAsset } from '@forgeax/engine-types';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

import {
  FONT_GUID,
  registerSharedSampler,
  spawnTextScenes,
} from './text-scenes.js';


const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) {
  throw new Error('[text] missing <canvas id="app"> in index.html');
}

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[text] EngineEnvironmentError: webgpu inner=${code}`);
  } else {
    console.error('[text] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter(), importTransport: createRuntimeAssetImportTransport(runtimeBinding) },
  );
  if (!appRes.ok) {
    reportAppError(appRes.error);
    return;
  }
  const app = appRes.value;
  console.warn(`[text] backend=${app.renderer.inspect().capabilities.backendKind}`);


  const assets = app.assets;
  if (assets === undefined || assets === null) {
    console.error('[text] AssetRegistry is unavailable');
    return;
  }
  configureRuntimeAssetCatalog(assets, runtimeBinding);
  const world = app.world;

  registerSharedSampler(assets);

  const fontGuidParsed = AssetGuid.parse(FONT_GUID);
  if (!fontGuidParsed.ok) {
    console.error('[text] FONT_GUID parse failed:', fontGuidParsed.error.code);
    return;
  }
  const fontHandleRes = await assets.loadByGuid<FontAsset>(fontGuidParsed.value);
  if (!fontHandleRes.ok) {
    console.error(
      '[text] loadByGuid<FontAsset> failed:',
      fontHandleRes.error.code,
      fontHandleRes.error.hint,
    );
    return;
  }
  // loadByGuid returns the payload (D-17); mint a user-tier column handle.
  const fontHandle: Handle<'FontAsset', 'shared'> = world.allocSharedRef(
    'FontAsset',
    fontHandleRes.value,
  );

  spawnTextScenes(world, fontHandle);

  // A grey cube placed BETWEEN the camera and scene (d)'s text to exercise
  // depth occlusion (AC-11). The cube needs a standard material.
  const cubeMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      { name: 'Forward', program: { module: 'forgeax::default-standard-pbr' }, renderState: { tags: { LightMode: 'Forward' }, queue: 2000 } },
    ],
    values: { baseColor: [0.6, 0.6, 0.6], metallic: 0, roughness: 0.5 },
  });
  world
    .spawn(
      {
        component: Transform,
        data: { pos: [2.2, -1.0, 1.5], quat: [0, 0, 0, 1], scale: [0.5, 0.5, 0.5]},
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [cubeMat] } },
    )
    .unwrap();

  world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [-0.3, -0.5, -0.8],
        color: [1, 1, 1],
        intensity: 1.2,
      },
    })
    .unwrap();

  // Camera with HDR tonemap + bloom enabled so scene (c)'s >1.0 text feeds the
  // Bloom extraction (AC-12).
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 8]} },
      {
        component: Camera,
        data: {
          ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }),
          tonemap: TONEMAP_REINHARD_EXTENDED,
          bloom: BLOOM_ENABLED,
          bloomThreshold: 1.0,
          bloomIntensity: 1.0,
          bloomSoftKnee: 0.5,
          bloomScatter: 0.7,
        },
      },
    )
    .unwrap();

  const startRes = app.start();
  if (!startRes.ok) {
    reportAppError(startRes.error);
    return;
  }
  console.warn('[text] running. Four world-space text scenes spawned.');
}

function reportAppError(err: CanvasAppError | EngineEnvironmentError): void {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[text] EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  console.error(`[text] ${err.code}: ${err.hint}`);
}

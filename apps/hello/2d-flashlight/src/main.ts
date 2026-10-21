import type { AssetHandle } from '@forgeax/engine-types';
// apps/hello/2d-flashlight -- flat 2D sprite-lit demo
// (tweak-20260701-sprite-lit-flat-default-drop-ndotl-for-2d M2 / m2-1).
//
// Under the flat sprite-lit shading model (post-M1), light shading is
// `albedo * lightColor * attenuation * cone`; sprites are omnidirectional
// receivers and light direction only shapes the SpotLight cone. This lets
// a "person holding a flashlight" scene put the SpotLight on the sprite
// plane (pos z=0, direction z=0) and get a visible sweep beam -- the pre-M1
// Half-Lambert path required pos z>0 or the beam vanished.
//
// URL modes (mirrors the sprite-lit demo's ?mode= convention):
//   ?mode=sweep-spot     -- AC-1 harness. Sole SpotLight at world origin
//                           pointing +X sweeps a wide sprite plane spanning
//                           x=1..3, y=-1..1. Wedge center world (2, 0)
//                           lands squarely inside the smoothstep cone at
//                           near-max attenuation, so the smoke asserts the
//                           center pixel brightness > 0.5.
//   ?mode=point-circle   -- AC-2 harness. Sole PointLight at (0, 0, 0.01)
//                           with range=1 makes a soft circular falloff on
//                           a sprite plane spanning x=-1..1, y=-1..1. Center
//                           world (0, 0) saturates ( > 0.7 ), edge world
//                           (1, 0) sits outside the KHR quartic window
//                           ( < 0.1 ).
//   ?mode=both (default) -- interactive show scene. PointLight left half,
//                           SpotLight right half; the two footprints do
//                           not overlap on the sprite grid so the visual
//                           reads as two independent lit regions.
//
// Charter mapping:
//   F1 -- the flat lighting model removes the "lights must sit above the
//         sprite plane" hidden constraint; AI users can now put lights
//         directly on the plane and the Godot Light2D / URP 2D intuition
//         holds.
//   P3 -- every Result.err path logs .code + .hint (no string parsing).
//   P4 -- DirectionalLight / PointLight / SpotLight are the same components
//         3D demos use; no 2D-specific light kind.

import type { App, CanvasAppError } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import type { World } from '@forgeax/engine-ecs';

import { Transform } from '@forgeax/engine-scene';

import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { orthographic, TONEMAP_NONE } from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { SPRITE_PREMULTIPLIED_ALPHA_BLEND } from '@forgeax/engine-render/authoring';
import { PointLight, SpotLight } from '@forgeax/engine-render';

import type { TextureAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';

import { createPrimitiveMesh } from '@forgeax/engine-geometry';


const SPRITE_LIT_PARAMETERS = [
  { name: 'colorTint', type: 'vec4' },
  { name: 'region', type: 'vec4' },
  { name: 'pivotAndSize', type: 'vec4' },
  { name: 'slicesAndMode', type: 'vec4' },
  { name: 'baseColorTexture', type: 'texture' },
] as const;

type Mode = 'sweep-spot' | 'point-circle' | 'both';

function readModeFromUrl(): Mode {
  const params = new URLSearchParams(globalThis.location?.search ?? '');
  const raw = params.get('mode');
  if (raw === 'sweep-spot' || raw === 'point-circle' || raw === 'both') return raw;
  return 'both';
}

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('[2d-flashlight] missing <canvas id="app">');

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    console.error('[2d-flashlight] no usable WebGPU backend:', err);
  } else {
    console.error('[2d-flashlight] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter() },
  );
  if (!appRes.ok) {
    reportAppError(appRes.error);
    return;
  }
  const app: App = appRes.value;
  console.warn(`[2d-flashlight] backend=${app.renderer.inspect().capabilities.backendKind}`);


  const world = app.world;
  const mode = readModeFromUrl();
  console.warn(`[2d-flashlight] mode=${mode}`);

  const textureHandle = await uploadCheckerboardTexture(world);

  buildScene({ mode, world, textureHandle });

  const startRes = app.start();
  if (!startRes.ok) {
    reportAppError(startRes.error);
    return;
  }
  console.warn(`[2d-flashlight] running (mode=${mode}).`);
}

interface SceneCtx {
  mode: Mode;
  world: World;
  textureHandle: AssetHandle<'texture'>;
}

// buildScene wires camera + lights + sprite geometry per mode. Each mode
// picks a camera framing that centers on the tested wedge or circle so
// the smoke sample point (framebuffer center) lands at world (2, 0) or
// world (0, 0) respectively; the world-to-pixel mapping is symmetric
// under the orthographic camera.
function buildScene(ctx: SceneCtx): void {
  switch (ctx.mode) {
    case 'sweep-spot':
      buildSweepSpotScene(ctx);
      return;
    case 'point-circle':
      buildPointCircleScene(ctx);
      return;
    case 'both':
      buildBothScene(ctx);
      return;
  }
}

// ─── sweep-spot: AC-1 harness ────────────────────────────────────────────────
// SpotLight at world origin points +X. A large sprite plane occupies
// x=[1, 3], y=[-1, 1]; the wedge center world (2, 0) sits inside the
// smoothstep cone and near-max range attenuation, saturating the LDR
// output ( > 0.5 normalized ).
function buildSweepSpotScene(ctx: SceneCtx): void {
  const { world, textureHandle } = ctx;

  world.spawn(
    { component: Transform, data: { pos: [1.9, 0, 5], quat: [0, 0, 0, 1]} },
    {
      component: Camera,
      data: {
        ...orthographic({ left: -1.5, right: 1.5, bottom: -1.5, top: 1.5, near: 0.1, far: 20 }),
        tonemap: TONEMAP_NONE,
        clearColor: [0.01, 0.01, 0.02, 1],
      },
    },
  ).unwrap();

  // SpotLight on the sprite plane; pos z=0 + direction z=0 sweeps parallel
  // to the plane (the pre-M1 Half-Lambert path returned near-black here
  // because dot(N=(0,0,1), L) collapsed to 0).
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1]} },
    {
      component: SpotLight,
      data: {
        direction: [1.0, 0.0, 0.0],
        color: [1.0, 1.0, 1.0],
        intensity: 5.0,
        range: 6.0,
        innerConeDeg: 15,
        outerConeDeg: 30,
        castShadow: false,
      },
    },
  ).unwrap();

  // Sprite plane covering x=[1, 3], y=[-1, 1]. Center world (2, 0) is
  // the AC-1 assertion point; sprite pivot 0.5 + size 1 + scale (2, 2)
  // gives the exact 2x2 footprint.
  spawnSprite(world, textureHandle, [1, 1, 1, 1], 2, 0, 0, 2, 2);
}

// ─── point-circle: AC-2 harness ──────────────────────────────────────────────
// PointLight just above the plane (pos z=0.01) with range=1 makes a soft
// circle. Center world (0, 0) saturates (dSq clamped to guard 1e-4,
// attenuation ~10000); edge world (1, 0) is outside the quartic window
// (factor clamped to 0), so the smoke asserts center > 0.7 / edge < 0.1.
function buildPointCircleScene(ctx: SceneCtx): void {
  const { world, textureHandle } = ctx;

  world.spawn(
    { component: Transform, data: { pos: [0, 0, 5], quat: [0, 0, 0, 1]} },
    {
      component: Camera,
      data: {
        ...orthographic({ left: -1.5, right: 1.5, bottom: -1.5, top: 1.5, near: 0.1, far: 20 }),
        tonemap: TONEMAP_NONE,
        clearColor: [0.01, 0.01, 0.02, 1],
      },
    },
  ).unwrap();

  world.spawn(
    { component: Transform, data: { pos: [0, 0, 0.01], quat: [0, 0, 0, 1]} },
    {
      component: PointLight,
      data: {
        color: [1.0, 1.0, 1.0],
        intensity: 2.0,
        range: 1.0,
      },
    },
  ).unwrap();

  // Sprite plane covering x=[-1.2, 1.2], y=[-1.2, 1.2]. Center world (0, 0)
  // and edge world (1, 0) both sit on the sprite so the smoke can read
  // per-pixel light contribution vs zero (range boundary).
  spawnSprite(world, textureHandle, [1, 1, 1, 1], 0, 0, 0, 2.4, 2.4);
}

// ─── both: interactive combined view ────────────────────────────────────────
// PointLight (left) + SpotLight (right) laid out so their footprints do
// not overlap. Not covered by the AC-1 / AC-2 smoke assertions; visual
// mode for AI users to eyeball both effects side by side.
function buildBothScene(ctx: SceneCtx): void {
  const { world, textureHandle } = ctx;

  world.spawn(
    { component: Transform, data: { pos: [0, 0, 5], quat: [0, 0, 0, 1]} },
    {
      component: Camera,
      data: {
        ...orthographic({ left: -3, right: 3, bottom: -1.5, top: 1.5, near: 0.1, far: 20 }),
        tonemap: TONEMAP_NONE,
        clearColor: [0.01, 0.01, 0.02, 1],
      },
    },
  ).unwrap();

  world.spawn(
    { component: Transform, data: { pos: [-1.5, 0, 0.01], quat: [0, 0, 0, 1]} },
    {
      component: PointLight,
      data: {
        color: [1.0, 0.72, 0.28],
        intensity: 2.0,
        range: 1.0,
      },
    },
  ).unwrap();

  world.spawn(
    { component: Transform, data: { pos: [0.4, 0, 0], quat: [0, 0, 0, 1]} },
    {
      component: SpotLight,
      data: {
        direction: [1.0, 0.0, 0.0],
        color: [0.88, 0.96, 1.0],
        intensity: 5.0,
        range: 4.0,
        innerConeDeg: 15,
        outerConeDeg: 30,
        castShadow: false,
      },
    },
  ).unwrap();

  // Two sprite regions: left plane receives the PointLight, right plane
  // receives the SpotLight; neither overlaps the other's light window.
  spawnSprite(world, textureHandle, [1, 0.9, 0.75, 1], -1.5, 0, 0, 2, 2);
  spawnSprite(world, textureHandle, [0.85, 0.9, 1.0, 1], 2.0, 0, 0, 2, 2);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function spawnSprite(
  world: World,
  texHandle: AssetHandle<'texture'>,
  tint: readonly [number, number, number, number],
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
): void {
const sceneAssets = world.assets;
if (!(sceneAssets instanceof AssetRegistry)) throw new Error('Scene requires its runtime asset owner');

const primitiveQuad = sceneAssets.create(createPrimitiveMesh('quad').unwrap()).unwrap();

  const mat = sceneAssets.create({
    kind: 'material',
    passes: [
      { name: 'Forward', program: { module: 'forgeax::sprite-lit' }, renderState: { ...{ blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND }, tags: { LightMode: 'Forward' }, queue: 3000 } },
    ],
    parameters: SPRITE_LIT_PARAMETERS,
    // values field names align with sprite-lit.material.json paramSchema:
    // colorTint / region / pivotAndSize / baseColorTexture (post-#520 SSOT).
    values: {
      colorTint: tint,
      baseColorTexture: texHandle,
      region: [0, 0, 1, 1],
      pivotAndSize: [0.5, 0.5, 1, 1],
    },
  }).unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [x, y, z], quat: [0, 0, 0, 1], scale: [sx, sy, 1] } },
      { component: MeshFilter, data: { assetHandle: primitiveQuad } },
      { component: MeshRenderer, data: { materials: [mat] } },
    )
    .unwrap();
}

// A 4-quadrant checkerboard so sprite pixels are unambiguously not solid
// black -- the demo relies on light contribution to lift these values
// above the clear color; a plain white texture would hide any
// pre-multiplication drift.
async function uploadCheckerboardTexture(
  world: World,
): Promise<AssetHandle<'texture'>> {
const sceneAssets = world.assets;
if (!(sceneAssets instanceof AssetRegistry)) throw new Error('Scene requires its runtime asset owner');

  const side = 8;
  const bytes = new Uint8Array(side * side * 4);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const i = (y * side + x) * 4;
      const top = y < side / 2;
      const left = x < side / 2;
      const quadrant = top ? (left ? 0 : 1) : left ? 2 : 3;
      const palette: ReadonlyArray<readonly [number, number, number, number]> = [
        [220, 180, 140, 255],
        [200, 200, 200, 255],
        [180, 200, 220, 255],
        [220, 200, 180, 255],
      ];
      const c = palette[quadrant] ?? palette[0];
      bytes[i + 0] = c?.[0] ?? 200;
      bytes[i + 1] = c?.[1] ?? 200;
      bytes[i + 2] = c?.[2] ?? 200;
      bytes[i + 3] = c?.[3] ?? 255;
    }
  }
  const desc: TextureAsset = {
    kind: 'texture',
    shape: {
      viewDimension: '2d',
      extent: { width: side, height: side },
    },
    format: 'rgba8unorm-srgb',
    data: bytes,
    colorSpace: 'srgb',
    mips: { kind: 'none' },
  };
  const handle = sceneAssets.create(desc).unwrap();
  return handle;
}

function reportAppError(err: CanvasAppError): void {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[2d-flashlight] EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  console.error(`[2d-flashlight] ${err.code}: ${err.hint}`);
}

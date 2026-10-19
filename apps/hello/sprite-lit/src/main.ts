// apps/hello/sprite-lit -- sprite-lit material end-to-end demo
// (feat-20260624-sprite-lit-shading-model-pure-2d-lighting M1' / w6).
//
// Scene (plan-tasks.json w6 description SSOT):
//   - 1 DirectionalLight (fixed direction, top-down warm key light).
//   - 1 PointLight (fixed position, magenta accent).
//   - 1 SpotLight (fixed cone, cyan rim from the side).
//   - >=4 sprite-lit quads laid out on the world-Z=0 plane.
//   - 1 standard-PBR cube co-located with the sprite cluster (AC-14
//     "sprite-lit quad + 3D mesh same lights -> visually consistent").
//   - URL ?mode= switches the 3 visualEvidence scenes:
//       directional-only -> only the DirectionalLight is spawned.
//       three-lights     -> all 3 lights spawned (default).
//       ab-compare       -> two quad rows side by side, left row uses
//                           forgeax::sprite (unlit baseline), right row
//                           uses forgeax::sprite-lit (lit; AC-13 one-string
//                           switch visual comparison).
//
// plan-decisions L-2 SSOT: procedural sprite + hardcoded light config
// (no new vendor asset under ./assets/); the sprite atlas is built
// in-memory at boot from a 32x32 checkerboard so the demo runs without
// requiring the forgeax-engine-assets submodule.
//
// Charter mapping:
//   F1 -- the 6 numbered steps in bootstrap() mirror the AGENTS-style recipe.
//   P3 -- every Result.err path logs .code + .hint (no string parsing).
//   P4 -- DirectionalLight / PointLight / SpotLight are the same components
//         3D demos use; no sprite-lit-specific light kind.
//   P5 -- shader='forgeax::sprite-lit' is a single-string switch
//         from forgeax::sprite (AC-13).

import type { App, CanvasAppError } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import type { World } from '@forgeax/engine-ecs';
import { HANDLE_CUBE, HANDLE_QUAD } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';

import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { orthographic, TONEMAP_NONE } from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { SPRITE_PREMULTIPLIED_ALPHA_BLEND } from '@forgeax/engine-render/authoring';
import { PointLight, SpotLight } from '@forgeax/engine-render';

import type { Handle, MaterialAsset, TextureAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

type Mode = 'directional-only' | 'three-lights' | 'ab-compare';

function readModeFromUrl(): Mode {
  const params = new URLSearchParams(globalThis.location?.search ?? '');
  const raw = params.get('mode');
  if (raw === 'directional-only' || raw === 'three-lights' || raw === 'ab-compare') {
    return raw;
  }
  return 'three-lights';
}

// 4 sprite quad slots laid in a horizontal row on the world-Z=0 plane.
// AC-11 requires >=4 sprite quads under the sprite-lit material so the
// instanced-vertex chain is exercised end-to-end; each entity ends up as
// instance_index=0 in its own draw, but the engine's @group(3) instances
// binding still runs on every spawn (the same vertex path lights all 4).
const SPRITE_SLOTS: ReadonlyArray<{
  pos: readonly [number, number, number];
  tint: readonly [number, number, number, number];
}> = [
  { pos: [-0.9, 0.0, 0.0], tint: [1.0, 1.0, 1.0, 1.0] },
  { pos: [-0.3, 0.0, 0.0], tint: [1.0, 0.7, 0.7, 1.0] },
  { pos: [0.3, 0.0, 0.0], tint: [0.7, 1.0, 0.7, 1.0] },
  { pos: [0.9, 0.0, 0.0], tint: [0.7, 0.7, 1.0, 1.0] },
];

const SPRITE_LIT_PARAMETERS = [
  { name: 'colorTint', type: 'vec4' },
  { name: 'region', type: 'vec4' },
  { name: 'pivotAndSize', type: 'vec4' },
  { name: 'slicesAndMode', type: 'vec4' },
  { name: 'baseColorTexture', type: 'texture' },
] as const;

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) {
  throw new Error('[sprite-lit] missing <canvas id="app"> in index.html');
}

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    console.error('[sprite-lit] no usable WebGPU backend:', err);
  } else {
    console.error('[sprite-lit] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  // Step 1: createApp -- one-screen takeoff. The app owns the rAF loop +
  // Time resource + auto input-attach.
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
  console.warn(`[sprite-lit] backend=${app.renderer.inspect().capabilities.backendKind}`);


  const world = app.world;
  const mode = readModeFromUrl();
  console.warn(`[sprite-lit] mode=${mode}`);

  // Step 2: procedural 8x8 checkerboard texture so the demo runs without
  // a forgeax-engine-assets submodule fetch. The colorTint per-slot
  // multiplies on top so the 4 quads stay visually distinct.
  const checkerboard = buildCheckerboardRgba(8);
  const textureHandle = world.allocSharedRef<'TextureAsset', TextureAsset>('TextureAsset', {
    kind: 'texture',
    shape: {
      viewDimension: '2d',
      extent: { width: checkerboard.width, height: checkerboard.height },
    },
    format: 'rgba8unorm-srgb',
    data: checkerboard.data,
    colorSpace: 'srgb',
    mips: { kind: 'none' },
  });


  // Step 3: lights. mode=directional-only spawns only the DirectionalLight;
  // three-lights + ab-compare spawn all 3. plan-strategy D-3 + D-8.
  world.spawn({
    component: DirectionalLight,
    data: { castShadow: true,
      // Outgoing direction: down + slightly forward, simulating a warm key
      // light overhead. The shader negates internally for L vector.
      direction: [0.0, -1.0, -0.3],
      color: [1.0, 0.95, 0.85],
      intensity: 1.0,
    },
  }).unwrap();

  if (mode === 'three-lights' || mode === 'ab-compare') {
    // PointLight: magenta accent floating just in front of the sprite cluster
    // so the falloff hits each quad differently (AC-06 evidence).
    world.spawn(
      {
        component: Transform,
        data: { pos: [0.0, 0.3, 1.5], quat: [0, 0, 0, 1]},
      },
      {
        component: PointLight,
        data: {
          color: [1.0, 0.4, 1.0],
          intensity: 3.0,
          range: 4.0,
        },
      },
    ).unwrap();

    // SpotLight: cyan rim coming from the right side, cone pointing
    // toward the sprite cluster origin.
    world.spawn(
      {
        component: Transform,
        data: { pos: [2.0, 1.0, 1.5], quat: [0, 0, 0, 1]},
      },
      {
        component: SpotLight,
        data: { castShadow: true,
          direction: [-0.8, -0.4, -0.4],
          color: [0.3, 1.0, 1.0],
          intensity: 4.0,
          range: 6.0,
          innerConeDeg: 15,
          outerConeDeg: 30,
        },
      },
    ).unwrap();
  }

  // Step 4: orthographic camera, fits the sprite row.
  world.spawn(
    {
      component: Transform,
      data: { pos: [0, 0, 5], quat: [0, 0, 0, 1]},
    },
    {
      component: Camera,
      data: {
        ...orthographic({
          left: -1.6,
          right: 1.6,
          bottom: -1.0,
          top: 1.0,
          near: 0.1,
          far: 100,
        }),
        tonemap: TONEMAP_NONE,
        clearColor: [0.05, 0.06, 0.08, 1.0],
      },
    },
  ).unwrap();

  // Step 5: build the sprite-lit MaterialAsset handles. AC-13 SSOT: switching
  // shader id from 'forgeax::sprite' to 'forgeax::sprite-lit' is the
  // entire opt-in for the new shading model.
  const litMaterialHandles: Array<Handle<'MaterialAsset', 'shared'>> = [];
  for (const slot of SPRITE_SLOTS) {
    litMaterialHandles.push(
      world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
        kind: 'material',
        passes: [
          { name: 'Forward', program: { module: 'forgeax::sprite-lit' }, renderState: { ...{ blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND }, tags: { LightMode: 'Forward' }, queue: 3000 } },
        ],
        parameters: SPRITE_LIT_PARAMETERS,
        values: {
          // post-#520 SSOT: values field names are UBO-aligned to the
          // shader's paramSchema. sprite-lit.material.json mirrors sprite:
          // colorTint / region / pivotAndSize / slicesAndMode / baseColorTexture.
          // The legacy baseColor / texture / pivot names are gone.
          colorTint: slot.tint,
          baseColorTexture: textureHandle,
          region: [0, 0, 1, 1],
          pivotAndSize: [0.5, 0.5, 1, 1],
        },
      }),
    );
  }

  if (mode === 'ab-compare') {
    // AB compare: shift the lit row down (-0.45 Y) and add a row of plain
    // forgeax::sprite (unlit) at +0.45 Y, both rows over 4 slots. AC-13
    // visual gate is "left/right share base art, only shader id differs".
    const unlitMaterialHandles: Array<Handle<'MaterialAsset', 'shared'>> = [];
    for (const slot of SPRITE_SLOTS) {
      unlitMaterialHandles.push(
        world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
          kind: 'material',
        passes: [
          { name: 'Forward', program: { module: 'forgeax::sprite' }, renderState: { ...{ blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND }, tags: { LightMode: 'Forward' }, queue: 3000 } },
        ],
        parameters: SPRITE_LIT_PARAMETERS,
          values: {
            colorTint: slot.tint,
            baseColorTexture: textureHandle,
            region: [0, 0, 1, 1],
            pivotAndSize: [0.5, 0.5, 1, 1],
          },
        }),
      );
    }
    spawnSpriteRow(world, SPRITE_SLOTS, unlitMaterialHandles, 0.45);
    spawnSpriteRow(world, SPRITE_SLOTS, litMaterialHandles, -0.45);
  } else {
    spawnSpriteRow(world, SPRITE_SLOTS, litMaterialHandles, 0.0);
  }

  // Step 6: AC-14 sanity check -- a standard PBR cube co-located with the
  // sprite row so the same 3 lights light both 2D sprite quad and 3D mesh
  // through the same DirectionalLight/PointLight/SpotLight components. The
  // sprite-lit Half-Lambert squared and PBR GGX diffuse are not pixel-equal
  // (different shading models by design) but the cube being lit in the same
  // colour direction is the AC-14 visual signal.
  if (mode !== 'ab-compare') {
    const cubeMaterial = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
      kind: 'material',
      passes: [
        { name: 'Forward', program: { module: 'forgeax::default-standard-pbr' }, renderState: { tags: { LightMode: 'Forward' }, queue: 2000 } },
      ],
      values: {
        baseColor: [0.7, 0.7, 0.75],
        metallic: 0.0,
        roughness: 0.8,
      },
    });
    world.spawn(
      {
        component: Transform,
        data: { pos: [0.0, -0.6, 0.0], quat: [0, 0, 0, 1], scale: [0.3, 0.3, 0.3]},
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [cubeMaterial] } },
    ).unwrap();
  }

  const startRes = app.start();
  if (!startRes.ok) {
    reportAppError(startRes.error);
    return;
  }
  console.warn(`[sprite-lit] running. mode=${mode} (4 sprite-lit quads + 3 lights).`);
}

function spawnSpriteRow(
  world: World,
  slots: typeof SPRITE_SLOTS,
  handles: ReadonlyArray<Handle<'MaterialAsset', 'shared'>>,
  yOffset: number,
): void {
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const matHandle = handles[i];
    if (slot === undefined || matHandle === undefined) continue;
    world
      .spawn(
        {
          component: Transform,
          data: {
            pos: [slot.pos[0], slot.pos[1] + yOffset, slot.pos[2]], quat: [0, 0, 0, 1], scale: [0.45, 0.45, 1],},
        },
        { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
        { component: MeshRenderer, data: { materials: [matHandle] } },
      )
      .unwrap();
  }
}

// Procedural 4-quadrant checkerboard so the colorTint multiplication stays
// visible without needing a vendor PNG. 4 quadrants follow the canonical
// dawn-smoke palette so a future smoke screenshot diff stays predictable.
function buildCheckerboardRgba(side: number): {
  width: number;
  height: number;
  data: Uint8Array;
} {
  const w = side;
  const h = side;
  const bytes = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const top = y < h / 2;
      const left = x < w / 2;
      const quadrant = top ? (left ? 0 : 1) : left ? 2 : 3;
      // 0 warm orange, 1 fresh green, 2 cool cyan, 3 pale magenta.
      const palette: ReadonlyArray<readonly [number, number, number, number]> = [
        [220, 110, 50, 255],
        [80, 220, 100, 255],
        [60, 180, 220, 255],
        [230, 130, 200, 255],
      ];
      const c = palette[quadrant] ?? palette[0];
      const r = c?.[0] ?? 220;
      const g = c?.[1] ?? 110;
      const b = c?.[2] ?? 50;
      const a = c?.[3] ?? 255;
      bytes[i + 0] = r;
      bytes[i + 1] = g;
      bytes[i + 2] = b;
      bytes[i + 3] = a;
    }
  }
  return { width: w, height: h, data: bytes };
}

function reportAppError(err: CanvasAppError): void {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[sprite-lit] EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  console.error(`[sprite-lit] ${err.code}: ${err.hint}`);
}

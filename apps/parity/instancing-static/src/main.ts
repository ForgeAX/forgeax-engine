// apps/parity/instancing-static/src/main.ts (M4 T-M4-3) — AC-09 fixture.
//
// 10000 static cubes in a 20*20*25 grid drawn as a single instanced draw via
// the new Instances component. Locked parameters mirror requirements.md
// AC-09 verbatim:
//   - grid:        20 * 20 * 25 = 10000 cubes
//   - spacing:     1 unit between centres -> 2.0 unit pitch (cube extent 1)
//   - camera:      position (30, 30, 60) looking at origin, fov = 60 degrees
//   - light:       single DirectionalLight direction (-0.3, -1, -0.5)
//                  (matches hello-room main.ts directional light shape)
//   - canvas:      1280 * 720 (default for metrics:run-fps + 16:9 aspect)
//   - clear color: (0.05, 0.05, 0.08, 1.0) (deep-blue background)
//
// Sampling driver (scripts/metrics/run-fps.mjs M4 T-M4-2 + AC-09):
//   - 30 frame warm-up + 60 frame sample.
//
// feat-20260514-ecs-children-instances-managed-buffer-array M3 / w15:
//   The legacy spawn-site (`engine.assets.createInstancedBuffer(...)` ->
//   `Handle<InstancedBufferAsset>` -> `Instances { buffer, count }`) is
//   gone — `AssetRegistry.createInstancedBuffer` was deleted alongside
//   the `InstancedBufferAsset` POD. Per-entity instance transforms now
//   live inside the ECS via `Instances { transforms: 'array<f32>' }`
//   (component-level `arrayStride: { transforms: 16 }` declared on the
//   defineComponent options arg). The RenderSystem record stage owns
//   GPU storage buffer allocation + upload; AI users hand the packed
//   `Float32Array` straight to `world.spawn({ component: Instances,
//   data: { transforms } })`.
//
// EMPTY_MANIFEST_URL placeholder: this fixture ships no .wgsl source, so
// shaderManifestUrl is supplied as a data URL holding an empty manifest
// (mirrors apps/parity/forgeax + apps/hello/triangle smoke pattern).

import { World } from '@forgeax/engine-ecs';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';

import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { createRenderer, EngineEnvironmentError } from '@forgeax/engine-runtime';
import { Instances } from '@forgeax/engine-render';

import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const CANVAS_W = 1280;
const CANVAS_H = 720;

// Grid form (locked by requirements.md AC-09):
const GRID_X = 20;
const GRID_Y = 20;
const GRID_Z = 25;
const INSTANCE_COUNT = GRID_X * GRID_Y * GRID_Z; // 10000
const SPACING = 2.0;

// Camera (locked by requirements.md AC-09):
const CAM_POS_X = 30;
const CAM_POS_Y = 30;
const CAM_POS_Z = 60;
const CAM_FOV = (60 * Math.PI) / 180; // 60 degrees -> radians

// Directional light (locked by requirements.md AC-09 + hello-room parity):
const LIGHT_DIR_X = -0.3;
const LIGHT_DIR_Y = -1.0;
const LIGHT_DIR_Z = -0.5;

// Clear color (locked by requirements.md AC-09):
const CLEAR_R = 0.05;
const CLEAR_G = 0.05;
const CLEAR_B = 0.08;
const CLEAR_A = 1.0;

// Build packed mat4 transform buffer for the 20*20*25 grid.
//
// Layout: column-major mat4 per instance (16 f32 each), so the buffer is
// Float32Array(INSTANCE_COUNT * 16) = 160000 f32 = 640000 bytes (well below
// the spec-minimum maxStorageBufferBindingSize = 128 MiB so the
// `'limit-exceeded'` cap-gate path is not triggered here). Each transform
// is a pure translation matrix centring the grid on origin: identity
// rotation, identity scale, only columns[3].xyz vary per instance.
//
//   col 0 = (1, 0, 0, 0)
//   col 1 = (0, 1, 0, 0)
//   col 2 = (0, 0, 1, 0)
//   col 3 = (tx, ty, tz, 1)
function buildTranslationGrid(): Float32Array {
  const out = new Float32Array(INSTANCE_COUNT * 16);
  const halfX = ((GRID_X - 1) * SPACING) / 2;
  const halfY = ((GRID_Y - 1) * SPACING) / 2;
  const halfZ = ((GRID_Z - 1) * SPACING) / 2;
  let i = 0;
  for (let z = 0; z < GRID_Z; z++) {
    for (let y = 0; y < GRID_Y; y++) {
      for (let x = 0; x < GRID_X; x++) {
        const base = i * 16;
        out[base + 0] = 1;
        out[base + 1] = 0;
        out[base + 2] = 0;
        out[base + 3] = 0;
        out[base + 4] = 0;
        out[base + 5] = 1;
        out[base + 6] = 0;
        out[base + 7] = 0;
        out[base + 8] = 0;
        out[base + 9] = 0;
        out[base + 10] = 1;
        out[base + 11] = 0;
        out[base + 12] = x * SPACING - halfX;
        out[base + 13] = y * SPACING - halfY;
        out[base + 14] = z * SPACING - halfZ;
        out[base + 15] = 1;
        i++;
      }
    }
  }
  return out;
}

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('parity-instancing-static: missing <canvas id="app">');
canvas.width = CANVAS_W;
canvas.height = CANVAS_H;

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError)
    console.error('[instancing-static] no usable backend:', err);
  else console.error('[instancing-static] bootstrap error:', err);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  // feat-20260518-pbr-direct-lighting-mvp M5 / w22.8: vite.config.ts wires
  // the forgeaxShader plugin which auto-emits the shader manifest carrying
  // pbr/unlit entries. feat-20260608 / M3: the manifest URL is owned by the
  // plugin (SSOT) and surfaced via the virtual:forgeax/bundler adapter so
  // callsites no longer name it.
  const rendererResult = await createRenderer(target, {}, forgeaxBundlerAdapter());
  if (!rendererResult.ok) throw rendererResult.error;
  const renderer = rendererResult.value;
  console.warn(`[instancing-static] state=${renderer.inspect().state}`);


  const world = new World();
  const worldAttachment = renderer.attach(world);
  if (!worldAttachment.ok) throw worldAttachment.error;
  const lease = worldAttachment.value;

  // Single entity holding the Instances component + cube mesh + standard
  // material renderer. Per requirements.md §4 "Per-draw fallback" + group
  // transform: this entity's Transform is identity, so the world =
  // entity_world * instances_local[i] reduces to instances_local[i] (pure
  // translation). The vertex shader walks instance i across all 10000.
  const transforms = buildTranslationGrid();
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    {
      component: MeshRenderer,
      data: {},
    },
    {
      component: Instances,
      data: { transforms },
    },
  );

  // Camera entity (locked AC-09 form).
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [CAM_POS_X, CAM_POS_Y, CAM_POS_Z], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
    },
    {
      component: Camera,
      data: {
        fov: CAM_FOV,
        aspect: CANVAS_W / CANVAS_H,
        near: 0.1,
        far: 1000,
        clearColor: [CLEAR_R, CLEAR_G, CLEAR_B, CLEAR_A],
      },
    },
  );

  // Single DirectionalLight (matches hello-room main.ts shape, per AC-09).
  world.spawn({
    component: DirectionalLight,
    data: {
      direction: [LIGHT_DIR_X, LIGHT_DIR_Y, LIGHT_DIR_Z],
      color: [1, 1, 1],
      intensity: 1,
    },
  });

  // Steady rAF loop so scripts/metrics/run-fps.mjs observes natural pacing
  // across its sampleCount * frameCount window.
  const tick = (): void => {
    world.update().unwrap();
    const frame = renderer.draw({
      leases: [lease],
      camera: { lease },
      environment: { lease },
    });
    if (!frame.ok) throw frame.error;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

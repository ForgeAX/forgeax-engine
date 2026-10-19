// apps/learn-render/4.advanced-opengl/9.instancing/src/index.ts
// LearnOpenGL section 4.advanced-opengl 9.instancing — asteroid belt.
//
// LO 9.instancing renders an asteroid belt of ~1000+ rocks in a single
// glDrawElementsInstanced call, feeding per-instance model matrices through
// an instanced vertex attribute. The engine equivalent is the `Instances`
// component: one entity carries a packed `Float32Array(N * 16)` of
// column-major mat4 transforms; the RenderSystem record stage uploads them to
// a per-entity GPU storage buffer and issues a single instanced draw.
//
// Per-instance orbit transforms are computed with @forgeax/engine-math
// (quat.fromAxisAngle + mat4.compose) — zero hand-written quaternion/matrix
// math at the demo layer (AC-07).
//
// Model+texture hit-rate:
//   Planet mesh:    hit (vendor gltf) — planet.gltf via loadByGuid<MeshAsset>
//   Asteroid mesh:  hit (vendor gltf) — rock.gltf via loadByGuid<MeshAsset>
//   Planet texture: hit (vendor png)  — mars.png via loadByGuid<TextureAsset>
//   Rock texture:   hit (vendor png)  — rock.png via loadByGuid<TextureAsset>
//
// GREP anchors for AI users:
//   "// 1. engine usage"    public engine API consumed (copy-paste)
//   "// 2. example glue"    LO 4.9 asteroid-belt scene constants (customize)
//   "// 3. bootstrap"       entry point wiring (1)+(2)

// 1. engine usage
import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { mat4, quat } from '@forgeax/engine-math';
import { createApp } from '@forgeax/engine-app/browser';
import { Transform } from '@forgeax/engine-scene';

import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';

import { Materials } from '@forgeax/engine-render';
import { Instances } from '@forgeax/engine-render';

import type {
  MaterialAsset,
  MeshAsset,
  TextureAsset,
} from '@forgeax/engine-types';
import { unwrapHandle } from '@forgeax/engine-types';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { addFirstPersonSystem } from '../../../../shared/src/learn-render-first-person';

// 2. example glue

// The runtime binding provides the scoped GUID -> URL map in dev and the
// single-game catalog emitted to dist/ at build time.

// Asteroid belt form. The belt is a torus of ASTEROID_COUNT rocks orbiting a
// central planet, mirroring LO 9.instancing's `amount = 1000` ring.
const ASTEROID_COUNT = 1200;
const BELT_RADIUS = 16.0; // mean orbit radius
const BELT_RADIUS_JITTER = 4.0; // +/- radial spread
const BELT_HEIGHT_JITTER = 2.0; // +/- vertical spread
const ASTEROID_SCALE_MIN = 0.1;
const ASTEROID_SCALE_MAX = 0.45;

// Central planet (non-instanced) radius.
const PLANET_SCALE = 4.0;

// Camera — pulled back + elevated to frame the whole belt.
const CAMERA_FOV = Math.PI / 3;
const CAMERA_POS_X = 0;
const CAMERA_POS_Y = 14;
const CAMERA_POS_Z = 34;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 200;

// vendored GUIDs (from forgeax-engine-assets/learn-opengl/objects/ sidecars)
const PLANET_MESH_GUID = AssetGuid.parse('019ea6af-7084-75fd-bf77-de799946f4c9');
const ROCK_MESH_GUID = AssetGuid.parse('019ea6af-9d77-7776-9e32-58ba7fd3e4cc');
const MARS_TEXTURE_GUID = AssetGuid.parse('019ea6b1-7e5e-7035-833e-e5a16a95307c');
const ROCK_TEXTURE_GUID = AssetGuid.parse('019ea6b1-7e5e-7e6e-99cc-147aeb8c56a8');

// Deterministic PRNG (mulberry32) so the belt layout is reproducible across
// runs — the smoke's instances=1 degenerate state must be a stable subset.
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Build the packed column-major mat4 buffer for `count` asteroids.
//
// Each asteroid's transform is composed via engine-math:
//   - orbit angle theta around the +Y axis (quat.fromAxisAngle)
//   - a random tumble tilt so rocks are not all axis-aligned
//   - position on the belt ring (radius + jitter, height jitter)
//   - per-rock scale
// mat4.compose(out, translation, rotation, scale) yields a column-major mat4;
// its 16 floats are copied verbatim into the per-instance slot (stride 16).
function buildAsteroidBelt(count: number): Float32Array {
  const out = new Float32Array(count * 16);
  const m = mat4.create();
  const rot = quat.create();
  const tilt = quat.create();
  const tumble = quat.create();
  const rng = makeRng(0x9e37_79b9);
  const t: [number, number, number] = [0, 0, 0];
  const s: [number, number, number] = [1, 1, 1];
  for (let i = 0; i < count; i++) {
    const theta = (i / count) * Math.PI * 2 + rng() * 0.08;
    const radius = BELT_RADIUS + (rng() * 2 - 1) * BELT_RADIUS_JITTER;
    t[0] = Math.cos(theta) * radius;
    t[1] = (rng() * 2 - 1) * BELT_HEIGHT_JITTER;
    t[2] = Math.sin(theta) * radius;

    // Orbit-facing yaw + a random tumble tilt, composed quat-on-quat.
    quat.fromAxisAngle(rot, [0, 1, 0], theta);
    quat.fromAxisAngle(tilt, [1, 0, 0], rng() * Math.PI * 2);
    quat.multiply(tumble, rot, tilt);

    const scale = ASTEROID_SCALE_MIN + rng() * (ASTEROID_SCALE_MAX - ASTEROID_SCALE_MIN);
    s[0] = scale;
    s[1] = scale;
    s[2] = scale;

    mat4.compose(m, t, tumble, s);
    out.set(m, i * 16);
  }
  return out;
}

// 3. bootstrap

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 4.9 instancing] missing <canvas id='app'> in index.html");
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
const appRes = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter(), importTransport: createRuntimeAssetImportTransport(runtimeBinding) },
  );
  if (!appRes.ok) {
    console.error('[learn-render 4.9 instancing] createApp failed:', appRes.error);
    return;
  }
  const app = appRes.value;
  const world = app.world;
  app.onError((error) => {
    console.error('[learn-render 4.9 instancing] app.onError:', error.code, error.hint);
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: error.code, hint: error.hint });
  });
  const assets = app.assets;
  if (assets === undefined) {
    console.error('[learn-render 4.9 instancing] asset owner is unavailable');
    return;
  }

  // Wire the scoped catalog: loadByGuid fast-path checks the in-memory map
  // first; the binding also supplies the scoped package and import endpoints.
  configureRuntimeAssetCatalog(assets, runtimeBinding);

  // --- load vendored planet mesh + mars.png texture ---

  if (!PLANET_MESH_GUID.ok) {
    console.error('[learn-render 4.9 instancing] invalid PLANET_MESH_GUID');
    return;
  }
  if (!ROCK_MESH_GUID.ok) {
    console.error('[learn-render 4.9 instancing] invalid ROCK_MESH_GUID');
    return;
  }
  if (!MARS_TEXTURE_GUID.ok) {
    console.error('[learn-render 4.9 instancing] invalid MARS_TEXTURE_GUID');
    return;
  }
  if (!ROCK_TEXTURE_GUID.ok) {
    console.error('[learn-render 4.9 instancing] invalid ROCK_TEXTURE_GUID');
    return;
  }

  const planetMeshRes = await assets.loadByGuid<MeshAsset>(PLANET_MESH_GUID.value);
  if (!planetMeshRes.ok) {
    console.error('[learn-render 4.9 instancing] loadByGuid<MeshAsset>(planet) failed:', planetMeshRes.error);
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: planetMeshRes.error.code, hint: planetMeshRes.error.hint });
    return;
  }
  const planetMeshHandle = world.allocSharedRef('MeshAsset', planetMeshRes.value);

  const marsTexRes = await assets.loadByGuid<TextureAsset>(MARS_TEXTURE_GUID.value);
  if (!marsTexRes.ok) {
    console.error('[learn-render 4.9 instancing] loadByGuid<TextureAsset>(mars.png) failed:', marsTexRes.error);
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: marsTexRes.error.code, hint: marsTexRes.error.hint });
    return;
  }
  const marsTexHandle = unwrapHandle(world.allocSharedRef('TextureAsset', marsTexRes.value));

  const rockMeshRes = await assets.loadByGuid<MeshAsset>(ROCK_MESH_GUID.value);
  if (!rockMeshRes.ok) {
    console.error('[learn-render 4.9 instancing] loadByGuid<MeshAsset>(rock) failed:', rockMeshRes.error);
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: rockMeshRes.error.code, hint: rockMeshRes.error.hint });
    return;
  }
  const rockMeshHandle = world.allocSharedRef('MeshAsset', rockMeshRes.value);

  const rockTexRes = await assets.loadByGuid<TextureAsset>(ROCK_TEXTURE_GUID.value);
  if (!rockTexRes.ok) {
    console.error('[learn-render 4.9 instancing] loadByGuid<TextureAsset>(rock.png) failed:', rockTexRes.error);
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: rockTexRes.error.code, hint: rockTexRes.error.hint });
    return;
  }
  const rockTexHandle = unwrapHandle(world.allocSharedRef('TextureAsset', rockTexRes.value));

  // Central planet material — PBR standard with mars.png baseColorTexture.
  const planetMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({
      baseColor: [0.7, 0.7, 0.7, 1],
      metallic: 0.1,
      roughness: 0.8,
      baseColorTexture: marsTexHandle,
    }),
  );

  // Asteroid material — PBR standard with rock.png baseColorTexture.
  // rock.mtl maps rock.png via map_Bump (normalTexture), not map_Kd
  // (baseColorTexture). Research F-7: demo self-manufactures material,
  // ignoring gltf built-in material entirely.
  const asteroidMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({
      baseColor: [0.7, 0.7, 0.7, 1],
      metallic: 0.05,
      roughness: 0.9,
      baseColorTexture: rockTexHandle,
    }),
  );

  // Central planet — a single non-instanced sphere at the origin, using
  // vendored planet mesh + mars.png texture.
  world.spawn(
    {
      component: Transform,
      data: { pos: [0, 0, 0], scale: [PLANET_SCALE, PLANET_SCALE, PLANET_SCALE]},
    },
    { component: MeshFilter, data: { assetHandle: planetMeshHandle } },
    { component: MeshRenderer, data: { materials: [planetMat] } },
  );

  // Asteroid belt — ONE entity carrying the packed per-instance transforms.
  // The engine walks instance i across all ASTEROID_COUNT rocks in a single
  // instanced draw; the holder Transform is identity so world = instance[i].
  const transforms = buildAsteroidBelt(ASTEROID_COUNT);
  world.spawn(
    { component: Transform, data: {} },
    { component: MeshFilter, data: { assetHandle: rockMeshHandle } },
    { component: MeshRenderer, data: { materials: [asteroidMat] } },
    { component: Instances, data: { transforms } },
  );

  // DirectionalLight — sun lighting the belt.
  world.spawn({
    component: DirectionalLight,
    data: { castShadow: true,
      direction: [-0.5, -0.7, -0.4],
      color: [1, 0.97, 0.92],
      intensity: 2.0,
    },
  });

  // Camera — elevated + pulled back to frame the whole belt.
  world.spawn(
    {
      component: Transform,
      data: { pos: [CAMERA_POS_X, CAMERA_POS_Y, CAMERA_POS_Z]},
    },
    {
      component: Camera,
      data: perspective({
        fov: CAMERA_FOV,
        aspect: target.width / target.height,
        near: CAMERA_NEAR,
        far: CAMERA_FAR,
      }),
    },
  );

  addFirstPersonSystem(world, {
    name: 'learn-render-4.9-instancing-first-person',
    overrideBackend: undefined,
  });

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 4.9 instancing] app.start failed:', startRes.error);
    return;
  }
  console.warn('[learn-render 4.9 instancing] Standard pipeline active');

  // Positive "bootstrap ran to completion" marker for the onerror-gate
  // tripwire (#426). Reaching here means every loadByGuid resolved and the
  // demo started — i.e. the OOS-1 mesh-DDC gap is closed. The reverse-
  // expectation test reads this to tell "OOS-1 fixed -> flip the tripwire
  // red" apart from "bootstrap disrupted before the planet load -> stay
  // green, inconclusive". Only set on the all-clear path; every early
  // return above leaves it unset.
  (globalThis as unknown as { __learnRenderBootstrapComplete?: boolean }).__learnRenderBootstrapComplete =
    true;
}

declare global {
  interface Window {
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
    __learnRenderBootstrapComplete?: boolean;
  }
}

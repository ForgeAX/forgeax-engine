import { Update } from '@forgeax/engine-ecs';
// Standard clustered-lighting 256-light demo
// (feat-20260608-cluster-lighting / M7 / w25).
//
// This demo selects the Standard clustered-lighting lane at host assembly.
// `renderPath` only chooses the forward/deferred graph variant; both variants
// consume the same unified Cluster light transport.
//
// Scene (charter F1 progressive disclosure):
//   - 1 ground cube (large, dark gray) acting as the "lit floor".
//   - 200 PointLight + 56 SpotLight = 256 punctual lights distributed in
//     a 6 x 6 m horizontal slab above the ground; intensity / color
//     randomized for visible cluster-forward dispatch.
//   - Per-frame animation: a fraction of the lights orbit the origin so
//     the cluster bins repopulate every frame (proves the binner runs
//     once per frame, not just once at install).
//
// Optional mode:
//   ?falsify=force-forward -- select the forward graph variant. This remains
//   the same clustered Standard lighting path.
//
// Charter mapping:
//   - P1 progressive disclosure: createApp -> Standard profile -> spawn 256
//     lights -> per-frame animation -> app.start.
//   - P5 consistent abstraction: direct and clustered are closed Standard
//     profile lanes with one renderer owner.

import { createApp } from '@forgeax/engine-app/browser';
import type { CanvasAppError } from '@forgeax/engine-app';

import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';

import {
  Camera,
  DEFAULT_STANDARD_PROFILE,
  MeshFilter,
  MeshRenderer,
  perspective,
  TONEMAP_ACES_FILMIC,
} from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { PointLight, SpotLight } from '@forgeax/engine-render';

import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const FALSIFY = (() => {
  if (typeof window !== 'undefined') {
    const url = new URL(window.location.href);
    return url.searchParams.get('falsify') ?? '';
  }
  return '';
})();

const POINT_LIGHT_COUNT = 200;
const SPOT_LIGHT_COUNT = 56;

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) {
  throw new Error('[standard-lighting] missing <canvas id="app"> in index.html');
}

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[standard-lighting] EngineEnvironmentError: webgpu inner=${code}`);
  } else {
    console.error('[standard-lighting] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  // Step 1: createApp -- one-screen takeoff.
  const appRes = await createApp(
    target,
    {
      standardProfile: {
        ...DEFAULT_STANDARD_PROFILE,
        renderPath: FALSIFY === 'force-forward' ? 'forward' : 'deferred',
        lightCount: 256,
      },
    },
    forgeaxBundlerAdapter(),
  );
  if (!appRes.ok) {
    reportAppError(appRes.error);
    return;
  }
  const app = appRes.value;
  console.warn(`[standard-lighting] backend=${app.renderer.inspect().capabilities.backendKind}`);


  const world = app.world;

  // Step 2: alloc a standard PBR material for the lit floor + lit cube as a
  // user-tier shared ref on the World (D-19).
  const materialHandle = world.allocSharedRef('MaterialAsset', {
    kind: 'material',
    passes: [
      { name: 'Forward', program: { module: 'forgeax::default-standard-pbr' }, renderState: { tags: { LightMode: 'Forward' }, queue: 2000 } },
    ],
    values: {
      baseColor: [0.6, 0.6, 0.65],
      metallic: 0.0,
      roughness: 0.6,
    },
  });

  // Step 4: spawn the lit floor cube (large flat slab) + a hero cube.
  world.spawn(
    {
      component: Transform,
      data: { pos: [0, -0.5, 0], quat: [0, 0, 0, 1], scale: [6, 0.1, 6]},
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
  ).unwrap();
  world.spawn(
    {
      component: Transform,
      data: { pos: [0, 0.6, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1]},
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
  ).unwrap();

  // Step 6: spawn 256 punctual lights distributed across the floor slab.
  // Deterministic mulberry32 PRNG so the smoke gate captures the same
  // pixel pattern across runs (ε <= 0.05 still tolerates minor driver
  // jitter, but determinism keeps the readback stable on dawn-node).
  const rng = mulberry32(0x484452_50);
  const pointEntities: Array<ReturnType<typeof world.spawn>> = [];
  const pointHomePositions: Array<readonly [number, number, number]> = [];
  for (let i = 0; i < POINT_LIGHT_COUNT; i++) {
    const x = (rng() - 0.5) * 5.5;
    const z = (rng() - 0.5) * 5.5;
    // Lift lights to y in [1.5, 3.5] -- ABOVE the hero cube (y=0.6) and the
    // floor slab (y=-0.5). With lights at the cube's own height, the +Z
    // face the camera sees gets NdotL ~= 0 (light direction is nearly
    // horizontal, surface normal is +Z) and the floor's +Y top sits past
    // the light's falloff edge -- the screen ends up almost entirely
    // black. Lifting the lights gives BOTH the cube's +Z face AND the
    // floor's +Y face a healthy NdotL, so the 256 lights actually paint
    // the scene.
    const y = 1.5 + rng() * 2.0;
    const homePosition: [number, number, number] = [x, y, z];
    pointHomePositions.push(homePosition);
    pointEntities.push(
      world.spawn(
        { component: Transform, data: { pos: homePosition, quat: [0, 0, 0, 1]} },
        {
          component: PointLight,
          data: {
            color: [0.5 + 0.5 * rng(), 0.5 + 0.5 * rng(), 0.5 + 0.5 * rng()],
            // 256 lights superimpose -- per-light intensity stays modest so
            // overlapping zones show colour mixing rather than saturating to
            // white. ACES tonemap (camera) handles peak roll-off.
            intensity: 0.3 + 0.4 * rng(),
            // Range 2.5..4.0m: lights are at y ~2.5 above the floor (y=-0.5)
            // and cube top (y=1.1), so a ~3m range reaches both surfaces
            // with healthy attenuation. Cluster index list capacity is now
            // 1 MiB (LIGHT_INDEX_LIST_CAPACITY) so AABB-fattening from the
            // larger range stays well within budget.
            range: 2.5 + 1.5 * rng(),
          },
        },
      ),
    );
  }
  for (let i = 0; i < SPOT_LIGHT_COUNT; i++) {
    const x = (rng() - 0.5) * 5.5;
    const z = (rng() - 0.5) * 5.5;
    // Spots also lifted to y in [2.0, 4.0] above the scene, pointing -Y.
    const y = 2.0 + rng() * 2.0;
    world.spawn(
      { component: Transform, data: { pos: [x, y, z], quat: [0, 0, 0, 1]} },
      {
        component: SpotLight,
        data: { castShadow: true,
          direction: [rng() - 0.5, -1, rng() - 0.5],
          color: [0.5 + 0.5 * rng(), 0.5 + 0.5 * rng(), 0.5 + 0.5 * rng()],
          intensity: 0.5 + 0.5 * rng(),
          // Range 2.5..4.0m, matches PointLight above; spots reach floor
          // through ~3.5m vertical drop with the cone roughly aimed -Y.
          range: 2.5 + 1.5 * rng(),
          innerConeDeg: 18,
          outerConeDeg: 32,
        },
      },
    );
  }
  console.warn(
    `[standard-lighting] spawned ${POINT_LIGHT_COUNT} point + ${SPOT_LIGHT_COUNT} spot = ${
      POINT_LIGHT_COUNT + SPOT_LIGHT_COUNT
    } punctual lights on the Standard clustered-lighting lane`,
  );

  // Step 7: spawn camera. identity quat looks down -Z (no lookAt helper yet,
  // see memory: smoke-camera-pose-untested-misses-cube-with-onerror-zero).
  // Eye at (0, 1.5, 6) keeps the hero cube at (0, 0.6, 0) inside the FOV
  // (vertical half-fov = atan(tan(pi/8) * 9/16) ~= 13deg; cube delta-y from
  // lookat ray = 0.9 over 6m = atan(0.9/6) ~= 8.5deg < 13deg, comfortably
  // in frame). Earlier eye y=4.0 placed the cube ~30deg below the lookat
  // ray, outside the vertical fov -- visible only as clearColor.
  // Smoke (scripts/smoke-dawn.mjs) was patched to y=1.5 in commit afe67262
  // but this browser entry was missed; M4.5-followup reconciliation.
  world.spawn(
    {
      component: Transform,
      data: { pos: [0, 1.5, 6.0], quat: [0, 0, 0, 1]},
    },
    {
      component: Camera,
      data: {
        ...perspective({ fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 50 }),
        clearColor: [0.02, 0.02, 0.04, 1],
        // 256 punctual lights with per-light intensity 1.5..4.0 push fragment
        // radiance into HDR territory; without a tonemap the swap-chain (sRGB
        // [0,1]) clamps and lit areas burn out to pure white. ACES is the
        // cinematic default; exposure 0.6 keeps mid-tones readable while
        // letting hot spots roll off naturally.
        tonemap: TONEMAP_ACES_FILMIC,
        exposure: 0.6,
      },
    },
  ).unwrap();

  // Step 8: per-frame animation -- orbit the first 32 point lights
  // around the slab center so the cluster binner repopulates every
  // frame. The orbit is small (radius 0.5) so the rough pixel pattern
  // stays close to the smoke baseline (deterministic readback target).
  let elapsed = 0;
  world.addSystem(Update, {
    name: 'standard-light-orbit',
    queries: [],
    fn: () => {
      elapsed += 1 / 60;
      const orbitCount = Math.min(32, pointEntities.length);
      for (let i = 0; i < orbitCount; i++) {
        const wrapped = pointEntities[i];
        if (!wrapped || !wrapped.ok) continue;
        const e = wrapped.value;
        const angle = elapsed * 0.6 + (i * Math.PI * 2) / orbitCount;
        const radius = 0.5;
        const dx = Math.cos(angle) * radius;
        const dz = Math.sin(angle) * radius;
        // Keep each light's authored position as the orbit center. Reusing
        // the actual seed preserves the original height and horizontal
        // distribution; deriving a second position from the entity index
        // would move the lights into a different scene every frame.
        const home = pointHomePositions[i];
        if (!home) continue;
        world.set(e, Transform, {
          pos: [home[0] + dx, home[1], home[2] + dz],
        });
      }
    },
  });

  // Step 9: arm the rAF loop.
  const startRes = app.start();
  if (!startRes.ok) {
    reportAppError(startRes.error);
    return;
  }
  console.warn(
    `[standard-lighting] running. Standard clustered lane (${FALSIFY === 'force-forward' ? 'forward' : 'deferred'} graph). 256 punctual lights orbiting.`,
  );
}

function reportAppError(err: CanvasAppError | EngineEnvironmentError): void {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[standard-lighting] EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  console.error(`[standard-lighting] ${err.code}: ${err.hint}`);
}

// mulberry32 PRNG -- deterministic 32-bit, used for repeatable seeds.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

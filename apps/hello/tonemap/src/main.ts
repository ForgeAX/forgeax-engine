// apps/hello/tonemap - Reinhard-extended tonemap opt-in exemplar
// (feat-20260519-tonemap-reinhard-mvp / M4 / T-M4.1).
//
// Why this demo exists: AC-08 (highlight readback in (0.3, 1.0)) requires a
// scene where the **default** path would burn out to (1, 1, 1) integer
// white. We pair a `'standard'` PBR sphere with a 2x-overbright (intensity=2)
// `DirectionalLight` so the unclipped HDR colour easily exceeds 1.0 in the
// brightest highlight band. With `Camera.tonemap = 'reinhard-extended'` the
// engine routes the geometry pass into an `rgba16float` HDR target and
// follows up with a fullscreen tonemap pass that maps the over-1.0 luminance
// back into the displayable [0, 1] range without integer clipping.
//
// Recipe (4 steps; AI users discover the opt-in via spawn-time field):
//   (1) `createRenderer(canvas, { clearColor })` mirrors hello-room.
//   (2) Register a procedural sphere + `'standard'` PBR material handle so
//       the GGX direct-lighting pipeline runs (12-float vertex stride).
//   (3) Spawn a single sphere entity with `MeshFilter` + `MeshRenderer`
//       bound to the material handle, plus a Camera with the **3 new
//       fields** (tonemap / exposure / whitePoint) and a 2x-overbright
//       DirectionalLight.
//   (4) `renderer.draw(world)` per frame; the engine reads
//       `camera.tonemap` and routes through the HDR + tonemap path
//       automatically (zero new API for AI users beyond the trio of fields).
//
// 5+5 minimal-surface example for AGENTS.md / README discovery (charter F1
// progressive disclosure). Default zero-overhead path:
//
//   const renderer = await createRenderer(canvas, {});
//   world.spawn(
//     { component: Transform, data: { pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1]} },
//     { component: Camera,    data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 } },
//   );
//
// Reinhard-extended opt-in (3 extra fields on Camera):
//
//   { component: Camera, data: {
//       fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100,
//       tonemap:    TONEMAP_REINHARD_EXTENDED,
//       exposure:   1.0,
//       whitePoint: 8.0,
//   } }
//
// On `whitePoint`: the extended Reinhard knee sends Y == Lw to exactly 1.0.
// AI users tune Lw against the peak HDR luminance the scene can produce. A
// PBR sphere lit by intensity=2 directional light produces a peak luminance
// in the 6-7 range (the GGX specular lobe is narrow at roughness=0.4, so
// the brightest pixel is many times the diffuse mean even at modest light
// intensity); `whitePoint = 8.0` keeps even the specular peak below 1
// without burning while still demonstrating the compression. Without opt-in
// the same scene burns to integer white because the swap-chain
// `bgra8unorm-srgb` store clamps at 1.0 after the sRGB encode.
//
// Visual effect with intensity=2 light:
//   default path  -> highlight burns to (255, 255, 255) integer white
//   opt-in path   -> highlight maps to a displayable mid-to-high grey
//                    inside the (0.3, 1.0) per-channel band

import { World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';

import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective, TONEMAP_REINHARD_EXTENDED } from '@forgeax/engine-render';
import { createRenderer, EngineEnvironmentError } from '@forgeax/engine-runtime';
import { Materials } from '@forgeax/engine-render';

import { createSphereGeometry } from '@forgeax/engine-geometry';
import type { MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('hello-tonemap: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    console.error('[tonemap] no usable backend:', err);
  } else {
    console.error('[tonemap] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const rendererResult = await createRenderer(target, {}, forgeaxBundlerAdapter());
  if (!rendererResult.ok) {
    console.error('[tonemap] renderer construction failed:', rendererResult.error);
    return;
  }
  const renderer = rendererResult.value;
  console.warn(`[tonemap] backend=${renderer.inspect().capabilities.backendKind}`);


  const sphereRes = createSphereGeometry(0.6, 32, 24);
  if (!sphereRes.ok) {
    console.error('[tonemap] createSphereGeometry failed:', sphereRes.error);
    return;
  }

  const world = new World();
  const worldAttachment1 = renderer.attach(world);
  if (!worldAttachment1.ok) throw worldAttachment1.error;

  const sphereHandle = world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', sphereRes.value);

  // Mid-grey standard PBR material; the high-intensity light is what
  // pushes the luminance > 1.0 into the integer-white burn band on the
  // default path. feat-20260523 M8-T03: schema-driven register form.
  const materialHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.7, 0.7, 0.7, 1], metallic: 0.0, roughness: 0.4 }),
  );

  // Sphere at origin (PBR; standard pipeline; 12F vertex stride).
  world.spawn(
    {
      component: Transform,
      data: {},
    },
    { component: MeshFilter, data: { assetHandle: sphereHandle } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
  ).unwrap();

  // Camera with the **3 new tonemap-trio fields** opt-in (T-M4.1 AC-01
  // discovery surface; charter F1 progressive disclosure).
  world.spawn(
    {
      component: Transform,
      data: { pos: [0, 0, 2.5]},
    },
    {
      component: Camera,
      data: {
        ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }),
        tonemap: TONEMAP_REINHARD_EXTENDED,
        exposure: 1.0,
        whitePoint: 8.0,
      },
    },
  ).unwrap();

  // 2x-overbright directional light. With the default tonemap='none' path
  // this would burn highlights to (255,255,255); with the opt-in extended
  // Reinhard the highlights stay below the integer-white ceiling
  // (AC-07 + AC-08).
  world.spawn({
    component: DirectionalLight,
    data: {
      direction: [-0.4, -0.6, -0.7],
      color: [1, 1, 1],
      intensity: 2,
    },
  }).unwrap();

  const frame = (): void => {
    world.update().unwrap();
    const r = renderer.draw({
      leases: [worldAttachment1.value],
      camera: { lease: worldAttachment1.value },
      environment: { lease: worldAttachment1.value },
    });
    if (!r.ok) console.error('[tonemap] draw error:', r.error);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

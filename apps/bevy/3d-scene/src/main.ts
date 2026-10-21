// apps/bevy/3d-scene - reproduction of Bevy's `3d_scene` example.
//
// Bevy source (references/repos/bevy/examples/3d/3d_scene.rs): "a simple 3D
// scene with light shining over a cube sitting on a plane" —
//   - a circular base plane, white StandardMaterial, rotated flat (-90 deg X)
//   - a unit cube, srgb_u8(124,144,255) StandardMaterial, at y=0.5
//   - a PointLight at (4,8,4), shadows enabled
//   - a Camera at (-2.5,4.5,9.0) looking at the origin
//
// forgeax mapping (thin over existing primitives, standard-PBR path — no
// pack.json / GUID plumbing; direct world.spawn like apps/hello/shadow-opt-out):
//   - base:  HANDLE_CUBE scaled flat (a plane primitive would work too; a flat
//            box keeps the demo to one mesh handle). White PBR material.
//   - cube:  HANDLE_CUBE at y=0.5. Blue PBR material (124,144,255)/255 in
//            linear-ish space — kept as authored sRGB-ish values for parity.
//   - light: Transform (4,8,4) + PointLight (standard-PBR needs >=1 light or
//            the render is physically black — runtime README Common pitfalls).
//   - cam:   Transform (-2.5,4.5,9.0) aimed at the origin via quat.fromLookAt
//            (the ergonomic camera helper — added in solo round 20260713-141636
//            to replace the mat4->invert->mat3->fromRotationMatrix hand-wiring
//            this demo originally used).

import { createApp } from '@forgeax/engine-app/browser';

import { Transform } from '@forgeax/engine-scene';

import { perspective } from '@forgeax/engine-render';

import { Materials } from '@forgeax/engine-render';
import { PointLight } from '@forgeax/engine-render';
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';

import { quat } from '@forgeax/engine-math';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';


const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-3d-scene: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  console.error('[bevy-3d-scene] bootstrap error:', err);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-3d-scene] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  const assets = app.assets;
  if (assets === undefined) throw new Error('App asset service is unavailable');


  const world = app.world;
const primitiveCube = assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();


  // ── Base plane (flat-scaled cube), white PBR ──────────────────────────
  const baseMat = assets.create(Materials.standard({ baseColor: [1, 1, 1, 1] })).unwrap();
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [8, 0.02, 8] } },
    { component: MeshFilter, data: { assetHandle: primitiveCube } },
    { component: MeshRenderer, data: { materials: [baseMat] } },
  );

  // ── Cube, blue PBR (Bevy srgb_u8(124,144,255)) at y=0.5 ───────────────
  const cubeMat = assets.create(Materials.standard({ baseColor: [124 / 255, 144 / 255, 255 / 255, 1] })).unwrap();
  world.spawn(
    { component: Transform, data: { pos: [0, 0.5, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: MeshFilter, data: { assetHandle: primitiveCube } },
    { component: MeshRenderer, data: { materials: [cubeMat] } },
  );

  // ── Point light at (4,8,4) ────────────────────────────────────────────
  // standard-PBR is physically black with zero lights; a single PointLight
  // suffices (runtime README Common pitfalls). intensity=400 tuned against
  // Bevy's reference render: at ~9.8m the 1/d^2 falloff lands the near-white
  // lit plane + periwinkle cube that Bevy's default PointLight produces (round
  // 3's intensity=8 only cleared the not-black smoke threshold — a dark
  // workaround the round-4 screenshot-vs-Bevy check caught; see REPORT).
  world.spawn(
    { component: Transform, data: { pos: [4, 8, 4], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: PointLight, data: { color: [1, 1, 1], intensity: 400, range: 40 } },
  );

  // ── Camera at (-2.5,4.5,9.0) looking at origin ────────────────────────
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [-2.5, 4.5, 9.0],
        quat: quat.fromLookAt(quat.create(), [-2.5, 4.5, 9.0], [0, 0, 0], [0, 1, 0]),
        scale: [1, 1, 1],
      },
    },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
  );

  const started = app.start();
  if (!started.ok) console.error('[bevy-3d-scene] app.start failed:', started.error);
}

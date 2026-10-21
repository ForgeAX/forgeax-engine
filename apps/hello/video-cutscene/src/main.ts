// apps/hello/video-cutscene -- worked example of the host-engine contract
// (feat-20260617-host-engine-contract-and-video-cutscene / M4 / w14).
//
// This demo is the canonical "video cutscene" host pattern documented in
// docs/how-to/2026-06-18-host-engine-contract.md section 4.2. It uses ONLY
// existing engine API and adds ZERO engine video code:
//
//   1. createApp(canvas) boots the engine; a rotating cube is the live world.
//   2. Pressing 'C' calls app.pause() -- requestAnimationFrame is cancelled,
//      the world freezes on its last frame.
//   3. A DOM <video> overlay (host DOM/CSS, contact surface 5) is shown and
//      played. The engine knows nothing about it.
//   4. video.onended hides the overlay and calls app.resume() -- the frame
//      loop resets its dt baseline so the first resumed frame's dt is not
//      inflated by the pause duration (research Finding 8).
//   5. app.stop() (press 'S') cleans up the overlay itself: the engine has no
//      knowledge of the DOM overlay, so overlay teardown is the host's job
//      (contract contact surface 5 + section 4.2 last bullet).
//
// The cutscene <video> carries its own audio track (OOS-7); no audio-bus
// routing and no third-party video/player library is used.

import type { App } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import { Time, Update } from '@forgeax/engine-ecs';
import { quat } from '@forgeax/engine-math';

import { Transform } from '@forgeax/engine-scene';

import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { Materials } from '@forgeax/engine-render';


import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';


const canvas = document.querySelector<HTMLCanvasElement>('#canvas');
if (!canvas) throw new Error('hello-video-cutscene: missing <canvas id="canvas">');

const videoEl = document.querySelector<HTMLVideoElement>('#video-overlay');
if (!videoEl) throw new Error('hello-video-cutscene: missing <video id="video-overlay">');
const video: HTMLVideoElement = videoEl;

// M3 (w16): input:false opt-out deleted (D-6). Canvas form always attaches
// input (D-2). This demo accepts input always-on — the cutscene lifecycle
// (pause/resume/stop) is driven via C/S keyboard keys, and
// input-always-on adds negligible overhead with zero correctness impact.
// Option (a) assemble-form migration was assessed but costs (renderer
// creation, bundler adapter wiring, aspect-sync, listener-sync) outweigh
// benefits for a demo.
const appRes = await createApp(canvas, {}, forgeaxBundlerAdapter());
if (!appRes.ok) {
  if (appRes.error instanceof EngineEnvironmentError) {
    console.error('[hello-video-cutscene] EngineEnvironmentError creating renderer');
  } else {
    console.error(`[hello-video-cutscene] ${appRes.error.code}: ${appRes.error.hint}`);
  }
  throw new Error('hello-video-cutscene: createApp failed');
}
const app: App = appRes.value;
if (app.assets === undefined) throw new Error('This scene requires the App asset owner');

console.warn(`[hello-video-cutscene] backend=${app.renderer.inspect().capabilities.backendKind}`);


const world = app.world;
const primitiveCube = app.assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();


// A red cube + light + perspective camera. autoAspect defaults to true, so the
// aspect-sync sidecar on the createApp(canvas) path keeps Camera.aspect in step
// with canvas size (contract contact surface 3).
const cubeMatHandle = app.assets.create(Materials.unlit([0.9, 0.3, 0.25, 1])).unwrap();

const cube = world
  .spawn(
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1]} },
    { component: MeshFilter, data: { assetHandle: primitiveCube } },
    { component: MeshRenderer, data: { materials: [cubeMatHandle] } },
  )
  .unwrap();

world
  .spawn({
    component: DirectionalLight,
    data: { castShadow: true,
      direction: [-0.4, -0.6, -0.7],
      color: [1, 1, 1],
      intensity: 1.2,
    },
  })
  .unwrap();

world
  .spawn(
    { component: Transform, data: { pos: [0, 1, 4], quat: [0, 0, 0, 1], scale: [1, 1, 1]} },
    { component: Camera, data: perspective({ fov: Math.PI / 3, aspect: canvas.width / canvas.height }) },
  )
  .unwrap();

// Rotate the cube every frame so a paused world is visibly frozen and a
// resumed world is visibly moving (the cutscene visual contract).
// dt is in seconds (frame-loop clamps to <= 1/30s); ~1 rad/s is a clearly
// visible spin and makes the pause/resume freeze observable.
let angle = 0;
const spin = quat.create();
world
  .addSystem(Update, {
    name: 'video-cutscene-spin',
    queries: [],
    fn: () => {
      const dt = world.getResource(Time).delta;
      angle += dt;
  quat.fromAxisAngle(spin, [0, 1, 0], angle);
  // spin is a length-4 Float32Array; noUncheckedIndexedAccess widens the reads
  // to number | undefined, so coalesce to keep the Transform set value typed.
      world.set(cube, Transform, {
        quat: [spin[0] ?? 0, spin[1] ?? 0, spin[2] ?? 0, spin[3] ?? 1],
      });
    },
  })
  .unwrap();

// --- Cutscene: pause -> overlay -> resume (contract section 4.2) ---

function playCutscene(): void {
  // pause() is idempotent: a no-op (Result.err 'app-not-started') when already
  // paused -- safe to ignore (contract section 4.2).
  const pauseResult = app.pause();
  if (!pauseResult.ok) return;

  video.style.display = 'block';
  video.currentTime = 0;
  void video.play();

  video.onended = () => {
    video.style.display = 'none';
    video.onended = null;
    const resumeResult = app.resume();
    if (!resumeResult.ok) {
      console.error('[hello-video-cutscene] resume failed:', resumeResult.error.code);
    }
  };
}

// stop() ends the frame loop. The engine has no knowledge of the DOM overlay,
// so the host tears it down itself (contract contact surface 5).
function stopApp(): void {
  video.style.display = 'none';
  video.onended = null;
  video.pause();
  const stopResult = app.stop();
  if (!stopResult.ok) {
    console.error('[hello-video-cutscene] stop failed:', stopResult.error.code);
  }
}

// Browser smoke + human both drive the cutscene via the keyboard. The smoke
// reads these globals to trigger the lifecycle deterministically.
Object.assign(globalThis as Record<string, unknown>, {
  __forgeax_video_cutscene__: { playCutscene, stopApp },
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'c' || e.key === 'C') playCutscene();
  else if (e.key === 's' || e.key === 'S') stopApp();
});

const startResult = app.start();
if (!startResult.ok) {
  console.error('[hello-video-cutscene] app.start failed:', startResult.error.code);
}

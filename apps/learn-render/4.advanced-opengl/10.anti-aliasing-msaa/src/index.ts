import { Update } from '@forgeax/engine-ecs';
// apps/learn-render/4.advanced-opengl/10.anti-aliasing-msaa -- MSAA hardware
// multisample anti-aliasing OFF/ON comparison demo with Space toggle.
// (feat-20260604-learn-render-4-10-anti-aliasing-msaa-engine-wiring / M3).
//
// What this demo exercises end-to-end (charter F1 progressive disclosure):
//   - createApp(canvas, opts) -- one-screen takeoff with rAF + auto
//     input-attach + Time resource.
//   - ANTIALIAS_MSAA -- the third member of the Camera.antialias enum
//     (hardware multisample geometric anti-aliasing, per-camera toggle).
//   - Space toggle runtime: reads InputSnapshot.keyboard.down(' '),
//     derives a press-edge from prev-frame level tracking, toggles
//     Camera.antialias between ANTIALIAS_NONE and ANTIALIAS_MSAA via
//     world.set(camEntity, Camera, { antialias }).
//   - DOM HUD overlay (charter F2 text over image): #msaa-hud span
//     updates textContent to "MSAA: ON" / "MSAA: OFF" on every toggle.
//
// Proposition: MSAA = hardware multisample geometric anti-aliasing;
// Space toggles ON/OFF. Compare aliasing on static geometry edges
// (triangle / cube / quad / sphere) -- MSAA ON smooths geometric
// jaggies at edge boundaries (4x sample-count per pixel), while OFF
// reveals raw pixel-stepping.
//
// Scene: 4 static geometries (triangle + cube + quad + sphere) under
// a single slant-directional light. All geometries are stationary so
// the dual-pass smoke can diff cleanly.
//
// Recipe (charter P1 progressive disclosure):
//   (1) createApp(canvas, {}, { shaderManifestUrl }) + spawn Camera with clear* fields
//   (2) world.allocSharedRef<'MaterialAsset', MaterialAsset>(standard PBR) -> materialHandle
//   (3) world.spawn 4 geometries, DirectionalLight, Camera (save entity)
//   (4) world.addSystem press-edge toggle + HUD sync
//   (5) app.start()

import { createApp } from '@forgeax/engine-app/browser';
import type { App, CanvasAppError } from '@forgeax/engine-app';

import { HANDLE_CUBE, HANDLE_QUAD, HANDLE_SPHERE, HANDLE_TRIANGLE } from '@forgeax/engine-assets-runtime';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine-input';
import { Transform } from '@forgeax/engine-scene';

import { ANTIALIAS_MSAA, ANTIALIAS_NONE, perspective } from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';

import type { Handle, MaterialAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) {
  throw new Error('[msaa] missing <canvas id="app"> in index.html');
}

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[msaa] EngineEnvironmentError: webgpu inner=${code}`);
  } else {
    console.error('[msaa] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  // Step 1: createApp(canvas, opts) -- one-screen takeoff.
  const appRes = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appRes.ok) {
    reportAppError(appRes.error);
    return;
  }
  const app = appRes.value;
  app.onError((error) => {
    console.error('[msaa] app.onError:', error.code, error.hint);
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: error.code, hint: error.hint });
  });
  console.warn(`[msaa] execution=${JSON.stringify(app.execution.report().workers)}`);

  const world = app.world;

  // Step 2: register the standard PBR material shared across all 4 geometries.
  const materialHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      { name: 'Forward', program: { module: 'forgeax::default-standard-pbr' }, renderState: { tags: { LightMode: 'Forward' }, queue: 2000 } },
    ],
    values: {
      baseColor: [0.7, 0.7, 0.7],
      metallic: 0.0,
      roughness: 0.4,
    },
  });

  // Step 3: spawn 4 static geometries (triangle + cube + quad + sphere).
  // Layout: 4 bodies spread horizontally so edges stay visible and
  // aliasing is obvious in the ANTIALIAS_NONE state. The triangle and
  // cube have the sharpest diagonal edges.
  const LAYOUT: readonly {
    readonly handle: Handle<'MeshAsset', 'shared'>;
    readonly pos: readonly [number, number, number];
  }[] = [
    { handle: HANDLE_TRIANGLE, pos: [-1.05, 0, 0]},
    { handle: HANDLE_CUBE, pos: [-0.35, 0, 0]},
    { handle: HANDLE_QUAD, pos: [0.35, 0, 0]},
    { handle: HANDLE_SPHERE, pos: [1.05, 0, 0]},
  ];
  for (const slot of LAYOUT) {
    world.spawn(
      {
        component: Transform,
        data: {
          pos: slot.pos,
          quat: [0, 0, 0, 1],
          scale: [0.5, 0.5, 0.5],
        },
      },
      { component: MeshFilter, data: { assetHandle: slot.handle } },
      { component: MeshRenderer, data: { materials: [materialHandle] } },
    ).unwrap();
  }

  // Step 4: spawn directional light with slant direction.
  world.spawn({
    component: DirectionalLight,
    data: { castShadow: true,
      direction: [-0.4, -0.6, -0.7],
      color: [1, 1, 1],
      intensity: 1.5,
    },
  }).unwrap();

  // Step 5: spawn camera starting at ANTIALIAS_NONE (OFF by default).
  // Save the entity handle so the toggle system can call world.set.
  const camEntity = world.spawn(
    {
      component: Transform,
      data: { pos: [0, 0, 6]},
    },
    {
      component: Camera,
      data: {
        ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }),
        antialias: ANTIALIAS_NONE,
      },
    },
  ).unwrap();

  // Step 6: Space-key press-edge toggle system.
  // InputSnapshot has only down (held-level) / up (release-edge), no
  // justPressed, so the demo tracks prev-frame level to derive a
  // false->true press edge. The closure keeps prevSpace and
  // currentAntialias as local state.
  let prevSpace = false;
  let currentAntialias: number = ANTIALIAS_NONE;

  // HUD element (charter F2 text over image): #msaa-hud span mirrors
  // the Camera.antialias value so AI users can read state from DOM.
  const hudEl = document.getElementById('msaa-hud');

  world.addSystem(Update, {
    name: 'msaa-space-toggle',
    after: ['input-frame-start-scan'],
    queries: [],
    fn: () => {
      const snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      if (snap === undefined) return;

      // InputSnapshot.keyboard matches KeyboardEvent.key (browser backend
      // stores ev.key), so the spacebar is the literal ' ' -- NOT 'Space'
      // (that is ev.code). See packages/input/src/input-snapshot.ts down() doc.
      const cur = snap.keyboard.down(' ');
      if (cur && !prevSpace) {
        // Press edge: toggle antialias.
        const target =
          currentAntialias === ANTIALIAS_MSAA ? ANTIALIAS_NONE : ANTIALIAS_MSAA;
        const setRes = world.set(camEntity, Camera, { antialias: target });
        if (setRes.ok) {
          currentAntialias = target;
          if (hudEl) {
            hudEl.textContent =
              target === ANTIALIAS_MSAA ? 'MSAA: ON' : 'MSAA: OFF';
          }
        } else {
          console.error('[msaa] toggle world.set failed:', setRes.error.code);
        }
      }
      prevSpace = cur;
    },
  });

  // Step 7: arm the rAF loop.
  const startRes = app.start();
  if (!startRes.ok) {
    reportAppError(startRes.error);
    return;
  }
  console.warn('[msaa] running. Press Space to toggle MSAA.');

  installCaptureHook(app);
}

// RHI-debug hook for the capture smoke harness. App owns the capture
// transaction and frame authority; this demo only exposes that capability.
function installCaptureHook(app: App): void {
  type CaptureFrameOptions = { readonly snapshotTimeoutMs?: number };
  type CaptureFrame = (options?: CaptureFrameOptions) => Promise<unknown>;
  const win = window as unknown as {
    __captureAntiAliasingMsaaFrame?: (options?: CaptureFrameOptions) => Promise<unknown>;
  };
  const captureFrame = app.rhiCapture?.captureFrame as CaptureFrame | undefined;
  win.__captureAntiAliasingMsaaFrame = (options?: CaptureFrameOptions): Promise<unknown> => {
    if (typeof captureFrame !== 'function') {
      throw new Error('[learn-render 4.10 anti-aliasing-msaa] RHI capture hook missing');
    }
    return captureFrame(options);
  };
}

function reportAppError(err: CanvasAppError | EngineEnvironmentError): void {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[msaa] EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  console.error(`[msaa] ${err.code}: ${err.hint}`);
}

declare global {
  interface Window {
    __captureAntiAliasingMsaaFrame?: (
      options?: { readonly snapshotTimeoutMs?: number },
    ) => Promise<unknown>;
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
  }
}

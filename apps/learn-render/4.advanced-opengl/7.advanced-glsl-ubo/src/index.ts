// apps/learn-render/4.advanced-opengl/7.advanced-glsl-ubo/src/index.ts
// LearnOpenGL section 4.advanced-opengl 7.advanced-glsl-ubo — lightweight
// documentary demo (plan D-3: skeleton from 4.face-culling, glue = UBO).
//
// This demo is a minimal proof (AC-05): three cubes + camera + DirectionalLight,
// demonstrating that the View UBO is engine-managed. No hand-written UBO code.
//
// View UBO anchor (research F-4, AC-04):
//   The engine's View UBO lives at @group(0) @binding(0), 784 B std140 layout
//   (common.wgsl:17-128 SSOT), per-view. Host side: allocated in the renderer,
//   populated each frame in render/view-ubo.ts. The AI user spawns a Camera
//   + DirectionalLight; the engine auto-fills viewProj, lightDir, lightColor,
//   cameraPos, four cascade matrices, split planes, shadow bias, and four spot
//   matrices — all 196 floats. Zero user-side
//   UBO code required (charter P4: uniform abstraction over manual binding).
//
// GREP anchors for AI users:
//   "// 1. engine usage"    public engine API consumed (copy-paste)
//   "// 2. example glue"    LO 4.7 scene-specific constants (customize)
//   "// 3. bootstrap"       entry point wiring (1)+(2)

// 1. engine usage
import { createApp } from '@forgeax/engine-app/browser';
import type { App } from '@forgeax/engine-app';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { Materials } from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { addFirstPersonSystem } from '../../../../shared/src/learn-render-first-person';
import { captureCanvasPixels } from '@forgeax/apps-shared/canvas-capture';

// 2. example glue


// Three cubes in a row — minimal geometry, no textures, just standard PBR.
// The View UBO (784B std140, @group(0)@binding(0)) carries camera + light
// payload to every shader stage automatically (engine-managed; no user UBO code).
const CUBE_POSITIONS: readonly [number, number, number][] = [
  [-1.5, 0, 0],
  [0, 0, 0],
  [1.5, 0, 0],
];

const CAMERA_FOV = Math.PI / 3;
const CAMERA_POS_X = 0;
const CAMERA_POS_Y = 0;
const CAMERA_POS_Z = 6;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 100;

// 3. bootstrap

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 4.7 advanced-glsl-ubo] missing <canvas id='app'> in index.html");
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appRes.ok) {
    console.error('[learn-render 4.7 advanced-glsl-ubo] createApp failed:', appRes.error);
    return;
  }
  const app = appRes.value;
  const renderer = app.renderer;
  const world = app.world;
  app.onError((error) => {
    console.error('[learn-render 4.7 advanced-glsl-ubo] app.onError:', error.code, error.hint);
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: error.code, hint: error.hint });
  });

  // Standard PBR material shared by all three cubes.
  // The engine places this material in the Forward pass which reads the
  // View UBO (@group(0)@binding(0)) for camera + light data automatically.
  const matHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({
      baseColor: [0.8, 0.8, 0.8, 1],
      metallic: 0.3,
      roughness: 0.7,
    }),
  );

  // Three cubes — minimal scene proof that the View UBO is live.
  // No explicit UBO code: Camera + DirectionalLight spawns -> engine extracts
  // viewProj/lightDir/lightColor/cameraPos, cascade/shadow data, and spot
  // matrices into the 784B std140 View struct at @group(0)@binding(0).
  for (const [px, py, pz] of CUBE_POSITIONS) {
    world.spawn(
      {
        component: Transform,
        data: { pos: [px, py, pz]},
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [matHandle] } },
    );
  }

  // DirectionalLight — the engine reads direction/color/intensity from this
  // component and writes them into the View UBO (lightDir/lightColor slots).
  world.spawn({
    component: DirectionalLight,
    data: {
      direction: [-0.4, -0.6, -0.7],
      color: [1, 1, 1],
      intensity: 1.5,
    },
  });

  // Camera — the engine reads Transform + Camera (fov/aspect/near/far/tonemap)
  // and writes viewProj + cameraPos + inverseViewProj into the View UBO.
  // This is the per-view dimension: each camera entity's own View UBO payload.
  world.spawn(
    {
      component: Transform,
      data: { pos: [CAMERA_POS_X, CAMERA_POS_Y, CAMERA_POS_Z]},
    },
    {
      component: Camera,
      data: {
        ...perspective({
          fov: CAMERA_FOV,
          aspect: target.width / target.height,
          near: CAMERA_NEAR,
          far: CAMERA_FAR,
        }),
      },
    },
  );

  addFirstPersonSystem(world, {
    name: 'learn-render-4.7-advanced-glsl-ubo-first-person',
    overrideBackend: undefined,
  });

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 4.7 advanced-glsl-ubo] app.start failed:', startRes.error);
    return;
  }
  console.warn(
    `[learn-render 4.7 advanced-glsl-ubo] backend=${renderer.inspect().capabilities.backendKind}`,
  );

  installCaptureHook(app, world, target);
}

// RHI-debug live-pixel hook for the capture smoke harness (pixel mode). Drives
// one update + draw + readPixels so the live canvas read is anchored to the same
// frame the capture records. Only meaningful when the page is served with
// FORGEAX_ENGINE_RHI_DEBUG=1; harmless otherwise.
function installCaptureHook(app: App, world: App['world'], canvas: HTMLCanvasElement): void {
  type CaptureHook = () => Promise<Uint8Array>;
  const win = window as unknown as { __captureAdvancedGlslUbo?: CaptureHook };
  const renderer = app.renderer;
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const lease = attached.value;
  win.__captureAdvancedGlslUbo = async (): Promise<Uint8Array> => {
    world.update(1 / 60).unwrap();
    const frame = renderer.draw({
      leases: [lease],
      camera: { lease },
      environment: { lease },
    });
    if (!frame.ok) throw frame.error;
    const observed = await renderer.observe(frame.value, { include: ['draws'] });
    if (!observed.ok) throw observed.error;
    const r = await captureCanvasPixels(canvas);
    if (!r.ok) {
      throw new Error(
        `[learn-render 4.7 advanced-glsl-ubo] readPixels failed: ${r.error.code} -- ${r.error.hint ?? ''}`,
      );
    }
    return r.value;
  };
}

declare global {
  interface Window {
    __captureAdvancedGlslUbo?: () => Promise<Uint8Array>;
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
  }
}

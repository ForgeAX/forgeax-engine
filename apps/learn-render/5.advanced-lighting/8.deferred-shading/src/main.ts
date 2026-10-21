import type { AssetHandle } from '@forgeax/engine-types';
// apps/learn-render/5.advanced-lighting/8.deferred-shading/src/main.ts
// LearnOpenGL section 5.8 — Deferred Shading.
//
// Standard clustered deferred-capable opaque + forward transparent with 32
// point lights and a 9-cube 3x3 grid.
//
// LO 5.8.1 numerical set (research F-1):
//   - NUM_LIGHTS = 32
//   - Attenuation: constant=1.0, linear=0.7, quadratic=1.8 (shader-side, not in component)
//   - Light position: rand()*6 - 3 per axis, seed=13 (glibc-style LCG)
//   - Light color: rand()/200 + 0.5 per channel ([0.5, 1.0))
//   - Cube scale = 0.5, y = -0.5, grid spacing = 3.0
//   - 32 light-box cubes at each light position (scale=0.125, color=lightColor)
//
// Charter mapping:
//   - P1 progressive disclosure: createApp -> register material -> select the
//     Standard profile -> spawn scene -> app.start
//   - P3 explicit failure: profile capability refusal remains structured
//
// GREP anchors for AI users:
//   - "// 1. engine usage"    public engine API consumed
//   - "// 2. scene constants" LO 5.8.1 numerical set + RNG
//   - "// 3. bootstrap"       entry point wiring

import { type App } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import type { CanvasAppError } from '@forgeax/engine-app';

import { Transform } from '@forgeax/engine-scene';

import {
  Camera,
  MeshFilter,
  MeshRenderer,
} from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { Materials } from '@forgeax/engine-render';
import { DEFAULT_STANDARD_PROFILE, PointLight } from '@forgeax/engine-render';


import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { captureCanvasPixels } from '@forgeax/apps-shared/canvas-capture';
import {
  exposeLearnRenderTestApp,
  trackLearnRenderTestBootstrap,
} from '../../../../shared/src/learn-render-test-lifecycle';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';


// 2. scene constants

const DEFAULT_NUM_LIGHTS = 32;
const NUM_LIGHTS = (() => {
  if (typeof window !== 'undefined') {
    const requested = Number(new URL(window.location.href).searchParams.get('lights'));
    if (Number.isInteger(requested) && requested >= 1 && requested <= 256) {
      return requested;
    }
  }
  return DEFAULT_NUM_LIGHTS;
})();
const STANDARD_LIGHT_COUNT = NUM_LIGHTS === 1 ? 1 : NUM_LIGHTS === 256 ? 256 : 32;
const CUBE_SCALE = 0.5;
const CUBE_SPACING = 3.0;
const CUBE_Y = -0.5;

// glibc-compatible LCG: matches `srand(13)` + `rand()` from LO 5.8.1.
// LO calls srand(13), then samples 32 lights * 6 values (pos x/y/z + color r/g/b)
// = 192 consecutive rand() calls. Each rand() returns (state >> 16) & 0x7fff.
// LO then normalises: `randInt % 100 / 100.0` for [0, 1), which differs from our
// direct float range; we replicate the exact LO pipeline below.
function glibcRand(state: number): [number, number] {
  const next = ((state * 1103515245 + 12345) >>> 0) & 0x7fffffff;
  const value = (next >> 16) & 0x7fff;
  return [next, value];
}

function randomPosition(state: number): [number, number, number, number] {
  const [s1, xv] = glibcRand(state);
  const [s2, yv] = glibcRand(s1);
  const [s3, zv] = glibcRand(s2);
  const x = ((xv % 100) / 100.0) * 6.0 - 3.0;
  const y = ((yv % 100) / 100.0) * 6.0 - 3.0;
  const z = ((zv % 100) / 100.0) * 6.0 - 3.0;
  return [x, y, z, s3];
}

function randomColor(state: number): [number, number, number, number] {
  const [s1, rv] = glibcRand(state);
  const [s2, gv] = glibcRand(s1);
  const [s3, bv] = glibcRand(s2);
  const r = ((rv % 100) / 200.0) + 0.5;
  const g = ((gv % 100) / 200.0) + 0.5;
  const b = ((bv % 100) / 200.0) + 0.5;
  return [r, g, b, s3];
}

// Pre-compute the deterministic light set with seed=13; the default is 32 lights.
function generateLightData(): Array<{
  pos: readonly [number, number, number];
  colorR: number; colorG: number; colorB: number;
}> {
  let state = 13; // srand(13)
  const lights: Array<{
    pos: readonly [number, number, number];
    colorR: number; colorG: number; colorB: number;
  }> = [];
  for (let i = 0; i < NUM_LIGHTS; i++) {
    const [px, py, pz, sa] = randomPosition(state);
    const [cr, cg, cb, sb] = randomColor(sa);
    state = sb;
    lights.push({ pos: [px, py, pz], colorR: cr, colorG: cg, colorB: cb });
  }
  return lights;
}

const LIGHT_DATA = generateLightData();

const FALSIFY = (() => {
  if (typeof window !== 'undefined') {
    const url = new URL(window.location.href);
    return url.searchParams.get('falsify') ?? '';
  }
  return '';
})();
const VISUAL_FALSIFY = FALSIFY === 'blank';

// 3. bootstrap

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) {
  throw new Error("[learn-render 5.8 deferred-shading] missing <canvas id='app'> in index.html");
}

const bootstrapPromise = bootstrap(canvas);
void bootstrapPromise.catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[learn-render 5.8 deferred] EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  console.error('[learn-render 5.8 deferred] bootstrap error:', err);
});
trackLearnRenderTestBootstrap(bootstrapPromise, canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(
    target,
    {
      standardProfile: {
        ...DEFAULT_STANDARD_PROFILE,
        lightCount: STANDARD_LIGHT_COUNT,
        renderPath: 'deferred',
      },
    },
    forgeaxBundlerAdapter(),
  );
  if (!appRes.ok) {
    reportAppError(appRes.error);
    return;
  }
  const app = appRes.value;
if (app.assets === undefined) throw new Error('This scene requires the App asset owner');

  exposeLearnRenderTestApp(app, target);
  const world = app.world;
const primitiveCube = app.assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();

  const inspection = app.renderer.inspect();
  console.warn(`[learn-render 5.8 deferred] backend=${inspection.capabilities.backendKind}`);


  // Wire the __learnRenderErrors bus for onerror-gate coverage.
  const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
  if (bus !== undefined) {
    app.onError((error) => {
      bus.push({ code: error.code, hint: error.hint });
    });
  }

  // CUbe base color variants: 9 distinct colors for the 3x3 grid.
  const cubeColors: Array<[number, number, number]> = [
    [1.0, 0.3, 0.3], [0.3, 1.0, 0.3], [0.3, 0.3, 1.0],
    [1.0, 1.0, 0.3], [0.3, 1.0, 1.0], [1.0, 0.3, 1.0],
    [0.7, 0.7, 0.3], [0.3, 0.7, 0.7], [0.7, 0.3, 0.7],
  ];

  // Spawn 9 cubes in 3x3 grid at y=-0.5, spacing 3.0.
  const cubeHandles: AssetHandle<'material'>[] = [];
  let idx = 0;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const cx = (col - 1) * CUBE_SPACING;
      const cz = (row - 1) * CUBE_SPACING;
      const [r, g, b] = cubeColors[idx]!;

      // Register material for this cube (distinct baseColor for visual differentiation).
      const mat = Materials.standard({ baseColor: [r, g, b, 1] });
      const matHandle = app.assets.create(mat).unwrap();
      cubeHandles.push(matHandle);

      world.spawn(
        {
          component: Transform,
          data: {
            pos: [cx, CUBE_Y, cz], quat: [0, 0, 0, 1], scale: [CUBE_SCALE, CUBE_SCALE, CUBE_SCALE],},
        },
        { component: MeshFilter, data: { assetHandle: primitiveCube } },
        { component: MeshRenderer, data: { materials: [matHandle] } },
      ).unwrap();
      idx++;
    }
  }

  // Spawn 32 point lights from the pre-computed deterministic seed=13 data.
  for (let i = 0; i < NUM_LIGHTS; i++) {
    const ld = LIGHT_DATA[i]!;
    world.spawn(
      {
        component: Transform,
        data: { pos: ld.pos, quat: [0, 0, 0, 1] },
      },
      {
        component: PointLight,
        data: {
          color: [ld.colorR, ld.colorG, ld.colorB],
          // LO 5.8 attenuation (1.0, 0.7, 1.8) is shader-side.
          // Intensity 1.0 + range 6.0 gives a healthy falloff across the 3-unit grid.
          intensity: 1.0,
          range: 6.0,
        },
      },
    );

    // Light-box visualization: small cube at each light position.
    world.spawn(
      {
        component: Transform,
        data: {
          pos: ld.pos,
          quat: [0, 0, 0, 1],
          scale: [0.125, 0.125, 0.125],
        },
      },
      { component: MeshFilter, data: { assetHandle: primitiveCube } },
      { component: MeshRenderer, data: { materials: [cubeHandles[0]!] } },
    );
  }

  // Camera at (0, 1.5, 6) looking -Z, matching the Standard lighting scene.
  // Eye height 1.5 gives a good view of the 3x3 grid at y=-0.5 from z=6.
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
      },
    },
  ).unwrap();

  const startRes = app.start();
  if (!startRes.ok) {
    reportAppError(startRes.error);
    return;
  }
  console.warn(
    `[learn-render 5.8 deferred] running. Standard ${FALSIFY === 'force-direct' ? 'direct' : 'clustered'} lane selected. ${NUM_LIGHTS} point lights + 9 cubes 3x3 grid.`,
  );

  installCaptureHook(app, world);
  if (VISUAL_FALSIFY) target.style.filter = 'brightness(0)';
}

// RHI-debug live-pixel hook for the capture smoke harness (pixel mode). Drives
// one update + receipt-bound observation so the live canvas read is anchored to the same
// frame the capture records. Only meaningful when the page is served with
// FORGEAX_ENGINE_RHI_DEBUG=1; harmless otherwise.
function installCaptureHook(app: App, world: App['world']): void {
  type CaptureHook = () => Promise<Uint8Array>;
  const win = window as unknown as { __captureDeferred?: CaptureHook };
  const renderer = app.renderer;
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const lease = attached.value;
  win.__captureDeferred = async (): Promise<Uint8Array> => {
    world.update(1 / 60).unwrap();
    const frame = renderer.draw({
      leases: [lease],
      camera: { lease },
      environment: { lease },
    });
    if (!frame.ok) throw frame.error;
    const observed = await renderer.observe(frame.value, { include: ['draws'] });
    if (!observed.ok) throw observed.error;
    const r = await captureCanvasPixels(document.querySelector<HTMLCanvasElement>('#app')!);
    if (!r.ok) {
      throw new Error(
        `[learn-render 5.8 deferred] canvas capture failed: ${r.error.code} -- ${r.error.hint ?? ''}`,
      );
    }
    return r.value;
  };
}

function reportAppError(err: CanvasAppError | EngineEnvironmentError): void {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[learn-render 5.8 deferred] EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  console.error(`[learn-render 5.8 deferred] ${err.code}: ${err.hint}`);
}

declare global {
  interface Window {
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
    __captureDeferred?: () => Promise<Uint8Array>;
  }
}

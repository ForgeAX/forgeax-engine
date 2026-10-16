// apps/hello/triangle - end-to-end Hello Triangle demo (M3 ECS-driven form).
//
// shadingModel routing (feat-20260518-pbr-direct-lighting-mvp / w24 / AC-13;
// feat-20260523 M8-T03 doc refresh: StandardMaterialAsset retired in favour
// of the schema-driven register API):
//   The renderable below carries `MeshRenderer { data: {} }` — the empty material
//   handle drops through render-system-extract.ts case B fallback to
//   `defaultMaterialSnapshot()` (mid-grey, `shadingModel: 'unlit'`). The demo
//   intentionally does NOT register a PBR material; the basic-primitive
//   "hello triangle" example belongs on the unlit pipeline (no DirectionalLight
//   coupling). For an explicit `MaterialAsset { shadingModel: 'unlit' }`
//   register-and-bind exemplar see `apps/learn-render/1.getting-started/4.textures/src/index.ts`;
//   for the flagship schema-driven GGX-PBR + DirectionalLight pairing (built
//   via `assetRegistry.registerMaterialAsset({ materialShader:
//   'forgeax::default-standard-pbr', ... })`) see `apps/hello/room/src/main.ts`.
//
// Cross-package smoke:
//   - @forgeax/engine-math       -> vec3 vertices + mat4 projection + quat orientation
//                            (still exercises the M2-M5 branded API surface
//                            end-to-end via CPU pre-bake binding exemplar).
//   - @forgeax/engine-ecs       -> World + spawn (5-component schemas).
//   - @forgeax/engine-runtime     -> createRenderer(canvas) async factory + Renderer
//                            ECS-driven path (M3): host initialization barrier +
//                            renderer.draw(world) every frame.
//
// Frame driver: requestAnimationFrame. Each frame the engine-internal
// RenderSystem walks the World query graph (Extract / Prepare / Record three
// stages) and submits one GPU command buffer (D-S2 / AC-09 - RenderSystem is
// NOT registered to user schedule; renderer.draw(world) invokes it).
//
// Failure path (R-1): on EngineEnvironmentError we render a banner inside the
// canvas's parent container so users on no-WebGPU hosts still see a meaningful
// message instead of a blank page. console.error is intentionally used to
// surface diagnostics in DevTools.
//
// Math API convention (D-3 / R-P3, M6 companion refactor):
//   - mat4.perspectiveNO       -> WebGL/OpenGL [-1, 1] NDC (gl-matrix-style
//                                 short name + NO suffix)
//   - mat4.perspectiveReverseZ -> reversed-Z (far -> 0, near -> 1; depth
//                                 precision optimisation)
// hello-triangle uses WebGPU exclusively (createRenderer throws
// EngineEnvironmentError when no WebGPU adapter is available). R-P3 mandates:
// grep -E 'mat4\.perspective\(' | grep -v 'NO\|ReverseZ' must yield 0 hits -
// preventing misuse of the WebGPU [0,1] short form vs the NO [-1,1] variant.
// We use both NO and ReverseZ-suffixed variants for the CPU pre-bake binding
// exemplar here.

import { World } from '@forgeax/engine-ecs';
import { mat4, quat, vec3 } from '@forgeax/engine-math';
import { AssetRegistry, HANDLE_TRIANGLE } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';

import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import { perspective } from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';

import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import brdfSrc from './shaders/brdf.wgsl?raw';
import pbrSrc from './shaders/pbr.wgsl?raw';
import viewSrc from './shaders/view.wgsl?raw';

// Reference AssetRegistry as a value so the import is not tree-shaken; the
// builtin handles consumed below (HANDLE_TRIANGLE) live in the same module
// (F-1 single-import contract part 3/3).
void AssetRegistry;

// .wgsl?raw side-effect references keep the three-file naga_oil composition
// (view + brdf + pbr via #import) in the rolldown input graph so the Vite
// plugin transform fires on each module and emits the manifest; the
// compileShader build-time API itself is exercised by
// @forgeax/engine-shader-compiler tests, never imported into the runtime
// bundle (AC-06 ship-runtime 0-wasm: shader-compiler -> naga -> wgpu-wasm
// must not appear in the static import graph rooted at main.ts).
void brdfSrc;
void pbrSrc;
void viewSrc;

// --- Math layer -------------------------------------------------------------

// Three vertex positions in clip space; produced via @forgeax/engine-math vec3 to
// exercise the branded API surface (CPU pre-bake binding exemplar; the actual
// triangle geometry consumed by the GPU comes from the engine's AssetRegistry
// HANDLE_TRIANGLE builtin so AI users do not learn two parallel geometry
// paths - charter proposition 5 consistent abstraction).
const v0 = vec3.create(0.0, 0.7, 0.0);
const v1 = vec3.create(-0.7, -0.6, 0.0);
const v2 = vec3.create(0.7, -0.6, 0.0);

// Projection matrix smoke: build WebGL / reversed-Z variants so the demo
// exercises both NDC conventions called out in plan-strategy section 3.1
// R-P3.
const projWebGL = mat4.perspectiveNO(mat4.create(), Math.PI / 4, 16 / 9, 0.1, 100);
const projReverseZ = mat4.perspectiveReverseZ(mat4.create(), Math.PI / 4, 16 / 9, 0.1, 100);

// Orientation quaternion smoke: identity rotation (no-op for the static
// triangle, but pulls quat namespace into the dependency graph).
const orientation = quat.identity(quat.create());

// --- ECS layer (M3 ECS-driven form) -----------------------------------------
//
// Spawn three entities (mesh + camera + light), matching the M0 spike SSOT
// lock values (plan-strategy D-S11 default table + spike-report-m0.md): so
// the production app exercises the same default binding the smoke gate's
// baseline anchor would expect (charter proposition 5 consistent abstraction).
//
// AI-user binding exemplar: this is the canonical four-step recipe (spawn ->
// ready -> draw -> onError) AI users discover via README + AGENTS.md "ECS
// render bridge" section.

const world = new World();

// Mesh entity: builtin triangle geometry + default PBR material (50% grey,
// dielectric, fully rough). Transform at origin / identity rotation / unit
// scale (M0 SSOT lock).
world.spawn(
  {
    component: Transform,
    data: {},
  },
  { component: MeshFilter, data: { assetHandle: HANDLE_TRIANGLE } },
  {
    component: MeshRenderer,
    data: {},
  },
).unwrap();

// Camera entity: Transform + Camera at (0, 0, 3) looking down -Z
// (M0 SSOT lock; identity quaternion = looking down -Z by RH convention).
world.spawn(
  {
    component: Transform,
    data: { pos: [0, 0, 3]},
  },
  {
    component: Camera,
    data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }),
  },
).unwrap();

// Directional light entity: -Y dominant + slight +X / +Z mix, white, unit
// intensity (M0 SSOT lock; matches spike-report-m0.md baseline conditions).
world.spawn({
  component: DirectionalLight,
  data: {
    direction: [-0.5, -1, -0.3],
    color: [1, 1, 1],
    intensity: 1,
  },
}).unwrap();

// --- Renderer + frame driver ------------------------------------------------

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) {
  throw new Error('hello-triangle: missing <canvas id="app"> in index.html');
}

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    renderFallbackBanner(canvas, err);
    console.error('[triangle] no usable backend:', err);
  } else {
    console.error('[triangle] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  // Round 3 fix-up F-P3-1 / w57: retired the second escape hatch (charter
  // proposition 5 red line; P3 Pure-B6). Previously this site monkey-
  // patched `rhi.requestAdapter` to capture the forgeax RhiDevice the
  // engine created internally. The Renderer interface now exposes the
  // captured RhiDevice through the `device: RhiDevice | null` accessor
  // (mirrors the shader / assets red-line pattern), so configuration
  // proceeds on the post-construction path with no patching.
  // feat-20260608 / M3: BundlerOptions third arg sourced from the
  // virtual:forgeax/bundler adapter to satisfy AC-12 (zero apps/ shader-
  // manifest URL string literals). The adapter is orthogonal to the D-S1
  // raw-device escape hatch demonstrated below: it only supplies the shader
  // manifest URL plumbing.
  const constructed = await constructRuntimeRendererHost(target, {}, forgeaxBundlerAdapter());
  if (!constructed.ok) throw constructed.error;
  const renderer = constructed.value.renderer;
  const worldAttachment1 = renderer.attach(world);
  if (!worldAttachment1.ok) throw worldAttachment1.error;

  console.warn('[triangle] Standard pipeline active');

  // CPU pre-bake binding exemplar (M5 t13 / S-3): actually run (v0, v1, v2)
  // x (projWebGL, projReverseZ) = 6 mat4.transformPoint calls, mapping vec3
  // vertices into clip space. clipBuf is a throwaway scratch - this path does
  // NOT feed any GPU vertex buffer (the engine RenderSystem owns its own via
  // the AssetRegistry HANDLE_TRIANGLE upload during `await host initialization`);
  // it exists purely to (1) force mat4.transformPoint surface resolution at
  // build time (AC-17 dual-projection smoke); (2) satisfy charter proposition
  // 4 - an AI user can copy-paste from main.ts once and learn the call shape.
  // S-3 / OQ-3 ruling: do NOT add a quat.transformVec3 binding; an identity
  // quat degenerates with no visible signal, so the binding has no semantic
  // value - kept as `void orientation;` placeholder line below.
  const clipBuf = vec3.create();
  // 3 vertices x 2 projections = 6 calls (unrolled so a grep can count all 6
  // binding exemplars at a glance).
  mat4.transformPoint(clipBuf, projWebGL, v0);
  mat4.transformPoint(clipBuf, projWebGL, v1);
  mat4.transformPoint(clipBuf, projWebGL, v2);
  mat4.transformPoint(clipBuf, projReverseZ, v0);
  mat4.transformPoint(clipBuf, projReverseZ, v1);
  mat4.transformPoint(clipBuf, projReverseZ, v2);
  void orientation;

  // smoke counter-example entry points (i)(ii)
  // (feat-20260508-verify-gpu-smoke-gate w6 / w5 counter-examples):
  //   ?backend=webgl2 -> console reports the simulated non-WebGPU path
  //                      backend for counter-example (i) smoke FAIL)
  //   ?clearOnly=1    -> renderer.draw(world) skipped (counter-example (ii):
  //                      clear only, no draw - the page leaves the canvas at
  //                      clearColor)
  // Production users never pass these params (charter proposition 4 explicit
  // failure: debug ports must not silently leak into prod).
  const params = new URLSearchParams(globalThis.location?.search ?? '');
  const forceBackend = params.get('backend');
  const clearOnly = params.get('clearOnly') === '1';
  if (forceBackend === 'webgl2') {
    // Override the backend report line so smoke criterion (a) FAILs (even if
    // The active backend is WebGPU; this query param only simulates
    // a non-WebGPU backend signal for counter-example (i)).
    console.warn(`[triangle] backend=webgl2`);
  }

  // smoke frame accumulator (counter-examples (ii)(iii) indirect signal +
  // AC-03 (b) frames >= 60 criterion). Exposed on globalThis for
  // page.evaluate consumption - naming convention `__forgeax_smoke_frames__`
  // lets any browser-side smoke harness grep-locate it at a glance.
  let framesObserved = 0;
  Object.assign(globalThis as Record<string, unknown>, {
    __forgeax_smoke_frames__: () => framesObserved,
  });

  // M3 ECS-driven path: await Renderer.ready barrier (D-S3 three-step serial
  // pipeline) before driving the raf loop. ready resolves once the manifest
  // load + PBR pipeline compile + AssetRegistry builtin mesh upload all
  // complete.
  // w25 — Renderer.ready resolves Result<void, RhiError>; AI users branch
  // on `.ok` rather than try/catch.

  // raf-driven frame: hand the World to the renderer; the engine-internal
  // RenderSystem walks the query graph (D-S2 Extract / Prepare / Record) and
  // submits one GPU command buffer per call. AC-09 contract: RenderSystem is
  // NOT registered to world.systems schedule; world.update() does not run
  // it - renderer.draw({ leases, camera, environment }) is the sole invocation site.
  const frame = (): void => {
    if (!clearOnly) {
      // w25 — draw returns Result; ignore .ok for the smoke path (onError
      // listener handles fan-out separately).
      // feat-20260708-composited-multi-world-rendering M3: this is the D-8
      // integration probe -- hello-triangle is the first real consumer migrated
      // to the explicit draw-owner signature (AC-01/AC-02), proving the
      // breaking change compiles + runs end-to-end (dawn-node smoke) rather
      // than passing compile-only. Single world composites at owner 0.
      world.update().unwrap();
      const r = renderer.draw({
        leases: [worldAttachment1.value],
        camera: { lease: worldAttachment1.value },
        environment: { lease: worldAttachment1.value },
      });
      if (!r.ok) console.error('[triangle] draw error:', r.error);
    } else {
      // Counter-example (ii): skip the draw call, leaving the canvas at
      // clearColor - smoke's triangle-center sample then sits at distance
      // 0 < threshold -> FAIL (same observable signature as the core
      // silent-skip counter-example).
    }
    framesObserved++;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function renderFallbackBanner(target: HTMLCanvasElement, err: EngineEnvironmentError): void {
  const parent = target.parentElement;
  if (!parent) return;
  const banner = document.createElement('div');
  banner.style.cssText = [
    'position: absolute',
    'inset: 0',
    'display: grid',
    'place-items: center',
    'color: #eee',
    'font: 14px/1.4 system-ui, sans-serif',
    'padding: 24px',
    'text-align: center',
    'background: #111',
  ].join('; ');
  banner.textContent =
    `forgeax-engine: ${err.reason}. ` +
    'WebGPU is unavailable on this browser. ' +
    'See DevTools console for diagnostic detail.';
  parent.appendChild(banner);
}

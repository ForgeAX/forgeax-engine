// apps/learn-render/1.getting-started/2.hello-triangle/src/index.ts
// LearnOpenGL section 1.2 - Hello Triangle (forgeax mapping).
//
// LO 1.2 covers `glGenVertexArrays + glGenBuffers + glBufferData + glDraw
// Arrays(GL_TRIANGLES, 0, 3)`. In forgeax the equivalent surface is a
// `world.spawn` with the builtin `HANDLE_TRIANGLE` mesh handle plus the
// 4-component unlit path (Transform / MeshFilter / MeshRenderer / Camera);
// no DirectionalLight because the LO 1.2 fragment shader is literally
// `FragColor = vec4(1.0, 0.5, 0.2, 1.0)` — flat orange, no lighting. The
// engine's v1 fragment shader (`PBR_FALLBACK_WGSL` in
// packages/runtime/src/createRenderer.ts) outputs `material.baseColor`
// directly, so `MeshRenderer.baseColor{R,G,B}` is the literal pixel color
// (charter proposition 5 consistent abstraction - the same factory +
// spawn idiom drives every learn-render example, LO 1.2 just lands the
// first visible triangle on top of the LO 1.1 baseline).
//
// AC-06 three-section marker convention:
//   `// 1. engine usage`            -> public engine API consumed.
//   `// 2. example-specific glue`   -> the LO-specific configuration
//                                       (clear color, scene spawn, three
//                                       entities: triangle / camera /
//                                       directional light).
//   `// 3. bootstrap`               -> entry point that wires (1)+(2).
//
// charter mapping:
//   - F1 (limited context):  three-section markers double as grep
//     anchors (AC-06) so AI users locate the recipe via a single
//     `rg "// 1\. engine usage"` call across the seven learn-render
//     workspaces.
//   - P1 (progressive disclosure):  the README top callout points at
//     this file; AI users read the 3 sections + the apps/hello/triangle
//     README cross-reference and have the full LO 1.2 -> forgeax picture.
//   - P3 (explicit failure):  `EngineEnvironmentError` surfaces the
//     "no usable backend" path; `await host initialization` returns a
//     `Result` whose `.ok === false` branch is logged via console.error
//     - we do not silently fall back to a console-only mode.
//   - P4 (consistent abstraction):  the same `Engine.create({ canvas,
//     clearColor })` factory + ECS spawn (Transform / MeshFilter /
//     MeshRenderer / Camera) is the entry across every learn-render
//     example; LO 1.2 just adds the visible triangle on top of the LO
//     1.1 baseline (LO §1.1 = clearColor only via the engine's clear-
//     pass-only frame path; Case E softening).

// 1. engine usage - the public Engine.create factory, the
// EngineEnvironmentError narrowing class, and the minimal ECS surface
// (World + Transform + Camera + MeshFilter + MeshRenderer + the triangle
// handle constant) needed to drive a single visible triangle frame. No
// DirectionalLight: LO 1.2 renders flat orange.
import { World } from '@forgeax/engine-ecs';
import { captureCanvasPixels } from '@forgeax/apps-shared/canvas-capture';
import { HANDLE_TRIANGLE } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { createRenderer, EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

type LearnRenderError = { code: string; hint?: string };
type CaptureHook = () => Promise<Uint8Array>;

function reportBootstrapError(
  label: string,
  error: EngineEnvironmentError | { readonly code: string; readonly hint?: string },
): void {
  console.error(label, error);
  const bus = window.__learnRenderErrors;
  if (bus !== undefined && 'code' in error) {
    bus.push({
      code: error.code,
      ...(error.hint !== undefined ? { hint: error.hint } : {}),
    });
  }
}

// 2. example-specific glue - LO 1.2 lands the first visible triangle.
// Color matches the LO 1.2 fragment shader literal
// `FragColor = vec4(1.0, 0.5, 0.2, 1.0)` (orange). The engine v1 frag
// shader outputs `material.baseColor` directly, so the MeshRenderer rgb
// is the on-screen pixel color (no light contribution). The clear color
// matches LO 1.1 / 1.3 teal so the captured frame is comparable across
// the seven learn-render examples.
function spawnTriangleScene(world: World, clearOnly: boolean): void {
  // Triangle entity (Transform + MeshFilter + MeshRenderer) at origin /
  // identity rotation / unit scale. Color = LO 1.2 frag literal orange
  // (1.0, 0.5, 0.2). metallic / roughness are unused on the engine v1
  // frag path (the fallback shader outputs baseColor directly) but the
  // schema requires the fields.
  if (!clearOnly) {
    world.spawn(
      {
        component: Transform,
        data: {
          pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_TRIANGLE } },
      {
        component: MeshRenderer,
        data: {},
      },
    );
  }
  // Camera entity (Transform + Camera) at z=3 looking down -z (RH
  // identity quaternion convention). Frustum (fov 45 deg, aspect 1,
  // near 0.1, far 100) keeps the unit-scale triangle visible.
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
    },
    {
      component: Camera,
      data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100, clearColor: [0.2, 0.3, 0.3, 1] },
    },
  );
}

// 3. bootstrap - locate the canvas the index.html document declares,
// hand it to Engine.create, await host initialization (the engine internal
// pipeline + RHI handshake), spawn the triangle scene, drive an rAF
// loop with `renderer.draw(world)`, expose a capture hook on globalThis
// for downstream readback paths, then log the resolved backend so the
// AI user can verify "WebGPU path live + triangle drawn" without
// opening DevTools.
const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error(
    "[learn-render 1.2 hello-triangle] missing <canvas id='app'> in index.html",
  );
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  try {
    const created = await createRenderer(target, {}, forgeaxBundlerAdapter());
    if (!created.ok) {
      reportBootstrapError('[learn-render 1.2 hello-triangle] renderer construction failed:', created.error);
      return;
    }
    const renderer = created.value;
    renderer.subscribe((event) => {
      if (event.kind !== 'error') return;
      reportBootstrapError('[learn-render 1.2 hello-triangle] renderer error:', event.error);
    });
    const params = new URLSearchParams(globalThis.location?.search ?? '');
    const clearOnly = params.get('clearOnly') === '1';
    let drawCalls = 0;
    Object.assign(window, {
      __learnRenderTriangleClearOnly: clearOnly,
      __learnRenderTriangleDrawCalls: () => drawCalls,
    });
    const world = new World();
    spawnTriangleScene(world, clearOnly);
    const attached = renderer.attach(world);
    if (!attached.ok) {
      reportBootstrapError('[learn-render 1.2 hello-triangle] attach failed:', attached.error);
      return;
    }
    // rAF-driven render loop - one `renderer.draw(world)` per compositor
    // tick. The engine-internal RenderSystem walks the World query graph
    // (Extract / Prepare / Record three stages) and submits one GPU
    // command buffer per call (D-S2 / AC-09 - RenderSystem is NOT
    // registered to user schedule; renderer.draw(world) is the sole
    // invocation site).
    const tick = (): void => {
      const updated = world.update(1 / 60);
      if (!updated.ok) {
        reportBootstrapError('[learn-render 1.2 hello-triangle] update failed:', updated.error);
        return;
      }
      const drawn = renderer.draw({
        leases: [attached.value],
        camera: { lease: attached.value },
        environment: { lease: attached.value },
      });
      if (!drawn.ok) {
        reportBootstrapError('[learn-render 1.2 hello-triangle] draw failed:', drawn.error);
        return;
      }
      drawCalls += 1;
      requestAnimationFrame(tick);
      // The positive marker is deliberately later than host initialization: the
      // scene, probes, render loop, and one successful draw must all exist.
      window.__learnRenderBootstrapComplete = true;
    };
    requestAnimationFrame(tick);
    // Capture hook for downstream readback paths (bench-screenshot
    // recorder, vitest browser smoke). Re-draws the world before
    // sampling so the canvas presents a fresh frame on every snapshot.
    // Body delegates to the host-owned canvas capture helper.
    window.__captureHelloTriangle = async (): Promise<Uint8Array> => {
      world.update(1 / 60).unwrap();
      const drawn = renderer.draw({
        leases: [attached.value],
        camera: { lease: attached.value },
        environment: { lease: attached.value },
      });
      if (!drawn.ok) {
        reportBootstrapError(
          '[learn-render 1.2 hello-triangle] capture draw failed:',
          drawn.error,
        );
        throw new Error(
          `[learn-render 1.2 hello-triangle] capture draw failed: ${drawn.error.code}`,
        );
      }
      const r = await captureCanvasPixels(target);
      if (!r.ok) throw new Error(`[learn-render 1.2 hello-triangle] canvas capture failed: ${r.error.hint}`);
      return r.value;
    };
    console.warn(
      `[learn-render 1.2 hello-triangle] backend=${renderer.inspect().capabilities.backendKind}`,
    );
  } catch (err: unknown) {
    if (err instanceof EngineEnvironmentError) {
      console.error('[learn-render 1.2 hello-triangle] no usable backend:', err);
    } else {
      console.error('[learn-render 1.2 hello-triangle] bootstrap error:', err);
    }
  }
}

declare global {
  interface Window {
    __learnRenderErrors?: LearnRenderError[];
    __learnRenderTriangleClearOnly?: boolean;
    __learnRenderTriangleDrawCalls?: () => number;
    __learnRenderBootstrapComplete?: boolean;
    __captureHelloTriangle?: CaptureHook;
  }
}

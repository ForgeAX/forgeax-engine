// apps/learn-render/1.getting-started/1.hello-window/src/index.ts
// LearnOpenGL section 1.1 - Hello Window (forgeax placeholder mapping).
//
// Plan-strategy section 7 / M5 milestone (T-M5-02) writes the minimal
// thinnest mapping of the LO chapter to the forgeax engine surface.
// LO 1.1 covers `glfwInit() + glfwCreateWindow() + render loop with
// glClear`, all of which collapse to a single `Engine.create({ canvas,
// clearColor })` call in forgeax. The README explains why this section
// is a placeholder example (D-3 / D-9 / AC-05); this file is the
// AI-user-facing thinnest idiomatic surface (charter F1 + P1 progressive
// disclosure).
//
// AC-06 three-section marker convention:
//   `// 1. engine usage`            -> public engine API consumed.
//   `// 2. example-specific glue`   -> the LO-specific configuration
//                                       (clear color, canvas binding,
//                                       camera entity to drive the
//                                       clear pass).
//   `// 3. bootstrap`               -> entry point that wires (1)+(2).
//
// charter mapping:
//   - F1 (limited context):  three-section markers double as grep
//     anchors (AC-06) so AI users locate the recipe via a single
//     `rg "// 1\. engine usage"` call.
//   - P1 (progressive disclosure):  the README top callout points at
//     this file as "the thinnest LO 1.1 mapping"; this file is the
//     leaf node, not a hub - no further indirection.
//   - P3 (explicit failure):  `EngineEnvironmentError` surfaces the
//     "no usable backend" path; `await host initialization` returns a
//     `Result` whose `.ok === false` branch is logged via console.error
//     - we do not silently fall back to a console-only mode.
//   - P4 (consistent abstraction):  the same `Engine.create({ canvas,
//     clearColor })` signature is the entry across every learn-render
//     example (M6 .. M11); LO 1.1 just stops here, the deeper sections
//     add geometry / shaders / textures / camera input on top.

// 1. engine usage - the public Engine.create factory, the
// EngineEnvironmentError narrowing class, and the minimal ECS surface
// (World + Transform + Camera) needed to drive a single clear-pass
// frame are the only symbols this section consumes from the engine
// runtime + ECS packages. The engine emits a clear-pass-only render
// pass when no entity carries MeshFilter + MeshRenderer (Case E in
// packages/runtime/src/render-system-record.ts; D-Q7 softening for
// the LO §1.1 minimum semantic), so a single Camera entity is enough
// to paint the swap-chain with `clearColor` every frame.
import { World } from '@forgeax/engine-ecs';
import { captureCanvasPixels } from '@forgeax/apps-shared/canvas-capture';
import { Transform } from '@forgeax/engine-scene';
import { Camera } from '@forgeax/engine-render';
import { createRenderer, EngineEnvironmentError } from '@forgeax/engine-runtime';

// 2. example-specific glue - LO 1.1 ends `glClearColor(0.2f, 0.3f, 0.3f,
// 1.0f); glClear(GL_COLOR_BUFFER_BIT);` once per frame. In forgeax the
// `clearColor` option is the single configuration knob the renderer
// applies on every clear-pass; the teal triplet matches LO 1.1 byte-
// for-byte so downstream pixel-parity (forgeax-engine-assets/.../
// round-1-hello-window.png) stays comparable. This minimal app passes
// only `clearColor` to `Engine.create`; with no custom shader option
// supplied the engine skips the shader manifest fetch and compiles
// no user pipelines (post bug-20260519 behavior - the clear-pass-only
// path needs no shader pipeline configuration), so the swap chain
// fills with the teal clear color every frame. A single Camera
// entity is required for the RenderSystem to issue the swap-chain
// clear pass (RhiError 'render-system-no-camera' otherwise; see
// packages/runtime/src/render-system-record.ts case B).
function spawnCameraOnly(world: World): void {
  // Single Camera entity (Transform + Camera) at z=3 looking down -z.
  // No MeshFilter / MeshRenderer entities -- the engine's clear pass
  // is independent of geometry submission (Case E softening), so an
  // empty world + Camera is the LO §1.1 minimum.
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
    },
    {
      component: Camera,
      data: {
        fov: Math.PI / 4,
        aspect: 1,
        near: 0.1,
        far: 100,
        // LO 1.1's `glClearColor(0.2f, 0.3f, 0.3f, 1.0f)` teal-byte triplet
        // (feat-20260608-create-app-param-surface-trim / M1: clear color
        // sinks onto the Camera entity per AGENTS.md Change stance).
        clearColor: [0.2, 0.3, 0.3, 1.0],
      },
    },
  );
}

// 3. bootstrap - locate the canvas the index.html document declares,
// hand it to Engine.create, await host initialization (the engine internal
// pipeline + RHI handshake), spawn one Camera entity, draw a single
// clear-pass frame, then log the resolved backend so the AI user can
// verify "WebGPU path live + cleared" without opening devtools.
const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error(
    "[learn-render 1.1 hello-window] missing <canvas id='app'> in index.html",
  );
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  try {
    const created = await createRenderer(target, {});
    if (!created.ok) {
      console.error('[learn-render 1.1 hello-window] renderer construction failed:', created.error);
      return;
    }
    const renderer = created.value;
    renderer.subscribe((event) => {
      if (event.kind !== 'error') return;
      const e = event.error;
      console.error('[learn-render 1.1 hello-window] renderer error:', e.code, e.hint);
      // Test bus (opt-in): browser tests set globalThis.__learnRenderErrors
      // before dynamic-import; absent in dev/runtime, so this is a noop
      // outside vitest. Mirror the same 4-line block across all 7 LO
      // section-1 index.ts files (architecture principle 1 SSOT).
      const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
      if (bus !== undefined) bus.push({ code: e.code, hint: e.hint });
    });
    const world = new World();
    const worldAttachment1 = renderer.attach(world);
    if (!worldAttachment1.ok) throw worldAttachment1.error;
    spawnCameraOnly(world);
    // Drive the canvas through requestAnimationFrame so the swap-chain
    // sees a fresh clear-pass on every compositor tick (the LO 1.1
    // render-loop equivalent). Headless capture readers (the M5
    // bench-screenshot recorder + downstream pixel-parity) then observe
    // a stable cleared frame regardless of when they snapshot.
    const tick = (): void => {
      world.update().unwrap();
      const drawn = renderer.draw({
        leases: [worldAttachment1.value],
        camera: { lease: worldAttachment1.value },
        environment: { lease: worldAttachment1.value },
      });
      if (!drawn.ok) {
        console.error('[learn-render 1.1 hello-window] draw failed:', drawn.error);
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    // Capture hook used by the M5 bench-screenshot recorder and any
    // downstream readback path: re-draw the world before sampling so
    // the canvas presents a fresh clear-pass on every snapshot. The
    // hook body delegates to the host-owned canvas capture helper. The
    // hook name stays so bench-screenshot.mjs
    // continues to page-evaluate window.__captureHelloWindow().
    type CaptureHook = () => Promise<Uint8Array>;
    const win = window as unknown as { __captureHelloWindow?: CaptureHook };
    win.__captureHelloWindow = async (): Promise<Uint8Array> => {
      world.update().unwrap();
      renderer.draw({
        leases: [worldAttachment1.value],
        camera: { lease: worldAttachment1.value },
        environment: { lease: worldAttachment1.value },
      });
      const r = await captureCanvasPixels(target);
      if (!r.ok) throw new Error(`[learn-render 1.1 hello-window] canvas capture failed: ${r.error.hint}`);
      return r.value;
    };
    console.warn(
      `[learn-render 1.1 hello-window] backend=${renderer.inspect().capabilities.backendKind}`,
    );
  } catch (err: unknown) {
    if (err instanceof EngineEnvironmentError) {
      console.error('[learn-render 1.1 hello-window] no usable backend:', err);
    } else {
      console.error('[learn-render 1.1 hello-window] bootstrap error:', err);
    }
  }
}

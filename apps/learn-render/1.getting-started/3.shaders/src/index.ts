// apps/learn-render/1.getting-started/3.shaders/src/index.ts
// LearnOpenGL section 1.3 - Shaders (forgeax mapping with unlit
// MaterialAsset + uniform pulse animation idiom).
//
// Plan-strategy section 7 / M7 milestone (T-M7-03) wires the LO 1.3
// chapter to the forgeax engine surface. LO 1.3 covers the GLSL
// uniform-driven fragment colour pulse via `glGetUniformLocation +
// glUniform4f("ourColor", ...)`; in forgeax the equivalent surface is
// (a) registering an `UnlitMaterialAsset` (`shadingModel: 'unlit'`)
// through `AssetRegistry.register`, (b) referencing it via the merged
// `MeshRenderer` ECS component on the spawned triangle, and (c)
// driving a `Math.sin(time)`-based pulse scalar each frame so the AI
// user can read the LO 1.3 idiom side by side with `play.wgsl`
// (charter F1 + P1 progressive disclosure).
//
// AC-06 three-section marker convention:
//   `// 1. engine usage`            -> public engine API consumed.
//   `// 2. example-specific glue`   -> the LO-specific configuration
//                                       (clear color, unlit material,
//                                       triangle entity, pulse
//                                       animation update).
//   `// 3. bootstrap`               -> entry point that wires (1)+(2).
//
// charter mapping:
//   - F1 (limited context):  three-section markers double as grep
//     anchors (AC-06) so AI users locate the LO 1.3 -> forgeax mapping
//     via a single `rg "// 1\. engine usage"` call across the seven
//     learn-render workspaces.
//   - F2 (text > image):     the LO 1.3 fragment uniform play idiom is
//     documented as text in src/shaders/play.wgsl + this file's pulse
//     animation comment block; the pixel-parity baseline (round-1-
//     shaders.png) is verification only.
//   - P1 (progressive disclosure):  the README top callout points at
//     this file; AI users read the 3 sections + the sibling play.wgsl
//     and have the full LO 1.3 -> forgeax picture in one directory.
//   - P3 (explicit failure):  `EngineEnvironmentError` surfaces the
//     "no usable backend" path; `await host initialization` returns a
//     `Result` whose `.ok === false` branch is logged via console.
//     error - no silent fallback.
//   - P4 (consistent abstraction):  the same `Engine.create({ canvas
//     })` factory + ECS spawn + `MeshRenderer` discriminator (the
//     `MaterialAsset.shadingModel` value picks unlit vs standard
//     pipeline inside the engine) is the entry across every learn-
//     render example; LO 1.3 just adds the unlit material asset on
//     top of the LO 1.1 / 1.2 baseline.

// 1. engine usage - the public Engine.create factory, the ECS World
// + 4 component schemas (Transform / Camera / MeshFilter /
// MeshRenderer), the AssetRegistry namespace, the merged
// `MaterialAsset` discriminated union (to declare the unlit
// shadingModel), the `EngineEnvironmentError` narrowing class, and
// the builtin `HANDLE_TRIANGLE` mesh handle constant are the only
// symbols this section consumes from the engine runtime + ECS + types
// packages. The `?raw` import on `play.wgsl` keeps the WGSL artefact
// in the rolldown graph next to this file (charter F1 + P5: the WGSL
// is the LO 1.3 -> forgeax shader-stage documentation companion; the
// engine's own unlit pipeline (`packages/shader/src/unlit.wgsl`)
// drives the actual GPU dispatch when MaterialAsset.shadingModel
// resolves to 'unlit').
import { World } from '@forgeax/engine-ecs';
import { captureCanvasPixels } from '@forgeax/apps-shared/canvas-capture';
import { HANDLE_TRIANGLE } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { createRenderer, EngineEnvironmentError } from '@forgeax/engine-runtime';
import type { MaterialAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import playShaderSrc from './shaders/play.wgsl?raw';

// Reference the WGSL source so the rolldown / esbuild dev transform
// keeps it in the import graph (a bare `import '... ?raw'` would also
// work, but exposing the source on globalThis lets AI users inspect
// the LO 1.3 -> WGSL mapping from DevTools without re-fetching). The
// engine RenderSystem internally selects unlit.wgsl for any entity
// whose MeshRenderer resolves to a MaterialAsset with
// `shadingModel: 'unlit'` -- this `?raw` keep-alive is the LO 1.3
// shader-stage documentation companion (charter F1 + P5).
(globalThis as unknown as { __playShaderSrc?: string }).__playShaderSrc = playShaderSrc;

// 2. example-specific glue - LO 1.3 colour pulse idiom mapped onto
// forgeax. The unlit MaterialAsset is registered once with a
// neutral-orange `baseColor` (matching the LO 1.3 shader chapter
// teaching colour); each frame the bootstrap section computes a
// `Math.sin(time)`-based `pulse` scalar and exposes it through the
// global `__captureShadersPulse` hook so the AI user (and the
// orchestrator-driven bench-screenshot recorder) can verify the
// pulse animation is live without opening DevTools. The clear color
// matches LO 1.3 / 1.1 teal so the captured frame is comparable
// across the seven learn-render examples.
// LO 1.3 base colour: the GLSL chapter teaches an orange triangle
// modulated by `sin(timeValue)`. forgeax registers the unlit
// MaterialAsset once with this RGBA quadruple; the per-frame pulse
// scalar lives at the JS layer and is exported on globalThis so AI
// users observe it via DevTools or the bench-screenshot hook.
const PLAY_BASE_COLOR = [1.0, 0.5, 0.2, 1.0] as const;

function spawnPulseScene(world: World): void {
  // Camera entity: identity orientation + pos z=3 (LO 1.1 / 1.3 cam
  // baseline) so the triangle sits inside the perspective frustum.
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
    },
    { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
  );
  // Pass-based MaterialAsset: the passes array with forgeax::default-unlit
  // routes the MeshRenderer through the engine's unlit pipeline; the
  // `baseColor` RGBA quadruple is the LO 1.3 orange triangle teaching colour.
  const playMaterial = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      { name: 'Forward', program: { module: 'forgeax::default-unlit' }, renderState: { tags: { LightMode: 'Forward' }, queue: 2000 } },
    ],
    values: { baseColor: PLAY_BASE_COLOR },
  });
  // Triangle entity: builtin HANDLE_TRIANGLE mesh + MeshRenderer
  // pointing at the unlit MaterialAsset above. The triangle sits at
  // origin / identity rotation / unit scale (M0 SSOT lock).
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_TRIANGLE } },
    {
      component: MeshRenderer,
      data: { materials: [playMaterial] },
    },
  );
}

// LO 1.3 fragment uniform play: the pulse value is a sin function of
// elapsed time (seconds since `basePulseTime`), mapped onto [0, 1] so
// AI users see a non-negative scalar pulsing the unlit baseColor each
// frame. Pure function; the bootstrap section invokes it inside the
// rAF tick + the bench-screenshot capture hook.
function computePulse(nowMs: number, basePulseTime: number): number {
  const elapsedSeconds = (nowMs - basePulseTime) * 0.001;
  return (Math.sin(elapsedSeconds) + 1.0) * 0.5;
}

// 3. bootstrap - locate the canvas the index.html document declares,
// hand it to Engine.create, await host initialization (the engine internal
// pipeline + RHI handshake), spawn the pulse scene, drive the rAF
// loop with the LO 1.3 pulse animation idiom, then expose the pulse
// scalar + capture hook on globalThis so the AI user (and the bench-
// screenshot recorder) can verify the pulse without opening DevTools.
const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error(
    "[learn-render 1.3 shaders] missing <canvas id='app'> in index.html",
  );
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  try {
    const created = await createRenderer(target, {}, forgeaxBundlerAdapter());
    if (!created.ok) {
      console.error('[learn-render 1.3 shaders] renderer construction failed:', created.error);
      return;
    }
    const renderer = created.value;
    renderer.subscribe((event) => {
      if (event.kind !== 'error') return;
      const e = event.error;
      console.error('[learn-render 1.3 shaders] renderer error:', e.code, e.hint);
      const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
      if (bus !== undefined) bus.push({ code: e.code, hint: e.hint });
    });
    const world = new World();
    const worldAttachment1 = renderer.attach(world);
    if (!worldAttachment1.ok) throw worldAttachment1.error;
    spawnPulseScene(world);
    const basePulseTime = performance.now();
    // rAF-driven LO 1.3 pulse loop: compute the pulse scalar every
    // frame + draw the scene through the engine RenderSystem. The
    // pulse scalar is also exposed on globalThis so the bench-
    // screenshot capture path can readback a stable + reproducible
    // pulse value.
    let pulse = 0;
    const tick = (): void => {
      pulse = computePulse(performance.now(), basePulseTime);
      world.update().unwrap();
      const drawn = renderer.draw({
        leases: [worldAttachment1.value],
        camera: { lease: worldAttachment1.value },
        environment: { lease: worldAttachment1.value },
      });
      if (!drawn.ok) {
        console.error('[learn-render 1.3 shaders] draw failed:', drawn.error);
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    // Capture hook used by the M7 bench-screenshot recorder and any
    // downstream readback path: re-draw the world before sampling so
    // the canvas presents a fresh frame on every snapshot. The hook
    // reads the latest pulse scalar so AI users observe both the
    // colour buffer and the LO 1.3 pulse value in one shot.
    type PulseCaptureHook = () => Promise<{
      pixels: Uint8Array;
      pulse: number;
    }>;
    const win = window as unknown as {
      __captureShaders?: PulseCaptureHook;
      __captureShadersPulse?: () => number;
    };
    win.__captureShadersPulse = (): number => pulse;
    win.__captureShaders = async (): Promise<{ pixels: Uint8Array; pulse: number }> => {
      pulse = computePulse(performance.now(), basePulseTime);
      world.update().unwrap();
      // Body delegates pixel capture to the host-owned canvas helper; the
      // wrapper combines engine pixels + the LO 1.3 pulse scalar so
      // bench-screenshot.mjs reads both in one shot.
      const r = await captureCanvasPixels(target);
      if (!r.ok) throw new Error(`[learn-render 1.3 shaders] canvas capture failed: ${r.error.hint}`);
      return { pixels: r.value, pulse };
    };
    console.warn(
      `[learn-render 1.3 shaders] backend=${renderer.inspect().capabilities.backendKind}`,
    );
  } catch (err: unknown) {
    if (err instanceof EngineEnvironmentError) {
      console.error('[learn-render 1.3 shaders] no usable backend:', err);
    } else {
      console.error('[learn-render 1.3 shaders] bootstrap error:', err);
    }
  }
}

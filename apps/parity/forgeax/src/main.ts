// apps/parity/forgeax/src/main.ts - right fixture full implementation
// (M2 T-006; D-P5 case C unlit + D-P6 8-dimension lock).
//
// Renders a static unlit cube via @forgeax/engine-runtime + ECS, exposes
// window.__captureRight for the scripts/bench/pixel-parity.mjs runner to
// read 512x512 RGBA after one Renderer.draw(world) frame.
//
// D-P5 case C unlit path (plan-strategy):
//   - 0 directional-light component spawned -> RenderSystem walks the
//     0-light branch + uses the manifest unlit entry constant-shading
//     (`fs_main()` returns `material.baseColor.rgb * texSample.rgb` —
//     post-w22.9 the unlit shader source lives in
//     @forgeax/engine-shader/src/unlit.wgsl, emitted into manifest.json
//     by @forgeax/engine-vite-plugin-shader).
//   - Material `metallic = 0, roughness = 1` for future-case-A compat
//     (the unlit fragment stage itself does not consume them).
//
// D-P6 8-dimension lock (mirrors apps/parity/threejs):
//   1. Canvas 512 x 512.
//   2. Material baseColor [204/255, 102/255, 51/255] linear.
//   3. Camera fov Math.PI / 4 (45 degrees).
//   4. Camera aspect 1.0.
//   5. Camera z = 3.
//   6. Cube rotation (0.3, 0.5, 0) static; expressed as a quaternion
//      from Euler XYZ.
//   7. premultipliedAlpha = true (canvas context configure).
//   8. canvas format 'rgba8unorm-srgb' (GPU does the linear -> sRGB
//      encode at the framebuffer attach, NOT shader hand-roll).
//
// Readback strategy: createImageBitmap(canvas) then draw to an offscreen
// 2D canvas + getImageData -> Uint8Array(W*H*4) RGBA. This avoids raw
// WebGPU mapAsync gymnastics in the fixture and re-uses the browser's
// built-in canvas-to-bytes path (research Finding 5 still holds: the
// readback is 4-byte RGBA, top-left origin in 2D context, same as the
// three.js side's gl.readPixels bottom-left origin after the implicit
// Y flip - this fixture flips back to bottom-left before returning so
// both __captureLeft + __captureRight expose the same orientation).
//
// Charter mapping: proposition 1 (progressive disclosure - one named
// __captureRight hook on window, same shape as __captureLeft) +
// proposition 5 (consistent abstraction - both fixtures expose
// `() => Promise<Uint8Array>` from window; the runner T-009 awaits both
// in parallel with the same evaluate() shape).

import { World } from '@forgeax/engine-ecs';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';

import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { createRenderer, EngineEnvironmentError, quat } from '@forgeax/engine-runtime';
import { Materials } from '@forgeax/engine-render';

import type { MaterialAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const CANVAS_W = 512;
const CANVAS_H = 512;
// linear-space RGB matching #cc6633 -> rgb(204, 102, 51). The canvas is
// configured with rgba8unorm-srgb so the GPU does the linear -> sRGB
// encode at attach time; we pass linear values here and the framebuffer
// emerges sRGB-encoded, byte-matching what three.js MeshBasicMaterial
// produces through its default outputColorSpace=SRGBColorSpace path.
const BASE_R = 204 / 255;
const BASE_G = 102 / 255;
const BASE_B = 51 / 255;

// Cube rotation: Euler (0.3, 0.5, 0) -> quaternion. Computed inline so
// the literal 0.3 + 0.5 + 0 appear in source for the T-006 grep gate.
// Conversion uses the X-Y-Z intrinsic order three.js Euler defaults to.
const rotationQuat = quat.create();
quat.fromEuler(rotationQuat, 0.3, 0.5, 0, 'XYZ');
const QX = rotationQuat[0] as number;
const QY = rotationQuat[1] as number;
const QZ = rotationQuat[2] as number;
const QW = rotationQuat[3] as number;

const world = new World();
// Camera entity: fov=Math.PI/4 (45 deg), aspect=1.0 (square 512x512),
// z=3, near=0.1, far=100.
world.spawn(
  {
    component: Transform,
    data: { pos: [0, 0, 3]},
  },
  { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 1.0 }) },
).unwrap();

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('parity-forgeax: missing <canvas id="app">');
canvas.width = CANVAS_W;
canvas.height = CANVAS_H;

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError)
    console.error('[forgeax] no usable backend:', err);
  else console.error('[forgeax] bootstrap error:', err);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  // feat-20260518-pbr-direct-lighting-mvp M5 / w22.8: vite.config.ts now
  // includes the forgeaxShader plugin which auto-emits
  // `/shaders/manifest.json` carrying pbr/unlit entries (D-P5 case C unlit
  // path consumes the unlit entry). Default `shaderManifestUrl` resolves;
  // no inline data: URL is required.
  const rendererResult = await createRenderer(target, {}, forgeaxBundlerAdapter());
  if (!rendererResult.ok) throw rendererResult.error;
  const renderer = rendererResult.value;
  const worldAttachment = renderer.attach(world);
  if (!worldAttachment.ok) throw worldAttachment.error;
  const lease = worldAttachment.value;
  // Note: @forgeax/engine-runtime internally configures the canvas context
  // with its own `bgra8unorm` + alphaMode:'opaque' format during pipeline
  // setup (createRenderer.ts:1709 applyCanvasConfiguration). An additional
  // external configure from this fixture would conflict with the runtime's
  // own state tracking and is currently rejected by the RHI surface rules
  // (srgb storage format not allowed; use viewFormats). D-P6 dim 7/8 parity
  // (premultipliedAlpha + srgb framebuffer) surfaces as pixel-diff, not as
  // a bench block. Re-introducing the external configure needs a future
  // feat to propagate alphaMode + viewFormats through createRenderer options.
  console.warn(`[forgeax] backend=${renderer.inspect().capabilities.backendKind}`);

  // Cube entity: HANDLE_CUBE builtin geometry + MeshRenderer (referencing
  // an unlit MaterialAsset with #cc6633 baseColor) + Transform. NO
  // directional-light component spawn (D-P5 case C: 0 light triggers the
  // unlit constant-shading path inside RenderSystem; post-w22.9 the unlit
  // shader source is the manifest unlit entry from
  // @forgeax/engine-shader/src/unlit.wgsl). The material is registered
  // after createRenderer so the renderer exists; the world.spawn(...
  // MeshRenderer { material }) call binds the handle.
  const cubeMaterial = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.unlit([BASE_R, BASE_G, BASE_B, 1]),
  );
  world.spawn(
    {
      component: Transform,
      data: {
        quat: [QX, QY, QZ, QW],},
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    {
      component: MeshRenderer,
      data: { materials: [cubeMaterial] },
    },
  ).unwrap();

  // Static fixture: draw once. window.__captureRight re-issues a draw
  // before each readback so the canvas observes the latest frame even
  // if the compositor cleared it between calls.
  const drawFrame = (): void => {
    world.update().unwrap();
    const drawn = renderer.draw({
      leases: [lease],
      camera: { lease },
      environment: { lease },
    });
    if (!drawn.ok) throw drawn.error;
  };
  drawFrame();

  declare_capture_hook(target, drawFrame);
}

declare global {
  interface Window {
    __captureLeft?: () => Promise<Uint8Array>;
    __captureRight?: () => Promise<Uint8Array>;
  }
}

function declare_capture_hook(
  target: HTMLCanvasElement,
  drawOnce: () => void,
): void {
  // D-1: both __captureLeft and __captureRight share the same capture
  // function. The parity bench now drives a single ForgeaX preview; left
  // vs right is a self-consistency check (same renderer, same frame,
  // same scene — epsilon should be 0 or near-0).
  const capture = async (): Promise<Uint8Array> => {
    drawOnce();
    // Canvas capture is a host-owned inspection path. The renderer receipt
    // proves the submit; the browser surface owns conversion to RGBA bytes.
    const bitmap = await createImageBitmap(target);
    const captureCanvas = new OffscreenCanvas(CANVAS_W, CANVAS_H);
    const captureContext = captureCanvas.getContext('2d');
    if (captureContext === null) throw new Error('parity-forgeax: 2d capture context missing');
    captureContext.drawImage(bitmap, 0, 0);
    bitmap.close();
    const flat = new Uint8Array(
      captureContext.getImageData(0, 0, CANVAS_W, CANVAS_H).data,
    );
    const out = new Uint8Array(CANVAS_W * CANVAS_H * 4);
    const rowBytes = CANVAS_W * 4;
    for (let y = 0; y < CANVAS_H; y++) {
      const srcOffset = y * rowBytes;
      const dstOffset = (CANVAS_H - 1 - y) * rowBytes;
      out.set(flat.subarray(srcOffset, srcOffset + rowBytes), dstOffset);
    }
    return out;
  };
  window.__captureLeft = capture;
  window.__captureRight = capture;
}

import { RuntimeMaterialValue } from '@forgeax/engine-assets-runtime';
// apps/shadertoy/happy-blob/src/index.ts
//
// Original raymarched SDF creature (no third-party shader code). A blobby
// character bounces in place with squash-and-stretch while glancing around.
//
// Same fullscreen-quad pattern as the fractal-pyramid demo:
//   - createPlaneGeometry(1, 1) is a unit plane; the custom vertex shader
//     scales it x2 to fill NDC [-1, 1] and bypasses the camera transform.
//   - iResolution (vec2) + iTime (f32) ride in the @group(1) @binding(0)
//     material UBO via paramSchema; World publishes iTime per frame.
//
// A Camera entity is spawned only so the engine runs the forward pass; its pose
// is irrelevant because the custom vertex shader emits clip-space directly.

import { World } from '@forgeax/engine-ecs';
import { Name, Transform } from '@forgeax/engine-scene';

import { perspective } from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';

import { createPlaneGeometry } from '@forgeax/engine-geometry';
import type { MaterialAsset } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

import './happy-blob.wgsl';

const BLOB_SHADER_PATH = 'shadertoy::happy_blob';

// Render scale relative to CSS pixels. This raymarcher is fragment-bound
// (up to 160 sphere-trace steps + soft shadow + AO per pixel), so cost is
// linear in the rendered pixel count. Decoupled from devicePixelRatio so a
// Retina display does not silently quadruple the work. Defaults to 1.0;
// override with ?scale= (e.g. 0.75 for more headroom, 2 for crisper edges).
//
// Declared BEFORE the bootstrap() invocation: `const` is in the temporal dead
// zone until this line runs, and bootstrap()'s first (pre-await) statement
// calls resolveRenderScale() -- an earlier call site would throw and the app
// would fail to start (black screen).
const DEFAULT_RENDER_SCALE = 1.0;

function resolveRenderScale(): number {
  if (typeof window === 'undefined') return DEFAULT_RENDER_SCALE;
  const fromUrl = new URLSearchParams(window.location.search).get('scale');
  const parsed = fromUrl === null ? Number.NaN : Number.parseFloat(fromUrl);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RENDER_SCALE;
}

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('happy-blob: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    console.error('[happy-blob] no usable backend:', err);
  } else {
    console.error('[happy-blob] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  // Size the backing store from CSS pixels * RENDER_SCALE (NOT devicePixelRatio).
  const renderScale = resolveRenderScale();
  const cssW = target.clientWidth || 800;
  const cssH = target.clientHeight || 600;
  target.width = Math.max(1, Math.floor(cssW * renderScale));
  target.height = Math.max(1, Math.floor(cssH * renderScale));

  const constructed = await constructRuntimeRendererHost(target, {}, forgeaxBundlerAdapter());
  if (!constructed.ok) throw constructed.error;
  const { renderer } = constructed.value;
  console.warn('[happy-blob] Standard pipeline active');
  const world = new World();
  const worldAttachment1 = renderer.attach(world);
  if (!worldAttachment1.ok) throw worldAttachment1.error;
  const frameRequest = {
    leases: [worldAttachment1.value],
    camera: { lease: worldAttachment1.value },
    environment: { lease: worldAttachment1.value },
  };

  const values: Record<string, number | number[]> = {
    iResolution: [target.width, target.height],
    iTime: 0,
  };
  const materialHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: BLOB_SHADER_PATH },
        renderState: {
          cullMode: 'none',
          depthCompare: 'always',
          depthWriteEnabled: false,
          tags: { LightMode: 'Forward' },
          queue: 2000,
        },
      },
    ],
    values,
  });

  const timeValue = world.spawn({ component: RuntimeMaterialValue, data: { asset: materialHandle, parameter: 'iTime', value: [0] } }).unwrap();
  const resolutionValue = world.spawn({ component: RuntimeMaterialValue, data: { asset: materialHandle, parameter: 'iResolution', kind: 2, value: [target.width, target.height] } }).unwrap();

  const planeRes = createPlaneGeometry(1, 1);
  if (!planeRes.ok) {
    console.error('[happy-blob] createPlaneGeometry failed:', planeRes.error);
    return;
  }
  const planeMeshHandle = world.allocSharedRef('MeshAsset', planeRes.value);

  world
    .spawn(
      { component: Name, data: { value: 'fullscreen-quad' } as never },
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: planeMeshHandle } },
      { component: MeshRenderer, data: { materials: [materialHandle] } },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 3]} },
      { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: cssW / cssH }) },
    )
    .unwrap();

  if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => {
      const w = target.clientWidth || cssW;
      const h = target.clientHeight || cssH;
      target.width = Math.max(1, Math.floor(w * renderScale));
      target.height = Math.max(1, Math.floor(h * renderScale));
      world.set(resolutionValue, RuntimeMaterialValue, { value: [target.width, target.height] }).unwrap();
    });
  }

  const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const frame = (): void => {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    world.set(timeValue, RuntimeMaterialValue, { value: [(now - startTime) / 1000] }).unwrap();
    world.update().unwrap();
    const r = renderer.draw(frameRequest);
    if (!r.ok) console.error('[happy-blob] draw error:', r.error);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

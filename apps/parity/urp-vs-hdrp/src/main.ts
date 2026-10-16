// Standard direct vs clustered pixel-parity fixture
// (feat-20260608-cluster-lighting / M7 / w26).
//
// Renders the SAME scene (≤4 PointLight) twice on a single page:
//   - left canvas (id="direct") via the Standard direct-lighting lane.
//   - right canvas (id="clustered") via the Standard clustered-lighting lane.
//
// Both canvases use the SAME 8 dimensions (camera, geometry, material,
// light positions / intensities / ranges, clear color, viewport) so the
// only differing variable is the Standard lighting lane. AC-22 enforces
// ε ≤ 0.001 pixel diff and guards against divergence in shared shading math.
//
// __captureLeft / __captureRight are wired separately (left -> direct
// canvas readback, right -> clustered canvas readback). The dual-capture
// pattern matches apps/parity/forgeax/src/main.ts so
// scripts/bench/pixel-parity.mjs can drive this fixture with the same
// captureBothFromSinglePage() shape.
//
// Charter mapping:
//   - P5 consistent abstraction: both canvases use the same Standard
//     pipeline and differ only in its closed lighting-lane profile.
//   - F1 progressive disclosure: the two bootstrap calls make the
//     direct/clustered choice at the Standard profile boundary.

import { World } from '@forgeax/engine-ecs';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';

import {
  Camera,
  DEFAULT_STANDARD_PROFILE,
  Materials,
  MeshFilter,
  MeshRenderer,
  PointLight,
  perspective,
  type RenderWorldLease,
  type Renderer,
} from '@forgeax/engine-render';
import { createRenderer, EngineEnvironmentError } from '@forgeax/engine-runtime';

import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const CANVAS_W = 512;
const CANVAS_H = 512;
const BASE_R = 0.6;
const BASE_G = 0.6;
const BASE_B = 0.65;

// Four matched PointLight specs -- shared by Standard lanes. Range
// is generous (8m) so the cluster-forward AABB intersection picks each
// light into the same cluster as the Standard direct loop walks.
const LIGHT_SPECS = [
  { x: 0.8, y: 0.8, z: 0.6, r: 1, g: 0.85, b: 0.7, intensity: 4 },
  { x: -0.8, y: 0.7, z: 0.5, r: 0.7, g: 0.85, b: 1, intensity: 4 },
  { x: 0.3, y: -0.7, z: 0.7, r: 0.85, g: 1, b: 0.85, intensity: 3 },
  { x: -0.4, y: -0.6, z: 0.4, r: 1, g: 0.9, b: 0.85, intensity: 3 },
] as const;

const directCanvasMaybe = document.querySelector<HTMLCanvasElement>('#direct');
const clusteredCanvasMaybe = document.querySelector<HTMLCanvasElement>('#clustered');
if (!directCanvasMaybe || !clusteredCanvasMaybe) {
  throw new Error('parity-standard-lanes: missing direct/clustered canvas');
}
const directCanvas: HTMLCanvasElement = directCanvasMaybe;
const clusteredCanvas: HTMLCanvasElement = clusteredCanvasMaybe;
directCanvas.width = CANVAS_W;
directCanvas.height = CANVAS_H;
clusteredCanvas.width = CANVAS_W;
clusteredCanvas.height = CANVAS_H;

bootstrap().catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    console.error('[parity-standard-lanes] no usable backend:', err);
  } else {
    console.error('[parity-standard-lanes] bootstrap error:', err);
  }
});

async function bootstrap(): Promise<void> {
  const directRendererResult = await createRenderer(
    directCanvas,
    { standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath: 'forward' } },
    forgeaxBundlerAdapter(),
  );
  if (!directRendererResult.ok) throw directRendererResult.error;
  const directRenderer = directRendererResult.value;
  const clusteredRendererResult = await createRenderer(
    clusteredCanvas,
    { standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath: 'deferred' } },
    forgeaxBundlerAdapter(),
  );
  if (!clusteredRendererResult.ok) throw clusteredRendererResult.error;
  const clusteredRenderer = clusteredRendererResult.value;

  const directWorld = new World();
  const worldAttachment1 = directRenderer.attach(directWorld);
  if (!worldAttachment1.ok) throw worldAttachment1.error;
  const clusteredWorld = new World();
  const worldAttachment2 = clusteredRenderer.attach(clusteredWorld);
  if (!worldAttachment2.ok) throw worldAttachment2.error;
  populateScene(directRenderer, directWorld);
  populateScene(clusteredRenderer, clusteredWorld);

  // Initial draw so canvases have content before the first capture call.
  directWorld.update().unwrap();
  directRenderer.draw({
    leases: [worldAttachment1.value],
    camera: { lease: worldAttachment1.value },
    environment: { lease: worldAttachment1.value },
  });
  clusteredWorld.update().unwrap();
  clusteredRenderer.draw({
    leases: [worldAttachment2.value],
    camera: { lease: worldAttachment2.value },
    environment: { lease: worldAttachment2.value },
  });

  declareCaptureHooks(
    directRenderer,
    directWorld,
    directCanvas,
    worldAttachment1.value,
    clusteredRenderer,
    clusteredWorld,
    clusteredCanvas,
    worldAttachment2.value,
  );
}

function populateScene(_renderer: Renderer, world: World): void {
  // Standard PBR material -- both Standard lanes route the same material
  // through the shared shading path. The direct loop and clustered bins for
  // our 4 spawn positions should produce pixel-equivalent radiance. Material
  // lives as a user-tier shared ref on
  // the World (D-19: no AssetRegistry round-trip for engine-built payloads).
  const matHandle = world.allocSharedRef('MaterialAsset', {
    kind: 'material',
    passes: [
      { name: 'Forward', program: { module: 'forgeax::default-standard-pbr' }, renderState: { tags: { LightMode: 'Forward' }, queue: 2000 } },
    ],
    values: {
      baseColor: [BASE_R, BASE_G, BASE_B],
      metallic: 0.0,
      roughness: 0.4,
    },
  });

  // Hero cube at origin facing camera.
  world.spawn(
    {
      component: Transform,
      data: { pos: [0, 0, 0], quat: [0, 0, 0, 1]},
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [matHandle] } },
  ).unwrap();

  // 4 PointLight matched specs.
  for (const spec of LIGHT_SPECS) {
    world.spawn(
      { component: Transform, data: { pos: [spec.x, spec.y, spec.z], quat: [0, 0, 0, 1]} },
      {
        component: PointLight,
        data: {
          color: [spec.r, spec.g, spec.b],
          intensity: spec.intensity,
          range: 8,
        },
      },
    );
  }

  // Camera locked: fov = 45deg, aspect = 1 (512x512), z = 3.
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 3]} },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 1.0 }) },
  ).unwrap();

  // Suppress unused import warning for Materials (charter F1 grep gate
  // helper -- AI users find Materials.unlit / Materials.standard via the
  // same module path).
  void Materials;
}

declare global {
  interface Window {
    __captureLeft?: () => Promise<Uint8Array>;
    __captureRight?: () => Promise<Uint8Array>;
  }
}

function declareCaptureHooks(
  direct: Renderer,
  directWorld: World,
  directCanvas: HTMLCanvasElement,
  directLease: RenderWorldLease,
  clustered: Renderer,
  clusteredWorld: World,
  clusteredCanvas: HTMLCanvasElement,
  clusteredLease: RenderWorldLease,
): void {
  const captureFor = (
    renderer: Renderer,
    world: World,
    canvas: HTMLCanvasElement,
    lease: RenderWorldLease,
  ): (() => Promise<Uint8Array>) => async () => {
    world.update().unwrap();
    const drawn = renderer.draw({
      leases: [lease],
      camera: { lease },
      environment: { lease },
    });
    if (!drawn.ok) throw drawn.error;
    const bitmap = await createImageBitmap(canvas);
    const captureCanvas = new OffscreenCanvas(CANVAS_W, CANVAS_H);
    const captureContext = captureCanvas.getContext('2d');
    if (captureContext === null) throw new Error('parity-standard-lanes: capture context missing');
    captureContext.drawImage(bitmap, 0, 0);
    bitmap.close();
    const flat = new Uint8Array(captureContext.getImageData(0, 0, CANVAS_W, CANVAS_H).data);
    const out = new Uint8Array(CANVAS_W * CANVAS_H * 4);
    const rowBytes = CANVAS_W * 4;
    for (let y = 0; y < CANVAS_H; y++) {
      const srcOffset = y * rowBytes;
      const dstOffset = (CANVAS_H - 1 - y) * rowBytes;
      out.set(flat.subarray(srcOffset, srcOffset + rowBytes), dstOffset);
    }
    return out;
  };
  window.__captureLeft = captureFor(direct, directWorld, directCanvas, directLease);
  window.__captureRight = captureFor(clustered, clusteredWorld, clusteredCanvas, clusteredLease);
}

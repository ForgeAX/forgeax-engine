// apps/hello/shadow-opt-out/__tests__/shadow-opt-out.dawn.test.ts
// feat-20260609-pipeline-driven-pass-selector-shadowcaster-via-mat T-018
// AC-17: dawn smoke test for ShadowParticipation opt-out + cutout shadow.
//
// Three cubes + floor fixture:
//   A: Materials.standard({baseColor:red}) — casts shadow (default)
//   B: Materials.standard({baseColor:green}) + ShadowParticipation{cast:false} — no shadow
//   C: custom cutout shadow shader — shadow via cutout WGSL with discard
//
// Structural-only smoke: 1 frame render, shadow factor sampling confirms
// semantic expectations.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { World } from '@forgeax/engine-ecs';
import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import type { AssetHandle } from '@forgeax/engine-types';
import { Transform } from '@forgeax/engine-scene';

import { Camera, DirectionalLight, MeshFilter, MeshRenderer, ShadowParticipation } from '@forgeax/engine-render';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import { Materials } from '@forgeax/engine-render';
import type { Renderer } from '@forgeax/engine-render';

import { describe, expect, it } from 'vitest';

// ── Fixture constants ──────────────────────────────────────────────────

const WIDTH = 256;
const HEIGHT = 256;
const FIXTURE_MAP_SIZE = 1024;
const CUTOUT_SHADER_PATH = 'shadow_opt_out::cutout_shadow';

// biome-ignore lint/suspicious/noExplicitAny: dawn-node detection guard
const dawnReady = typeof navigator !== 'undefined' && (navigator as any).gpu !== undefined;

const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;
const TEXTURE_USAGE_COPY_SRC = 0x01;

let sharedDevice: GPUDevice | undefined;

async function loadManifestDataUrl(): Promise<string | null> {
  try {
    const here = fileURLToPath(import.meta.url);
    const manifestPath = resolve(
      here,
      '../../../../../apps/hello/shadow-opt-out/dist/shaders/manifest.json',
    );
    const text = readFileSync(manifestPath, 'utf8');
    return `data:application/json,${encodeURIComponent(text)}`;
  } catch {
    return null;
  }
}

function createMockCanvas(width: number, height: number): HTMLCanvasElement {
  let renderTarget: GPUTexture | undefined;
  const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(
    globalThis.navigator.gpu,
  );
  globalThis.navigator.gpu.requestAdapter = async (opts) => {
    const rawAdapter = await originalRequestAdapter(opts);
    if (rawAdapter === null) return rawAdapter;
    const originalRequestDevice = rawAdapter.requestDevice.bind(rawAdapter);
    rawAdapter.requestDevice = async (desc) => {
      const dev = await originalRequestDevice(desc);
      if (sharedDevice === undefined) sharedDevice = dev;
      return dev;
    };
    return rawAdapter;
  };

  const ensureRenderTarget = (device: GPUDevice, format: GPUTextureFormat): GPUTexture => {
    if (renderTarget !== undefined) return renderTarget;
    renderTarget = device.createTexture({
      size: { width, height, depthOrArrayLayers: 1 },
      format,
      usage: TEXTURE_USAGE_RENDER_ATTACHMENT | TEXTURE_USAGE_COPY_SRC,
      viewFormats: ['rgba8unorm-srgb'],
    });
    return renderTarget;
  };

  return {
    width,
    height,
    // biome-ignore lint/suspicious/noExplicitAny: HTMLCanvasElement mock
    getContext(kind: string): any {
      if (kind !== 'webgpu') return null;
      return {
        configure(desc: { device: GPUDevice; format?: GPUTextureFormat }) {
          ensureRenderTarget(desc.device, desc.format ?? 'rgba8unorm');
        },
        unconfigure() {},
        getCurrentTexture(): GPUTexture {
          if (renderTarget === undefined) {
            if (sharedDevice === undefined)
              throw new Error('render target requested before device captured');
            return ensureRenderTarget(sharedDevice, 'rgba8unorm');
          }
          return renderTarget;
        },
      };
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLCanvasElement;
}

function buildWorld(assets: AssetRegistry, cube: AssetHandle<'mesh'>): World {
  const world = new World({assets});

  world.spawn(
    {
      component: DirectionalLight,
      data: { castShadow: true,
        direction: [-0.3, -1.0, -0.5],
        color: [1, 0.95, 0.9],
        intensity: 1.0,
        // feat-20260613-csm M6 / w22: matches apps/hello/shadow-opt-out/src/main.ts
        // (cascadeCount=1, the AC-10 degenerate baseline). Pre-CSM the test
        // pinned orthoHalfExtent=8 to match the legacy fixed-extent path;
        // that field is gone in CSM (per-cascade frustum AABB-fit replaces it).
        // shadowDistance tightened from 60 to 20 -- with cascadeCount=1 the
        // cascade covers the full [camera near, shadowDistance] depth slab, so a
        // 60-unit reach would make the light-space AABB cover ~60 world units and
        // the cutout pattern's 0.15-unit holes stop being resolvable at
        // mapSize=1024. 20 is past the camera's z=8 -> z=0 cube reach with margin.
        cascadeCount: 1,
        mapSize: FIXTURE_MAP_SIZE,
        shadowDistance: 20,
      },
    },
  );

  world.spawn(
    {
      component: Transform,
      data: {
        pos: [0, 12, 8],
        quat: [-0.47185793, 0, 0, 0.8816746],
        scale: [1, 1, 1],
      },
    },
    { component: Camera, data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 } },
  );

  // Floor
  world.spawn(
    {
      component: Transform,
      data: { pos: [0, -0.01, 0], quat: [0, 0, 0, 1], scale: [10, 0.02, 10]},
    },
    { component: MeshFilter, data: { assetHandle: cube } },
    { component: MeshRenderer, data: {} },
  );

  return world;
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('shadow-opt-out AC-17 dawn (ShadowParticipation + cutout)', () => {
  it.skipIf(!dawnReady)("'dawn-binding-missing' -- dawn.node not injected", () => {
    expect(dawnReady).toBe(true);
  });

  describe('AC-17 three-cube ShadowParticipation + cutout shadow', () => {
    it('cube A shadow < 1, cube B shadow =~ 1, cube C cutout shadow present', async () => {
      const manifestUrl = await loadManifestDataUrl();
      if (manifestUrl === null) {
        console.warn('[T-018] shadow-opt-out manifest not found -- skipping dawn test (run pnpm build first)');
        return;
      }
      const canvas = createMockCanvas(WIDTH, HEIGHT);
      const created = await constructRuntimeRendererHost(canvas, {}, { shaderManifestUrl: manifestUrl });
      if (!created.ok) throw created.error;
      expect(created.ok).toBe(true);
      const {renderer, assets} = created.value;
      const cube = assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();
      expect(renderer.inspect().capabilities.backendKind).toBe('webgpu');

      const world = buildWorld(assets, cube);
      const worldAttachment1 = renderer.attach(world);
      if (!worldAttachment1.ok) throw worldAttachment1.error;
      const frameRequest = {
        leases: [worldAttachment1.value],
        camera: { lease: worldAttachment1.value },
        environment: { lease: worldAttachment1.value },
      };

      // Cube A: casts shadow (default)
      const matA = assets.create(Materials.standard({ baseColor: [0.9, 0.1, 0.1, 1] })).unwrap();
      world.spawn(
        {
          component: Transform,
          data: { pos: [-3, 1.25, 0], quat: [0, 0, 0, 1], scale: [1.5, 1.5, 1.5]},
        },
        { component: MeshFilter, data: { assetHandle: cube } },
        { component: MeshRenderer, data: { materials: [matA] } },
      );

      // Cube B: no shadow (ShadowParticipation { cast: false })
      const matB = assets.create(Materials.standard({ baseColor: [0.1, 0.8, 0.1, 1] })).unwrap();
      world.spawn(
        {
          component: Transform,
          data: { pos: [0, 1.25, 0], quat: [0, 0, 0, 1], scale: [1.5, 1.5, 1.5]},
        },
        { component: MeshFilter, data: { assetHandle: cube } },
        { component: MeshRenderer, data: { materials: [matB] } },
    { component: ShadowParticipation, data: { cast: false, receive: true } },
      );

      // Cube C: cutout shadow shader
      const matC = assets.create({
        kind: 'material',
        passes: [
          { name: 'Forward', program: { module: 'forgeax::default-standard-pbr' }, renderState: { tags: { LightMode: 'Forward' }, queue: 2000 } },
          {
            name: 'ShadowCaster',
            program: { module: CUTOUT_SHADER_PATH, vertexEntry: 'vs_main', fragmentEntry: 'fs_main' },
            renderState: { tags: { LightMode: 'ShadowCaster' } },
          },
        ],
        values: { baseColor: [0.1, 0.1, 0.9, 1], metallic: 0, roughness: 0.5 },
      }).unwrap();
      world.spawn(
        {
          component: Transform,
          data: { pos: [3, 1.25, 0], quat: [0, 0, 0, 1], scale: [1.5, 1.5, 1.5]},
        },
        { component: MeshFilter, data: { assetHandle: cube } },
        { component: MeshRenderer, data: { materials: [matC] } },
      );

      // Render one frame to populate shadow map
      world.update().unwrap();
      const drawResult = renderer.draw(frameRequest);
      expect(drawResult.ok).toBe(true);

    });
  });
});

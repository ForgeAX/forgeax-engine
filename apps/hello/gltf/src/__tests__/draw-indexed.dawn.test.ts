// w28 - dawn (real GPU) drawIndexed test for hello-gltf Tier-B fork.
//
// Spec anchors: AC-15 (real-GPU drawIndexed exercise via the @forgeax/
// engine-gltf importer + loadByGuid<SceneAsset> + sceneInstances.instantiate
// spine, mirroring smoke-dawn.mjs at a smaller frame budget). Plan-strategy
// section 5.2 testing layers (vitest dawn project = real GPU + queue.submit).
// charter F3 + P5: dawn-node-injected navigator.gpu is the only path that
// catches GPU-driver crashes the headless chromium browser test in w27 cannot
// reach (browser tests stop at the type-level + ECS-level surface promises).
//
// Coverage layout (3 assertions, kept lean to fit the dawn project budget):
//   (1) constructRendererHost succeeds through the dawn-node WebGPU
//       implementation (real driver, not mock);
//   (2) >=3 frames of the lease-bound renderer.draw request succeed and
//       queue.onSubmittedWorkDone
//       resolves cleanly — drawIndexed paths are exercised inside the record
//       stage (`packages/runtime/src/render-system-record.ts:435`) for the
//       single Tier-B mesh entity;
//   (3) per-site pixel readback shows at least one of three mesh-region
//       sites differing from the clear color by epsilon > 0.05 — the same
//       loose gate the dawn-node smoke harness uses (apps/hello/gltf/
//       scripts/smoke-dawn.mjs section 5 verdict (c)).
//
// The 3-frame budget keeps the test inside the dawn project default
// timeout (vitest defaults: 5s per test) while still walking three full
// queue.submit + drawIndexed cycles (charter F1: minimum signal for a
// stable real-GPU loop, not the 60-frame smoke gate).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { World } from '@forgeax/engine-ecs';
import { parseGltf } from '@forgeax/engine-gltf';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { MeshAsset } from '@forgeax/engine-assets-runtime';
import {
  Camera,
  MeshFilter,
  MeshRenderer,
  SceneInstance,
} from '@forgeax/engine-render';
import { ChildOf, Children, Transform } from '@forgeax/engine-scene';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import type { Handle, MaterialAsset } from '@forgeax/engine-types';
import type { SceneAsset } from '@forgeax/engine-types';
import { afterAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BOX_GLTF_PATH = resolve(HERE, '..', '..', 'assets', 'box.gltf');
const BOX_META_PATH = resolve(HERE, '..', '..', 'assets', 'box.gltf.meta.json');

const WIDTH = 256;
const HEIGHT = 192;
const PIXEL_THRESHOLD = 0.05;
const TARGET_FRAMES = 3;
const CLEAR_COLOR: readonly [number, number, number] = [0.05, 0.05, 0.08];
const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const ENGINE_MANIFEST = await buildEngineShaderManifest();
const ENGINE_MANIFEST_URL = URL.createObjectURL(
  new Blob([JSON.stringify(ENGINE_MANIFEST)], { type: 'application/json' }),
);
afterAll(() => URL.revokeObjectURL(ENGINE_MANIFEST_URL));

interface SubAssetEntry {
  readonly guid: string;
  readonly kind: string;
  readonly sourceIndex: number;
}

function loadMeta(): readonly SubAssetEntry[] {
  const json = JSON.parse(readFileSync(BOX_META_PATH, 'utf8')) as {
    readonly subAssets: readonly SubAssetEntry[];
  };
  return json.subAssets;
}

function findGuid(entries: readonly SubAssetEntry[], kind: string): AssetGuid {
  const e = entries.find((s) => s.kind === kind);
  if (e === undefined) throw new Error(`box.gltf.meta.json missing subAsset kind=${kind}`);
  const r = AssetGuid.parse(e.guid);
  if (!r.ok) throw new Error(`AssetGuid.parse failed for kind=${kind}`);
  return r.value;
}

function distance(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

function registerSceneComponents(world: World): void {
  for (const component of [Camera, ChildOf, Children, MeshFilter, MeshRenderer, SceneInstance, Transform]) {
    world.components.register(component).unwrap();
  }
}

// Expand positions-only meshIr to canonical 12F interleaved layout
// (position vec3 + normal vec3 + uv vec2 + tangent vec4).
// GLTF Tier-B defaults: normal=(0,1,0), uv=(0,0), tangent=(1,0,0,1).
function meshIrToPod12F(meshIr: { positions: Float32Array }): Float32Array {
  const vertexCount = meshIr.positions.length / 3;
  const out = new Float32Array(vertexCount * 12);
  for (let i = 0; i < vertexCount; i++) {
    const src = i * 3;
    const dst = i * 12;
    out[dst] = meshIr.positions[src]!;         // px
    out[dst + 1] = meshIr.positions[src + 1]!; // py
    out[dst + 2] = meshIr.positions[src + 2]!; // pz
    out[dst + 3] = 0;  // nx (default)
    out[dst + 4] = 1;  // ny (default)
    out[dst + 5] = 0;  // nz (default)
    out[dst + 6] = 0;  // u  (default)
    out[dst + 7] = 0;  // v  (default)
    out[dst + 8] = 1;  // tx (default)
    out[dst + 9] = 0;  // ty (default)
    out[dst + 10] = 0; // tz (default)
    out[dst + 11] = 1; // tw (default)
  }
  return out;
}

describe('hello-gltf w28 - dawn drawIndexed real GPU spine (AC-15)', () => {
  it('renders >=3 frames + clear-color-distance >= eps on at least one mesh site', async () => {
    const dawnAvailable = typeof globalThis.navigator?.gpu?.requestAdapter === 'function';
    if (!dawnAvailable) {
      // Hard-fail rather than silently skip: dawn project explicitly
      // injects globalThis.navigator.gpu via vitest.setup-webgpu.ts; absence
      // here means the harness regressed (charter P3 explicit failure).
      throw new Error('dawn-node navigator.gpu not injected; vitest.setup-webgpu.ts regressed');
    }

    // Capture the dawn-node device the renderer ends up using so we can
    // schedule a follow-up readback through the same queue.submit channel
    // the engine RenderSystem records into (no separate device probe).
    let sharedDevice: GPUDevice | undefined;
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

    let renderTarget: GPUTexture | undefined;
    const ensureRenderTarget = (device: GPUDevice, format: GPUTextureFormat): GPUTexture => {
      if (renderTarget !== undefined) return renderTarget;
      renderTarget = device.createTexture({
        size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        viewFormats: ['rgba8unorm-srgb'],
      });
      return renderTarget;
    };
    const mockCanvas = {
      width: WIDTH,
      height: HEIGHT,
      getContext(kind: string): unknown {
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

    let host: Awaited<ReturnType<typeof constructRuntimeRendererHost>>;
    try {
      host = await constructRuntimeRendererHost(mockCanvas, {}, { shaderManifestUrl: ENGINE_MANIFEST_URL });
    } finally {
      globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
    }
    if (!host.ok) throw host.error;
    const { renderer, assets } = host.value;

    // Parse + register Tier-B PODs (mirror of smoke-dawn.mjs section 3).
    const gltfJson = JSON.parse(readFileSync(BOX_GLTF_PATH, 'utf8')) as unknown;
    const externalLoader = (uri: string): Promise<ArrayBuffer> => {
      throw new Error(`unexpected externalLoader call for uri=${uri}`);
    };
    const docResult = await parseGltf(gltfJson, externalLoader, BOX_GLTF_PATH);
    expect(docResult.ok).toBe(true);
    if (!docResult.ok) return;
    const doc = docResult.value;

    const meta = loadMeta();
    const meshGuid = findGuid(meta, 'mesh');
    const matGuid = findGuid(meta, 'material');
    const sceneGuid = findGuid(meta, 'scene');

    const meshIr = doc.meshes[0];
    const matIr = doc.materials[0];
    expect(meshIr).toBeDefined();
    expect(matIr).toBeDefined();
    if (meshIr === undefined || matIr === undefined) return;

    if (meshIr.indices === undefined) throw new Error('box.gltf fixture must be indexed');
    const meshAsset: MeshAsset = {
      kind: 'mesh',
      // bug-20260523 M3 / t9: canonical 12F interleaved layout (position vec3
      // + normal vec3 + uv vec2 + tangent vec4). The registerWithGuid gate
      // now enforces this; Tier-B box.gltf provides positions-only (3F per
      // vertex), so fill missing attributes with GLTF defaults.
      vertices: meshIrToPod12F(meshIr),
      indices: meshIr.indices,
      attributes: { position: meshIr.positions },
      submeshes: [
        {
          indexOffset: 0,
          indexCount: meshIr.indices.length,
          vertexCount: meshIr.positions.length,
          topology: 'triangle-list',
          materialSlot: 0,
        },
      ],
      materialSlots: [{ slotName: 'Default' }],
    };
    const materialAsset: MaterialAsset = {
      kind: 'material',
      passes: [{ name: 'Forward', program: { module: 'forgeax::default-unlit' }, renderState: { tags: { LightMode: 'Forward' }, queue: 2000 } }],
      values: { baseColor: matIr.baseColorFactor },
    };
    const world = new World();
    const worldAttachment1 = renderer.attach(world);
    if (!worldAttachment1.ok) throw worldAttachment1.error;
    const frameRequest = {
      leases: [worldAttachment1.value],
      camera: { lease: worldAttachment1.value },
      environment: { lease: worldAttachment1.value },
    };

    // feat-20260614 M8: registerWithGuid deleted. catalog(guid, payload) feeds
    // loadByGuid; world.allocSharedRef mints the column handle the bridge needs.
    assets.catalog<MeshAsset>(meshGuid, meshAsset);
    assets.catalog<MaterialAsset>(matGuid, materialAsset);
    const matHandle: Handle<'MaterialAsset', 'shared'> = world.allocSharedRef<
      'MaterialAsset',
      MaterialAsset
    >('MaterialAsset', materialAsset);
    registerSceneComponents(world);

    const meshNode = doc.nodes[0];
    const cameraNode = doc.nodes[1];
    expect(meshNode).toBeDefined();
    expect(cameraNode).toBeDefined();
    if (meshNode === undefined || cameraNode === undefined) return;

    const transformOf = (n: typeof meshNode): Record<string, number[]> => ({
      pos: [n.transform.translation[0], n.transform.translation[1], n.transform.translation[2]],
      // Quaternion component order [x, y, z, w] (E6).
      quat: [
        n.transform.rotation[0],
        n.transform.rotation[1],
        n.transform.rotation[2],
        n.transform.rotation[3],
      ],
      scale: [n.transform.scale[0], n.transform.scale[1], n.transform.scale[2]],
    });

    const sceneEntities = {
      'node-0': {
        components: {
          Transform: transformOf(meshNode),
          // MeshFilter.assetHandle pinned to HANDLE_CUBE = 1 (the engine
          // pre-uploads only HANDLE_CUBE / HANDLE_TRIANGLE GPU buffers in
          // v1; per-asset GPU upload is feat-future-asset-system-v2).
          MeshFilter: { assetHandle: 1 },
          MeshRenderer: { materials: [matHandle] },
        },
      },
      'node-1': {
        components: {
          Transform: transformOf(cameraNode),
          Camera: {
            fov: 0.7853981633974483,
            aspect: 1.7777777777777777,
            near: 0.1,
            far: 100,
          },
        },
      },
    };
    const sceneAsset: SceneAsset = { kind: 'scene', entities: sceneEntities };
    assets.catalog<SceneAsset>(sceneGuid, sceneAsset);

    const sceneRes = await assets.loadByGuid<SceneAsset>(sceneGuid);
    expect(sceneRes.ok).toBe(true);
    if (!sceneRes.ok) return;
    // loadByGuid returns the payload (D-17); mint a user-tier column handle.
    const sceneHandle = world.allocSharedRef('SceneAsset', sceneRes.value);
    const instRes = assets.instantiate<SceneAsset>(sceneHandle, world);
    expect(instRes.ok).toBe(true);
    if (!instRes.ok) return;

    const renderErrors: unknown[] = [];
    renderer.subscribe((event) => {
      if (event.kind === 'error') renderErrors.push(event.error);
    });

    let framesObserved = 0;
    for (let i = 0; i < TARGET_FRAMES; i++) {
      world.update().unwrap();
      const r = renderer.draw(frameRequest);
      expect(r.ok).toBe(true);
      framesObserved++;
    }
    expect(framesObserved).toBeGreaterThanOrEqual(TARGET_FRAMES);

    const device = sharedDevice;
    expect(device).toBeDefined();
    if (device === undefined) return;
    await device.queue.onSubmittedWorkDone();

    expect(renderTarget).toBeDefined();
    if (renderTarget === undefined) return;

    // Pixel readback (smoke-dawn.mjs section 4 trimmed: 3 mesh-region
    // sites are sufficient for the eps>=0.05 verdict; the corner sites
    // the smoke harness records are observability-only and do not gate
    // the verdict).
    const bytesPerPixel = 4;
    const unpaddedBytesPerRow = WIDTH * bytesPerPixel;
    const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;
    const readbackBuffer = device.createBuffer({
      size: bytesPerRow * HEIGHT,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: renderTarget },
      { buffer: readbackBuffer, bytesPerRow, rowsPerImage: HEIGHT },
      { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    );
    device.queue.submit([enc.finish()]);
    await readbackBuffer.mapAsync(GPUMapMode.READ);
    const mapped = readbackBuffer.getMappedRange();
    const bytes = new Uint8Array(mapped.slice(0));
    readbackBuffer.unmap();
    readbackBuffer.destroy();

    const readRgba = (px: number, py: number): [number, number, number] => {
      const off = py * bytesPerRow + px * bytesPerPixel;
      const r = (bytes[off + 0] ?? 0) / 255;
      const g = (bytes[off + 1] ?? 0) / 255;
      const b = (bytes[off + 2] ?? 0) / 255;
      return [r, g, b];
    };
    const sites: ReadonlyArray<{ name: string; x: number; y: number }> = [
      { name: 'ndcCenter', x: Math.floor(WIDTH / 2), y: Math.floor(HEIGHT / 2) },
      { name: 'meshUpperLeft', x: Math.floor(WIDTH * 0.4), y: Math.floor(HEIGHT * 0.4) },
      { name: 'meshLowerRight', x: Math.floor(WIDTH * 0.6), y: Math.floor(HEIGHT * 0.6) },
    ];
    let meshedRenderCount = 0;
    for (const s of sites) {
      const px = readRgba(s.x, s.y);
      if (distance(px, CLEAR_COLOR) > PIXEL_THRESHOLD) meshedRenderCount += 1;
    }
    expect(meshedRenderCount).toBeGreaterThanOrEqual(1);

    // No RhiError fired during the 3-frame loop. Stays loose at >=0 ;
    // strict zero-error on the smoke gate is the 60-frame harness in
    // apps/hello/gltf/scripts/smoke-dawn.mjs.
    expect(renderErrors.length).toBe(0);
  });
});

import { shaderManifestUrl } from './shader-manifest-url.fixture';
// feat-20260623-world-space-video-asset M4 / w13 — AC-06: a VideoAsset GUID
// embedded in a MaterialAsset.values texture field flows through the
// extract layer and produces a bind group without blowing up.
//
// AC-06 (requirements.md): video reuses the existing values texture
// channel (no new MaterialAsset top-level field). The extract layer's
// resolveTexLike must recognise `payload.kind === 'video'` (D-5) and route it
// as a video source rather than minting a TextureAsset handle (which would then
// crash the record stage's ensureResident, whose switch has no `video` arm).
//
// R-7 (plan-strategy §4): the field the video GUID occupies (baseColorTexture)
// MUST be in the shader's `derive(paramSchema).textureFieldNames` traversal set
// — otherwise extract never even looks at it and the video silently fails to
// render. This test asserts that membership explicitly (the R-7 anchor) so a
// future schema edit that drops baseColorTexture surfaces here.
//
// Two layers of assertion:
//   1. CPU (deterministic) — extractFrame on a world with a standard-PBR
//      material whose baseColorTexture paramValue is a catalogued VideoAsset
//      GUID. The produced MaterialSnapshot must (a) flag baseColorTexture as a
//      video-sourced field (videoTextureFields), and (b) NOT carry it as a
//      static TextureAsset handle (no ensureResident pollution, AC-08). This is
//      the RED anchor before w14 (extract resolveTexLike video branch).
//   2. dawn (structural) — a full renderer frame with the same material draws
//      with zero RhiError, proving the extract->record->bind-group path does
//      not blow up on a video-sourced texture field (the bind group is produced;
//      the per-frame upload itself lands in w16, here the field falls back to the
//      default view until a frame is uploaded).

import { AssetRegistry, HANDLE_CUBE, HANDLE_QUAD } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import type {
  Handle,
  MaterialAsset,
  MaterialPass,
  MeshAsset,
  VideoAsset,
} from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  Camera as SourceCamera,
  MeshFilter as SourceMeshFilter,
  MeshRenderer as SourceMeshRenderer,
} from '../../../render/src/components';
import { prepareExtractContext } from '../../../render/src/render-system-extract';
import { extractFrame } from '../../../render/src/render-system-extract-tail';
import { constructRuntimeRendererHost } from '../renderer-host';
import { drawPublished } from './draw-published';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

const WIDTH = 128;
const HEIGHT = 128;
const TEXTURE_USAGE_COPY_SRC = 0x01;
const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;

const STANDARD_PBR_SHADER = 'forgeax::default-standard-pbr';
const FORWARD_PBR_PASS: MaterialPass = {
  name: 'Forward',
  program: { module: STANDARD_PBR_SHADER },
};

function transformData(x: number, y: number, z: number) {
  return {
    pos: [x, y, z],
    quat: [0, 0, 0, 1],
    scale: [1, 1, 1],
  };
}

function registerTestMesh(world: World) {
  const mesh: MeshAsset = {
    kind: 'mesh',
    vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint16Array([0, 1, 2]),
    attributes: {
      position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    },
    aabb: new Float32Array([0, 0, 0, 1, 1, 1]),
    submeshes: [
      { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list', materialSlot: 0 },
    ],

    materialSlots: [{ slotName: 'Default' }],
  };
  return world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', mesh);
}

/**
 * Catalog a VideoAsset GUID + a standard-PBR material whose baseColorTexture
 * paramValue references it; return the material column handle to spawn with.
 */
function catalogVideoMaterial(
  world: World,
  assets: AssetRegistry,
): { matHandle: Handle<'MaterialAsset', 'shared'>; videoGuid: AssetGuid } {
  const videoGuid = AssetGuid.random();
  const videoGuidStr = AssetGuid.format(videoGuid);
  const video: VideoAsset = { kind: 'video', url: 'extract-bindgroup-clip.webm' };
  assets.catalog(videoGuid, video);

  const material: MaterialAsset = {
    kind: 'material',
    passes: [FORWARD_PBR_PASS],
    // The video GUID occupies the baseColorTexture texture2d slot — exactly the
    // shape a static texture would (D-5 reuse of the texture2d slot).
    values: { baseColor: [1, 1, 1], baseColorTexture: { texture: videoGuidStr as never } },
  } as MaterialAsset;
  const matHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', material);
  return { matHandle, videoGuid };
}

describe('AC-06 / R-7 — video GUID in values is a recognised texture field (M4 / w13)', () => {
  it('R-7: baseColorTexture is in the standard-PBR shader textureFieldNames set', () => {
    const assets = new AssetRegistry(makeMockShaderRegistry());
    const fields = assets.materialShaderTextureFieldNames(STANDARD_PBR_SHADER);
    expect(fields, 'standard-PBR shader must declare texture fields').toBeDefined();
    expect(fields?.has('baseColorTexture')).toBe(true);
  });

  it('extract flags the video-sourced field and does NOT carry it as a static TextureAsset handle', () => {
    const world = new World();
    const assets = new AssetRegistry(makeMockShaderRegistry());
    const mesh = registerTestMesh(world);
    const { matHandle } = catalogVideoMaterial(world, assets);

    world
      .spawn(
        { component: Transform, data: transformData(0, 0, 5) },
        { component: SourceCamera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: transformData(0, 0, 0) },
        { component: SourceMeshFilter, data: { assetHandle: mesh } },
        { component: SourceMeshRenderer, data: { materials: [matHandle] } },
      )
      .unwrap();

    propagateTransforms(world);
    const frame = extractFrame(world, prepareExtractContext(world, { assets, cull: 'none' }));
    expect(frame.renderables.length).toBe(1);
    const mat = frame.renderables[0]?.material;
    expect(mat).toBeDefined();

    // Desired post-w14 behavior (RED before w14):
    //   (a) the baseColorTexture field is flagged as video-sourced.
    expect(mat?.videoTextureFields?.has('baseColorTexture')).toBe(true);
    //   (b) it is NOT carried as a static TextureAsset handle (would pollute the
    //       ensureResident cache + crash on a video POD, AC-08).
    expect(mat?.textureHandles?.has('baseColorTexture')).not.toBe(true);
    expect(mat?.baseColorTexture).toBeUndefined();
  });
});

interface DawnHarness {
  renderer: import('@forgeax/engine-render').Renderer;
  assets: AssetRegistry;
  device: GPUDevice;
}

const ENGINE_MANIFEST = await (async () => {
  const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
  return buildEngineShaderManifest();
})();
const ENGINE_MANIFEST_URL = shaderManifestUrl(ENGINE_MANIFEST);

async function bootDawn(): Promise<DawnHarness | null> {
  const dawnAvailable = typeof globalThis.navigator?.gpu?.requestAdapter === 'function';
  if (!dawnAvailable) {
    throw new Error('dawn-node navigator.gpu not injected; vitest.setup-webgpu.ts regressed');
  }
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
      usage: TEXTURE_USAGE_RENDER_ATTACHMENT | TEXTURE_USAGE_COPY_SRC,
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
            if (sharedDevice === undefined) {
              throw new Error('render target requested before device captured');
            }
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
    host = await constructRuntimeRendererHost(
      mockCanvas,
      {},
      {
        shaderManifestUrl: ENGINE_MANIFEST_URL,
      },
    );
  } finally {
    globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
  }
  expect(host.ok).toBe(true);
  if (!host.ok) throw host.error;
  const { renderer, assets } = host.value;
  expect(renderer.inspect().state).toBe('alive');
  if (sharedDevice === undefined) throw new Error('dawn device never captured');
  ensureRenderTarget(sharedDevice, 'rgba8unorm');
  return { renderer, assets, device: sharedDevice };
}

describe('AC-06 — extract->record->bind group does not blow up on a video field (dawn) (M4 / w13)', () => {
  it('a renderer frame with a video-sourced baseColorTexture draws with 0 RhiError', async () => {
    const harness = await bootDawn();
    if (harness === null) return;
    const { renderer, assets, device } = harness;

    const videoGuid = AssetGuid.random();
    const videoGuidStr = AssetGuid.format(videoGuid);
    const video: VideoAsset = { kind: 'video', url: 'extract-bindgroup-clip.webm' };
    const videoCatalog = assets.catalog(videoGuid, video as never);
    expect(videoCatalog.ok).toBe(true);

    const materialPayload = {
      kind: 'material' as const,
      passes: [FORWARD_PBR_PASS],
      values: {
        baseColor: [1, 1, 1],
        baseColorTexture: { texture: videoGuidStr as never },
      },
    };

    const errorCodes: Array<{ code: string; causeCode?: string }> = [];
    const unsub = renderer.subscribe((event) => {
      if (event.kind !== 'error') return;
      errorCodes.push({
        code: event.error.code,
        ...(event.error.code === 'device-operation-failed'
          ? { causeCode: event.error.detail.cause.code }
          : {}),
      });
    });

    const world = new World();
    const matHandle = world.allocSharedRef('MaterialAsset', materialPayload);
    world
      .spawn(
        { component: Transform, data: transformData(0, 0, 0) },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: { materials: [matHandle] } },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: transformData(0, 0, 5) },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
      )
      .unwrap();

    const drawn = drawPublished(renderer, world);
    expect(drawn.ok).toBe(true);
    await device.queue.onSubmittedWorkDone();
    if (typeof unsub === 'function') unsub();

    // The video-sourced texture field must not trip any WebGPU VALIDATION error
    // (the bind group is well-formed; the field falls back to the default view).
    // The expected, structured `video-upload-unsupported` signal (AC-10, asserted
    // below) is NOT a validation error and is excluded here.
    const validationErrors = errorCodes.filter(
      (event) =>
        event.code !== 'video-upload-unsupported' && event.causeCode !== 'video-upload-unsupported',
    );
    expect(
      validationErrors,
      'a video-sourced texture field must not trip any WebGPU validation error',
    ).toEqual([]);
  });

  // AC-10 PRODUCTION-PATH assertion: with no VideoSourceProvider registered
  // (dawn has no HTMLVideoElement) and no high-perf GPUExternalTexture capability,
  // the REAL per-frame upload path (render-system-record videoTextureView) hits
  // the double-miss and MUST fire the structured VideoUploadUnsupportedError on
  // the engine error channel — NOT silently bind a default view. This exercises
  // the production draw path end-to-end, replacing the prior orphan pure-function
  // test (resolveVideoUpload) that the production render path never called.
  it('AC-10: production draw fires video-upload-unsupported on capability double-miss', async () => {
    const harness = await bootDawn();
    if (harness === null) return;
    const { renderer, assets, device } = harness;

    const videoGuid = AssetGuid.random();
    const videoGuidStr = AssetGuid.format(videoGuid);
    const video: VideoAsset = { kind: 'video', url: 'double-miss-clip.webm' };
    expect(assets.catalog(videoGuid, video as never).ok).toBe(true);

    // Mirror the demo recipe exactly: unlit shader + HANDLE_QUAD. The video
    // upload path (videoTextureView) is reached via the per-submesh user-region
    // bind-group loop, which iterates the shader's textureFieldNames; unlit
    // declares baseColorTexture there. (The earlier standard-PBR + HANDLE_CUBE
    // shape routes through a different builtin-cube pipeline branch that does not
    // hit the user-region video loop — not the production demo path.)
    const materialPayload = {
      kind: 'material' as const,
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax::default-unlit' },
          renderState: { tags: { LightMode: 'Forward' } },
        },
      ],
      values: {
        baseColor: [1, 1, 1],
        baseColorTexture: { texture: videoGuidStr as never },
      },
    };

    const fired: { code: string; causeCode?: string; hint: string }[] = [];
    const unsub = renderer.subscribe((event) => {
      if (event.kind !== 'error') return;
      fired.push({
        code: event.error.code,
        ...(event.error.code === 'device-operation-failed'
          ? { causeCode: event.error.detail.cause.code }
          : {}),
        hint: event.error.hint,
      });
    });

    const world = new World();
    // NB: NO VIDEO_SOURCE_PROVIDER_KEY resource inserted -> the production
    // upload path resolves element===undefined; high-perf path is absent on
    // dawn -> genuine AC-10 double-miss.
    const matHandle = world.allocSharedRef('MaterialAsset', materialPayload);
    world
      .spawn(
        { component: Transform, data: transformData(0, 0, 0) },
        { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
        { component: MeshRenderer, data: { materials: [matHandle] } },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: transformData(0, 0, 5) },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
      )
      .unwrap();

    const drawn = drawPublished(renderer, world);
    expect(drawn.ok).toBe(true);
    await device.queue.onSubmittedWorkDone();
    if (typeof unsub === 'function') unsub();

    const unsupported = fired.filter(
      (event) =>
        event.code === 'video-upload-unsupported' || event.causeCode === 'video-upload-unsupported',
    );
    expect(
      unsupported.length,
      'production videoTextureView must fire video-upload-unsupported on double-miss (AC-10), not silently bind default',
    ).toBeGreaterThan(0);
    // The signal is property-accessible (charter P3): AI users branch on .code
    // and read .hint without string-parsing the human message.
    expect(unsupported[0]?.hint.length ?? 0).toBeGreaterThan(0);
  });
});

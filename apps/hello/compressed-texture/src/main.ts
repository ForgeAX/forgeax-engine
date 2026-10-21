import type { AssetHandle } from '@forgeax/engine-types';
// hello-compressed-texture -- KTX2/Basis block-compression e2e demo (M6 w39).
//
// Loads a 256x256 checkerboard texture through the build-time pack pipeline:
// the .meta.json sidecar sets `compressionMode: 'etc1s'` so the image importer
// produces a Basis KTX2 (.ktx2) at import time. The runtime loader transcode
// arm (M5 w34) transparently transcodes it to the platform-native block format
// on load. A quad mesh carries the texture through the packed PBR material
// pipeline so the pixel-parity smoke (w42) has a non-trivial render target.
//
// Query switch (D-13):
//   `?mode=uncompressed` -- loads an identical checkerboard through the
//   `compressionMode: 'none'` path, producing a raw RGBA8 .bin baseline.
//   This mirrors the production-fallback code path: when the device lacks
//   texture-compression capability, the loader falls back to rgba8unorm.
//
// charter mapping:
//   P1 progressive disclosure -- the default path exercises the full
//     Basis transcode chain with zero sidecar knowledge; the query switch
//     is the second-level disclosure for parity comparison.
//   P4 consistent abstraction -- same MeshFilter+MeshRenderer entry
//     whether loading KTX2 or raw .bin.
//
// Falsifiability (D-13 / §5.4): the uncompressed baseline path renders the
// same checkerboard through a different code path (raw RGBA8 upload vs
// block-compressed upload), serving as the ground truth for w42 pixel parity.

import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { type App } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { decodeImageBytes } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';

import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';


import type { MaterialAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';

import { createPrimitiveMesh } from '@forgeax/engine-geometry';



// GUIDs embedded in the demo's .meta.json sidecars (subAssets[0].guid).
// These are the stable identifiers the pack plugin stamps into pack-index.json
// at build time; the runtime resolves them via assets.load.
const COMPRESSED_GUID = '8a2b5c3d-4e6f-7a8b-9c0d-1e2f3a4b5c6d';
const UNCOMPRESSED_GUID = '9b3c4d5e-6f7a-8b9c-0d1e-2f3a4b5c6d7e';
const PNG_2X2_SOLID_RED_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAAklEQVR4AewaftIAAAARSURBVGP8z8DwnwEImBigAAAfFwIC5VM8ugAAAABJRU5ErkJggg==';

type RuntimeRecoveryPhase = 'baseline' | 'invalid' | 'repaired' | 'cleaned';

interface RuntimeRecoveryState {
  readonly phase: RuntimeRecoveryPhase;
  readonly invalidCode: string | null;
  readonly textureHandle: number | null;
  readonly samplerHandle: number | null;
  readonly textureDimensions: readonly [number, number] | null;
  readonly materialHasTexture: boolean;
  readonly textureAllocations: number;
  readonly samplerAllocations: number;
  readonly releasedResources: number;
  readonly cleanupCalls: number;
  readonly liveSharedRefs: number;
}

interface RuntimeRecoveryApi {
  readonly readState: () => RuntimeRecoveryState;
  readonly injectInvalid: () => Promise<RuntimeRecoveryState>;
  readonly repair: () => Promise<RuntimeRecoveryState>;
  readonly cleanup: () => RuntimeRecoveryState;
}

declare global {
  interface Window {
    __forgeaxRuntimeImageRecovery?: RuntimeRecoveryApi;
  }
}

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) {
  throw new Error('[compressed-texture] missing <canvas id="app"> in index.html');
}

const mode = new URLSearchParams(window.location.search).get('mode') ?? 'compressed';

bootstrap(canvas, mode).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    console.error('[compressed-texture] no usable WebGPU backend:', err);
  } else {
    console.error('[compressed-texture] bootstrap error:', err);
  }
});

async function bootstrap(
  target: HTMLCanvasElement,
  loadMode: string,
): Promise<void> {
  const appRes = await createApp(
    target,
    {},
    {
      ...forgeaxBundlerAdapter(),
      importTransport: createRuntimeAssetImportTransport(runtimeBinding),
    },
  );
  if (!appRes.ok) {
    console.error('[compressed-texture] createApp failed');
    return;
  }
  const app = appRes.value;
  console.warn(
    `[compressed-texture] backend=${app.renderer.inspect().capabilities.backendKind} mode=${loadMode}`,
  );


  const assets = app.assets;
  if (assets === undefined) {
    console.error('[compressed-texture] host asset owner is unavailable');
    return;
  }
  configureRuntimeAssetCatalog(assets, runtimeBinding);
  const world = app.world;
const primitiveQuad = assets.create(createPrimitiveMesh('quad').unwrap()).unwrap();

  app.start().unwrap();

  if (loadMode === 'runtime-recovery') {
    await bootstrapRuntimeRecovery(app, world);
    return;
  }

  // Select the texture GUID based on the query mode.
  const textureGuid = loadMode === 'uncompressed' ? UNCOMPRESSED_GUID : COMPRESSED_GUID;
  const guidRes = AssetGuid.parse(textureGuid);
  if (!guidRes.ok) {
    console.error('[compressed-texture] GUID parse failed:', guidRes.error.code);
    return;
  }

  // Load a managed texture handle, then read its decoded metadata.
  // Basis transcoding runs inside the load path.
  const texLoadRes = await assets.load(guidRes.value, 'texture');
  if (!texLoadRes.ok) {
    console.error(
      '[compressed-texture] texture load failed:',
      texLoadRes.error.code,
      texLoadRes.error.hint,
    );
    return;
  }
  const texAsset = assets.read(texLoadRes.value).unwrap();
  const mipLevelCount = texAsset.mips.kind === 'packed' ? texAsset.mips.levelCount : 1;
  console.warn(
    `[compressed-texture] texture loaded: format=${texAsset.format} ` +
      `size=${texAsset.data.byteLength}B mipLevelCount=${mipLevelCount}`,
  );

  // Bind the loaded texture handle to the material.
  const textureHandle = texLoadRes.value;

  // Default linear-repeat sampler.
  const samplerHandle = assets.create({
    kind: 'sampler',
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'repeat',
    addressModeV: 'repeat',
  }).unwrap();

  // Packed PBR material with the checkerboard texture wired to baseColor.
  const materialHandle = assets.create({
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::default-standard-pbr' },
        renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
      },
    ],
    values: {
      baseColor: [1, 1, 1, 1],
      metallic: 0,
      roughness: 0.8,
      baseColorTexture: textureHandle,
      sampler: samplerHandle,
    },
  }).unwrap();

  // A staggered layout of 4 quads helps the parity smoke (w42) exercise
  // the pipeline against multiple draw calls and UV offsets.
  const quads: [number, number, number, number, number, number][] = [
    [-1.5, 0.8, 0, 0.7, 0.7, 1],
    [1.5, 0.8, 0, 0.5, 0.5, 1],
    [-1.5, -0.8, 0, 0.5, 0.5, 1],
    [1.5, -0.8, 0, 0.7, 0.7, 1],
  ];

  for (const [px, py, pz, sx, sy, sz] of quads) {
    world.spawn(
      {
        component: MeshFilter,
        data: { assetHandle: primitiveQuad },
      },
      {
        component: MeshRenderer,
        data: { materials: [materialHandle] },
      },
      {
        component: Transform,
        data: {
          pos: [px, py, pz], scale: [sx, sy, sz],},
      },
    );
  }

  // Directional light (no Transform -- direction is a field on the component).
  world.spawn({
    component: DirectionalLight,
    data: { castShadow: true,
      direction: [-0.1, -0.6, -1.0],
      color: [1, 1, 1],
      intensity: 3,
    },
  });

  // Camera: perspective from Z=3, looking at origin.
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 3]} },
    {
      component: Camera,
      data: {
        ...perspective({ fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 }),
        clearColor: [0.02, 0.02, 0.05, 1],
      },
    },
  );

  // Print caps info on the page HUD.
  const caps = app.renderer.inspect().capabilities;
  const hud = document.getElementById('texture-hud');
  if (hud) {
    hud.innerHTML =
      `Backend: ${caps.backendKind}  Mode: ${loadMode}<br>` +
      `BC: ${caps.textureCompressionBc ? 'yes' : 'no'}  ` +
      `ETC2: ${caps.textureCompressionEtc2 ? 'yes' : 'no'}  ` +
      `ASTC: ${caps.textureCompressionAstc ? 'yes' : 'no'}`;
  }
}

function pngBytes(): Uint8Array {
  const binary = atob(PNG_2X2_SOLID_RED_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function bootstrapRuntimeRecovery(
  app: App,
  world: World,
): Promise<void> {
const sceneAssets = world.assets;
if (!(sceneAssets instanceof AssetRegistry)) throw new Error('Scene requires its runtime asset owner');

  const materialFor = (
    baseColor: readonly [number, number, number, number],
    textureHandle?: number,
    samplerHandle?: number,
  ): MaterialAsset => ({
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::default-unlit' },
        renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
      },
    ],
    values: {
      baseColor,
      ...(textureHandle === undefined ? {} : { baseColorTexture: textureHandle }),
      ...(samplerHandle === undefined ? {} : { sampler: samplerHandle }),
    } as NonNullable<MaterialAsset['values']>,
  });

  const baselineMaterialHandle = sceneAssets.create(materialFor([0, 0, 0, 1])).unwrap();
  const meshEntity = spawnRuntimeRecoveryScene(world, baselineMaterialHandle);
  const releasedBaseline = sceneAssets.release(baselineMaterialHandle);
  if (!releasedBaseline.ok) {
    throw new Error(`[m27] baseline material release failed: ${releasedBaseline.error.code}`);
  }

  const installMaterial = (material: MaterialAsset): void => {
    const nextHandle = sceneAssets.create(material).unwrap();
    const setResult = world.set(meshEntity, MeshRenderer, { materials: [nextHandle] });
    if (!setResult.ok) {
      sceneAssets.release(nextHandle);
      throw new Error(`[m27] material switch failed: ${setResult.error.code}`);
    }
    const releasedOwner = sceneAssets.release(nextHandle);
    if (!releasedOwner.ok) {
      throw new Error(`[m27] material owner release failed: ${releasedOwner.error.code}`);
    }
  };

  let textureHandle: AssetHandle<'texture'> | undefined;
  let samplerHandle: AssetHandle<'sampler'> | undefined;
  const state: {
    phase: RuntimeRecoveryPhase;
    invalidCode: string | null;
    textureHandle: number | null;
    samplerHandle: number | null;
    textureDimensions: readonly [number, number] | null;
    materialHasTexture: boolean;
    textureAllocations: number;
    samplerAllocations: number;
    releasedResources: number;
    cleanupCalls: number;
    liveSharedRefs: number;
  } = {
    phase: 'baseline',
    invalidCode: null,
    textureHandle: null,
    samplerHandle: null,
    textureDimensions: null,
    materialHasTexture: false,
    textureAllocations: 0,
    samplerAllocations: 0,
    releasedResources: 0,
    cleanupCalls: 0,
    liveSharedRefs: world.sharedRefs._liveCount(),
  };

  const readState = (): RuntimeRecoveryState => ({ ...state });
  const publish = (): void => {
    state.textureHandle = textureHandle === undefined ? null : Number(textureHandle);
    state.samplerHandle = samplerHandle === undefined ? null : Number(samplerHandle);
    state.liveSharedRefs = world.sharedRefs._liveCount();
    const stateElement = document.getElementById('texture-recovery-state');
    if (stateElement) stateElement.textContent = JSON.stringify(readState());
    const hud = document.getElementById('texture-hud');
    if (hud) {
      hud.innerHTML =
        `Backend: ${app.renderer.inspect().capabilities.backendKind}  Mode: runtime-recovery<br>` +
        `Phase: ${state.phase}  Invalid: ${state.invalidCode ?? 'none'}<br>` +
        `Texture: ${state.materialHasTexture ? 'bound' : 'none'}`;
    }
  };

  const injectInvalid = async (): Promise<RuntimeRecoveryState> => {
    if (state.invalidCode !== null) return readState();
    const result = await decodeImageBytes(new Uint8Array([0, 1, 2]), 'image/png', {
      mipmap: false,
    });
    if (result.ok) throw new Error('[m27] invalid PNG unexpectedly decoded');
    state.invalidCode = result.error.code;
    state.phase = 'invalid';
    publish();
    return readState();
  };

  const repair = async (): Promise<RuntimeRecoveryState> => {
    if (textureHandle !== undefined) return readState();
    const result = await decodeImageBytes(pngBytes(), 'image/png', { mipmap: false });
    if (!result.ok) throw new Error(`[m27] valid PNG decode failed: ${result.error.code}`);

    textureHandle = sceneAssets.create(result.value).unwrap();
    samplerHandle = sceneAssets.create({
      kind: 'sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    }).unwrap();
    installMaterial(
      materialFor(
        [1, 1, 1, 1],
        Number(textureHandle),
        Number(samplerHandle),
      ),
    );
    state.phase = 'repaired';
    state.materialHasTexture = true;
    state.textureDimensions = [result.value.shape.extent.width, result.value.shape.extent.height];
    state.textureAllocations += 1;
    state.samplerAllocations += 1;
    publish();
    return readState();
  };

  const cleanup = (): RuntimeRecoveryState => {
    state.cleanupCalls += 1;
    if (state.phase !== 'cleaned') {
      installMaterial(materialFor([0, 0, 0, 1]));
      state.materialHasTexture = false;
      if (textureHandle !== undefined) {
        const released = sceneAssets.release(textureHandle);
        if (!released.ok) throw new Error(`[m27] texture release failed: ${released.error.code}`);
        textureHandle = undefined;
        state.releasedResources += 1;
      }
      if (samplerHandle !== undefined) {
        const released = sceneAssets.release(samplerHandle);
        if (!released.ok) throw new Error(`[m27] sampler release failed: ${released.error.code}`);
        samplerHandle = undefined;
        state.releasedResources += 1;
      }
      state.phase = 'cleaned';
    }
    publish();
    return readState();
  };

  window.__forgeaxRuntimeImageRecovery = {
    readState,
    injectInvalid,
    repair,
    cleanup,
  };
  publish();
}

function spawnRuntimeRecoveryScene(
  world: World,
  materialHandle: AssetHandle<'material'>,
): EntityHandle {
const sceneAssets = world.assets;
if (!(sceneAssets instanceof AssetRegistry)) throw new Error('Scene requires its runtime asset owner');

const primitiveQuad = sceneAssets.create(createPrimitiveMesh('quad').unwrap()).unwrap();

  const meshEntity = world.spawn(
    { component: MeshFilter, data: { assetHandle: primitiveQuad } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
    { component: Transform, data: { pos: [0, 0, 0], scale: [2.6, 1.8, 1] } },
  );
  if (!meshEntity.ok) throw new Error(`[m27] recovery mesh spawn failed: ${meshEntity.error.code}`);
  world.spawn({
    component: DirectionalLight,
    data: { castShadow: true,
      direction: [-0.1, -0.6, -1.0],
      color: [1, 1, 1],
      intensity: 3,
    },
  });
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 3] } },
    {
      component: Camera,
      data: {
        ...perspective({ fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 }),
        clearColor: [0.02, 0.02, 0.05, 1],
      },
    },
  );
  return meshEntity.value;
}

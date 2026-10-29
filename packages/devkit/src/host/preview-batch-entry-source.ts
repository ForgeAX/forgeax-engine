import {
  previewVfxBoundsSource,
  resourcePresentationSource,
} from './resource-presentation-source.js';

/** One retained App/Renderer serves successive ordinary asset preview leases. */
export function previewBatchEntrySource(): string {
  return `import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { runtimeBinding, createRuntimeAssetImportTransport } from 'virtual:forgeax/pack-runtime';
import { createApp } from '@forgeax/engine/app/browser';
import { captureEngineWorkspaceAssetBinding, createEngineWorkspaceAppPreview, createTextureWorkspacePreview, createWorkspaceMeshDisplay, createWorkspaceMaterialPreview, fitToolPreviewCameraToAabb, loadEngineWorkspaceMaterialSlots } from '@forgeax/engine/app';
import { createCatalogSource, createCatalogHotSubscription } from '@forgeax/engine/assets-runtime';
import { THUMBNAIL_PREVIEW, previewThumbnailInput, textureViewSource } from '@forgeax/engine/preview';
import { createPrimitiveMesh } from '@forgeax/engine/geometry';
import { mat4 } from '@forgeax/engine/math';
import { physicsComponentsPlugin } from '@forgeax/engine/physics';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer, Skylight, SkyboxBackground, TONEMAP_REINHARD_EXTENDED, materialSampledTextureBudget } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import { skinningPlugin } from '@forgeax/engine/skinning';
import { ParticleEffectPlayer } from '@forgeax/engine/vfx';
import { createVfxRuntimeHost } from '@forgeax/engine/vfx-render';

const canvas = document.querySelector('canvas');
const size = THUMBNAIL_PREVIEW.size;
canvas.width = canvas.height = size;
const canonicalEnvironmentGuid = null;
const previewCameraEntities = new WeakMap();
const previewCameraTargets = new WeakMap();
const previewVfxHosts = new WeakMap();
const vfx = createVfxRuntimeHost({ camera: { read(world) {
  const entity = previewCameraEntities.get(world);
  if (entity === undefined) return undefined;
  const transform = world.get(entity, Transform).unwrap();
  const camera = world.get(entity, Camera).unwrap();
  const position = new Float32Array(transform.pos);
  const target = previewCameraTargets.get(world) ?? [0, 0, 0];
  return { position, right: new Float32Array([1,0,0]), up: new Float32Array([0,1,0]),
    viewProjection: mat4.multiply(mat4.create(), mat4.perspectiveReverseZ(mat4.create(), camera.fov, camera.aspect, camera.near, camera.far), mat4.lookAt(mat4.create(), position, target, [0,1,0])) };
} } });
function ensureVfxRuntimeHost() { return vfx; }
${previewVfxBoundsSource}
async function prepareAssetRegistry(assets) { (await assets.enumerateCatalog()).unwrap(); }
${resourcePresentationSource}

function value(result) { if (!result.ok) throw result.error; return result.value; }
function failure(cause) {
  return { code: cause?.code ?? 'preview-image-failed', expected: cause?.expected ?? 'A completed asset preview', hint: typeof cause?.hint === 'string' ? cause.hint : cause?.message ?? JSON.stringify(cause) };
}
const state = { ready: false };
globalThis.__forgeaxPreviewBatch = state;
try {
  if (!runtimeBinding) throw new Error('Preview Catalog binding unavailable');
  const adapter = forgeaxBundlerAdapter();
  const app = value(await createApp(canvas, {
    assetCatalog: createCatalogSource({ url: runtimeBinding.catalogUrl, expectedScope: runtimeBinding, subscribe: createCatalogHotSubscription(import.meta.hot) }),
    assetRuntimeBinding: runtimeBinding,
    plugins: [physicsComponentsPlugin(), skinningPlugin()],
    features: [vfx.feature],
    pointerLockAllowed: () => false,
  }, { ...adapter, shaderManifestUrl: new URL(adapter.shaderManifestUrl, location.href).href,
    importTransport: createRuntimeAssetImportTransport(runtimeBinding) }));
  value(app.start()); value(app.pause());
  let active = false;
  let receipt;
  let renderError;
  const remove = app.renderer.subscribe(event => { if (event.kind === 'frame-submitted') receipt = event.receipt; });
  const removeError = app.onError(error => { renderError = error; });
  state.capture = async ({ asset, input }) => {
    if (active) throw new Error('A preview lease is already active');
    active = true;
    const start = performance.now();
    let preview;
    try {
      const rows = value(await app.assets.enumerateCatalog());
      if (previewThumbnailInput(new Map(rows.map(row => [row.guid, row])), asset.guid) !== input) throw new Error('Preview input changed before binding');
      renderError = undefined;
      preview = await createEngineWorkspaceAppPreview({
        app, assets: app.assets, asset,
        target: { targetId: 'batch', sessionId: 'batch', worldId: app.world.identity, width: size, height: size, headed: false },
        applyInput: () => {},
        openResourcePreview: ({ asset }) => prepareResourcePreview(app, asset, canvas, { ...THUMBNAIL_PREVIEW, evidence: false }),
      });
      if (asset.kind === 'scene') {
        for (const { entity } of app.world.query({ with: [Camera] }).unwrap()) {
          app.world.set(entity, Camera, { clearColor: [0,0,0,0], antialias: 0, bloom: 0 }).unwrap();
        }
        for (const { entity } of app.world.query({ with: [SkyboxBackground] }).unwrap()) app.world.removeComponent(entity, SkyboxBackground).unwrap();
      }
      const preparedMs = performance.now() - start;
      let ready = 0;
      let submitted = 0;
      const frames = asset.kind === 'vfx' ? THUMBNAIL_PREVIEW.vfxFrames : 1;
      const deadline = performance.now() + 30_000;
      while (ready < frames) {
        if (performance.now() > deadline) throw new Error('Preview frame readiness deadline exceeded');
        receipt = undefined;
        if (ready === frames - 1) value(app.renderer.requestObservation(['final-display']));
        const stepped = app.stepFrame(ready > 0 && asset.kind === 'vfx' ? 1 / 60 : 0);
        if (!stepped.ok && stepped.error.code === 'app-frame-step-invalid' && stepped.error.detail?.reason === 'credit') {
          await new Promise(done => setTimeout(done, 0)); continue;
        }
        value(stepped);
        // App owns asynchronous frame dispatch; wait for that exact submission.
        while (!receipt && !renderError && performance.now() < deadline) await new Promise(done => setTimeout(done, 0));
        if (renderError) throw renderError;
        if (!receipt) throw new Error('Preview submitted no frame');
        submitted++;
        value(await receipt.completed);
        if (receipt.presentation === 'ready') ready++;
        else await new Promise(done => setTimeout(done, 0));
      }
      const observed = value(await app.renderer.observe(receipt, { include: ['final-display'] }));
      const image = observed.observations?.find(item => item.domain === 'final-display');
      if (!image || image.metadata.width !== size || image.metadata.height !== size) throw new Error('Preview readback extent mismatch');
      const rgba = new Uint8ClampedArray(size * size * 4);
      const bgra = image.metadata.format.startsWith('bgra');
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const src = y * image.metadata.bytesPerRow + x * 4;
        const dst = (y * size + x) * 4;
        rgba[dst] = image.bytes[src + (bgra ? 2 : 0)];
        rgba[dst + 1] = image.bytes[src + 1];
        rgba[dst + 2] = image.bytes[src + (bgra ? 0 : 2)];
        rgba[dst + 3] = image.bytes[src + 3];
      }
      const output = new OffscreenCanvas(size, size);
      output.getContext('2d').putImageData(new ImageData(rgba, size, size), 0, 0);
      const blob = await output.convertToBlob({ type: 'image/png' });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
      const current = value(await app.assets.enumerateCatalog());
      if (previewThumbnailInput(new Map(current.map(row => [row.guid, row])), asset.guid) !== input) throw new Error('Preview input changed during capture');
      return { dataUrl: 'data:image/png;base64,' + btoa(binary), preparedMs, totalMs: performance.now() - start, submitted, ready };
    } catch (cause) {
      if (app.rhiCapture) {
        const captured = await app.rhiCapture.captureFrame({ seed: { maxResourceBytes: 1048576 } });
        console.error('Preview failure capture', captured.ok ? await app.rhiCapture.upload(captured.value) : captured.error);
      }
      throw cause;
    } finally {
      try { await preview?.close(); } finally { active = false; }
    }
  };
  state.dispose = async () => { remove(); removeError(); value(await app.dispose()); };
  state.ready = true;
} catch (cause) { state.error = failure(cause); state.ready = true; }
`;
}

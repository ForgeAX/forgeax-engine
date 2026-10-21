import { createBrowserPlatform } from '@forgeax/engine/platform-browser';
import { createApp } from '@forgeax/engine-app';
import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { createBoxGeometry, packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer, Materials, Skylight, perspective, type FrameReceipt, type RenderFeature, type RenderFrameInput } from '@forgeax/engine-render';
import type { RendererLegacyHostAdapter } from '@forgeax/engine-render/internal/construct-renderer';
import { Transform } from '@forgeax/engine-scene';
import { Skin, skinningPlugin } from '@forgeax/engine-skinning';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import { readbackTexturePixels } from '@forgeax/engine-rhi-debug';
import { ok, resolveMaterialAsset } from '@forgeax/engine-types';
import type { MaterialAsset, TextureAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
// @ts-expect-error browser-safe evidence module is intentionally JavaScript.
import { createLinearHdrRoiEvidence, fnv1a } from '../evidence/evaluator-core.mjs';
import caseInput from '../evidence/case-input.json';
import caseManifest from '../evidence/case-manifest.json';
import referenceArtifact from '../evidence/reference-linear-hdr.json';
// @ts-expect-error browser-safe evidence module is intentionally JavaScript.
import { captureGpuErrors, captureWorldErrors, requireFrameMaterials } from '../evidence/phase-executor.mjs';
import { physicalMaterialChild, physicalMaterialRoots, withPhysicalMaterialModule } from './material-contract';
// @ts-expect-error browser-safe evidence module is intentionally JavaScript.
import { createBrowserCasePlans, evaluateBrowserRecords } from '../evidence/browser-executor.mjs';
// @ts-expect-error browser-safe evidence module is intentionally JavaScript.
import { describeMaterialCase } from '../evidence/material-case-builder.mjs';
// @ts-expect-error browser-safe evidence module is intentionally JavaScript.
import { createBrowserPhaseController } from '../evidence/browser-phase-controller.mjs';
// @ts-expect-error browser-safe evidence module is intentionally JavaScript.
import { createAdditiveCoatMutantPublication } from '../evidence/additive-coat-mutant.mjs';
import { AssetRegistry } from '@forgeax/engine/assets-runtime';


const WIDTH = caseInput.render.width;
if (new URLSearchParams(location.search).has('webgl2')) {
  Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
}
declare const __FORGEAX_PHYSICAL_MATERIAL_EXACT_HEAD__: string;

// Each physical root is a cooked MaterialAsset publication.  The shader
// source stays the engine-owned Standard template; these ids are the Pack /
// Catalog identities for the exact root contracts used by this witness.
const PHYSICAL_MATERIAL_MODULES = {
  scalar: 'physical-material::standard-clearcoat',
  factor: 'physical-material::standard-clearcoat-factor-r',
  roughness: 'physical-material::standard-clearcoat-roughness-g',
  normal: 'physical-material::standard-clearcoat-normal-rg',
  skinFactor: 'physical-material::pbr-skin-clearcoat-factor-r',
  skinRoughness: 'physical-material::pbr-skin-clearcoat-roughness-g',
  skinNormal: 'physical-material::pbr-skin-clearcoat-normal-rg',
  full: 'physical-material::standard-full-physical',
  skinFull: 'physical-material::pbr-skin-full-physical',
} as const;
const PHYSICAL_MATERIAL_GUIDS = {
  full: '8a5a0001-0000-4000-8000-000000000008',
} as const;
const PHYSICAL_MATERIAL_MUTANT = 'physical-material::standard-clearcoat-mutant';

const mutantMaterialPrewarmFeature = {
  identity: 'physical-material::mutant-prewarm',
  requiredMaterialShaders: [PHYSICAL_MATERIAL_MUTANT],
  extract: () => ok(undefined),
  plan: () => ok({ work: [] }),
} satisfies RenderFeature<undefined>;

// The paired energy witness uses a fixed grazing pose so the clearcoat
// Fresnel attenuation is measurable above the frozen 0.05 L1 threshold. The
// regular case grid remains at its authored pose; this pose is restored before
// the IBL phase is captured.
const PAIR_WITNESS_QUAT = [0, 0.6755902, 0, 0.7372773] as const;

function physicalMaterialModule(item: (typeof caseManifest.cases)[number]): string {
  const skin = item.geometry === 'skinned';
  switch (item.semantic) {
    case 'factor-r':
      return skin ? PHYSICAL_MATERIAL_MODULES.skinFactor : PHYSICAL_MATERIAL_MODULES.factor;
    case 'roughness-g':
      return skin ? PHYSICAL_MATERIAL_MODULES.skinRoughness : PHYSICAL_MATERIAL_MODULES.roughness;
    case 'normal-rg':
    case 'coat-normal-isolation':
      return skin ? PHYSICAL_MATERIAL_MODULES.skinNormal : PHYSICAL_MATERIAL_MODULES.normal;
    default:
      return skin ? PHYSICAL_MATERIAL_MODULES.skinNormal : PHYSICAL_MATERIAL_MODULES.normal;
  }
}

let loadedFullPhysicalMaterial: MaterialAsset | undefined;

function loadedMaterialReceipt(): unknown {
  if (loadedFullPhysicalMaterial === undefined) return undefined;
  return {
    values: loadedFullPhysicalMaterial.values,
    parameterNames: loadedFullPhysicalMaterial.parameters?.map((parameter) => parameter.name),
    passModules: loadedFullPhysicalMaterial.passes?.map((pass) => ({
      name: pass.name,
      module: pass.program.module,
    })),
  };
}

function makeTexture(world: World, channel: string) {
const sceneAssets = world.assets;
if (!(sceneAssets instanceof AssetRegistry)) throw new Error('Scene requires its runtime asset owner');

  const data = new Uint8Array(4 * 4 * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = channel === 'R' ? 255 : channel === 'RG' ? 128 : 0;
    data[index + 1] = channel === 'G' ? 255 : channel === 'RG' ? 128 : 0;
    data[index + 2] = channel === 'RG' ? 255 : 0;
    data[index + 3] = 255;
  }
  const payload: TextureAsset = {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
    format: 'rgba8unorm',
    data,
    colorSpace: 'linear',
    mips: { kind: 'none' },
  };
  return sceneAssets.create(payload).unwrap();
}

function makeMaterial(world: World, item: (typeof caseManifest.cases)[number]) {
  const facts = describeMaterialCase(item, caseInput);
  const standardMaterial = Materials.standard({ staticSwitches: { clearcoat: true },
    baseColor: Materials.srgb(facts.baseColor as [number, number, number, number]),
    metallic: facts.metallic,
    roughness: facts.roughness,
    clearcoat: facts.clearcoat,
    clearcoatRoughness: facts.clearcoatRoughness,
    clearcoatNormalScale: facts.clearcoatNormalScale,
    [facts.textureField]: makeTexture(world, facts.channel),
  });
  const module = physicalMaterialModule(item);
  return physicalMaterialChild(standardMaterial, module);
}

function makePairMaterial(clearcoat = 0, useLoadedRoot = true) {
  const material = Materials.standard({
    baseColor: [1, 1, 1, 1],
    metallic: 0,
    roughness: 0.42,
    ior: 1.5,
    transmission: 0,
    thickness: 0,
    clearcoat,
    clearcoatRoughness: 0.18,
  });
  return useLoadedRoot
    ? physicalMaterialChild(material, PHYSICAL_MATERIAL_MODULES.full)
    : withPhysicalMaterialModule(material, PHYSICAL_MATERIAL_MODULES.scalar);
}

declare global {
  var __forgeaxPhysicalMaterialEvidence:
    | {
        ready: boolean;
        browserPath: boolean;
        webgpu: boolean;
        stage: string;
        frameCount: number;
        caseManifest: { url: string; serializedHash: string; parsedHash: string; equal: boolean };
        caseRecords: readonly unknown[];
        semanticEvaluation: unknown;
        pairedSentinelEvaluation: unknown;
        renderDiagnostics: {
          readback: { status: string; frameId?: number; byteLength?: number; nonZeroBytes?: number };
          bindingReceipt?: readonly unknown[];
          rendererState?: string;
          rendererFrameId?: number;
          maxSampledTexturesPerShaderStage?: number;
        };
        materialLoad?: {
          status: string;
          guid?: string;
          route?: string;
          shader?: string;
          parameterNames?: readonly string[];
          values?: Record<string, unknown>;
          passModules?: readonly unknown[];
        };
        rendererErrors: readonly unknown[];
        errors: string[];
      }
    | undefined;
}

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('physical-material: missing canvas');
canvas.width = caseInput.render.width;
canvas.height = caseInput.render.height;
globalThis.__forgeaxPhysicalMaterialEvidence = {
  ready: false,
  browserPath: true,
  webgpu: typeof navigator !== 'undefined' && navigator.gpu !== undefined,
  stage: 'created',
  frameCount: 0,
  caseManifest: { url: '/evidence/case-manifest.json', serializedHash: '', parsedHash: '', equal: false },
  caseRecords: [],
  semanticEvaluation: { verdict: 'blocked' },
  pairedSentinelEvaluation: { verdict: 'blocked' },
  renderDiagnostics: { readback: { status: 'pending' } },
  materialLoad: { status: 'pending' },
  rendererErrors: [],
  errors: [],
};

if (new URLSearchParams(location.search).has('diagnostics')) {
  const panel = document.createElement('pre');
  panel.style.cssText =
    'position:fixed;inset:0;z-index:9999;overflow:auto;background:#080808;color:#b5ffb5;padding:12px;font:12px monospace;white-space:pre-wrap;overflow-wrap:anywhere';
  document.body.append(panel);
  setInterval(() => {
    const evidence = globalThis.__forgeaxPhysicalMaterialEvidence;
    const lastError = evidence?.errors.at(-1) ?? '';
    panel.textContent = JSON.stringify({
      webgpu: evidence?.webgpu,
      ready: evidence?.ready,
      stage: evidence?.stage,
      elapsedMs: Math.round(performance.now()),
      resourcesLoaded: performance.getEntriesByType('resource').length,
      frameCount: evidence?.frameCount,
      gpuCause: /0:\d+: S\d+: [^\\"]+/.exec(lastError)?.[0] ?? null,
      materialLoad: evidence?.materialLoad?.status,
      readback: evidence?.renderDiagnostics.readback,
      rendererErrorCount: evidence?.rendererErrors.length,
      errors: lastError.length > 320 ? `${lastError.slice(0, 320)}...` : lastError,
    }, null, 2);
  }, 500);
}

async function bootstrap(canvas: HTMLCanvasElement): Promise<void> {
  const evidence = globalThis.__forgeaxPhysicalMaterialEvidence;
  if (evidence) captureWorldErrors(evidence.errors);
  if (evidence) evidence.stage = 'fetch-manifest';
  const serializedManifest = JSON.stringify(caseManifest);
  const manifestResponse = await fetch('/evidence/case-manifest.json');
  if (!manifestResponse.ok) throw new Error(`case manifest fetch failed: ${manifestResponse.status}`);
  const fetchedManifest = JSON.parse(await manifestResponse.text()) as typeof caseManifest;
  if (evidence !== undefined) {
    evidence.caseManifest = {
      url: '/evidence/case-manifest.json',
      serializedHash: fnv1a(serializedManifest),
      parsedHash: fnv1a(JSON.stringify(fetchedManifest)),
      equal: serializedManifest === JSON.stringify(fetchedManifest),
    };
  }
  if (evidence) evidence.stage = 'construct-renderer';
  const constructed = await constructRuntimeRendererHost(canvas, {}, {
    ...forgeaxBundlerAdapter(),
    importTransport: createRuntimeAssetImportTransport(runtimeBinding),
  });
  if (!constructed.ok) throw new Error(`renderer construction failed: ${String(constructed.error)}`);
  if (evidence) evidence.stage = 'load-material';
  const { renderer, assets, debugDrawHost } = constructed.value;
  const nativeDevice = renderer.nativeDevice();
  if (nativeDevice.ok && evidence) captureGpuErrors(nativeDevice.value, evidence.errors);
  configureRuntimeAssetCatalog(assets, runtimeBinding);
  const materialGuid = assets.parseGuid(PHYSICAL_MATERIAL_GUIDS.full);
  const loadedMaterial = await assets.load(materialGuid, 'material');
  if (!loadedMaterial.ok) {
    evidence?.errors.push(`material-load-failed:${loadedMaterial.error.code}`);
    if (evidence) evidence.materialLoad = { status: 'failed', guid: PHYSICAL_MATERIAL_GUIDS.full, route: 'assets.loadByGuid' };
    throw new Error(
      `full physical material load failed: ${loadedMaterial.error.code} expected=${loadedMaterial.error.expected} hint=${loadedMaterial.error.hint}`,
    );
  }
  loadedFullPhysicalMaterial = assets.read(loadedMaterial.value).unwrap();
  for (const root of physicalMaterialRoots) {
    if (root.guid === PHYSICAL_MATERIAL_GUIDS.full) continue;
    const loaded = await assets.load(assets.parseGuid(root.guid), 'material');
    if (!loaded.ok) throw new Error(`physical root ${root.guid} load failed: ${loaded.error.code}`);
  }
  if (evidence) {
    const loadedShader = loadedFullPhysicalMaterial.passes?.[0]?.program.module;
    const loadedParameterNames = loadedFullPhysicalMaterial.parameters?.map((parameter) => parameter.name);
    evidence.materialLoad = {
      status: 'ok',
      guid: PHYSICAL_MATERIAL_GUIDS.full,
      route: 'assets.loadByGuid',
      ...(loadedShader === undefined ? {} : { shader: loadedShader }),
      ...(loadedParameterNames === undefined ? {} : { parameterNames: loadedParameterNames }),
      ...(loadedFullPhysicalMaterial.values === undefined ? {} : { values: loadedFullPhysicalMaterial.values }),
      ...(loadedFullPhysicalMaterial.passes === undefined
        ? {}
        : {
            passModules: loadedFullPhysicalMaterial.passes.map((pass) => ({
              name: pass.name,
              module: pass.program.module,
            })),
          }),
    };
  }
  if (evidence) evidence.stage = 'prepare-scene';
  const world = new World({ assets: assets });
const sceneAssets = world.assets;
if (!(sceneAssets instanceof AssetRegistry)) throw new Error('Scene requires its runtime asset owner');

  const meshResult = createBoxGeometry(1.2, 1.2, 1.2);
  if (!meshResult.ok) throw new Error(`box geometry failed: ${meshResult.error.code}`);
  const mesh = sceneAssets.create(meshResult.value).unwrap();
  const skinnedAttributes = {
    position: new Float32Array([-0.55, -0.55, 0, 0.55, -0.55, 0, 0, 0.55, 0]),
    normal: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uv: new Float32Array([0, 0, 1, 0, 0.5, 1]),
    tangent: new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]),
    skinIndex: new Uint16Array(12),
    skinWeight: new Float32Array([0.75, 0.25, 0, 0, 0.35, 0.65, 0, 0, 0.6, 0.4, 0, 0]),
  };
  const skinnedPacked = packInterleavedVertexAttributes(skinnedAttributes, 3);
  if (!skinnedPacked.ok) throw new Error(`skinned geometry packing failed: ${skinnedPacked.error.code}`);
  const skinnedMesh = sceneAssets.create({
    kind: 'mesh',
    vertices: skinnedPacked.value.vertices,
    indices: new Uint16Array([0, 1, 2]),
    attributes: skinnedAttributes,
    aabb: new Float32Array([-0.55, -0.55, 0, 0.55, 0.55, 0]),
    materialSlots: [{ slotName: 'Default' }],
    submeshes: [{ indexOffset: 0, indexCount: 3, vertexCount: 3, materialSlot: 0, topology: 'triangle-list' }],
  }).unwrap();
  const identity = new Float32Array(16);
  identity[0] = 1;
  identity[5] = 1;
  identity[10] = 1;
  identity[15] = 1;
  const skeleton = sceneAssets.create({
    kind: 'skeleton',
    inverseBindMatrices: new Float32Array([...identity, ...identity]),
    jointCount: 2,
  }).unwrap();
  const directCases = caseManifest.cases.filter((item) => item.lighting === 'direct');
  const entities = new Map<string, EntityHandle>();
  for (const item of directCases) {
    const position = caseInput.geometry.casePositions[item.caseId as keyof typeof caseInput.geometry.casePositions] as [number, number];
    const [x, y] = position;
    const material = makeMaterial(world, item);
    const materialHandle = sceneAssets.create(material).unwrap();
    const entity = world.spawn(
      { component: Transform, data: { pos: [x, y, 0] } },
      { component: MeshFilter, data: { assetHandle: item.geometry === 'skinned' ? skinnedMesh : mesh } },
      { component: MeshRenderer, data: { materials: [materialHandle] } },
      ...(item.geometry === 'skinned'
        ? [{
            component: Skin,
            data: {
              skeleton,
              joints: new Uint32Array([
                world.spawn({ component: Transform, data: { pos: [x + 0.25, y + 0.1, 0], quat: [0, 0, 0.258819, 0.965926], scale: [1, 1.1, 1] } }).unwrap(),
                world.spawn({ component: Transform, data: { pos: [x + 0.48, y - 0.08, 0], quat: [0, 0, -0.130526, 0.991445], scale: [0.9, 1.2, 1] } }).unwrap(),
              ]),
            },
          }]
        : []),
    ).unwrap();
    entities.set(item.caseId, entity);
  }
  world.spawn({
    component: Transform,
    data: { pos: [0, 0, 7] },
  }, {
    component: Camera,
    data: { ...perspective({ fov: Math.PI / 4, aspect: caseInput.render.width / caseInput.render.height }), clearColor: caseInput.render.clearColor },
  }).unwrap();
  const light = world.spawn({ component: DirectionalLight, data: caseInput.directLight }).unwrap();
  if (evidence) evidence.stage = 'create-app';
  const platform = createBrowserPlatform(canvas).unwrap();
  const appResult = await createApp({ platform,  renderer, world, plugins: [{ name: 'browser-platform', apply(ctx) { ctx.effect(() => () => platform.dispose()); } }, skinningPlugin()] });
  if (!appResult.ok) throw new Error(`createApp failed: ${appResult.error.code}`);
  if (evidence) evidence.stage = 'create-mutant';
  const app = appResult.value;
  const observationHost = debugDrawHost as unknown as RendererLegacyHostAdapter;
  const sampledTextureLimit = debugDrawHost.device.limits.maxSampledTexturesPerShaderStage;
  renderer.subscribe((event) => {
    if (event.kind === 'error' && evidence) {
      evidence.errors.push(`renderer:${event.error.code}`);
      evidence.rendererErrors = [...evidence.rendererErrors, {
        code: event.error.code,
        expected: event.error.expected,
        hint: event.error.hint,
        ...('detail' in event.error ? { detail: event.error.detail } : {}),
      }];
    }
  });
  let mutantRenderer: typeof renderer | undefined;
  let mutantObservationHost: (RendererLegacyHostAdapter & typeof debugDrawHost) | undefined;
  let mutantFrameRequest: RenderFrameInput | undefined;
  let mutantReceipt: { identifier: string; sourceClosureDigest: string; productManifestDigest: string; productClosure: false } | undefined;
  const mutantCanvas = document.createElement('canvas');
  mutantCanvas.width = WIDTH;
  mutantCanvas.height = caseInput.render.height;
  mutantCanvas.hidden = true;
  if (!new URLSearchParams(location.search).has('primaryOnly')) document.body.appendChild(mutantCanvas);
  if (!new URLSearchParams(location.search).has('primaryOnly')) {
    try {
    const manifestResponse = await fetch('/shaders/manifest.json');
    if (!manifestResponse.ok) throw new Error(`shader manifest fetch failed: ${manifestResponse.status}`);
    const productPublication = await manifestResponse.json();
    const mutantPublication = await createAdditiveCoatMutantPublication(
      productPublication,
      PHYSICAL_MATERIAL_MODULES.scalar,
      PHYSICAL_MATERIAL_MUTANT,
    );
    const productManifestBytes = JSON.stringify(productPublication);
    const mutantManifestBytes = JSON.stringify(mutantPublication);
    mutantReceipt = {
      identifier: PHYSICAL_MATERIAL_MUTANT,
      sourceClosureDigest: fnv1a(mutantManifestBytes),
      productManifestDigest: fnv1a(productManifestBytes),
      productClosure: false,
    };
    const mutantManifestUrl = `data:application/json,${encodeURIComponent(mutantManifestBytes)}`;
    if (evidence) evidence.stage = 'construct-mutant';
    const constructedMutant = await constructRuntimeRendererHost(mutantCanvas, {
      features: [mutantMaterialPrewarmFeature],
    }, {
      ...forgeaxBundlerAdapter(),
      shaderManifestUrl: mutantManifestUrl,
      importTransport: createRuntimeAssetImportTransport(runtimeBinding),
    });
    if (!constructedMutant.ok) throw new Error(`mutant renderer construction failed: ${String(constructedMutant.error)}`);
    const mutantAssets = constructedMutant.value.assets;
    configureRuntimeAssetCatalog(mutantAssets, runtimeBinding);
    for (const root of physicalMaterialRoots) {
      const loaded = await mutantAssets.load(mutantAssets.parseGuid(root.guid), 'material');
      if (!loaded.ok) throw new Error(`mutant root ${root.guid} load failed: ${loaded.error.code}`);
    }
    mutantRenderer = constructedMutant.value.renderer;
    const mutantNativeDevice = mutantRenderer.nativeDevice();
    if (mutantNativeDevice.ok && evidence) captureGpuErrors(mutantNativeDevice.value, evidence.errors);
    if (evidence) evidence.stage = 'prepare-mutant';
    mutantObservationHost = constructedMutant.value.debugDrawHost as unknown as RendererLegacyHostAdapter & typeof debugDrawHost;
    mutantRenderer.subscribe((event) => {
      if (event.kind === 'error') evidence?.errors.push(`mutant-renderer:${event.error.code}`);
    });
    const mutantAttachment = mutantRenderer.attach(world);
    if (!mutantAttachment.ok) throw new Error(`mutant renderer attach failed: ${mutantAttachment.error.code}`);
    mutantFrameRequest = {
      leases: [mutantAttachment.value],
      camera: { lease: mutantAttachment.value },
      environment: { lease: mutantAttachment.value },
    };
    } catch (error: unknown) {
      evidence?.errors.push(error instanceof Error ? `mutant-setup:${error.message}` : `mutant-setup:${String(error)}`);
    }
  }
  const plans = createBrowserCasePlans(caseManifest, referenceArtifact);
  let captureInFlight = false;
  let captureReceipt: FrameReceipt | undefined;
  let readyCompletedFrames = 0;
  const expectedMaterials = () => [...entities.values()].map((entityKey) => ({
    entityKey, handle: world.get(entityKey, MeshRenderer).unwrap().materials[0],
  }));
  let hdr: import('@forgeax/engine-types').AssetHandle<'equirect'> | undefined;
  const guid = assets.parseGuid(caseInput.ibl.sourceGuid);
  const loaded = await assets.load(guid, 'equirect');
  if (loaded.ok) hdr = loaded.value;
  else evidence?.errors.push(`ibl-load-failed:${loaded.error.code}`);
  const hdrSource = hdr === undefined ? undefined : assets.read(hdr).unwrap();
  const captureFrame = async ({ phase, frameId }: { phase: 'direct' | 'ibl'; frameId: number }) => {
    const receipt = captureReceipt;
    if (receipt === undefined || receipt.frameId !== frameId) throw new Error('missing current capture receipt');
    if (evidence?.errors.length) throw new Error(`Runtime errors: ${evidence.errors.join(', ')}`);
    const frameMaterials = requireFrameMaterials(receipt, renderer.inspect(), world.identity, expectedMaterials());
    const observed = await observationHost.observeCurrentFrame({
      semantic: 'linear-hdr',
      readback: async (lease) => ok(await readbackTexturePixels(debugDrawHost.device, lease.descriptor.texture, lease.descriptor.size.width, lease.descriptor.size.height, { bytesPerTexel: 8 })),
    });
    if (!observed.ok) throw new Error(`readback failed: ${observed.error.code}`);
    if (observed.value.metadata.frameId + 1 !== receipt.frameId) throw new Error('linear HDR observation frame mismatch');
    if (observed.value.metadata.format !== 'rgba16float') throw new Error('linear HDR readback contract failed');
    const observedBackend = observed.value.metadata.backendId === 'wgpu-webgl2' ? 'webgl2' : 'webgpu';
    const nonZeroBytes = observed.value.bytes.reduce((count, byte) => count + (byte === 0 ? 0 : 1), 0);
    if (evidence) evidence.renderDiagnostics.readback = { status: 'ok', frameId: observed.value.metadata.frameId, byteLength: observed.value.bytes.byteLength, nonZeroBytes };
    const cases = phase === 'direct' ? directCases : caseManifest.cases.filter((item) => item.lighting === 'ibl');
    const records = cases.map((item) => {
      const index = caseManifest.cases.indexOf(item);
      const roi = plans.get(item.caseId)?.roi ?? { x: (index % 4) * 50, y: Math.floor(index / 4) * 75, width: 50, height: 75 };
      const projected = createLinearHdrRoiEvidence(observed.value.bytes, WIDTH, roi, item.caseId, caseInput.render.clearColor);
      return {
        caseId: item.caseId,
        backend: observedBackend,
        device: `browser-${observedBackend}`,
        exactHead: __FORGEAX_PHYSICAL_MATERIAL_EXACT_HEAD__,
        lighting: item.lighting,
        geometry: item.geometry,
        authoredSlot: item.authoredSlot,
        channel: item.channel,
        material: { kind: 'MaterialAsset', shader: physicalMaterialModule(item) },
        sourceClosure: item.lighting === 'ibl' ? { hdrReceipt: hdr === undefined ? undefined : { sourceGuid: caseInput.ibl.sourceGuid, sourceRevision: caseInput.ibl.sourceRevision, load: 'assets.load', format: hdrSource?.format, width: hdrSource?.width, height: hdrSource?.height } } : undefined,
        submittedFrame: { start: Math.max(0, frameId - 29), end: frameId, count: 30 },
        readback: { status: 'ok', format: observed.value.metadata.format, colorSpace: 'linear-hdr', byteLength: projected.rawBytes.byteLength, frameId: observed.value.metadata.frameId, pipelineId: observed.value.metadata.pipelineId, backendId: observed.value.metadata.backendId },
        roi,
        reference: plans.get(item.caseId),
        observed: projected.observed,
        objectMask: projected.objectMask,
        rawHash: projected.rawHash,
      };
    });
    const finiteRecords = records.every((record) => (record.observed.linearHdrMean as number[]).every((value: number) => Number.isFinite(value)));
    const pairRoi = plans.get('direct-rigid-factor-r')?.roi ?? { x: 0, y: 0, width: 50, height: 75 };
    const pairProjection = createLinearHdrRoiEvidence(observed.value.bytes, WIDTH, pairRoi, 'paired', caseInput.render.clearColor);
    const inspection = renderer.inspect();
    if (evidence) {
      evidence.renderDiagnostics.bindingReceipt = inspection.meshMaterialBindings;
      evidence.renderDiagnostics.rendererState = inspection.state;
      evidence.renderDiagnostics.rendererFrameId = inspection.frame.frameId;
      evidence.renderDiagnostics.maxSampledTexturesPerShaderStage = sampledTextureLimit;
    }
    return {
      records,
      finite: finiteRecords,
      observation: {
        observed: pairProjection.observed.linearHdrMean,
        objectMask: pairProjection.objectMask,
        rawHash: pairProjection.rawHash,
        frameId: observed.value.metadata.frameId,
        pipelineId: observed.value.metadata.pipelineId,
        backendId: observed.value.metadata.backendId,
        bindingReceipt: inspection.meshMaterialBindings,
        frameMaterials,
        rendererState: inspection.state,
        rendererFrameId: inspection.frame.frameId,
        sampledTextureLimit,
        standardLighting: inspection.standardLighting,
        iblBinding: inspection.iblBinding,
        rendererError: inspection.output.error,
        loadedMaterial: loadedMaterialReceipt(),
      },
    };
  };
  const pairEntity = entities.get('direct-rigid-factor-r');
  const assignPairMaterial = (material: ReturnType<typeof makePairMaterial>): void => {
    if (pairEntity === undefined) return;
    world.set(pairEntity, MeshRenderer, { materials: [sceneAssets.create(material).unwrap()] }).unwrap();
  };
  const captureMutantObservation = async () => {
    if (mutantRenderer === undefined || mutantObservationHost === undefined || mutantFrameRequest === undefined) return undefined;
    const pairRoi = plans.get('direct-rigid-factor-r')?.roi ?? { x: 0, y: 0, width: 50, height: 75 };
    const paused = app.pause();
    if (!paused.ok) {
      evidence?.errors.push(`mutant-pause:${paused.error.code}`);
      return undefined;
    }
    const wasPaused = true;
    const productMaterial = makePairMaterial(1, false);
    assignPairMaterial(withPhysicalMaterialModule(productMaterial, PHYSICAL_MATERIAL_MUTANT));
    try {
      const drawn = mutantRenderer.draw(mutantFrameRequest);
      if (!drawn.ok) {
        evidence?.errors.push(`mutant-draw:${drawn.error.code}`);
        return undefined;
      }
      const completed = await drawn.value.completed;
      if (!completed.ok) {
        evidence?.errors.push(`mutant-completion:${completed.error.code}`);
        return undefined;
      }
      requireFrameMaterials(drawn.value, mutantRenderer.inspect(), world.identity, expectedMaterials());
      const observed = await mutantObservationHost.observeCurrentFrame({
        semantic: 'linear-hdr',
        readback: async (lease) => ok(await readbackTexturePixels(mutantObservationHost.device, lease.descriptor.texture, lease.descriptor.size.width, lease.descriptor.size.height, { bytesPerTexel: 8 })),
      });
      if (!observed.ok || observed.value.metadata.format !== 'rgba16float') {
        evidence?.errors.push(`mutant-readback:${observed.ok ? 'format-invalid' : observed.error.code}`);
        return undefined;
      }
      // Render's receipt counter is one-based while the frame-graph observation
      // counter is the zero-based record-frame number.  This relation is the
      // stable same-submit identity exposed by the two public seams.
      if (observed.value.metadata.frameId + 1 !== drawn.value.frameId) {
        evidence?.errors.push(`mutant-observation-stale:${observed.value.metadata.frameId}:${drawn.value.frameId}`);
        return undefined;
      }
      const projected = createLinearHdrRoiEvidence(observed.value.bytes, WIDTH, pairRoi, 'mutant', caseInput.render.clearColor);
      if ((projected.objectMask?.coverage ?? 0) <= 0.01) {
        evidence?.errors.push('mutant-observation-not-rendered');
        return undefined;
      }
      return {
        observed: projected.observed.linearHdrMean,
        objectMask: projected.objectMask,
        rawHash: projected.rawHash,
        frameId: observed.value.metadata.frameId,
        pipelineId: observed.value.metadata.pipelineId,
        backendId: observed.value.metadata.backendId,
      };
    } finally {
      assignPairMaterial(productMaterial);
      if (wasPaused) {
        const resumed = app.resume();
        if (!resumed.ok) evidence?.errors.push(`mutant-resume:${resumed.error.code}`);
      }
    }
  };
  let defaultSurfaceContract: string | undefined;
  const controller = createBrowserPhaseController({
    evidence,
    caseManifest,
    referenceArtifact,
    plans,
    captureFrame,
    mutantReceipt,
    captureMutant: captureMutantObservation,
    preparePairStage: async (stage: string) => {
      if (stage === 'base') {
        world.set(light, DirectionalLight, { ...caseInput.directLight, intensity: 2 }).unwrap();
        if (pairEntity !== undefined) {
          world.set(pairEntity, Transform, {
            pos: [-2.7, 0.9, 0],
            quat: PAIR_WITNESS_QUAT,
            scale: [1, 1, 1],
          }).unwrap();
        }
        assignPairMaterial(makePairMaterial(0));
      } else if (stage === 'factor-zero') {
        assignPairMaterial(makePairMaterial(0));
      } else if (stage === 'default' || stage === 'custom') {
        const material = makePairMaterial();
        const child = { ...material, values: { ...material.values } };
        if (loadedFullPhysicalMaterial === undefined) throw new Error('full physical root is unavailable');
        const resolved = resolveMaterialAsset('pair', {
          pair: child, [PHYSICAL_MATERIAL_GUIDS.full]: loadedFullPhysicalMaterial,
        }).unwrap().asset;
        if (!resolved.parameters?.length) throw new Error('full physical parameter layout is missing');
        const contract = JSON.stringify({ parameters: resolved.parameters, values: resolved.values, passes: resolved.passes });
        if (stage === 'default') defaultSurfaceContract = contract;
        else if (contract !== defaultSurfaceContract) throw new Error('default/custom resolved material contract differs');
        assignPairMaterial(child);
      } else if (stage === 'additive-base') {
        world.set(light, DirectionalLight, { ...caseInput.directLight, intensity: 128, castShadow: false }).unwrap();
        assignPairMaterial(makePairMaterial(1, false));
      }
    },
    prepareIbl: async () => {
      if (hdr === undefined) {
        evidence?.errors.push('ibl-guid-load-failed');
        return;
      }
      world.despawn(light).unwrap();
      world.spawn({ component: Skylight, data: { equirect: hdr, intensity: 1 } }).unwrap();
      for (const item of caseManifest.cases.filter((candidate) => candidate.lighting === 'ibl')) {
        const entity = entities.get(item.caseId.replace('ibl-', 'direct-'));
        if (entity !== undefined) {
          if (entity === pairEntity) {
            world.set(entity, Transform, {
              pos: [-2.7, 0.9, 0],
              quat: [0, 0, 0, 1],
              scale: [1, 1, 1],
            }).unwrap();
          }
          world.set(entity, MeshRenderer, { materials: [sceneAssets.create(makeMaterial(world, item)).unwrap()] }).unwrap();
        }
      }
    },
    evaluateRecords: evaluateBrowserRecords,
  });
  renderer.subscribe((event) => {
    if (event.kind !== 'frame-submitted' || captureInFlight) return;
    captureInFlight = true;
    captureReceipt = event.receipt;
    void (async () => {
      const completed = await event.receipt.completed;
      if (!completed.ok) throw completed.error;
      if (event.receipt.presentation !== 'ready') return;
      readyCompletedFrames += 1;
      if (evidence) evidence.frameCount = readyCompletedFrames;
      if (readyCompletedFrames < 60) return;
      await controller.onFrame(event.frameId);
    })().catch((error: unknown) => {
      evidence?.errors.push(error instanceof Error ? error.message : String(error));
    }).finally(() => { captureInFlight = false; });
  });
  if (evidence) evidence.stage = 'start-app';
  const started = app.start();
  if (!started.ok) throw new Error(`app.start failed: ${started.error.code}`);
}

bootstrap(canvas).catch((error: unknown) => {
  const evidence = globalThis.__forgeaxPhysicalMaterialEvidence;
  evidence?.errors.push(error instanceof Error ? error.message : String(error));
  if (error instanceof EngineEnvironmentError) console.error('[physical-material] environment', error);
  else console.error('[physical-material] bootstrap error', error);
});

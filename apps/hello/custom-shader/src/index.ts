// apps/hello/custom-shader/src/index.ts
//
// The demo consumes one authored MaterialAsset pack. The shader manifest and
// cooked material records are produced by the Vite build; the app only loads
// them through the runtime catalog and readiness validator.

import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { World } from '@forgeax/engine-ecs';
import { Name, Transform } from '@forgeax/engine-scene';

import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import type { RendererLegacyHostAdapter } from '@forgeax/engine-render/internal/construct-renderer';
import { perspective } from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';

import { createBoxGeometry } from '@forgeax/engine-geometry';
import { toMaterialAsset, type GltfMaterialIr } from '@forgeax/engine-gltf';
import {
  createMaterialLoader,
  installMaterialReadyShaders,
  MaterialGenerationCache,
} from '@forgeax/engine-assets-runtime';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { readbackTexturePixels } from '@forgeax/engine-rhi-debug';
import type { CookedMaterialRecord } from '@forgeax/engine-pack';
import type {
  Handle,
  MaterialAsset,
  MaterialGenerationVector,
  MaterialTextureValue,
  MaterialValue,
  TextureAsset,
} from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';

import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

import './pulse-material.wgsl';
import pulsePackUrl from '../assets/pulse-material.pack.json?url';

declare global {
  var __forgeaxMaterialEvidence:
    | {
      ready: boolean;
      browserPath: boolean;
      webgpu: boolean;
      rootGuid: string;
      derivedGuid: string;
      rootArtifactDigest: string;
      derivedArtifactDigest: string;
      rootCookInputDigest: string;
      derivedCookInputDigest: string;
      renderedMaterialGuids: readonly [string, string];
      renderedTextureHandles: readonly [number, number];
      resolvedTextureHandles: readonly [number, number];
      values: Readonly<Record<string, unknown>>;
      resolvedValues: Readonly<Record<string, unknown>>;
      renderedSamplingInput: Readonly<Record<string, readonly number[]>>;
      resolvedSamplingInput: Readonly<Record<string, readonly number[]>>;
      liveMutation: {
        enabled: boolean;
        inheritanceBacked: boolean;
        applied: boolean;
        appliedFrame: number | null;
        beforeMaterialHandle: number;
        afterMaterialHandle: number;
        beforeTextureHandles: readonly [number, number];
        afterTextureHandles: readonly [number, number];
        baseColorSlotChanged: boolean;
        normalSlotChanged: boolean;
        afterComponentMaterialHandle: number | null;
        sourceDerivedGuid: string;
        sourceArtifactDigest: string;
        sourceCookInputDigest: string;
      };
      resizeRebuild: {
        enabled: boolean;
        applied: boolean;
        requestedCanvas: readonly [number, number];
        beforeCanvas: readonly [number, number];
        afterCanvas: readonly [number, number] | null;
        postResizeMaterialHandle: number | null;
        postResizeBindGroupCreateCount: number | null;
      };
      rendererErrorCodes: readonly string[];
      drawErrorCodes: readonly string[];
      frameObservationCount: number;
      frameCount: number;
      renderDiagnostics: {
        shader: { status: 'ok'; module: string; artifactDigest: string };
        readback:
          | { status: 'pending' }
          | {
              status: 'ok';
              frameId: number;
              byteLength: number;
              nonZeroBytes: number;
              nonZeroAlphaPixels: number;
            }
          | { status: 'error'; code: string };
      };
      materialGeneration?: {
        runStale: () => Promise<unknown>;
        publishRecooked: () => Promise<unknown>;
      };
    }
    | undefined;
}

const PULSE_MATERIAL_SHADER_PATH = 'my-game::pulse-material';
const ROOT_MATERIAL_GUID = '01935b00-7d8c-7c4e-9f12-345678abcd02';
const DERIVED_MATERIAL_GUID = '01935b00-7d8c-7c4e-9f12-345678abcd03';
const materialQuery = new URLSearchParams(globalThis.location?.search ?? '');
const ACTIVE_ROOT_MATERIAL_GUID = materialQuery.get('materialGuid') ?? ROOT_MATERIAL_GUID;
const ACTIVE_DERIVED_MATERIAL_GUID = materialQuery.get('derivedMaterialGuid') ?? DERIVED_MATERIAL_GUID;
const MATERIAL_GENERATION_DEPENDENCIES = [
  PULSE_MATERIAL_SHADER_PATH,
  'pack:pulse-material',
] as const;
const RESOLVED_SAMPLING_INPUT = {
  baseColorUvTransform: [0, 0, 1, 1],
  normalUvTransform: [0.125, 0.25, 2, 2],
} as const;
const UV0_SAMPLING_INPUT = {
  baseColorUvTransform: [0, 0, 1, 1],
  normalUvTransform: [0, 0, 1, 1],
} as const;

const BASE_COLOR_TEXTURE_GUID = '01935b00-7d8c-7c4e-9f12-345678abcd11';
const NORMAL_TEXTURE_GUID = '01935b00-7d8c-7c4e-9f12-345678abcd12';

const BASE_COLOR_TEXTURE_PAYLOAD: TextureAsset = {
  kind: 'texture',
  shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
  format: 'rgba8unorm-srgb',
  data: new Uint8Array([
    255, 96, 32, 255,
    32, 96, 255, 255,
    32, 96, 255, 255,
    255, 96, 32, 255,
  ]),
  colorSpace: 'srgb',
  mips: { kind: 'none' },
};

const NORMAL_TEXTURE_PAYLOAD: TextureAsset = {
  ...BASE_COLOR_TEXTURE_PAYLOAD,
  data: new Uint8Array([
    32, 224, 32, 255,
    224, 32, 32, 255,
    224, 32, 32, 255,
    32, 224, 32, 255,
  ]),
};

function materialFromCookedRecord(
  record: CookedMaterialRecord,
  textureHandles: Readonly<{ baseColor: number; normal: number }>,
  samplingInput: Readonly<Record<string, readonly number[]>>,
): MaterialAsset {
  const [firstPass, ...remainingPasses] = record.resolved.passes;
  if (firstPass === undefined) {
    throw new Error(`[custom-shader] cooked material ${record.guid} has no render pass`);
  }
  const declared = new Set(
    record.resolved.parameters
      .filter((parameter) => parameter.type !== 'bool')
      .map((parameter) => parameter.name),
  );
  const values: Record<string, MaterialValue | null> = Object.fromEntries(
    Object.entries(record.resolved.values).filter(([name]) => declared.has(name)),
  );
  for (const [name, value] of Object.entries(samplingInput)) {
    if (declared.has(name)) values[name] = value;
  }
  if (declared.has('baseColorTexture')) {
    values.baseColorTexture = {
      texture: textureHandles.baseColor as unknown as AssetGuid,
      coordinates: {
        set: 0,
        transform: {
          offset: samplingInput.baseColorUvTransform?.slice(0, 2) as [number, number],
          scale: samplingInput.baseColorUvTransform?.slice(2, 4) as [number, number],
        },
      },
    };
  }
  if (declared.has('normalTexture')) {
    values.normalTexture = {
      texture: textureHandles.normal as unknown as AssetGuid,
      coordinates: {
        set: 1,
        transform: {
          offset: samplingInput.normalUvTransform?.slice(0, 2) as [number, number],
          scale: samplingInput.normalUvTransform?.slice(2, 4) as [number, number],
        },
      },
    };
  }
  return {
    kind: 'material',
    passes: [firstPass, ...remainingPasses],
    parameters: record.resolved.parameters,
    values,
  };
}

function declaredMaterialValues(
  record: CookedMaterialRecord,
  values: Readonly<Record<string, MaterialValue | null>>,
): Record<string, MaterialValue | null> {
  const declared = new Set(
    record.resolved.parameters
      .filter((parameter) => parameter.type !== 'bool')
      .map((parameter) => parameter.name),
  );
  return Object.fromEntries(Object.entries(values).filter(([name]) => declared.has(name)));
}

function rebindMaterialTextures(
  material: MaterialAsset,
  textureHandles: Readonly<{ baseColor?: number; normal?: number }>,
): MaterialAsset {
  const values = material.values ?? {};
  const nextValues: Record<string, MaterialValue | null> = { ...values };
  for (const [slot, handle] of Object.entries(textureHandles)) {
    if (handle === undefined) continue;
    const valueKey = slot === 'baseColor' ? 'baseColorTexture' : 'normalTexture';
    const textureValue = values[valueKey];
    if (textureValue === undefined) continue;
    if (textureValue === null || typeof textureValue !== 'object' || Array.isArray(textureValue)) {
      throw new Error(`[custom-shader] derived material has no structured ${valueKey} value`);
    }
    nextValues[valueKey] = {
      ...(textureValue as MaterialTextureValue),
      texture: handle as unknown as AssetGuid,
    };
  }
  return {
    ...material,
    values: nextValues,
  };
}

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('hello-custom-shader: missing <canvas id="app"> in index.html');

const liveMode = new URLSearchParams(globalThis.location?.search ?? '').get('live');
const materialGenerationMode =
  new URLSearchParams(globalThis.location?.search ?? '').get('m36') === 'stale-recook';
const liveNormalSlotSwap = liveMode === 'normal-slot-swap' || liveMode === 'normal-slot-swap-resize';
const liveResizeRebuild = liveMode === 'normal-slot-resize' || liveMode === 'normal-slot-swap-resize';
const liveTwoSlotSwap = liveMode === 'two-slot-swap' || liveMode === 'two-slot-swap-resize';
const liveTwoSlotResize = liveMode === 'two-slot-resize' || liveMode === 'two-slot-swap-resize';
const liveInheritanceRebind = liveMode === 'inheritance-rebind';
const liveMutationEnabled = liveNormalSlotSwap || liveTwoSlotSwap || liveInheritanceRebind;
const liveResizeEnabled = liveResizeRebuild || liveTwoSlotResize;

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    console.error('[custom-shader] no usable backend:', err);
  } else {
    console.error('[custom-shader] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const constructed = await constructRuntimeRendererHost(target, {}, {
    ...forgeaxBundlerAdapter(),
    importTransport: createRuntimeAssetImportTransport(runtimeBinding),
  });
  if (!constructed.ok) throw constructed.error;
  const { renderer, debugDrawHost, assets } = constructed.value;
  const legacyDebugDrawHost = debugDrawHost as unknown as RendererLegacyHostAdapter;
  const rendererErrorCodes: string[] = [];
  const drawErrorCodes: string[] = [];
  let frameObservationCount = 0;
  renderer.subscribe((event) => {
    if (event.kind === 'error') rendererErrorCodes.push(event.error.code);
  });
  console.warn('[custom-shader] Standard pipeline active');

  configureRuntimeAssetCatalog(assets, runtimeBinding);
  const catalogedBaseColorTexture = assets.catalog(
    BASE_COLOR_TEXTURE_GUID,
    BASE_COLOR_TEXTURE_PAYLOAD,
  );
  if (!catalogedBaseColorTexture.ok) throw catalogedBaseColorTexture.error;
  const catalogedNormalTexture = assets.catalog(NORMAL_TEXTURE_GUID, NORMAL_TEXTURE_PAYLOAD);
  if (!catalogedNormalTexture.ok) throw catalogedNormalTexture.error;
  const rootGuid = AssetGuid.parse(ACTIVE_ROOT_MATERIAL_GUID);
  const derivedGuid = AssetGuid.parse(ACTIVE_DERIVED_MATERIAL_GUID);
  if (!rootGuid.ok || !derivedGuid.ok) throw new Error('[custom-shader] material GUID is malformed');
  const catalogMaterialPair =
    ACTIVE_ROOT_MATERIAL_GUID === ROOT_MATERIAL_GUID &&
    ACTIVE_DERIVED_MATERIAL_GUID === DERIVED_MATERIAL_GUID
      ? await Promise.all([
          assets.loadByGuid<MaterialAsset>(rootGuid.value),
          assets.loadByGuid<MaterialAsset>(derivedGuid.value),
        ])
      : undefined;
  if (catalogMaterialPair !== undefined && (!catalogMaterialPair[0].ok || !catalogMaterialPair[1].ok)) {
    const [rootLoaded, derivedLoaded] = catalogMaterialPair;
    console.error('[custom-shader] material catalog load failed', {
      root: rootLoaded.ok
        ? undefined
        : { code: rootLoaded.error.code, expected: rootLoaded.error.expected, hint: rootLoaded.error.hint, detail: rootLoaded.error.detail },
      derived: derivedLoaded.ok
        ? undefined
        : { code: derivedLoaded.error.code, expected: derivedLoaded.error.expected, hint: derivedLoaded.error.hint, detail: derivedLoaded.error.detail },
    });
    throw new Error('[custom-shader] runtime catalog did not load the material inheritance pair');
  }

  const materialCache = new MaterialGenerationCache();
  let packRead = 0;
  let lastMaterialGeneration: MaterialGenerationVector | undefined;
  const loadCookedMaterial = async (guid: string) => {
    const requestedPackUrl = materialQuery.get('materialPack') ?? pulsePackUrl;
    const packUrl = new URL(requestedPackUrl, globalThis.location.href);
    packUrl.searchParams.set('forgeax-material-generation', String(++packRead));
    const packResponse = await fetch(packUrl, { cache: 'no-store' });
    if (!packResponse.ok) throw new Error('[custom-shader] authored pack fetch failed');
    const pack = (await packResponse.json()) as {
      assets?: readonly { guid?: unknown; payload?: { cooked?: unknown } }[];
    };
    const cookedByGuid = new Map<string, CookedMaterialRecord | undefined>();
    for (const entry of pack.assets ?? []) {
      if (typeof entry.guid === 'string' && entry.payload?.cooked !== undefined) {
        cookedByGuid.set(entry.guid.toLowerCase(), entry.payload.cooked as CookedMaterialRecord);
      }
    }
    const requestedRecord = cookedByGuid.get(guid.toLowerCase());
    if (requestedRecord === undefined || typeof requestedRecord.specializationKey !== 'string') {
      throw new Error(`[custom-shader] cooked publication missing specializationKey: ${guid}`);
    }
    const loaded = await createMaterialLoader({
      loadPublication: async (recordGuid) => {
        const record = cookedByGuid.get(recordGuid.toLowerCase());
        if (record === undefined) return undefined;
        return {
          guid: recordGuid,
          record,
          artifacts: Object.fromEntries(
            record.programs.map(({ artifact }) => [
              artifact.path,
              { bytes: new Uint8Array(artifact.bytes), digest: artifact.digest },
            ]),
          ),
        };
      },
      loadReference: async () => true,
    }).load({ guid, specializationKey: requestedRecord.specializationKey });
    if (loaded.status !== 'Ready') {
      throw new Error(`[custom-shader] cooked material load failed: ${loaded.error.code}`);
    }
    installMaterialReadyShaders(assets.shaderRegistry, loaded, assets.materialArtifactRegistry);
    return loaded;
  };
  const loadCachedMaterial = (guid: string, destabilize = false) =>
    materialCache.resolve(guid, guid, () =>
      materialCache.loadWithGeneration(
        guid,
        MATERIAL_GENERATION_DEPENDENCIES,
        async (generation) => {
          lastMaterialGeneration = generation;
          const loaded = await loadCookedMaterial(guid);
          if (destabilize) materialCache.bump(MATERIAL_GENERATION_DEPENDENCIES[0]);
          return { generation, value: loaded };
        },
      ),
    );
  const [rootResult, derivedResult] = await Promise.all([
    loadCachedMaterial(ACTIVE_ROOT_MATERIAL_GUID),
    loadCachedMaterial(ACTIVE_DERIVED_MATERIAL_GUID),
  ]);
  if (!rootResult.ok) {
    throw new Error(`[custom-shader] cooked material generation failed: ${rootResult.error.code}`);
  }
  if (!derivedResult.ok) {
    throw new Error(
      `[custom-shader] cooked material generation failed: ${derivedResult.error.code}`,
    );
  }
  const rootReady = rootResult.value;
  const derivedReady = derivedResult.value;
  const sharesCookedSpecialization =
    rootReady.record.specializationKey === derivedReady.record.specializationKey &&
    rootReady.record.artifactDigest === derivedReady.record.artifactDigest &&
    rootReady.record.receipt.identity.cookIdentity ===
      derivedReady.record.receipt.identity.cookIdentity;
  if (
    ACTIVE_ROOT_MATERIAL_GUID === ROOT_MATERIAL_GUID &&
    ACTIVE_DERIVED_MATERIAL_GUID === DERIVED_MATERIAL_GUID &&
    !sharesCookedSpecialization
  ) {
    throw new Error('[custom-shader] inherited materials do not share the cooked specialization');
  }
  const falsify = new URLSearchParams(globalThis.location?.search ?? '').get('falsify');
  if (falsify === 'missing-derived-parent') throw new Error('FALSIFY_EXPECTED_FAILURE:missing-derived-parent');
  if (falsify === 'missing-normal-resource') throw new Error('FALSIFY_EXPECTED_FAILURE:missing-normal-resource');

  const world = new World();
  const worldAttachment1 = renderer.attach(world);
  if (!worldAttachment1.ok) throw worldAttachment1.error;
  const frameRequest = {
    leases: [worldAttachment1.value],
    camera: { lease: worldAttachment1.value },
    environment: { lease: worldAttachment1.value },
  };

  const materialModule = rootReady.record.resolved.passes[0]?.program.module;
  if (typeof materialModule !== 'string') {
    throw new Error('[custom-shader] cooked material has no authored shader module identity');
  }
  const materialArtifact = assets.shaderRegistry.findMaterialArtifact(materialModule);
  if (!materialArtifact.ok) {
    throw new Error('[custom-shader] cooked shader module is absent from the build manifest');
  }

  const liveSwapNormalTexturePayload: TextureAsset = {
    ...BASE_COLOR_TEXTURE_PAYLOAD,
    data: new Uint8Array([
      224, 32, 224, 255,
      32, 32, 224, 255,
      32, 32, 224, 255,
      224, 32, 224, 255,
    ]),
  };
  const liveSwapBaseColorTexturePayload: TextureAsset = {
    ...BASE_COLOR_TEXTURE_PAYLOAD,
    data: new Uint8Array([
      32, 224, 224, 255,
      224, 224, 32, 255,
      224, 224, 32, 255,
      32, 224, 224, 255,
    ]),
  };
  const baseColorTextureHandle = world.allocSharedRef('TextureAsset', BASE_COLOR_TEXTURE_PAYLOAD);
  const normalTextureHandle = world.allocSharedRef('TextureAsset', NORMAL_TEXTURE_PAYLOAD);
  const liveSwapNormalTextureHandle = world.allocSharedRef('TextureAsset', liveSwapNormalTexturePayload);
  const liveSwapBaseColorTextureHandle = world.allocSharedRef('TextureAsset', liveSwapBaseColorTexturePayload);
  const resolvedTextureHandles = {
    baseColor: baseColorTextureHandle,
    normal: normalTextureHandle,
  };
  const renderedTextureHandles =
    falsify === 'normal-slot-swap'
      ? { baseColor: baseColorTextureHandle, normal: baseColorTextureHandle }
      : falsify === 'swapped-normal-binding'
        ? { baseColor: normalTextureHandle, normal: baseColorTextureHandle }
        : resolvedTextureHandles;
  const gltfMaterial = toMaterialAsset(
    {
      name: 'material-inheritance-demo-gltf',
      baseColorFactor: [1, 1, 1, 1],
      metallicFactor: 0,
      roughnessFactor: 1,
      baseColorTexture: {
        texture: 0,
        texCoord: 0,
        transform: { offset: [0, 0], scale: [1, 1] },
      },
      normalTexture: {
        texture: 1,
        texCoord: 1,
        transform: { offset: [0.125, 0.25], scale: [2, 2] },
        scale: 0.8,
      },
    } satisfies GltfMaterialIr,
    {
      textureHandles: new Map([
        [0, renderedTextureHandles.baseColor as unknown as Handle<'TextureAsset', 'shared'>],
        [1, renderedTextureHandles.normal as unknown as Handle<'TextureAsset', 'shared'>],
      ]),
    },
  );
  const gltfValues = gltfMaterial.values as Record<string, MaterialValue | null>;
  const gltfTextureValues: Record<string, MaterialValue | null> = {};
  for (const textureName of ['baseColorTexture', 'normalTexture'] as const) {
    const value = gltfValues[textureName];
    if (value !== undefined) gltfTextureValues[textureName] = value;
  }
  const resolvedSamplingInput = RESOLVED_SAMPLING_INPUT;
  const renderedSamplingInput =
    falsify === 'uv0-transform-loss' ? UV0_SAMPLING_INPUT : resolvedSamplingInput;
  const rootMaterialBase = materialFromCookedRecord(
    rootReady.record,
    renderedTextureHandles,
    renderedSamplingInput,
  );
  const derivedMaterialBase = materialFromCookedRecord(
    derivedReady.record,
    renderedTextureHandles,
    renderedSamplingInput,
  );
  const rootMaterial: MaterialAsset = {
    ...rootMaterialBase,
    values: {
      ...rootMaterialBase.values,
      ...declaredMaterialValues(rootReady.record, gltfTextureValues),
    },
  };
  const derivedMaterial: MaterialAsset = {
    ...derivedMaterialBase,
    values: {
      ...derivedMaterialBase.values,
      ...declaredMaterialValues(derivedReady.record, gltfTextureValues),
    },
  };
  const liveSwapMaterial = rebindMaterialTextures(derivedMaterial, { normal: liveSwapNormalTextureHandle });
  const liveTwoSlotSwapMaterial = rebindMaterialTextures(derivedMaterial, {
    baseColor: liveSwapBaseColorTextureHandle,
    normal: liveSwapNormalTextureHandle,
  });
  const inheritanceReplacementTextureHandles: readonly [number, number] =
    falsify === 'live-inheritance-rebind'
      ? [renderedTextureHandles.baseColor, renderedTextureHandles.normal]
      : [liveSwapBaseColorTextureHandle, liveSwapNormalTextureHandle];
  const inheritanceReplacementMaterial = rebindMaterialTextures(derivedMaterial, {
    baseColor: inheritanceReplacementTextureHandles[0],
    normal: inheritanceReplacementTextureHandles[1],
  });
  const rootMaterialHandle = world.allocSharedRef('MaterialAsset', rootMaterial);
  const derivedMaterialHandle = world.allocSharedRef('MaterialAsset', derivedMaterial);
  const liveSwapMaterialHandle = world.allocSharedRef('MaterialAsset', liveSwapMaterial);
  const liveTwoSlotSwapMaterialHandle = world.allocSharedRef('MaterialAsset', liveTwoSlotSwapMaterial);
  const inheritanceReplacementMaterialHandle = world.allocSharedRef('MaterialAsset', inheritanceReplacementMaterial);
  const liveReplacementMaterialHandle = liveTwoSlotSwap
    ? liveTwoSlotSwapMaterialHandle
      : liveNormalSlotSwap
        ? liveSwapMaterialHandle
        : liveInheritanceRebind
          ? inheritanceReplacementMaterialHandle
          : derivedMaterialHandle;
  const liveReplacementTextureHandles: readonly [number, number] = liveTwoSlotSwap
    ? [liveSwapBaseColorTextureHandle, liveSwapNormalTextureHandle]
      : liveNormalSlotSwap
        ? [renderedTextureHandles.baseColor, liveSwapNormalTextureHandle]
        : liveInheritanceRebind
          ? inheritanceReplacementTextureHandles
          : [renderedTextureHandles.baseColor, renderedTextureHandles.normal];
  const derivedValues = derivedMaterial.values as Record<string, MaterialValue | null>;
  globalThis.__forgeaxMaterialEvidence = {
    ready: true,
    browserPath: true,
    webgpu: typeof navigator !== 'undefined' && navigator.gpu !== undefined,
    rootGuid: ACTIVE_ROOT_MATERIAL_GUID,
    derivedGuid: ACTIVE_DERIVED_MATERIAL_GUID,
    rootArtifactDigest: rootReady.record.artifactDigest,
    derivedArtifactDigest: derivedReady.record.artifactDigest,
    rootCookInputDigest: rootReady.record.receipt.identity.cookIdentity,
    derivedCookInputDigest: derivedReady.record.receipt.identity.cookIdentity,
    renderedMaterialGuids: [rootReady.record.guid, derivedReady.record.guid],
    renderedTextureHandles: [renderedTextureHandles.baseColor, renderedTextureHandles.normal],
    resolvedTextureHandles: [resolvedTextureHandles.baseColor, resolvedTextureHandles.normal],
    values: rootReady.record.resolved.values,
    resolvedValues: derivedReady.record.resolved.values,
    renderedSamplingInput,
    resolvedSamplingInput,
    liveMutation: {
      enabled: liveMutationEnabled,
      inheritanceBacked: liveInheritanceRebind,
      applied: false,
      appliedFrame: null,
      beforeMaterialHandle: derivedMaterialHandle,
      afterMaterialHandle: liveReplacementMaterialHandle,
      beforeTextureHandles: [renderedTextureHandles.baseColor, renderedTextureHandles.normal],
      afterTextureHandles: liveReplacementTextureHandles,
      baseColorSlotChanged: renderedTextureHandles.baseColor !== liveReplacementTextureHandles[0],
      normalSlotChanged: renderedTextureHandles.normal !== liveReplacementTextureHandles[1],
      afterComponentMaterialHandle: null,
      sourceDerivedGuid: derivedReady.record.guid,
      sourceArtifactDigest: derivedReady.record.artifactDigest,
      sourceCookInputDigest: derivedReady.record.receipt.identity.cookIdentity,
    },
    resizeRebuild: {
      enabled: liveResizeEnabled,
      applied: false,
      requestedCanvas: [384, 192],
      beforeCanvas: [target.width, target.height],
      afterCanvas: null,
      postResizeMaterialHandle: null,
      postResizeBindGroupCreateCount: null,
    },
    rendererErrorCodes,
    drawErrorCodes,
    frameObservationCount,
    frameCount: 0,
    renderDiagnostics: {
      shader: {
        status: 'ok',
        module: materialModule,
        artifactDigest: rootReady.record.artifactDigest,
      },
      readback: { status: 'pending' },
    },
  };

  // Procedural box (12-floats stride: position + normal + uv + tangent).
  // The PBR pipeline cache builder (M9-T03) assumes the standard 4-BGL
  // chain and 12-floats vertex layout for user shaders.
  const boxRes = createBoxGeometry(1, 1, 1);
  if (!boxRes.ok) {
    console.error('[custom-shader] createBoxGeometry failed:', boxRes.error);
    return;
  }
  const boxMeshHandle = world.allocSharedRef('MeshAsset', boxRes.value);

  // Compose the World: cube + camera + directional light. Direct light
  // ensures the pulse-material lit path produces a non-black baseline
  // (the shader's f_schlick term still evaluates against the world
  // normal); the SMOKE_PIXEL_THRESHOLD pulse-delta gate at M9-T06 reads
  // pixels at 3 distinct t values to confirm the colour is visibly
  // pulsing across frames.
  world
    .spawn(
      { component: Name, data: { value: 'pulse-root' } as never },
      { component: Transform, data: { pos: [-0.9, 0, 0] } },
      { component: MeshFilter, data: { assetHandle: boxMeshHandle } },
      { component: MeshRenderer, data: { materials: [rootMaterialHandle] } },
    )
    .unwrap();
  const derivedEntity = world
    .spawn(
      { component: Name, data: { value: 'pulse-derived' } as never },
      { component: Transform, data: { pos: [0.9, 0, 0] } },
      { component: MeshFilter, data: { assetHandle: boxMeshHandle } },
      { component: MeshRenderer, data: { materials: [derivedMaterialHandle] } },
    )
    .unwrap();
  world.spawn(
    {
      component: Transform,
      data: { pos: [0, 0, 3]},
  },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
  ).unwrap();
  world.spawn({
    component: DirectionalLight,
    data: {
      direction: [-0.5, -1, -0.3],
      color: [1, 0.95, 0.9],
      intensity: 1.0,
    },
  }).unwrap();

  let renderedFrameCount = 0;
  let frameReadbackInFlight = false;
  let currentDerivedHandle = derivedMaterialHandle;
  let staleEvidence: unknown;
  let freshEvidence: unknown;
  const stableWorld = world;
  const stableRenderer = renderer;

  const runStaleGenerationProbe = async (): Promise<unknown> => {
    if (staleEvidence !== undefined) return staleEvidence;
    materialCache.bump(MATERIAL_GENERATION_DEPENDENCIES[1]);
    const stale = await loadCachedMaterial(DERIVED_MATERIAL_GUID, true);
    staleEvidence = stale.ok
      ? {
          status: 'unexpected-fresh',
          published: false,
          sameWorld: world === stableWorld,
          sameRenderer: renderer === stableRenderer,
        }
      : {
          status: 'stale',
          published: false,
          error: { code: stale.error.code, detail: stale.error.detail },
          diagnostic: materialCache.generationError(DERIVED_MATERIAL_GUID)?.detail,
          staleArtifactDigest: derivedReady.record.artifactDigest,
          siblingArtifactDigest: rootReady.record.artifactDigest,
          currentMaterialHandle: currentDerivedHandle,
          sameWorld: world === stableWorld,
          sameRenderer: renderer === stableRenderer,
        };
    return staleEvidence;
  };

  const publishRecookedMaterial = async (): Promise<unknown> => {
    if (freshEvidence !== undefined) return freshEvidence;
    materialCache.bump(MATERIAL_GENERATION_DEPENDENCIES[1]);
    const fresh = await loadCachedMaterial(DERIVED_MATERIAL_GUID);
    if (!fresh.ok) {
      freshEvidence = {
        status: 'error',
        error: { code: fresh.error.code, detail: fresh.error.detail },
      };
      return freshEvidence;
    }
    const freshMaterialBase = materialFromCookedRecord(
      fresh.value.record,
      renderedTextureHandles,
      renderedSamplingInput,
    );
    const freshMaterial: MaterialAsset = {
      ...freshMaterialBase,
      values: {
        ...freshMaterialBase.values,
        ...declaredMaterialValues(fresh.value.record, gltfTextureValues),
      },
    };
    const freshHandle = world.allocSharedRef('MaterialAsset', freshMaterial);
    const mutation = world.set(derivedEntity, MeshRenderer, { materials: [freshHandle] });
    if (!mutation.ok) {
      world.sharedRefs.release(freshHandle);
      freshEvidence = { status: 'error', error: { code: mutation.error.code } };
      return freshEvidence;
    }
    const allocationRelease = world.sharedRefs.release(freshHandle);
    if (!allocationRelease.ok) {
      freshEvidence = {
        status: 'error',
        error: { code: allocationRelease.error.code },
      };
      return freshEvidence;
    }
    currentDerivedHandle = freshHandle;
    freshEvidence = {
      status: 'fresh',
      published: true,
      artifactDigest: fresh.value.record.artifactDigest,
      inputDigest: fresh.value.record.receipt.identity.cookIdentity,
      generation: lastMaterialGeneration,
      diagnostic: materialCache.generationError(DERIVED_MATERIAL_GUID),
      oldArtifactDigest: derivedReady.record.artifactDigest,
      siblingArtifactDigest: rootReady.record.artifactDigest,
      currentMaterialHandle: currentDerivedHandle,
      allocationRelease: { ok: allocationRelease.ok },
      materialRefcount: world.sharedRefs.refcount(currentDerivedHandle),
      sameWorld: world === stableWorld,
      sameRenderer: renderer === stableRenderer,
    };
    return freshEvidence;
  };
  if (materialGenerationMode && globalThis.__forgeaxMaterialEvidence !== undefined) {
    globalThis.__forgeaxMaterialEvidence.materialGeneration = {
      runStale: runStaleGenerationProbe,
      publishRecooked: publishRecookedMaterial,
    };
  }

  // Animate the runtime material values to exercise the cooked shader path.
  const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const frame = (): void => {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (Object.hasOwn(derivedValues, 'time')) {
      derivedValues.time =
        materialGenerationMode || liveResizeEnabled || liveMutationEnabled
          ? 0
          : (now - startTime) / 1000;
    }
    world.update().unwrap();
    const r = renderer.draw(frameRequest);
    if (!r.ok) {
      drawErrorCodes.push(r.error.code);
      console.error('[custom-shader] draw error:', r.error);
    } else {
      void renderer.observe(r.value, { include: ['draws', 'bindings'] }).then((observed) => {
        if (observed.ok) {
          frameObservationCount += 1;
          if (globalThis.__forgeaxMaterialEvidence !== undefined) {
            globalThis.__forgeaxMaterialEvidence.frameObservationCount = frameObservationCount;
          }
        }
      });
      if (!frameReadbackInFlight && globalThis.__forgeaxMaterialEvidence !== undefined) {
        frameReadbackInFlight = true;
        void legacyDebugDrawHost
          .observeCurrentFrame({
            semantic: 'linear-hdr',
            readback: async (lease) => {
              try {
                return ok(
                  await readbackTexturePixels(
                    debugDrawHost.device,
                    lease.descriptor.texture,
                    lease.descriptor.size.width,
                    lease.descriptor.size.height,
                    { bytesPerTexel: 8 },
                  ),
                );
              } catch (cause) {
                return err(cause instanceof Error ? cause : new Error(String(cause)));
              }
            },
          })
          .then((observed) => {
            frameReadbackInFlight = false;
            const evidence = globalThis.__forgeaxMaterialEvidence;
            if (evidence === undefined) return;
            if (!observed.ok) {
              evidence.renderDiagnostics.readback = {
                status: 'error',
                code: observed.error.code,
              };
              return;
            }
            let nonZeroBytes = 0;
            let nonZeroAlphaPixels = 0;
            for (let offset = 0; offset < observed.value.bytes.length; offset += 1) {
              if ((observed.value.bytes[offset] ?? 0) !== 0) nonZeroBytes += 1;
            }
            for (let offset = 0; offset + 7 < observed.value.bytes.length; offset += 8) {
              if (
                (observed.value.bytes[offset + 6] ?? 0) !== 0 ||
                (observed.value.bytes[offset + 7] ?? 0) !== 0
              ) {
                nonZeroAlphaPixels += 1;
              }
            }
            evidence.renderDiagnostics.readback = {
              status: 'ok',
              frameId: observed.value.metadata.frameId,
              byteLength: observed.value.bytes.byteLength,
              nonZeroBytes,
              nonZeroAlphaPixels,
            };
          })
          .catch((cause: unknown) => {
            frameReadbackInFlight = false;
            const evidence = globalThis.__forgeaxMaterialEvidence;
            if (evidence === undefined) return;
            evidence.renderDiagnostics.readback = {
              status: 'error',
              code: cause instanceof Error ? cause.name : 'readback-failed',
            };
          });
      }
    }
    renderedFrameCount += 1;
    if (globalThis.__forgeaxMaterialEvidence !== undefined) {
      globalThis.__forgeaxMaterialEvidence.frameCount = renderedFrameCount;
      if (liveMutationEnabled && renderedFrameCount === 120) {
        const mutation = world.set(derivedEntity, MeshRenderer, {
          materials: [liveReplacementMaterialHandle],
        });
        if (!mutation.ok) {
          console.error('[custom-shader] live normal-slot rebind failed:', mutation.error);
        } else {
          globalThis.__forgeaxMaterialEvidence.liveMutation.applied = true;
          globalThis.__forgeaxMaterialEvidence.liveMutation.appliedFrame = renderedFrameCount;
          const currentRenderer = world.get(derivedEntity, MeshRenderer);
          if (currentRenderer.ok) {
            const materials = currentRenderer.value.materials as unknown as ArrayLike<number>;
            globalThis.__forgeaxMaterialEvidence.liveMutation.afterComponentMaterialHandle =
              materials[0] ?? null;
          }
        }
      }
      if (liveResizeEnabled && renderedFrameCount === 150) {
        target.width = 384;
        target.height = 192;
        globalThis.__forgeaxMaterialEvidence.resizeRebuild.applied = true;
      }
      if (
        liveResizeEnabled &&
        globalThis.__forgeaxMaterialEvidence.resizeRebuild.applied &&
        globalThis.__forgeaxMaterialEvidence.resizeRebuild.afterCanvas === null &&
        (target.width !== globalThis.__forgeaxMaterialEvidence.resizeRebuild.beforeCanvas[0] ||
          target.height !== globalThis.__forgeaxMaterialEvidence.resizeRebuild.beforeCanvas[1])
      ) {
        const currentRenderer = world.get(derivedEntity, MeshRenderer);
        if (currentRenderer.ok) {
          const materials = currentRenderer.value.materials as unknown as ArrayLike<number>;
          globalThis.__forgeaxMaterialEvidence.resizeRebuild.afterCanvas = [target.width, target.height];
          globalThis.__forgeaxMaterialEvidence.resizeRebuild.postResizeMaterialHandle = materials[0] ?? null;
          globalThis.__forgeaxMaterialEvidence.resizeRebuild.postResizeBindGroupCreateCount =
            frameObservationCount;
        }
      }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

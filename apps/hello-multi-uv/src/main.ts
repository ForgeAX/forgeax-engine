// hello-multi-uv: multi-UV visual differentiation demo for AC-10.
//
// Spawns a plane with 2 UV sets. The interleaved vertices buffer carries all
// attributes; independent per-attribute typed arrays are extracted for the
// VertexAttributeMap contract (deriveVertexBufferLayout reads them).
//
// uv0 = standard grid pattern (0..1 per segment)
// uv1 = checkerboard pattern per quad
//
// AC-10 visual differentiation is carried by the demo's OWN custom shader
// (multi-uv-demo.wgsl), NOT by the engine-shipped default-standard-pbr: the
// built-in PBR fragment must stay byte-identical for single-UV meshes
// (AC-11/AC-12 zero regression). The demo shader paints uv1 into the surface
// colour so the per-quad checkerboard is directly visible. A mesh with no
// second UV set reads uv0 via clamp-to-last (NOT (0,0)) -- the per-cell
// variance only appears because this plane carries a real second set.
//
// Import path follows `apps/hello/cube/src/main.ts` pattern.

import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { type CanvasAppError, createFullscreenRenderFeature } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import { createMaterialLoader, type MaterialReady } from '@forgeax/engine-assets-runtime';
import type { CookedMaterialRecord } from '@forgeax/engine-pack';
import {
  ANTIALIAS_MSAA,
  Camera,
  DEFAULT_STANDARD_PROFILE,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type {
  MaterialAsset,
  MaterialPassList,
  MaterialValue,
  TextureAsset,
} from '@forgeax/engine-types';
import './multi-uv-demo.wgsl';
import './multi-uv-demo-false.wgsl';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import inheritancePackUrl from './multi-uv-inheritance.pack.json?url';
import depthFalsifierShader from './post-depth-falsifier.wgsl';
import depthOverlayShader from './post-depth-overlay.wgsl';
import depthOverlayMsaaShader from './post-depth-overlay-msaa.wgsl';
import inversionShader from './post-inversion.wgsl';
import passthroughShader from './post-passthrough.wgsl';

declare global {
  var __forgeaxMultiUvEvidence:
    | {
        ready: boolean;
        mode: string | null;
        liveMaterial: {
          enabled: boolean;
          applied: boolean;
          beforeMaterialHandle: number | null;
          afterMaterialHandle: number | null;
          beforeTextureHandles: readonly [number, number];
          afterTextureHandles: readonly [number, number];
          baseColorSlotChanged: boolean;
          detailSlotChanged: boolean;
          baseColorParameterChanged: boolean;
          baseColorUvTransformChanged: boolean;
          beforeBaseColor: readonly [number, number, number, number];
          afterBaseColor: readonly [number, number, number, number];
          beforeBaseColorUvTransform: readonly [number, number, number, number];
          afterBaseColorUvTransform: readonly [number, number, number, number];
          inheritanceBacked: boolean;
          afterComponentMaterialHandle: number | null;
          sourceRootGuid: string | null;
          sourceDerivedGuid: string | null;
          sourceRootArtifactDigest: string | null;
          sourceArtifactDigest: string | null;
          sourceRootCookInputDigest: string | null;
          sourceCookInputDigest: string | null;
          falsifierMarker: string | null;
          resizeHistory: string[];
        };
        applyLiveMaterialRebind: () => { ok: boolean; code?: string };
      }
    | undefined;
}

const DEMO_MATERIAL_SHADER_PATH = 'hello-multi-uv::multi-uv-demo';
const DEMO_FALSE_MATERIAL_SHADER_PATH = 'hello-multi-uv::multi-uv-demo-false';

function materialFromCookedRecord(
  record: CookedMaterialRecord,
  textureHandles: Readonly<{ baseColor: number; detail: number }>,
  variant: 'true' | 'false' = 'true',
  valueOverrides: Readonly<Record<string, MaterialValue>> = {},
): MaterialAsset {
  if (record.resolved.passes.length === 0)
    throw new Error('[hello-multi-uv] cooked material has no passes');
  const [firstPass, ...restPasses] = record.resolved.passes;
  if (firstPass === undefined)
    throw new Error('[hello-multi-uv] cooked material has no first pass');
  const withVariant = (pass: (typeof record.resolved.passes)[number]) => ({
    ...pass,
    program: {
      ...pass.program,
      module:
        variant === 'true'
          ? 'hello-multi-uv::multi-uv-demo'
          : 'hello-multi-uv::multi-uv-demo-false',
    },
  });
  const passes: MaterialPassList = [withVariant(firstPass), ...restPasses.map(withVariant)];
  return {
    kind: 'material',
    passes,
    parameters: record.resolved.parameters,
    values: {
      ...record.resolved.values,
      ...valueOverrides,
      baseColorTexture: textureHandles.baseColor,
      detailTexture: textureHandles.detail,
    },
  };
}

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('hello-multi-uv: missing <canvas id="app"> in index.html');
const targetCanvas = canvas;
const params = new URLSearchParams(location.search);
const useMsaa = params.has('msaa');
type PostChoice = 'passthrough' | 'inversion' | 'depth';
const initialPost: PostChoice =
  params.get('post') === 'depth'
    ? 'depth'
    : params.get('post') === 'inversion'
      ? 'inversion'
      : 'passthrough';
function createPostFeature(effect: PostChoice) {
  const falsifyMsaaResolve = useMsaa && params.has('falsify-msaa-resolve');
  const source = falsifyMsaaResolve
    ? effect === 'inversion'
      ? passthroughShader.wgsl
      : inversionShader.wgsl
    : effect === 'depth'
      ? params.has('falsify-depth')
        ? depthFalsifierShader.wgsl
        : useMsaa
          ? depthOverlayMsaaShader.wgsl
          : depthOverlayShader.wgsl
      : effect === 'inversion'
        ? inversionShader.wgsl
        : passthroughShader.wgsl;
  return createFullscreenRenderFeature({
    identity: `hello-multi-uv::${effect}`,
    source,
    ...(effect === 'depth' && !params.has('falsify-depth')
      ? { reads: [{ key: 'depth', sampleType: 'depth' as const }] }
      : {}),
  });
}

function resizeCanvas(): void {
  targetCanvas.width = window.innerWidth;
  targetCanvas.height = window.innerHeight;
}

resizeCanvas();
window.addEventListener('resize', resizeCanvas);

const HALF_W = 1.5;
const HALF_H = 1.5;
const GRID_X = 4;
const GRID_Y = 4;
const VX = GRID_X + 1;
const VY = GRID_Y + 1;
const UV_SETS = 2;
const FLOATS_BASE = 12;
const FLOATS_PER_VERTEX = FLOATS_BASE + (UV_SETS - 1) * 2; // 14
const vertexCount = VX * VY;
const indexCount = GRID_X * GRID_Y * 6;
const vertices = new Float32Array(vertexCount * FLOATS_PER_VERTEX);
const indices = new Uint16Array(indexCount);
const segW = (HALF_W * 2) / GRID_X;
const segH = (HALF_H * 2) / GRID_Y;

for (let iy = 0, vi = 0; iy < VY; iy++) {
  for (let ix = 0; ix < VX; ix++, vi++) {
    const x = ix * segW - HALF_W;
    const y = -(iy * segH - HALF_H);
    const b = vi * FLOATS_PER_VERTEX;
    vertices[b + 0] = x;
    vertices[b + 1] = y;
    vertices[b + 2] = 0;
    vertices[b + 3] = 0;
    vertices[b + 4] = 0;
    vertices[b + 5] = 1;
    vertices[b + 6] = ix / GRID_X;
    vertices[b + 7] = iy / GRID_Y;
    vertices[b + 8] = 1;
    vertices[b + 9] = 0;
    vertices[b + 10] = 0;
    vertices[b + 11] = 1;
    const cell = (ix ^ iy) & 1;
    vertices[b + 12] = cell === 0 ? 0.0 : 1.0;
    vertices[b + 13] = cell === 0 ? 0.0 : 1.0;
  }
}

for (let iy = 0, ii = 0; iy < GRID_Y; iy++) {
  for (let ix = 0; ix < GRID_X; ix++) {
    const a = ix + VX * iy;
    const b = ix + VX * (iy + 1);
    const c = ix + 1 + VX * (iy + 1);
    const d = ix + 1 + VX * iy;
    indices[ii++] = a;
    indices[ii++] = b;
    indices[ii++] = d;
    indices[ii++] = b;
    indices[ii++] = c;
    indices[ii++] = d;
  }
}

// Independent per-attribute typed arrays. Each carries ONE attribute's data
// (not interleaved), matching the VertexAttributeMap contract: the engine's
// deriveVertexBufferLayout layer assembles GPU vertex buffers from these
// independent arrays. Copy from the interleaved vertices buffer using correct
// per-attribute byte offsets within the FLOATS_PER_VERTEX stride.
const positions = new Float32Array(vertexCount * 3);
const normals = new Float32Array(vertexCount * 3);
const uvs = new Float32Array(vertexCount * 2);
const tangents = new Float32Array(vertexCount * 4);
const uv1 = new Float32Array(vertexCount * 2);

for (let i = 0; i < vertexCount; i++) {
  const srcBase = i * FLOATS_PER_VERTEX;
  positions[i * 3 + 0] = vertices[srcBase + 0] as number;
  positions[i * 3 + 1] = vertices[srcBase + 1] as number;
  positions[i * 3 + 2] = vertices[srcBase + 2] as number;
  normals[i * 3 + 0] = vertices[srcBase + 3] as number;
  normals[i * 3 + 1] = vertices[srcBase + 4] as number;
  normals[i * 3 + 2] = vertices[srcBase + 5] as number;
  uvs[i * 2 + 0] = vertices[srcBase + 6] as number;
  uvs[i * 2 + 1] = vertices[srcBase + 7] as number;
  tangents[i * 4 + 0] = vertices[srcBase + 8] as number;
  tangents[i * 4 + 1] = vertices[srcBase + 9] as number;
  tangents[i * 4 + 2] = vertices[srcBase + 10] as number;
  tangents[i * 4 + 3] = vertices[srcBase + 11] as number;
  uv1[i * 2 + 0] = vertices[srcBase + 12] as number;
  uv1[i * 2 + 1] = vertices[srcBase + 13] as number;
}

const app = await createApp(
  canvas,
  {
    standardProfile: {
      ...DEFAULT_STANDARD_PROFILE,
    },
  },
  forgeaxBundlerAdapter(),
);
if (!app.ok) {
  reportError(app.error);
} else {
  const world = app.value.world;
  const sceneAssets = world.assets;
  if (!(sceneAssets instanceof AssetRegistry))
    throw new Error('Scene requires its runtime asset owner');

  const assets = app.value.assets;
  if (assets === undefined) {
    throw new Error('hello-multi-uv: asset owner unavailable');
  }
  const featureHost = app.value.pluginContext.renderFeatureHost;
  if (featureHost === undefined) {
    throw new Error('hello-multi-uv: render feature host unavailable');
  }
  const startupVariant: 'true' | 'false' = params.get('variant') === 'false' ? 'false' : 'true';
  const switchedVariant: 'true' | 'false' = startupVariant === 'true' ? 'false' : 'true';
  const liveMaterialMode = params.get('live-material');
  const inheritanceParameterMutation = liveMaterialMode === 'inheritance-parameter-mutation-resize';
  const inheritanceLiveMaterial =
    liveMaterialMode === 'inheritance-two-slot-swap-resize' || inheritanceParameterMutation;
  const liveVariantSwitch = inheritanceLiveMaterial && params.has('live-variant-switch');
  const liveMaterialEnabled =
    liveMaterialMode === 'two-slot-swap-resize' || inheritanceLiveMaterial;
  const falsifyLiveMaterial =
    params.has('falsify-live-material') || params.has('falsify-live-inheritance');
  const falsifyVariantSelection = params.has('falsify');
  let inheritedMaterialPair:
    | {
        root: MaterialReady;
        derived: MaterialReady;
      }
    | undefined;
  if (inheritanceLiveMaterial) {
    const response = await fetch(inheritancePackUrl);
    if (!response.ok) throw new Error(`multi-uv inheritance pack fetch failed: ${response.status}`);
    const pack = (await response.json()) as {
      assets?: readonly { guid?: unknown; payload?: { cooked?: CookedMaterialRecord } }[];
    };
    const cookedByGuid = new Map(
      (pack.assets ?? [])
        .filter(
          (entry): entry is { guid: string; payload?: { cooked?: CookedMaterialRecord } } =>
            typeof entry.guid === 'string',
        )
        .map((entry) => [entry.guid.toLowerCase(), entry.payload?.cooked]),
    );
    const loader = createMaterialLoader({
      loadPublication: async (guid: string) => {
        const record = cookedByGuid.get(guid.toLowerCase());
        if (record === undefined) return undefined;
        return {
          guid,
          record,
          artifacts: Object.fromEntries(
            record.programs.map(({ artifact }) => [
              artifact.path,
              {
                bytes: Uint8Array.from(artifact.bytes),
                digest: artifact.digest,
              },
            ]),
          ),
        };
      },
      loadReference: async (guid: string) =>
        cookedByGuid.has(guid.toLowerCase()) || guid === DEMO_MATERIAL_SHADER_PATH,
    });
    const [root, derived] = await Promise.all([
      loader.load({
        guid: '71935b00-7d8c-4c4e-8f12-345678abcd02',
        specializationKey: DEMO_MATERIAL_SHADER_PATH,
      }),
      loader.load({
        guid: '71935b00-7d8c-4c4e-8f12-345678abcd03',
        specializationKey: DEMO_MATERIAL_SHADER_PATH,
      }),
    ]);
    if (root.status !== 'Ready' || derived.status !== 'Ready') {
      throw new Error('[hello-multi-uv] inheritance cooked records are not runtime-ready');
    }
    if (
      root.record.artifactDigest !== derived.record.artifactDigest ||
      root.record.receipt.identity.programIdentity !==
        derived.record.receipt.identity.programIdentity ||
      root.record.resolved.passes[0]?.program.module !== DEMO_MATERIAL_SHADER_PATH ||
      derived.record.resolved.passes[0]?.program.module !== DEMO_MATERIAL_SHADER_PATH
    ) {
      throw new Error('[hello-multi-uv] inheritance cooked records diverged');
    }
    inheritedMaterialPair = { root, derived };
  }
  const variantControl = document.createElement('label');
  variantControl.id = 'variant-control';
  variantControl.style.cssText =
    'position:fixed;z-index:1;top:12px;left:12px;padding:8px 10px;color:#fff;background:#111c;border-radius:4px;font:14px monospace';
  variantControl.append('M3_MULTI_UV_VARIANT ');
  const variantSelect = document.createElement('select');
  variantSelect.id = 'variant-select';
  variantSelect.setAttribute('aria-label', 'M3 multi-UV shader variant');
  variantSelect.add(new Option('true (default)', 'true'));
  variantSelect.add(new Option('false', 'false'));
  variantControl.append(variantSelect, ' ');
  const variantStatus = document.createElement('span');
  variantStatus.id = 'variant-status';
  variantStatus.textContent = 'M3_MULTI_UV_VARIANT=true';
  variantControl.append(variantStatus);
  document.body.append(variantControl);

  const postStatus = document.createElement('span');
  postStatus.id = 'post-status';
  postStatus.textContent = `M3_POST_EFFECT=${initialPost}`;
  const postControl = document.createElement('label');
  postControl.id = 'post-control';
  postControl.style.cssText =
    'position:fixed;z-index:1;top:104px;left:12px;padding:8px 10px;color:#fff;background:#111c;border-radius:4px;font:14px monospace';
  postControl.append('M3_POST_EFFECT ');
  const postSelect = document.createElement('select');
  postSelect.id = 'post-select';
  postSelect.setAttribute('aria-label', 'M3 post-process effect');
  postSelect.add(new Option('passthrough', 'passthrough'));
  postSelect.add(new Option('inversion', 'inversion'));
  postSelect.add(new Option('depth', 'depth'));
  postControl.append(postSelect, ' ', postStatus);
  document.body.append(postControl);

  const pipelineControl = document.createElement('label');
  pipelineControl.id = 'pipeline-control';
  pipelineControl.style.cssText =
    'position:fixed;z-index:1;top:58px;left:12px;padding:8px 10px;color:#fff;background:#111c;border-radius:4px;font:14px monospace';
  pipelineControl.append('M3_PIPELINE ');
  const pipelineSelect = document.createElement('select');
  pipelineSelect.id = 'pipeline-select';
  pipelineSelect.setAttribute('aria-label', 'M3 render pipeline');
  pipelineSelect.add(new Option('standard', 'standard'));
  pipelineSelect.add(new Option('feature-host', 'custom'));
  pipelineControl.append(pipelineSelect, ' ');
  const pipelineStatus = document.createElement('span');
  pipelineStatus.id = 'pipeline-status';
  const initialPipeline = params.get('pipeline') === 'standard' ? 'standard' : 'custom';
  let selectedPipeline: 'standard' | 'custom' = initialPipeline;
  pipelineSelect.value = initialPipeline;
  pipelineStatus.textContent = `M3_PIPELINE=${initialPipeline}`;
  pipelineControl.append(pipelineStatus);
  document.body.append(pipelineControl);

  type PostFeatureLease = Extract<
    Awaited<ReturnType<typeof featureHost.installFeature>>,
    { ok: true }
  >['value'];
  let postFeatureLease: PostFeatureLease | undefined;
  let postFeatureOperation = Promise.resolve();
  const installPostFeature = async (effect: PostChoice): Promise<void> => {
    const previous = postFeatureLease;
    postFeatureLease = undefined;
    if (previous !== undefined) {
      const released = await previous.release();
      if (!released.ok) throw released.error;
    }
    const suppressFeature =
      (selectedPipeline === 'custom' && params.has('falsify-pipeline')) ||
      (selectedPipeline === 'standard' && params.has('falsify-reverse-pipeline'));
    if (!suppressFeature) {
      const installed = await featureHost.installFeature(createPostFeature(effect));
      if (!installed.ok) throw installed.error;
      postFeatureLease = installed.value;
    }
    postSelect.value = effect;
    postStatus.textContent = `M3_POST_EFFECT=${effect}`;
  };
  const queuePostFeature = (): Promise<void> => {
    const operation = postFeatureOperation.then(() => installPostFeature(selectedPost));
    postFeatureOperation = operation.catch(() => undefined);
    return operation;
  };
  let selectedPost: PostChoice = initialPost;
  await installPostFeature(initialPost);
  postSelect.addEventListener('change', () => {
    selectedPost =
      postSelect.value === 'inversion'
        ? 'inversion'
        : postSelect.value === 'depth'
          ? 'depth'
          : 'passthrough';
    void queuePostFeature();
  });
  pipelineSelect.addEventListener('change', () => {
    selectedPipeline = pipelineSelect.value === 'custom' ? 'custom' : 'standard';
    pipelineStatus.textContent = `M3_PIPELINE=${selectedPipeline}`;
    void queuePostFeature();
  });

  const baseColorTexture: TextureAsset = {
    kind: 'texture',
    shape: {
      viewDimension: '2d',
      extent: { width: 2, height: 2 },
    },
    format: 'rgba8unorm',
    data: new Uint8Array([
      255, 128, 64, 255, 255, 128, 64, 255, 255, 128, 64, 255, 255, 128, 64, 255,
    ]),
    colorSpace: 'linear',
    mips: { kind: 'none' },
  };
  const baseColorTextureHandle = sceneAssets.create(baseColorTexture).unwrap();
  const detailTexture: TextureAsset = {
    kind: 'texture',
    shape: {
      viewDimension: '2d',
      extent: { width: 2, height: 2 },
    },
    format: 'rgba8unorm',
    data: new Uint8Array([
      64, 192, 255, 255, 64, 192, 255, 255, 64, 192, 255, 255, 64, 192, 255, 255,
    ]),
    colorSpace: 'linear',
    mips: { kind: 'none' },
  };
  const detailTextureHandle = sceneAssets.create(detailTexture).unwrap();
  const liveBaseColorTexture: TextureAsset = {
    ...baseColorTexture,
    data: new Uint8Array([
      64, 255, 128, 255, 64, 255, 128, 255, 64, 255, 128, 255, 64, 255, 128, 255,
    ]),
  };
  const liveDetailTexture: TextureAsset = {
    ...detailTexture,
    data: new Uint8Array([
      255, 64, 192, 255, 255, 64, 192, 255, 255, 64, 192, 255, 255, 64, 192, 255,
    ]),
  };
  const liveBaseColorTextureHandle = sceneAssets.create(liveBaseColorTexture).unwrap();
  const liveDetailTextureHandle = sceneAssets.create(liveDetailTexture).unwrap();
  const textureStatus = document.createElement('span');
  textureStatus.id = 'texture-status';
  textureStatus.textContent = 'M3_TEXTURE_BINDING=baseColorTexture+detailTexture';
  variantControl.append(' ', textureStatus);
  const antialiasStatus = document.createElement('span');
  antialiasStatus.id = 'antialias-status';
  antialiasStatus.textContent = `M3_ANTIALIAS=${useMsaa ? 'msaa' : 'none'}`;
  variantControl.append(' ', antialiasStatus);
  // Build MeshAsset with independent per-attribute typed arrays. The interleaved
  // `vertices` buffer is the main GPU vertex data; `attributes` provides
  // per-attribute views for deriveVertexBufferLayout.
  const meshAsset = {
    kind: 'mesh' as const,
    vertices,
    indices,
    attributes: {
      position: positions,
      normal: normals,
      uv: uvs,
      tangent: tangents,
      uv1,
    },
    submeshes: [
      {
        indexOffset: 0,
        indexCount: indices.length,
        vertexCount,
        topology: 'triangle-list' as const,
        materialSlot: 0,
      },
    ],
    aabb: new Float32Array([-HALF_W, -HALF_H, -0.01, HALF_W, HALF_H, 0.01]),

    materialSlots: [{ slotName: 'Default' }],
  };

  // Build MaterialAsset referencing the custom multi-uv shader (AC-10 visual
  // carrier). The shader samples the real texture with uv0 and uv1 -> visible
  // per-quad checkerboard; the
  // built-in PBR is deliberately NOT used here so the engine core stays
  // single-UV-zero-regression clean.
  const falsifyDetailTexture = new URLSearchParams(location.search).has('falsify-texture');
  const asMaterialVec4 = (
    value: MaterialValue | null | undefined,
    fallback: readonly [number, number, number, number],
  ): readonly [number, number, number, number] => {
    if (
      Array.isArray(value) &&
      value.length === 4 &&
      value.every((component) => typeof component === 'number')
    ) {
      return [value[0] as number, value[1] as number, value[2] as number, value[3] as number];
    }
    return fallback;
  };
  const beforeBaseColor = asMaterialVec4(
    inheritedMaterialPair?.derived.record.resolved.values.baseColor,
    [0.7, 0.7, 0.7, 1],
  );
  const beforeBaseColorUvTransform = asMaterialVec4(
    inheritedMaterialPair?.derived.record.resolved.values.baseColorUvTransform,
    [0, 0, 1, 1],
  );
  const liveBaseColor = [0.12, 0.86, 0.34, 1] as const;
  const liveBaseColorUvTransform = [0.35, 0.05, 0.65, 0.9] as const;
  const afterBaseColor =
    inheritanceParameterMutation && !falsifyLiveMaterial ? liveBaseColor : beforeBaseColor;
  const afterBaseColorUvTransform =
    inheritanceParameterMutation && !falsifyLiveMaterial
      ? liveBaseColorUvTransform
      : beforeBaseColorUvTransform;
  const parameterValueChanged = (before: readonly number[], after: readonly number[]) =>
    before.some((value, index) => value !== after[index]);
  const materialAsset = (
    variant: 'true' | 'false',
    textures: { baseColor: number; detail: number } = {
      baseColor: baseColorTextureHandle,
      detail: detailTextureHandle,
    },
    values: {
      baseColor?: readonly [number, number, number, number];
      baseColorUvTransform?: readonly [number, number, number, number];
    } = {},
  ): MaterialAsset => ({
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: {
          // Material module identity is closed before render extraction. Keep
          // the falsifier on the same module as the positive path so a
          // constant-selection run proves the visual delta is causal.
          module:
            falsifyVariantSelection || variant === 'true'
              ? DEMO_MATERIAL_SHADER_PATH
              : DEMO_FALSE_MATERIAL_SHADER_PATH,
        },
        renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
      },
    ],
    values: {
      baseColor: values.baseColor ?? beforeBaseColor,
      baseColorUvTransform: values.baseColorUvTransform ?? beforeBaseColorUvTransform,
      baseColorTexture: textures.baseColor,
      ...(falsifyDetailTexture ? {} : { detailTexture: textures.detail }),
    },
  });
  const defaultMaterial = materialAsset('true');
  const falseMaterial = materialAsset('false');
  const liveMaterial = materialAsset('true', {
    baseColor: liveBaseColorTextureHandle,
    detail: falsifyLiveMaterial ? detailTextureHandle : liveDetailTextureHandle,
  });
  const inheritedDerivedMaterial = inheritedMaterialPair
    ? materialFromCookedRecord(
        inheritedMaterialPair.derived.record,
        {
          baseColor: baseColorTextureHandle,
          detail: detailTextureHandle,
        },
        startupVariant,
      )
    : undefined;
  const inheritedSwitchedMaterial = inheritedMaterialPair
    ? materialFromCookedRecord(
        inheritedMaterialPair.derived.record,
        {
          baseColor: baseColorTextureHandle,
          detail: detailTextureHandle,
        },
        switchedVariant,
      )
    : undefined;
  const inheritedReplacementMaterial = inheritedMaterialPair
    ? materialFromCookedRecord(
        inheritedMaterialPair.derived.record,
        {
          baseColor: falsifyLiveMaterial ? baseColorTextureHandle : liveBaseColorTextureHandle,
          detail: falsifyLiveMaterial ? detailTextureHandle : liveDetailTextureHandle,
        },
        liveVariantSwitch ? switchedVariant : startupVariant,
        inheritanceParameterMutation
          ? {
              baseColor: afterBaseColor,
              baseColorUvTransform: afterBaseColorUvTransform,
            }
          : {},
      )
    : undefined;

  const meshHandle = sceneAssets.create(meshAsset).unwrap();
  const defaultMatHandle = sceneAssets.create(defaultMaterial).unwrap();
  const falseMatHandle = sceneAssets.create(falseMaterial).unwrap();
  const liveMatHandle = sceneAssets.create(liveMaterial).unwrap();
  const inheritedDerivedMaterialHandle = inheritedDerivedMaterial
    ? sceneAssets.create(inheritedDerivedMaterial).unwrap()
    : null;
  const inheritedReplacementMaterialHandle = inheritedReplacementMaterial
    ? sceneAssets.create(inheritedReplacementMaterial).unwrap()
    : null;
  const inheritedSwitchedMaterialHandle = inheritedSwitchedMaterial
    ? sceneAssets.create(inheritedSwitchedMaterial).unwrap()
    : null;
  const initialMaterialHandle = inheritanceLiveMaterial
    ? inheritedDerivedMaterialHandle
    : startupVariant === 'true'
      ? defaultMatHandle
      : falseMatHandle;
  if (initialMaterialHandle === null)
    throw new Error('[hello-multi-uv] inherited material handle is missing');

  const planeEntity = world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [0, 0, 0.5],
          quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      },
      { component: MeshFilter, data: { assetHandle: meshHandle } },
      { component: MeshRenderer, data: { materials: [initialMaterialHandle] } },
    )
    .unwrap();

  let activeMaterialHandle = initialMaterialHandle;
  const selectVariant = (variant: 'true' | 'false') => {
    if (inheritanceLiveMaterial && !liveVariantSwitch) {
      variantSelect.value = variant;
      variantStatus.textContent = `M3_MULTI_UV_VARIANT=${variant}`;
      return;
    }
    const nextMaterialHandle = inheritanceLiveMaterial
      ? variant === startupVariant
        ? inheritedDerivedMaterialHandle
        : inheritedSwitchedMaterialHandle
      : variant === 'true'
        ? defaultMatHandle
        : falseMatHandle;
    if (nextMaterialHandle === null) {
      console.error('[multi-uv] variant selection has no inherited material handle');
      return;
    }
    const result = world.set(planeEntity, MeshRenderer, {
      materials: [nextMaterialHandle],
    });
    if (!result.ok) {
      console.error('[multi-uv] variant selection failed:', result.error);
      return;
    }
    activeMaterialHandle = nextMaterialHandle;
    variantSelect.value = variant;
    variantStatus.textContent = `M3_MULTI_UV_VARIANT=${variant}`;
  };
  variantSelect.addEventListener('change', () => {
    selectVariant(variantSelect.value === 'false' ? 'false' : 'true');
  });
  selectVariant(startupVariant);
  globalThis.__forgeaxMultiUvEvidence = {
    ready: true,
    mode: liveMaterialMode,
    liveMaterial: {
      enabled: liveMaterialEnabled,
      applied: false,
      beforeMaterialHandle: activeMaterialHandle,
      afterMaterialHandle: liveMaterialEnabled
        ? inheritanceLiveMaterial
          ? inheritedReplacementMaterialHandle
          : liveMatHandle
        : null,
      beforeTextureHandles: [baseColorTextureHandle, detailTextureHandle],
      afterTextureHandles: [
        inheritanceLiveMaterial && (falsifyLiveMaterial || inheritanceParameterMutation)
          ? baseColorTextureHandle
          : liveBaseColorTextureHandle,
        inheritanceLiveMaterial
          ? falsifyLiveMaterial || inheritanceParameterMutation
            ? detailTextureHandle
            : liveDetailTextureHandle
          : liveMaterial
            ? falsifyLiveMaterial
              ? detailTextureHandle
              : liveDetailTextureHandle
            : detailTextureHandle,
      ],
      baseColorSlotChanged: inheritanceLiveMaterial
        ? inheritanceParameterMutation
          ? false
          : !falsifyLiveMaterial
        : liveBaseColorTextureHandle !== baseColorTextureHandle,
      detailSlotChanged: inheritanceParameterMutation ? false : !falsifyLiveMaterial,
      baseColorParameterChanged: parameterValueChanged(beforeBaseColor, afterBaseColor),
      baseColorUvTransformChanged: parameterValueChanged(
        beforeBaseColorUvTransform,
        afterBaseColorUvTransform,
      ),
      beforeBaseColor,
      afterBaseColor,
      beforeBaseColorUvTransform,
      afterBaseColorUvTransform,
      inheritanceBacked: inheritanceLiveMaterial,
      afterComponentMaterialHandle: null,
      sourceRootGuid: inheritedMaterialPair?.root.record.guid ?? null,
      sourceDerivedGuid: inheritedMaterialPair?.derived.record.guid ?? null,
      sourceRootArtifactDigest: inheritedMaterialPair?.root.record.artifactDigest ?? null,
      sourceArtifactDigest: inheritedMaterialPair?.derived.record.artifactDigest ?? null,
      sourceRootCookInputDigest:
        inheritedMaterialPair?.root.record.receipt.identity.cookIdentity ?? null,
      sourceCookInputDigest:
        inheritedMaterialPair?.derived.record.receipt.identity.cookIdentity ?? null,
      falsifierMarker:
        inheritanceParameterMutation && falsifyLiveMaterial
          ? 'FALSIFY_EXPECTED_FAILURE:live-inheritance-parameters'
          : inheritanceLiveMaterial && falsifyLiveMaterial
            ? 'FALSIFY_EXPECTED_FAILURE:live-inheritance-rebind'
            : null,
      resizeHistory: [],
    },
    applyLiveMaterialRebind: () => {
      const evidence = globalThis.__forgeaxMultiUvEvidence;
      if (evidence === undefined || !evidence.liveMaterial.enabled)
        return { ok: false, code: 'disabled' };
      const nextMaterialHandle = inheritanceLiveMaterial
        ? inheritedReplacementMaterialHandle
        : liveMatHandle;
      if (nextMaterialHandle === null) return { ok: false, code: 'missing-inherited-material' };
      const result = world.set(planeEntity, MeshRenderer, { materials: [nextMaterialHandle] });
      if (!result.ok) return { ok: false, code: result.error.code };
      activeMaterialHandle = nextMaterialHandle;
      evidence.liveMaterial.applied = true;
      evidence.liveMaterial.afterComponentMaterialHandle = nextMaterialHandle;
      return { ok: true };
    },
  };
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [0, 0, 3],
        quat: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
    },
    {
      component: Camera,
      data: {
        fov: Math.PI / 4,
        aspect: 16 / 9,
        near: 0.1,
        far: 100,
        ...(useMsaa ? { antialias: ANTIALIAS_MSAA } : {}),
      },
    },
  );
  world.spawn({
    component: DirectionalLight,
    data: { castShadow: true, direction: [-0.3, -0.8, -1], color: [1, 1, 1], intensity: 1 },
  });

  app.value.start();
}

function reportError(err: CanvasAppError): void {
  console.error('[multi-uv] createApp failed:', err);
}

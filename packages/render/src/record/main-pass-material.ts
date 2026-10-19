import { STANDARD_DIRECT_DFG_LUT_BINDING } from '@forgeax/engine-shader';
import {
  standardTransmissionAdmission,
  transmissionBackdropAvailable,
} from '../assembly/device-feature-admission';
import { meshSsboBuffer } from '../assembly/mesh-ssbo-grow';
import { getOrCreateDirectDfgLut } from '../device/direct-dfg-lut';
import type { IblPrecomputeOutput } from '../ibl/IblPipelineCache';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { MaterialBgAssemblyCache } from './material-bg-assembly-cache';
import type { _InternalRenderPipelineContext } from './render-context';
import { MATERIAL_PER_ENTITY_STRIDE } from './render-context';
import { PLANAR_REFLECTION_UNIFORM_OFFSET } from './view-ubo';
// @forgeax/engine-runtime - RenderSystem record stage: main-pass-material.
// Extracted from render-system-record.ts (feat-20260704 M3/w17, pure move).

import { resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import type { EntityHandle } from '@forgeax/engine-ecs';
import {
  VIDEO_SOURCE_PROVIDER_KEY,
  type VideoSourceProvider,
  videoSourceExtent,
} from '@forgeax/engine-graphics-extras';
import {
  type BindGroup,
  type BindGroupEntry,
  type BindGroupLayout,
  type Buffer,
  type RenderPipeline,
  type RhiBindingResource,
  RhiError,
  type Sampler,
  type TextureView,
} from '@forgeax/engine-rhi';
import type { PipelineGroup2Contract } from '@forgeax/engine-shader';
import {
  DEFAULT_MSDF_TEXT_PARAM_SCHEMA,
  DEFAULT_SPRITE_PARAM_SCHEMA,
  DEFAULT_UNLIT_PARAM_SCHEMA,
  STANDARD_PHYSICAL_TEXTURE_FIELDS,
  STANDARD_PIPELINE_PARAM_SCHEMA,
  STANDARD_SHARED_TRANSMISSION_SLOTS,
} from '@forgeax/engine-shader';
import type {
  Handle,
  ImageError,
  MaterialRenderState,
  ParamSchemaEntry,
  PrimitiveTopology,
  SamplerAsset,
  TextureAsset,
} from '@forgeax/engine-types';
import { derive, getAdmittedParamSchemaInterface, handleSlot } from '@forgeax/engine-types';
import type { GpuResidencyCache } from '../device/gpu-residency';
import { VideoUploadUnsupportedError } from '../errors/render';
import {
  assembleMaterialWithSkylightEntries,
  type SkylightBindGroupResources,
  type SurfaceMediumBindGroupResources,
  skylightBindGroupResources,
  type TextureInjectionResource,
  type TransmissionBindGroupResources,
} from '../ibl/skylight-bind-group';
import { writeMaterialTextureCoordinateRecord } from '../material-texture-coordinates';
import type { IblBindingEntryInspection } from '../mesh-material-bindings';
import {
  isCanonicalStandardPbrMaterialShader,
  isStandardPbrMaterialShader,
  omittedStandardMaterialBindings,
  physicalTextureFields,
  sharedMaterialBindingDeclarations,
  standardNormalInputField,
} from '../pbr-pipeline';
import { deriveTextureUvScale } from '../render-data';
import type { MaterialSnapshot, SkylightSnapshot } from '../render-system-extract';
import {
  type RenderTargetMaterialSourceBinding,
  resolveRenderTargetMaterialSource,
} from '../targets/material-source';
import { canvasTextureState, isCanvasTextureSource } from '../textures/canvas-texture';
import { isExternalTextureSource } from '../textures/external-texture';
import type {
  BindGroupCounts,
  MaterialBgAssemblyCacheEntry,
  RenderFrameState,
} from './frame-snapshot';
import { getOpaqueResourceIdentity } from './frame-snapshot';
import { extractEntryResourceHandle, getOrCreatePerEntity } from './mesh-ssbo';
import {
  type PipelineState,
  type RenderSystemRuntime,
  STANDARD_PBR_UBO_SIZE,
} from './render-context';

/**
 * Resolve the group(2) resource layout from the material shader contract.
 * Standard clustered PBR consumes the unified cluster bind group; every other
 * material consumes the ordinary mesh bind group. Missing ordinary resources
 * remain missing so the caller can skip the draw rather than violate layout
 * compatibility by binding a cluster group.
 */
export function selectMaterialGroup2(
  clusterGroup: BindGroup | null,
  meshGroup: BindGroup | null,
  group2Contract: PipelineGroup2Contract,
): BindGroup | null {
  if (group2Contract === 'cluster') return clusterGroup;
  if (group2Contract === 'mesh') return meshGroup;
  return null;
}

// Only owner-admitted schemas retain field lookup; Types owns mutable layout validation.
interface MaterialTextureProjection {
  readonly parametersByName: ReadonlyMap<string, ParamSchemaEntry>;
  readonly textureFields: readonly string[];
  readonly physicalFields: readonly string[];
  readonly standardUserFields: readonly string[];
  readonly parameterTypes: ReadonlyMap<string, ParamSchemaEntry['type']>;
}

const MATERIAL_TEXTURE_PROJECTION_CACHE = new WeakMap<
  ReturnType<typeof derive>,
  MaterialTextureProjection
>();

function materialTextureProjection(schema: readonly ParamSchemaEntry[]) {
  const derived = getAdmittedParamSchemaInterface(schema);
  if (derived === undefined) return undefined;
  const cached = MATERIAL_TEXTURE_PROJECTION_CACHE.get(derived);
  if (cached !== undefined) return cached;
  const textureFields = Object.freeze([...derived.textureFieldNames]);
  const physicalFields = Object.freeze([...physicalTextureFields(schema)]);
  const physicalNames = new Set(physicalFields);
  const projection: MaterialTextureProjection = {
    parametersByName: new Map(schema.map((entry) => [entry.name, entry])),
    parameterTypes: derived.parameterTypes,
    textureFields,
    physicalFields,
    standardUserFields: Object.freeze(textureFields.filter((field) => !physicalNames.has(field))),
  };
  MATERIAL_TEXTURE_PROJECTION_CACHE.set(derived, projection);
  return projection;
}

function parameterByName(
  schema: readonly ParamSchemaEntry[] | undefined,
  field: string | undefined,
) {
  if (schema === undefined || field === undefined) return undefined;
  const admitted = materialTextureProjection(schema);
  return admitted === undefined
    ? schema.find((entry) => entry.name === field)
    : admitted.parametersByName.get(field);
}

// feat-20260601-customizable-render-pipeline-seam M2 / w12: the former
// `RecordPassContext` (26-field full surface, including the `internals` kitchen-sink and
// the 0-consumed `skyboxCount` residual) is DELETED. The per-frame shared state injected
// into the render-graph pass execute closures is now the clean `RenderPipelineContext`
// (defined in `render-system.ts`): `internals` is gone (replaced by the named
// `assets` / `store` / `pipelineState` / `runtime` surfaces) so a pipeline author cannot
// reach the runtime kitchen-sink through the public ctx (AC-08). The graph is
// `RenderGraph<RenderPipelineContext>` so `execute(ctx)` forwards the object to each
// closure with no `as` assertion.
//
// Encoder ownership (RD-4): `ctx.encoder` is the SHARED frame encoder used by the main /
// tonemap / FXAA passes (finished + submitted once at frame end); the shadow pass opens
// its OWN encoder internally + submits independently (the runtime-side manual barrier for
// the depth write -> sample hazard).

// M1 / w7: ensureLazyTexture DELETED — GPU texture ownership moved to render-graph
// via addColorTarget + compile(device). The graph allocates transient/persistent
// render targets during the compile allocation phase; pass execute closures resolve
// TextureViews through resolve(name). PerPassResources texture slots still hold
// the last-used views for bindgroup-invalidation self-checks (D-3 physical texture
// identity), but the graph owns the create/destroy lifecycle.

/**
 * Keep line primitives visible when they share a depth plane with filled
 * geometry. The same topology policy is consumed by the CPU and GPU-driven
 * raster lanes so a mixed mesh does not change appearance when ownership
 * moves between them.
 */
export function geometryRenderStateForTopology(
  topology: PrimitiveTopology,
  renderState: MaterialRenderState | undefined,
): MaterialRenderState | undefined {
  if (topology !== 'line-list' && topology !== 'line-strip') return renderState;
  return {
    ...renderState,
    depthWriteEnabled: false,
    depthCompare: 'less-equal',
  };
}

/**
 * feat-20260604-learn-render-4.10-anti-aliasing-msaa M2 / w9: pick the static
 * unlit geometry pipeline handle for a (tonemapActive x msaaActive)
 * combination. The four mode axes (LDR/HDR x single/MSAA) map to the 14 static
 * pipeline handles built in createRenderer (7 base + 7 count=4 variants). A
 * pipeline's `multisample.count` must match the colour-attachment sampleCount,
 * so the count=4 variant is required whenever the camera carries
 * `antialias === 'msaa'`. Returns null when the requested pipeline was not
 * built (empty-manifest path / MSAA variant build failure) -- the caller fires
 * a structured `shader-compile-failed` on the null-narrow.
 */
// feat-20260615-pipeline-spec-ssot M6-T1: the standard-shading fallback
// selector was deleted. The pre-M6 selector silently substituted the
// boot-time URP `pipelineState.standardPipeline*` whenever the per-
// MaterialShader cache returned null and HDRP was inactive -- masking
// real PipelineSpecError build failures behind a layout-compatible-but-
// wrong PSO. Charter P3 explicit-failure now governs: a missing cache
// entry surfaces as null, and the per-submesh
// `if (smPipelineHandle === null) continue` skip-draw (which already
// covered the HDRP-active and skin-shader miss-skip paths) is the single
// uniform recovery shape across URP / HDRP / skin.

export function selectGeometryPipeline(
  pipelineState: PipelineState,
  tonemapActive: boolean,
  msaaActive: boolean,
): RenderPipeline | null {
  if (tonemapActive) {
    return msaaActive ? pipelineState.unlitPipelineHdrMsaa : pipelineState.unlitPipelineHdr;
  }
  return msaaActive ? pipelineState.unlitPipelineMsaa : pipelineState.unlitPipeline;
}

/**
 * feat-city-glb Bug 5 (per-submesh transparency): true when EVERY submesh
 * material of the entity is transparent (blend). Used by the geometry pass to
 * decide whether to skip the whole entity (fully transparent → deferred to the
 * blend sub-pass) vs. draw its opaque submeshes and skip only the transparent
 * ones per-submesh.
 *
 * Falls back to the entity-level `material.transparent` when `materials` is
 * absent (single-material entities / test fixtures), byte-identical to the
 * pre-fix whole-entity gate.
 *
 * @internal
 */
export function isEntityFullyTransparent(source: {
  readonly material: MaterialSnapshot;
  readonly materials?: readonly MaterialSnapshot[];
}): boolean {
  const mats = source.materials;
  if (mats === undefined || mats.length === 0) return source.material.transparent === true;
  for (let j = 0; j < mats.length; j++) {
    if (mats[j]?.transparent !== true) return false;
  }
  return true;
}

/**
 * feat-20260601-device/gpu-residency-extraction M1 / D-9: resolve a texture's
 * GPU view through the pull-model residency store. The three steps replace the
 * pre-extraction single-call accessor on the registry:
 *   1. fetch the TextureAsset POD off the registry (CPU; registry keeps PODs)
 *   2. synchronously `ensureResident(handle, pod)` (first access builds the
 *      GPU texture + prewarmed mipmap blit; subsequent access is O(1))
 *   3. return the GPU view (or undefined on POD miss / ensureResident err)
 *
 * Returns `undefined` when the POD is absent (handle never registered) or the
 * upload fails (a structured error is fired). Callers then fall back to their
 * existing placeholder view, preserving the pre-extraction fallback semantics.
 */
function isImageError(error: unknown): error is ImageError {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' && code.startsWith('image-');
}

function materialDiagnosticsEnabled(): boolean {
  if (typeof globalThis !== 'object' || globalThis === null || !('process' in globalThis)) {
    return false;
  }
  const processValue = (
    globalThis as {
      readonly process?: { readonly env?: Record<string, string | undefined> };
    }
  ).process;
  return processValue?.env?.FORGEAX_MATERIAL_DIAGNOSTICS === '1';
}

export function residentTextureView(
  world: RenderResourceScope,
  store: GpuResidencyCache,
  runtime: RenderSystemRuntime,
  handle: Handle<'TextureAsset', 'shared'>,
  worldId: RenderResourceScope | number = world,
): TextureView | undefined {
  const podRes = resolveAssetHandle<TextureAsset>(world, handle);
  const diagnosticsEnabled = materialDiagnosticsEnabled();
  if (!podRes.ok) {
    if (diagnosticsEnabled) {
      console.error(
        `[render-material] texture resolve failed: ${JSON.stringify({ handle: handleSlot(handle), error: podRes.error })}`,
      );
    }
    return undefined;
  }
  const residentRes = store.ensureResident(handle, podRes.value, worldId);
  if (!residentRes.ok) {
    // Preserve the concrete asset-capability boundary on the renderer error
    // channel. In particular, WebGL2 texture-dimension refusal must not
    // collapse into the later debug-pink asset-not-registered fallback.
    if (residentRes.error instanceof RhiError || isImageError(residentRes.error)) {
      runtime.errorRegistry.fire(residentRes.error);
    }
    if (diagnosticsEnabled) {
      console.error(
        `[render-material] texture residency failed: ${JSON.stringify({
          handle: handleSlot(handle),
          pod: {
            kind: podRes.value.kind,
            shape: podRes.value.shape,
            format: podRes.value.format,
            dataByteLength: podRes.value.data.byteLength,
            mips: podRes.value.mips,
          },
          error: residentRes.error,
        })}`,
      );
    }
    return undefined;
  }
  const view = store.getTextureGpuView(handle, worldId);
  if (diagnosticsEnabled) {
    console.error(
      `[render-material] texture residency ready: ${JSON.stringify({
        handle: handleSlot(handle),
        pod: {
          kind: podRes.value.kind,
          shape: podRes.value.shape,
          format: podRes.value.format,
          dataByteLength: podRes.value.data.byteLength,
          mips: podRes.value.mips,
        },
        receipt: 'receipt' in residentRes.value ? residentRes.value.receipt : undefined,
        viewReady: view !== undefined,
      })}`,
    );
  }
  return view;
}

function residentSampler(
  world: RenderResourceScope,
  store: GpuResidencyCache,
  runtime: RenderSystemRuntime,
  handle: Handle<'SamplerAsset', 'shared'>,
  worldId: RenderResourceScope | number = world,
): Sampler | undefined {
  const podRes = resolveAssetHandle<SamplerAsset>(world, handle);
  if (!podRes.ok) return undefined;
  const residentRes = store.ensureSamplerResident(handle, podRes.value, worldId);
  if (!residentRes.ok) {
    runtime.errorRegistry.fire(residentRes.error);
    return undefined;
  }
  return residentRes.value;
}

// feat-20260623-world-space-video-asset M4 / w16 (D-3): resolve the
// current-frame GPU view for a video-sourced texture field through the
// transient DynamicTextureStore, NOT the static `residentTextureView` /
// `ensureResident` cache (video never enters that switch; AC-08).
//
// Per frame: ask the host-registered VideoSourceProvider (RenderResourceScope Resource,
// D-1) for this entity's HTMLVideoElement, upload its current frame via
// `store.uploadFrame` (copyExternalImageToTexture), and return the resulting
// view. When the provider is absent / returns no element / the element has no
// decodable dimensions yet, fall back to a previously-uploaded view and
// finally to `undefined` (caller binds the default view this frame — charter
// P3 graceful, no garbage sampling). A failed GPU upload fires the structured
// RhiError on the engine channel and degrades to the default view.
//
// `highPerfAvailable` is the w17 capability probe; the high-perf
// GPUExternalTexture branch is a reserved hook (OOS-5) — when it ever becomes
// available the upload would route there. Today it is always false so the
// general copyExternalImageToTexture path is the only one taken.
type DynamicTextureStore = import('@forgeax/engine-assets-runtime').DynamicTextureStore;

type VideoUploadFailureEpisodes = Map<number, Set<number>>;

// The store is renderer-owned, so this keeps one failure episode per
// renderer/entity/clip without creating a second video system or leaking
// state across a replacement renderer.
const VIDEO_UPLOAD_FAILURE_EPISODES = new WeakMap<
  DynamicTextureStore,
  VideoUploadFailureEpisodes
>();

function markVideoUploadFailureEpisode(
  store: DynamicTextureStore,
  entityKey: number,
  clip: Handle<'VideoAsset', 'shared'>,
): boolean {
  let clips = VIDEO_UPLOAD_FAILURE_EPISODES.get(store);
  if (clips === undefined) {
    clips = new Map();
    VIDEO_UPLOAD_FAILURE_EPISODES.set(store, clips);
  }
  let episodes = clips.get(entityKey);
  if (episodes === undefined) {
    episodes = new Set();
    clips.set(entityKey, episodes);
  }
  const clipId = handleSlot(clip);
  if (episodes.has(clipId)) return false;
  episodes.add(clipId);
  return true;
}

function clearVideoUploadFailureEpisode(
  store: DynamicTextureStore,
  entityKey: number,
  clip: Handle<'VideoAsset', 'shared'>,
): void {
  const clips = VIDEO_UPLOAD_FAILURE_EPISODES.get(store);
  const episodes = clips?.get(entityKey);
  if (episodes === undefined) return;
  episodes.delete(handleSlot(clip));
  if (episodes.size === 0) clips?.delete(entityKey);
  if (clips?.size === 0) VIDEO_UPLOAD_FAILURE_EPISODES.delete(store);
}

function videoSourceElement(
  world: RenderResourceScope,
  entityKey: number,
  clip: Handle<'VideoAsset', 'shared'>,
): HTMLVideoElement | VideoFrame | undefined {
  if ('resolveAsset' in world) return world.videoFrame(entityKey, clip);
  return world.hasResource(VIDEO_SOURCE_PROVIDER_KEY)
    ? world
        .getResource<VideoSourceProvider>(VIDEO_SOURCE_PROVIDER_KEY)
        .getSource(entityKey as EntityHandle, clip)
    : undefined;
}

const DIRECT_VIDEO_KEYS = new WeakMap<DynamicTextureStore, Map<number, object>>();

/** texture_external slots sample in source orientation, so their copies use a separate unflipped key. */
function directVideoKey(store: DynamicTextureStore, clip: Handle<'VideoAsset', 'shared'>): object {
  let keys = DIRECT_VIDEO_KEYS.get(store);
  if (keys === undefined) {
    keys = new Map();
    DIRECT_VIDEO_KEYS.set(store, keys);
  }
  let key = keys.get(handleSlot(clip));
  if (key === undefined) {
    key = {};
    keys.set(handleSlot(clip), key);
  }
  return key;
}

/**
 * Copy path for one VideoPlayer field. `slotExternal` selects the unflipped
 * copy that a `texture_external` slot samples when zero-copy import is absent.
 */
export function videoTextureView(
  world: RenderResourceScope,
  store: DynamicTextureStore | undefined,
  runtime: RenderSystemRuntime,
  entityKey: number,
  clip: Handle<'VideoAsset', 'shared'>,
  slotExternal = false,
): TextureView | undefined {
  if (store === undefined) return undefined;
  const key = slotExternal ? directVideoKey(store, clip) : clip;
  const element = videoSourceElement(world, entityKey, clip);
  // Both upload paths need a host element. Bind the last good (or default)
  // view so the draw survives, but report the dead path once per episode.
  if (element === undefined) {
    if (markVideoUploadFailureEpisode(store, entityKey, clip)) {
      runtime.errorRegistry.fire(new VideoUploadUnsupportedError());
    }
    return store.getView(key);
  }
  const extent = videoSourceExtent(element);
  if (extent === undefined) return store.getView(key);
  const { width, height } = extent;
  const uploaded = store.uploadFrame(key, element, width, height, { flipY: !slotExternal });
  if (uploaded === undefined) return store.getView(key);
  if (!uploaded.ok) {
    runtime.errorRegistry.fire(uploaded.error);
    return store.getView(key);
  }
  clearVideoUploadFailureEpisode(store, entityKey, clip);
  return uploaded.value;
}

/**
 * Binding for one VideoPlayer field. A `texture_external` slot imports the
 * current frame zero-copy when the device reports `caps.externalTexture`;
 * everything else takes the copy path.
 */
export function videoBindingResource(
  world: RenderResourceScope,
  runtime: RenderSystemRuntime,
  entityKey: number,
  clip: Handle<'VideoAsset', 'shared'>,
  highPerfAvailable: boolean,
  slotExternal: boolean,
): RhiBindingResource | undefined {
  if (slotExternal && highPerfAvailable && runtime.externalTextures !== undefined) {
    const element = videoSourceElement(world, entityKey, clip);
    const external =
      element !== undefined && videoSourceExtent(element) !== undefined
        ? runtime.externalTextures.importVideoFrame(element)
        : undefined;
    if (external !== undefined) {
      const store = runtime.dynamicTextureStore;
      if (store !== undefined) clearVideoUploadFailureEpisode(store, entityKey, clip);
      return { kind: 'externalTexture', value: external };
    }
  }
  const view = videoTextureView(
    world,
    runtime.dynamicTextureStore,
    runtime,
    entityKey,
    clip,
    slotExternal,
  );
  return view === undefined ? undefined : { kind: 'textureView', value: view };
}

// The canonical schema owns the runtime fallback's binding order as well as
// its shader and BGL. A second slot list makes later engine injections drift.
export const BUILTIN_USER_REGION_TEXTURE_FIELDS: readonly string[] = [
  ...derive(STANDARD_PIPELINE_PARAM_SCHEMA).textureFieldNames,
];

const LEGACY_MATERIAL_TEXTURE_SCALE_OFFSET = 80;
const LEGACY_MATERIAL_TEXTURE_SCALE_FIELDS = [
  'baseColorTexture',
  'metallicRoughnessTexture',
  'normalTexture',
  'emissiveTexture',
  'occlusionTexture',
] as const;
const IDENTITY_TEXTURE_SCALE: readonly [number, number] = Object.freeze([1, 1]);
const DEFAULT_LEGACY_TEXTURE_SCALES = new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);

/** Derives the logical-content UV scale for an uploaded material texture. */
export function materialTextureUvScale(
  texture: Pick<TextureAsset, 'shape' | 'format'> | undefined,
): readonly [number, number] {
  if (texture === undefined) return [1, 1];
  return deriveTextureUvScale(
    texture.format,
    texture.shape.extent.width,
    texture.shape.extent.height,
  );
}

function materialTextureForField(
  material: MaterialSnapshot,
  field: string,
): Handle<'TextureAsset', 'shared'> | undefined {
  if (field === 'emissiveTexture') return material.emissiveTexture;
  if (field === 'occlusionTexture') return material.occlusionTexture;
  return material.textureHandles?.get(field);
}

/** Resolve a renderer-local target source without entering AssetRegistry. */
export function materialRenderTargetSourceForField(
  material: MaterialSnapshot,
  field: string,
  resolveSource?: RenderSystemRuntime['resolveRenderTargetTextureSource'],
): RenderTargetMaterialSourceBinding | undefined {
  const source = material.textureSources?.get(field);
  return source === undefined || isCanvasTextureSource(source) || isExternalTextureSource(source)
    ? undefined
    : (resolveSource?.(source) ?? resolveRenderTargetMaterialSource(source));
}

/** Upload the current Canvas version through the same store as video frames. */
export function materialCanvasTextureView(
  material: MaterialSnapshot,
  field: string,
  world: RenderResourceScope,
  runtime: RenderSystemRuntime,
): TextureView | undefined {
  const source = material.textureSources?.get(field);
  const store = runtime.dynamicTextureStore;
  if (!isCanvasTextureSource(source) || store === undefined) return undefined;
  const local = canvasTextureState(source);
  const published =
    'resolveAsset' in world ? world.canvasFrame?.(source.canvasTextureId) : undefined;
  const image = local?.canvas ?? published?.frame;
  const key = local === undefined ? published?.key : source;
  if (key === undefined) return undefined;
  if (image === undefined) return store.getView(key);
  const width = 'displayWidth' in image ? image.displayWidth : image.width;
  const height = 'displayHeight' in image ? image.displayHeight : image.height;
  const uploaded = store.uploadFrame(key, image, width, height, {
    version: local?.version ?? published?.version,
    generateMipmaps: true,
    flipY: source.flipY,
    signal: local?.lifetime.signal ?? published?.signal,
  });
  if (uploaded !== undefined && !uploaded.ok) runtime.errorRegistry.fire(uploaded.error);
  return uploaded?.ok ? uploaded.value : store.getView(key);
}

/**
 * Appends the engine-owned scale for every built-in material texture binding.
 * Asset dimensions remain logical; this is the sole record-stage projection
 * from a bound texture asset to its shader sampling coordinates.
 */
type MaterialUboPayload = ArrayBuffer | Uint8Array | Float32Array;

function materialUboFloatView(payload: MaterialUboPayload): Float32Array {
  if (payload instanceof Float32Array) return payload;
  return payload instanceof Uint8Array
    ? new Float32Array(payload.buffer, payload.byteOffset, payload.byteLength / 4)
    : new Float32Array(payload);
}

function materialUboDataView(payload: MaterialUboPayload): DataView {
  if (payload instanceof Float32Array || payload instanceof Uint8Array) {
    return new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  return new DataView(payload);
}

const materialNumericViews = new WeakMap<Float32Array, DataView>();

function materialNumericView(payload: MaterialUboPayload): DataView {
  if (!(payload instanceof Float32Array)) return materialUboDataView(payload);
  let view = materialNumericViews.get(payload);
  if (view === undefined) {
    view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    materialNumericViews.set(payload, view);
  }
  return view;
}

/** Write one schema value with the scalar type's actual WGSL bit encoding. */
function writeNumericParamValue(
  view: DataView,
  entry: { readonly offset: number; readonly size: number; readonly type: string },
  value: number | readonly number[],
): void {
  if (entry.type === 'i32' || entry.type === 'u32') {
    const component = typeof value === 'number' ? value : value[0];
    if (typeof component !== 'number') return;
    if (entry.type === 'i32') view.setInt32(entry.offset, component, true);
    else view.setUint32(entry.offset, component, true);
    return;
  }
  if (
    entry.type !== 'f32' &&
    entry.type !== 'vec2' &&
    entry.type !== 'vec3' &&
    entry.type !== 'vec4' &&
    entry.type !== 'color'
  )
    return;
  if (typeof value === 'number') {
    view.setFloat32(entry.offset, value, true);
    return;
  }
  const writeCount = Math.min(value.length, entry.size / 4);
  for (let index = 0; index < writeCount; index += 1) {
    const component = value[index];
    if (typeof component === 'number') view.setFloat32(entry.offset + index * 4, component, true);
  }
}

export function applyMaterialTextureUvScales(
  payload: MaterialUboPayload,
  material: MaterialSnapshot,
  world: RenderResourceScope,
): void {
  const f32 = materialUboFloatView(payload);
  const coordinateSchema = materialParameterSchema(material);
  if (coordinateSchema !== undefined) {
    const coordinateRecords = derive(
      coordinateSchema,
      STANDARD_PIPELINE_PARAM_SCHEMA,
    ).coordinateRecords;
    for (const record of coordinateRecords) {
      const field = record.parameter;
      const handle = materialTextureForField(material, field);
      const resolvedTexture =
        handle === undefined ? undefined : resolveAssetHandle<TextureAsset>(world, handle);
      const texture = resolvedTexture?.ok === true ? resolvedTexture.value : undefined;
      const physicalScale =
        texture === undefined ? IDENTITY_TEXTURE_SCALE : materialTextureUvScale(texture);
      writeMaterialTextureCoordinateRecord(
        f32,
        record.offset / 4,
        material.textureCoordinates?.get(field),
        physicalScale,
      );
    }
    return;
  }
  // Unknown legacy material paths retain their historical packed scale tail.
  // Every registered Standard/material-schema path returns above and is
  // therefore fully schema-driven (including physical texture coordinates).
  const textureScaleOffset = LEGACY_MATERIAL_TEXTURE_SCALE_OFFSET;
  const hasTextureMetadata =
    material.textureCoordinates !== undefined ||
    material.textureHandles !== undefined ||
    material.videoTextureFields !== undefined ||
    material.baseColorTexture !== undefined ||
    material.metallicRoughnessTexture !== undefined ||
    material.normalTexture !== undefined ||
    material.emissiveTexture !== undefined ||
    material.occlusionTexture !== undefined;
  if (!hasTextureMetadata) {
    f32.set(DEFAULT_LEGACY_TEXTURE_SCALES, textureScaleOffset / 4);
    return;
  }
  const fields = LEGACY_MATERIAL_TEXTURE_SCALE_FIELDS;
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (field === undefined) continue;
    const handle = materialTextureForField(material, field);
    const resolved =
      handle === undefined ? undefined : resolveAssetHandle<TextureAsset>(world, handle);
    const texture = resolved?.ok === true ? resolved.value : undefined;
    const scale = texture === undefined ? IDENTITY_TEXTURE_SCALE : materialTextureUvScale(texture);
    const offset = textureScaleOffset / 4 + index * 2;
    f32[offset] = scale[0];
    f32[offset + 1] = scale[1];
  }
}

function materialParameterSchema(
  material: MaterialSnapshot,
): readonly ParamSchemaEntry[] | undefined {
  if (material.materialParamSchema !== undefined && material.materialParamSchema.length > 0) {
    return material.materialParamSchema;
  }
  if (isStandardPbrMaterialShader(material.materialShaderId)) return STANDARD_PIPELINE_PARAM_SCHEMA;
  switch (material.materialShaderId) {
    case 'forgeax::default-unlit':
      return DEFAULT_UNLIT_PARAM_SCHEMA;
    case 'forgeax::sprite':
    case 'forgeax::sprite-lit':
      return DEFAULT_SPRITE_PARAM_SCHEMA;
    case 'forgeax::msdf-text':
      return DEFAULT_MSDF_TEXT_PARAM_SCHEMA;
    default:
      return undefined;
  }
}

/**
 * feat-20260621-learn-render-5-5-parallax M2 / w8 (D-3): ordered user-region
 * texture field names for a material's bind-group assembly, derived from the
 * shader's paramSchema via the `derive()` SSOT (insertion order = sampler/
 * texture pair order in derive().bglEntries). Falls back to the built-in
 * fields only when the schema is unavailable; an explicit empty schema means
 * the authored material has no user-region textures.
 */
export function userRegionTextureFieldOrder(
  schema: Parameters<typeof derive>[0] | undefined,
): readonly string[] {
  if (schema === undefined) return BUILTIN_USER_REGION_TEXTURE_FIELDS;
  const admitted = materialTextureProjection(schema);
  return admitted?.textureFields ?? [...derive(schema).textureFieldNames];
}

/** Preserve the Standard ABI's canonical region and physical injection tail. */
function materialUserRegionFields(
  shaderId: string | undefined,
  layout: BindGroupLayout | undefined,
  schema: readonly ParamSchemaEntry[] | undefined,
): readonly string[] {
  if (
    layout === undefined ||
    isCanonicalStandardPbrMaterialShader(shaderId) ||
    schema === undefined
  )
    return BUILTIN_USER_REGION_TEXTURE_FIELDS;
  const projection = materialTextureProjection(schema);
  if (projection !== undefined) return projection.standardUserFields;
  const physicalFields = physicalTextureFields(schema);
  return userRegionTextureFieldOrder(schema).filter((field) => !physicalFields.includes(field));
}

const TARGET_VIEW_DIMENSION_FOR_PARAMETER: Readonly<Record<string, string>> = {
  texture2d: '2d',
  texture_cube: 'cube',
  texture3d: '3d',
  texture2d_array: '2d-array',
};

/**
 * A target source binds only into a param of its own view dimension; a
 * mismatch would invalidate the material BGL, so the draw stays on the
 * fallback and is reported non-resident.
 */
export function renderTargetSourceFitsParameter(
  binding: RenderTargetMaterialSourceBinding,
  field: string | undefined,
  schema?: readonly ParamSchemaEntry[],
): boolean {
  const type = parameterByName(schema, field)?.type;
  return renderTargetSourceFitsParameterType(binding, type);
}

function renderTargetSourceFitsParameterType(
  binding: RenderTargetMaterialSourceBinding,
  type: ParamSchemaEntry['type'] | undefined,
): boolean {
  const expected = type === undefined ? undefined : TARGET_VIEW_DIMENSION_FOR_PARAMETER[type];
  return expected === undefined || expected === binding.view.dimension;
}

/**
 * feat-20260621-learn-render-5-5-parallax M2 / w8: the fallback texture view
 * for a user-region field when no handle is provided (graceful, charter P3).
 * normalTexture decodes to a flat tangent normal; everything else (baseColor,
 * MR, height, ...) uses the 1x1 white default (height white -> zero displacement).
 */
export function defaultViewForUserRegionField(
  field: string,
  pipelineState: PipelineState,
  schema?: readonly ParamSchemaEntry[],
): TextureView {
  const parameter = parameterByName(schema, field);
  if (parameter?.type === 'texture_cube') {
    // The renderer already owns a valid white cube for the Skylight fallback.
    // Use it until a receipt-promoted RenderTarget source becomes available;
    // binding a 2D view here would invalidate the custom cube material BGL.
    return pipelineState.skylightFallback?.prefilterView ?? pipelineState.defaultWhiteTextureView;
  }
  if (parameter?.type === 'texture3d') {
    return pipelineState.defaultWhite3dTextureView ?? pipelineState.defaultWhiteTextureView;
  }
  if (parameter?.type === 'texture2d_array') {
    return pipelineState.defaultWhite2dArrayTextureView ?? pipelineState.defaultWhiteTextureView;
  }
  if (field === 'normalTexture') return pipelineState.defaultNormalTextureView;
  if (field === 'baseColorTexture') return pipelineState.fallbackTextureView;
  if (field === 'anisotropyTexture') {
    // The flat-normal fallback encodes a zero tangent direction and unit B
    // strength; the shader's zero-vector guard selects its neutral (1, 0)
    // axis. This keeps an absent anisotropy map neutral even on hosts that do
    // not allocate the optional dedicated identity texture.
    return pipelineState.defaultAnisotropyTextureView ?? pipelineState.defaultNormalTextureView;
  }
  return pipelineState.defaultWhiteTextureView;
}

function defaultViewForParameterType(
  field: string,
  pipelineState: PipelineState,
  type: ParamSchemaEntry['type'] | undefined,
): TextureView {
  if (type === 'texture_cube') {
    // The renderer already owns a valid white cube for the Skylight fallback.
    // Use it until a receipt-promoted RenderTarget source becomes available;
    // binding a 2D view here would invalidate the custom cube material BGL.
    return pipelineState.skylightFallback?.prefilterView ?? pipelineState.defaultWhiteTextureView;
  }
  if (type === 'texture3d') {
    return pipelineState.defaultWhite3dTextureView ?? pipelineState.defaultWhiteTextureView;
  }
  if (type === 'texture2d_array') {
    return pipelineState.defaultWhite2dArrayTextureView ?? pipelineState.defaultWhiteTextureView;
  }
  if (field === 'normalTexture') return pipelineState.defaultNormalTextureView;
  if (field === 'baseColorTexture') return pipelineState.fallbackTextureView;
  if (field === 'anisotropyTexture') {
    // The flat-normal fallback encodes a zero tangent direction and unit B
    // strength; the shader's zero-vector guard selects its neutral (1, 0)
    // axis. This keeps an absent anisotropy map neutral even on hosts that do
    // not allocate the optional dedicated identity texture.
    return pipelineState.defaultAnisotropyTextureView ?? pipelineState.defaultNormalTextureView;
  }
  return pipelineState.defaultWhiteTextureView;
}

/**
 * feat-20260527-sprite-nineslice M4 / w17 (AC-16): once-per-renderable
 * detection of "Transform.scale below the four 9-slice corner anchors". Pure
 * helper extracted out of recordFrame so unit tests can drive it without a
 * GPU device — the recordFrame loop calls this with its `transformWorld` /
 * `slices` / `renderableIndex` / `seenIndices` / `metrics` arguments.
 *
 * The scale-vs-anchor formula mirrors plan-strategy §D-3 — the world x scale must
 * accommodate `|slices.x| + |slices.z|`, and `scaleY` must accommodate
 * `|slices.y| + |slices.w|`. Slices ≡ all zero is a no-op (legacy quad
 * path); a breach increments `nineslice.scale-too-small` exactly once per
 * `renderableIndex` per RenderSystem lifetime via the `seenIndices` Set
 * (the same warn-once anchor pattern used for missing-texture sprites).
 *
 * @param transformWorld The entity's resolved GlobalTransform.world mat4 (16 floats column-major).
 * @param slices         The four anchor distances `[left, top, right, bottom]`
 *                       (sentinel `bottom < 0` for tile mode is consumed via abs()).
 * @param renderableIndex The entity index into the validated renderables list.
 * @param seenIndices    The per-frame-state guard Set; entries are added on increment.
 * @param metrics        The owner-provided EngineMetrics counter.
 * @internal — exported for unit-test access (w17).
 */
export function detectNineSliceScaleTooSmall(
  transformWorld: Float32Array,
  slices: readonly [number, number, number, number],
  renderableIndex: number,
  seenIndices: Set<number>,
  metrics: { increment(name: string): void },
): void {
  const anyNonZero = slices[0] !== 0 || slices[1] !== 0 || slices[2] !== 0 || slices[3] !== 0;
  if (!anyNonZero) return;
  const sx = Math.hypot(transformWorld[0] ?? 1, transformWorld[1] ?? 0, transformWorld[2] ?? 0);
  const sy = Math.hypot(transformWorld[4] ?? 0, transformWorld[5] ?? 1, transformWorld[6] ?? 0);
  const horizontalAnchor = Math.abs(slices[0]) + Math.abs(slices[2]);
  const verticalAnchor = Math.abs(slices[1]) + Math.abs(slices[3]);
  if (sx < horizontalAnchor || sy < verticalAnchor) {
    if (!seenIndices.has(renderableIndex)) {
      seenIndices.add(renderableIndex);
      metrics.increment('nineslice.scale-too-small');
    }
  }
}

/** Build one max-sized, schema-driven Standard material UBO payload. */
export function buildPbrMaterialUboPayload(material: MaterialSnapshot): Uint8Array {
  const bytes = Math.max(
    STANDARD_PBR_UBO_SIZE,
    derive(material.materialParamSchema ?? []).uboLayout.totalBytes,
  );
  const buf = new Uint8Array(bytes);
  writePbrMaterialUboPayload(buf, material);
  return buf;
}

const UNIT_MATERIAL_VEC3: readonly number[] = Object.freeze([1, 1, 1]);
const UNIT_MATERIAL_VEC2: readonly number[] = Object.freeze([1, 1]);
const ZERO_MATERIAL_VEC3: readonly number[] = Object.freeze([0, 0, 0]);

function materialNumericFallback(
  material: MaterialSnapshot,
  name: string,
  entry: { readonly name: string; readonly default?: unknown },
): unknown {
  switch (name) {
    case 'metallic':
      return material.metallic;
    case 'roughness':
      return material.roughness;
    case 'specularColor':
      return material.specularColor ?? UNIT_MATERIAL_VEC3;
    case 'normalScale':
      return material.normalScale ?? UNIT_MATERIAL_VEC2;
    case 'emissive':
      return material.emissive ?? ZERO_MATERIAL_VEC3;
    case 'emissiveIntensity':
      return material.emissiveIntensity ?? entry.default;
    case 'occlusionStrength':
      return material.occlusionStrength ?? 1;
    default:
      return entry.default;
  }
}

function writeBaseColorFallback(
  view: DataView,
  entry: { readonly offset: number; readonly size: number; readonly type: string },
  red: number,
  green: number,
  blue: number,
): void {
  if (entry.type === 'i32' || entry.type === 'u32') {
    writeNumericParamValue(view, entry, red);
    return;
  }
  if (
    entry.type !== 'f32' &&
    entry.type !== 'vec2' &&
    entry.type !== 'vec3' &&
    entry.type !== 'vec4' &&
    entry.type !== 'color'
  )
    return;
  const count = Math.min(4, entry.size / 4);
  if (count > 0 && typeof red === 'number') view.setFloat32(entry.offset, red, true);
  if (count > 1 && typeof green === 'number') view.setFloat32(entry.offset + 4, green, true);
  if (count > 2 && typeof blue === 'number') view.setFloat32(entry.offset + 8, blue, true);
  if (count > 3) view.setFloat32(entry.offset + 12, 1, true);
}

/**
 * Write the standard material payload into caller-owned storage.
 *
 * The allocating wrapper above remains the helper/test surface, while the
 * frame recorder reuses one scratch slot for all materials.  Field offsets are
 * read from the material's admitted schema; no Standard field offset table is
 * maintained in the record stage.
 */
export function writePbrMaterialUboPayload(
  buf: Uint8Array | Float32Array,
  material: MaterialSnapshot,
  view?: DataView,
): ReturnType<typeof derive> {
  if (buf.byteLength < STANDARD_PBR_UBO_SIZE) {
    throw new RangeError(
      `writePbrMaterialUboPayload: expected at least ${STANDARD_PBR_UBO_SIZE} bytes, got ${buf.byteLength}`,
    );
  }
  buf.fill(0);
  const dataView = view ?? materialNumericView(buf);
  const schema = materialParameterSchema(material) ?? STANDARD_PIPELINE_PARAM_SCHEMA;
  const snapshot = material.paramSnapshot;
  const derived = derive(schema, STANDARD_PIPELINE_PARAM_SCHEMA);
  const parametersByName = materialTextureProjection(schema)?.parametersByName;
  for (const entry of derived.uboLayout.entries) {
    let value: unknown = snapshot?.[entry.name];
    if (value === undefined || value === null) {
      const schemaEntry =
        (parametersByName === undefined
          ? schema.find((item) => item.name === entry.name)
          : parametersByName.get(entry.name)) ?? entry;
      if (entry.name === 'baseColor') {
        // Capture all components before writing, as the former tuple did.
        const red = material.baseColor[0] ?? 1;
        const green = material.baseColor[1] ?? 1;
        const blue = material.baseColor[2] ?? 1;
        writeBaseColorFallback(dataView, entry, red, green, blue);
        continue;
      }
      value = materialNumericFallback(material, entry.name, schemaEntry);
    }
    if (typeof value === 'number') {
      writeNumericParamValue(dataView, entry, value);
    } else if (Array.isArray(value)) {
      writeNumericParamValue(dataView, entry, value);
    }
  }
  return derived;
}

/**
 * Generic std140 UBO writer driven by `derive(paramSchema).uboLayout.entries`
 * (feat-20260625-refactor-sprite-as-transparent-mesh M1 / w3, plan-strategy
 * section 2 D-2).
 *
 * For each numeric entry in the schema, looks up the matching value in
 * `paramSnapshot` and writes it at the std140 offset `derive` computed.
 * Vec / color entries pull from `paramSnapshot[name]` as a `readonly number[]`
 * (writes `min(size/4, value.length)` floats, padding with 0 if shorter for
 * the field's declared width); scalar entries pull a single number.
 *
 * Behaviour:
 *   - schema or snapshot `undefined` -> no writes (caller may keep payload
 *     baseline).
 *   - missing snapshot field -> that field's bytes are left untouched
 *     (overlay semantics; same shape the legacy inline overlay had).
 *   - field type the writer cannot interpret (texture / sampler / storage_
 *     buffer / value-type mismatch) -> skipped silently; `derive` strips
 *     non-numeric entries from `uboLayout.entries` so the loop only iterates
 *     numeric fields.
 *
 * The writer reads `paramSnapshot` only -- it does NOT call
 * `runtime.assets.get<MaterialAsset>` or cast `firstMaterial`. Gate R-H
 * (plan-strategy section 5.6) bans those paths through
 * `scripts/forgeax/check-render-record-no-material-asset-get.mjs`.
 *
 * standard-pbr remains byte-identical to `buildPbrMaterialUboPayload`: the
 * engine's stock PBR material ships `paramSnapshot: undefined`, so this
 * writer is a no-op on that path; the explicit field writes in the helper
 * above cover every byte. User shaders (sprite-shaped 4 x vec4 or another
 * paramSchema) get their fields written at the offsets declared by derive.
 *
 * @internal export-for-test (consumed inside `recordFrame` + render-system-
 * record.test.ts; not part of the package's public surface).
 */
export function applyParamSnapshotToUbo(
  payload: MaterialUboPayload,
  paramSchema: readonly ParamSchemaEntry[] | undefined,
  paramSnapshot:
    | Readonly<Record<string, number | readonly number[] | string | undefined>>
    | undefined,
  view?: DataView,
): void {
  if (paramSchema === undefined) return;
  if (paramSnapshot === undefined) return;
  const dataView = view ?? materialNumericView(payload);
  const { uboLayout } = derive(paramSchema);
  for (const entry of uboLayout.entries) {
    const value = paramSnapshot[entry.name];
    if (value === undefined) continue;
    if (typeof value === 'number') {
      writeNumericParamValue(dataView, entry, value);
      continue;
    }
    if (Array.isArray(value)) {
      const arr = value as readonly number[];
      writeNumericParamValue(dataView, entry, arr);
    }
    // string values (texture GUIDs) belong to texture bindings, not the
    // UBO; derive's uboLayout.entries already strips non-numeric schema
    // entries, so we will not see a uboLayout entry whose snapshot value
    // is a string under normal flow. Skip defensively if we do.
  }
}

/**
 * Seed a schema-driven UBO with the defaults declared by its numeric contract.
 *
 * Prepared graphics (VFX and other feature-owned materials) do not pass
 * through the extracted `MaterialSnapshot` writer, so their payload starts as
 * zeroed storage. Applying the schema defaults first keeps that path
 * byte-compatible with the ordinary material writer while preserving the
 * snapshot writer's intentional overlay semantics.
 */
export function applyParamSchemaDefaultsToUbo(
  payload: MaterialUboPayload,
  paramSchema: readonly ParamSchemaEntry[] | undefined,
): void {
  if (paramSchema === undefined) return;
  const admitted = getAdmittedParamSchemaInterface(paramSchema);
  if (admitted !== undefined) {
    const view = materialUboDataView(payload);
    const parametersByName = materialTextureProjection(paramSchema)?.parametersByName;
    for (const entry of admitted.uboLayout.entries) {
      const schemaEntry = parametersByName?.get(entry.name);
      const value =
        schemaEntry !== undefined && 'default' in schemaEntry ? schemaEntry.default : undefined;
      if (typeof value === 'number' || Array.isArray(value)) {
        writeNumericParamValue(view, entry, value as number | readonly number[]);
      }
    }
    return;
  }
  // Raw schema getters may change the layout while defaults are captured.
  // Keep the two observations and deferred write boundary on that surface.
  const defaults: Record<string, number | readonly number[]> = {};
  const derived = derive(paramSchema);
  const parametersByName = materialTextureProjection(paramSchema)?.parametersByName;
  for (const entry of derived.uboLayout.entries) {
    const schemaEntry =
      parametersByName === undefined
        ? paramSchema.find((candidate) => candidate.name === entry.name)
        : parametersByName.get(entry.name);
    const value =
      schemaEntry !== undefined && 'default' in schemaEntry ? schemaEntry.default : undefined;
    if (typeof value === 'number' || Array.isArray(value)) {
      defaults[entry.name] = value as number | readonly number[];
    }
  }
  applyParamSnapshotToUbo(payload, paramSchema, defaults);
}

/**
 * feat-20260704 M3/w19: shared per-submesh material bind-group assembly, hoisted
 * from the `buildPerSubmeshMaterialBg` closure inside recordMainPass so both the
 * geometry pass and the LDR blend sub-pass (extracted to separate functions)
 * call the identical layout.
 *
 * feat-city-glb Bug 5 (per-submesh transparency): a transparent PBR submesh
 * binds the identical metallic/roughness/normal/emissive/occlusion +
 * Skylight layout the geometry pass uses (the sub-pass previously bound a
 * sprite-only BG, which cannot render a PBR decal). The per-frame closure state
 * (runtime / pipelineState / world / store / skylightResources / the shared
 * material BG cache + counters) is threaded through `deps`; the caller passes
 * the per-submesh material snapshot + entityKey (video texture routing) and sets
 * the dynamic UBO offset itself.
 *
 * @internal
 */
export interface PerSubmeshMaterialBgDeps {
  readonly planarReflectionView?: TextureView;
  readonly runtime: RenderSystemRuntime;
  readonly pipelineState: PipelineState;
  readonly world: RenderResourceScope;
  readonly store: GpuResidencyCache;
  readonly materialSlice: number;
  readonly videoHighPerfAvailable: boolean;
  readonly skylightResources: SkylightBindGroupResources;
  readonly resolveRenderTargetTextureSource?: RenderSystemRuntime['resolveRenderTargetTextureSource'];
  readonly resolveReflectionProbeResources?: (
    materialWorld: RenderResourceScope,
    entityKey: number,
  ) => { readonly resources: SkylightBindGroupResources; readonly probeIndex: number } | undefined;
  readonly materialBgShared: Map<string, WeakMap<object, unknown>>;
  /** Cross-frame final BG reuse keyed by the stable source material handle. */
  readonly materialBgAssemblyCache: MaterialBgAssemblyCache;
  /** Producer-owned numeric scene rows consumed by scene-index PBR draws. */
  readonly sceneMaterialBuffer?: Buffer;
  /** Active transmission backdrop; undefined/null means layout placeholder. */
  readonly transmissionBackdropView?: TextureView | null;
  /** Independent sampled raw depth for the active medium graph pass. */
  readonly surfaceRawDepthView?: TextureView | null;
  /** Nearest-layer color from the preceding medium graph pass. */
  readonly surfaceNearestLayerView?: TextureView | null;
  /** Nearest-layer depth from the preceding medium graph pass. */
  readonly surfaceNearestDepthView?: TextureView | null;
  readonly bindGroupCounts: BindGroupCounts;
  readonly frameState: RenderFrameState;
}

function recordIblMaterialBinding(
  frameState: RenderFrameState,
  materialBgl: BindGroupLayout,
  bindGroup: BindGroup,
  entries: readonly BindGroupEntry[],
  iblStart: number,
  cache: 'hit' | 'miss',
): void {
  const receipt = frameState.iblBindingInspection;
  if (receipt === undefined) return;
  const skylightBindingStart = entries.findIndex((entry) => entry.binding === iblStart);
  if (skylightBindingStart < 0) return;
  const iblEntries = entries.slice(skylightBindingStart, skylightBindingStart + 6);
  const projected: IblBindingEntryInspection[] = [];
  for (const entry of iblEntries) {
    const { kind } = entry.resource;
    if (kind === 'externalTexture' || kind === 'accelerationStructure') continue;
    const value =
      entry.resource.kind === 'buffer' ? entry.resource.value.buffer : entry.resource.value;
    if (typeof value !== 'object' || value === null) continue;
    projected.push({
      binding: entry.binding,
      kind: entry.resource.kind,
      resourceIdentity: getOpaqueResourceIdentity(value as object),
    });
  }
  frameState.iblBindingInspection = {
    ...receipt,
    material: {
      bindGroupIdentity: getOpaqueResourceIdentity(bindGroup as object),
      materialBglIdentity: getOpaqueResourceIdentity(materialBgl as object),
      cache,
      skylightBindingStart: iblEntries[0]?.binding ?? 0,
      entries: projected,
      reflectionBindings: projected.map((entry) => entry.binding),
    },
    errors: [],
  };
}

const nativeMaterialMapIterator = Map.prototype[Symbol.iterator];
const nativeMaterialMapForEach = Map.prototype.forEach;

interface MaterialMapComparison {
  readonly right: ReadonlyMap<string, number> | undefined;
  same: boolean;
}

function compareMaterialMapEntry(this: MaterialMapComparison, handle: number, field: string): void {
  if (this.same && this.right?.get(field) !== handle) this.same = false;
}

function sameCustomMaterialMap(
  left: ReadonlyMap<string, number>,
  right: ReadonlyMap<string, number> | undefined,
  iterator: ReadonlyMap<string, number>[typeof Symbol.iterator],
): boolean {
  // Preserve a custom iterator's receiver, single acquisition and IteratorClose.
  const entries = { [Symbol.iterator]: () => iterator.call(left) };
  for (const [field, handle] of entries) if (right?.get(field) !== handle) return false;
  return true;
}

function sameMaterialHandleMap(
  left: ReadonlyMap<string, number> | undefined,
  right: ReadonlyMap<string, number> | undefined,
): boolean {
  if (left === right) return true;
  if ((left?.size ?? 0) !== (right?.size ?? 0)) return false;
  if (left !== undefined) {
    const iterator = left[Symbol.iterator];
    if (iterator === nativeMaterialMapIterator) {
      // Native Worker maps need no iterator-result and entry-pair allocations.
      // Read live values every time; resource maps are not immutable facts.
      const comparison: MaterialMapComparison = { right, same: true };
      nativeMaterialMapForEach.call(left, compareMaterialMapEntry, comparison);
      return comparison.same;
    }
    return sameCustomMaterialMap(left, right, iterator);
  }
  return true;
}

/** Uniform row values are not bind-group resources; Worker cloning preserves these handles. */
function sameMaterialBindingSources(left: MaterialSnapshot, right: MaterialSnapshot): boolean {
  return (
    left === right ||
    (left.standardTextureMask === right.standardTextureMask &&
      left.emissiveTexture === right.emissiveTexture &&
      left.occlusionTexture === right.occlusionTexture &&
      // On the minimum texture budget, declaring transmission remaps scalar slots.
      (left.paramSnapshot?.transmission === undefined) ===
        (right.paramSnapshot?.transmission === undefined) &&
      sameMaterialHandleMap(left.textureHandles, right.textureHandles) &&
      sameMaterialHandleMap(left.samplerHandles, right.samplerHandles))
  );
}

/** @internal Exported only so buffer-generation invalidation stays regression-tested. */
export function isMaterialBgAssemblyCacheHit(
  cached: MaterialBgAssemblyCacheEntry | undefined,
  material: MaterialSnapshot,
  materialBgl: BindGroupLayout,
  materialBuffer: Buffer,
  skylightResources: SkylightBindGroupResources,
  materialResourceEpoch: number,
  transmissionBackdropView?: TextureView | null,
  sceneMaterialBuffer?: Buffer,
  surfaceRawDepthView?: TextureView | null,
): cached is MaterialBgAssemblyCacheEntry {
  // Logical target sources keep their identity when a resize promotes a new
  // physical view. Resolve those views each frame; the lower binding cache is
  // keyed by the actual GPU resources and still reuses unchanged bindings.
  if (
    transmissionBackdropView != null ||
    surfaceRawDepthView != null ||
    (material.textureSources?.size ?? 0) > 0 ||
    (material.videoTextureFields?.size ?? 0) > 0
  )
    return false;
  return (
    cached !== undefined &&
    sameMaterialBindingSources(cached.material, material) &&
    cached.materialResourceEpoch === materialResourceEpoch &&
    cached.materialBgl === materialBgl &&
    cached.materialBuffer === materialBuffer &&
    cached.sceneMaterialBuffer === sceneMaterialBuffer &&
    cached.skylightResources.irradianceView === skylightResources.irradianceView &&
    cached.skylightResources.irradianceSampler === skylightResources.irradianceSampler &&
    cached.skylightResources.prefilterView === skylightResources.prefilterView &&
    cached.skylightResources.skylightPrefilterView === skylightResources.skylightPrefilterView &&
    cached.skylightResources.prefilterSampler === skylightResources.prefilterSampler &&
    cached.skylightResources.brdfLutView === skylightResources.brdfLutView &&
    cached.skylightResources.intensityBuffer === skylightResources.intensityBuffer
  );
}

interface MaterialBindingResources {
  readonly material: MaterialSnapshot;
  readonly world: RenderResourceScope;
  readonly store: GpuResidencyCache;
  readonly runtime: RenderSystemRuntime;
  readonly pipelineState: PipelineState;
  resident: boolean;
}
function materialBindingSampler(
  sources: MaterialBindingResources,
  field: string | undefined,
): Sampler {
  const handle = field === undefined ? undefined : sources.material.samplerHandles?.get(field);
  if (handle === undefined) return sources.pipelineState.defaultSampler;
  const sampler = residentSampler(sources.world, sources.store, sources.runtime, handle);
  if (sampler === undefined) sources.resident = false;
  return sampler ?? sources.pipelineState.defaultSampler;
}
// Cache hits must not allocate the miss factory's captured resource context.
function materialBindingGroup(
  runtime: RenderSystemRuntime,
  layout: BindGroupLayout,
  entries: BindGroupEntry[],
  shared: Map<string, WeakMap<object, unknown>>,
  shaderId: string | undefined,
  handles: readonly object[],
  backdrop: boolean,
  counts: BindGroupCounts,
): BindGroup {
  const create = () => {
    const result = runtime.device.createBindGroup({
      label: 'pbr-material-skylight-bg',
      layout,
      entries,
    });
    if (!result.ok) throw result.error;
    return result.value;
  };
  return backdrop
    ? create()
    : getOrCreatePerEntity(
        shared,
        shaderId ?? '',
        [layout, ...handles],
        'material-shared',
        create,
        counts,
      );
}

export function buildPerSubmeshMaterialBg(
  deps: PerSubmeshMaterialBgDeps,
  submeshMaterial: MaterialSnapshot,
  entityKey: number,
  materialWorld: RenderResourceScope = deps.world,
  materialShaderId: string | undefined = submeshMaterial.materialShaderId,
  materialSlot = 0,
): BindGroup {
  const {
    runtime,
    pipelineState,
    store,
    materialSlice,
    videoHighPerfAvailable,
    skylightResources,
    resolveRenderTargetTextureSource,
    resolveReflectionProbeResources,
    materialBgShared,
    materialBgAssemblyCache,
    transmissionBackdropView,
    surfaceRawDepthView,
    surfaceNearestLayerView,
    surfaceNearestDepthView,
    bindGroupCounts,
    frameState,
  } = deps;
  const materialBuffer = meshSsboBuffer(
    pipelineState.materialUniformBuffer,
    materialSlot * MATERIAL_PER_ENTITY_STRIDE,
  );
  const selectedProbe = resolveReflectionProbeResources?.(materialWorld, entityKey);
  const effectiveSkylightResources = selectedProbe?.resources ?? skylightResources;
  const smMaterialHandle = submeshMaterial.materialHandle;
  const probeIndex = selectedProbe?.probeIndex;
  const materialScopeIdentity = smMaterialHandle === undefined ? undefined : materialWorld.identity;
  const smHasVideoFields = (submeshMaterial.videoTextureFields?.size ?? 0) > 0;
  const smShaderId = materialShaderId;
  const selectedMaterialShaderArtifact =
    smShaderId === undefined ? undefined : runtime.getMaterialShaderArtifact?.(smShaderId);
  const selectedMediumShader =
    smShaderId === 'forgeax::single-layer-medium' ||
    selectedMaterialShaderArtifact?.receipt?.surface?.model === 'single-layer-medium';
  let surfaceMediumResources: SurfaceMediumBindGroupResources | undefined;
  if (selectedMediumShader) {
    if (surfaceRawDepthView == null) {
      throw new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'single-layer medium material bind group has producer-owned raw depth',
        hint: 'admit the Surface material only from a graph pass with an available raw-depth pair',
      });
    }
    const nearestLayerView = surfaceNearestLayerView ?? transmissionBackdropView;
    const nearestDepthView = surfaceNearestDepthView ?? pipelineState.shadowFallbackTextureView;
    if (nearestLayerView == null || pipelineState.surfaceMediumDepthSampler === undefined) {
      throw new RhiError({
        code: 'rhi-descriptor-invalid',
        expected:
          'single-layer medium material bind group has paired nearest resources and depth sampler',
        hint: 'publish the nearest-layer target and the non-filtering raw-depth sampler before recording the Surface pass',
      });
    }
    surfaceMediumResources = {
      planarView: deps.planarReflectionView ?? effectiveSkylightResources.brdfLutView,
      planarUniform: pipelineState.viewUniformBuffer,
      planarUniformOffset: PLANAR_REFLECTION_UNIFORM_OFFSET,
      rawDepthSampler: pipelineState.surfaceMediumDepthSampler,
      rawDepthView: surfaceRawDepthView,
      nearestLayerSampler: effectiveSkylightResources.prefilterSampler,
      nearestLayerView,
      nearestDepthSampler: pipelineState.surfaceMediumDepthSampler,
      nearestDepthView,
    };
  }
  // The cooked shader schema owns the resource ABI. A material snapshot may
  // carry only the authored values (for example a clearcoat-only root omits
  // the standard emissive/occlusion maps), while the Standard template still
  // declares those slots and expects neutral fallbacks to be bound.
  const smSchema =
    (smShaderId !== undefined ? runtime.getParamSchema?.(smShaderId) : undefined) ??
    submeshMaterial.materialParamSchema;
  const smPerShaderBgl =
    smShaderId !== undefined
      ? runtime.getMaterialBindGroupLayout?.(smShaderId, smSchema)
      : undefined;
  const smMaterialBgl = smPerShaderBgl ?? pipelineState.materialBindGroupLayout;
  const hasActiveTransmissionBackdrop = transmissionBackdropView != null;
  const sceneMaterialBuffer = runtime.device.caps.storageBuffer
    ? (deps.sceneMaterialBuffer ?? meshSsboBuffer(pipelineState.meshStorageBuffer, 0))
    : undefined;
  const diagnosticsEnabled = materialDiagnosticsEnabled();
  if (smMaterialHandle !== undefined && !smHasVideoFields && !hasActiveTransmissionBackdrop) {
    const cached = materialBgAssemblyCache.get(
      materialScopeIdentity,
      smMaterialHandle,
      materialShaderId,
      probeIndex,
    );
    if (
      isMaterialBgAssemblyCacheHit(
        cached,
        submeshMaterial,
        smMaterialBgl,
        materialBuffer,
        effectiveSkylightResources,
        store.materialResourceEpoch,
        transmissionBackdropView,
        sceneMaterialBuffer,
        surfaceRawDepthView,
      )
    ) {
      if (diagnosticsEnabled) {
        const smUserRegionFields = materialUserRegionFields(smShaderId, smPerShaderBgl, smSchema);
        recordIblMaterialBinding(
          frameState,
          smMaterialBgl,
          cached.bindGroup,
          [
            {
              binding: 1 + smUserRegionFields.length * 2,
              resource: { kind: 'textureView', value: effectiveSkylightResources.irradianceView },
            },
            {
              binding: 2 + smUserRegionFields.length * 2,
              resource: { kind: 'sampler', value: effectiveSkylightResources.irradianceSampler },
            },
            {
              binding: 3 + smUserRegionFields.length * 2,
              resource: { kind: 'textureView', value: effectiveSkylightResources.prefilterView },
            },
            {
              binding: 4 + smUserRegionFields.length * 2,
              resource: { kind: 'sampler', value: effectiveSkylightResources.prefilterSampler },
            },
            {
              binding: 5 + smUserRegionFields.length * 2,
              resource: { kind: 'textureView', value: effectiveSkylightResources.brdfLutView },
            },
            {
              binding: 6 + smUserRegionFields.length * 2,
              resource: {
                kind: 'buffer',
                value: { buffer: effectiveSkylightResources.intensityBuffer },
              },
            },
          ],
          1 + smUserRegionFields.length * 2,
          'hit',
        );
      }
      return cached.bindGroup;
    }
  }
  const standardMaterial = isStandardPbrMaterialShader(smShaderId);
  const schemaProjection = smSchema === undefined ? undefined : materialTextureProjection(smSchema);
  const derivedSchema = smSchema === undefined ? undefined : derive(smSchema);
  // The admitted schema owns the same fixed physical slots as the BGL builder.
  // Cooked program keys are content digests, not Standard shader aliases.
  const physicalFields =
    derivedSchema === undefined
      ? []
      : (schemaProjection?.physicalFields ??
        STANDARD_PHYSICAL_TEXTURE_FIELDS.filter((field) =>
          derivedSchema.parameterTypes.has(field),
        ));
  // Admitted schemas share their immutable projection; compatibility schemas
  // retain the original per-field reads, including resolver reentrancy.
  const smUserRegionFields =
    smPerShaderBgl === undefined || isCanonicalStandardPbrMaterialShader(smShaderId)
      ? BUILTIN_USER_REGION_TEXTURE_FIELDS
      : schemaProjection !== undefined
        ? schemaProjection.standardUserFields
        : [...(derivedSchema?.textureFieldNames ?? BUILTIN_USER_REGION_TEXTURE_FIELDS)].filter(
            (field) => !physicalFields.includes(field),
          );
  const parameterTypes = schemaProjection?.parameterTypes;
  const materialResources = {
    material: submeshMaterial,
    world: materialWorld,
    store,
    runtime,
    pipelineState,
    resident: true,
  };
  const smBaseEntries: BindGroupEntry[] = [
    {
      binding: 0,
      resource: {
        kind: 'buffer' as const,
        value: {
          buffer: materialBuffer,
          offset: 0,
          size: materialSlice,
        },
      },
    },
  ];
  // The medium shader keeps the transmission backdrop pair in its fixed
  // group(1) ABI even on a device that cannot admit the ordinary Standard
  // transmission topology. Its Surface resources start at binding 10, so
  // retain a real backdrop pair here whenever the medium resources exist;
  // otherwise the raw-depth view would slide into binding 9 and Dawn would
  // reject the unfilterable r32float view as a filtering float texture.
  const keepMediumBackdropSlots = surfaceMediumResources !== undefined;
  const transmissionAvailable =
    transmissionBackdropAvailable(runtime.device.limits.maxSampledTexturesPerShaderStage) ||
    keepMediumBackdropSlots;
  const omittedTransmissionBindings = omittedStandardMaterialBindings(
    smUserRegionFields,
    transmissionAvailable,
    standardMaterial || smPerShaderBgl === undefined,
    isCanonicalStandardPbrMaterialShader(smShaderId) || smPerShaderBgl === undefined,
    smPerShaderBgl === undefined
      ? undefined
      : sharedMaterialBindingDeclarations(runtime.shaderRegistry, smShaderId),
  );
  // Below the dedicated budget, the shared transmission variant reads its
  // transmission resources through the split scalar-map pairs it leaves unused.
  const usesSharedTransmissionSlots =
    smShaderId !== undefined &&
    standardTransmissionAdmission(
      smShaderId === submeshMaterial.materialShaderId
        ? submeshMaterial
        : { ...submeshMaterial, materialShaderId: smShaderId },
      runtime.device.limits.maxSampledTexturesPerShaderStage,
    )?.kind === 'shared';
  const smBglPairCount = smUserRegionFields.length;
  for (let fi = 0; fi < smBglPairCount; fi++) {
    const canonicalSlot = smUserRegionFields[fi];
    let sharedResource: string | undefined;
    if (usesSharedTransmissionSlots) {
      for (const slot of STANDARD_SHARED_TRANSMISSION_SLOTS) {
        if (slot.host === canonicalSlot) {
          sharedResource = slot.resource;
          break;
        }
      }
    }
    const samplerBinding = 1 + fi * 2;
    const textureBinding = samplerBinding + 1;
    if (sharedResource === 'transmissionBackdropTexture') {
      smBaseEntries.push(
        {
          binding: samplerBinding,
          resource: { kind: 'sampler', value: pipelineState.defaultSampler },
        },
        {
          binding: textureBinding,
          resource: {
            kind: 'textureView',
            value: transmissionBackdropView ?? pipelineState.defaultWhiteTextureView,
          },
        },
      );
      continue;
    }
    const slot = sharedResource ?? canonicalSlot;
    const field =
      slot !== undefined && isCanonicalStandardPbrMaterialShader(smShaderId)
        ? standardNormalInputField(slot, submeshMaterial.standardTextureMask)
        : slot;
    if (sharedResource === undefined && omittedTransmissionBindings.has(textureBinding)) {
      // Keep the logical region length until the shared IBL merger computes
      // its offsets. Omitted slots must not trigger residency requirements.
      smBaseEntries.push(
        {
          binding: samplerBinding,
          resource: { kind: 'sampler', value: pipelineState.defaultSampler },
        },
        {
          binding: textureBinding,
          resource: { kind: 'textureView', value: pipelineState.defaultWhiteTextureView },
        },
      );
      continue;
    }
    let smView: TextureView =
      field !== undefined
        ? parameterTypes === undefined
          ? defaultViewForUserRegionField(field, pipelineState, smSchema)
          : defaultViewForParameterType(field, pipelineState, parameterTypes.get(field))
        : pipelineState.defaultWhiteTextureView;
    let smResource: RhiBindingResource | undefined;
    const smVideoClip =
      field !== undefined ? submeshMaterial.videoTextureFields?.get(field) : undefined;
    const smSlotExternal =
      field !== undefined &&
      (parameterTypes === undefined
        ? smSchema?.find((entry) => entry.name === field)?.type
        : parameterTypes.get(field)) === 'texture_external';
    const smRuntimeSource =
      field === undefined ? undefined : submeshMaterial.textureSources?.get(field);
    const smTargetSource =
      field === undefined
        ? undefined
        : materialRenderTargetSourceForField(
            submeshMaterial,
            field,
            resolveRenderTargetTextureSource,
          );
    if (isExternalTextureSource(smRuntimeSource)) {
      smResource = runtime.externalTextures?.resolve(smRuntimeSource, smSlotExternal);
      if (smResource === undefined) materialResources.resident = false;
    } else if (field !== undefined && isCanvasTextureSource(smRuntimeSource)) {
      const view = materialCanvasTextureView(submeshMaterial, field, materialWorld, runtime);
      if (view !== undefined) smView = view;
      else materialResources.resident = false;
    } else if (smTargetSource !== undefined) {
      // The Renderer host resolves the generation-checked physical view. A
      // candidate is never exposed here; until its matching FrameReceipt
      // completes, the material remains on the neutral fallback.
      if (
        smTargetSource.textureView !== undefined &&
        (parameterTypes === undefined
          ? renderTargetSourceFitsParameter(smTargetSource, field, smSchema)
          : renderTargetSourceFitsParameterType(
              smTargetSource,
              field === undefined ? undefined : parameterTypes.get(field),
            ))
      ) {
        smView = smTargetSource.textureView;
      } else materialResources.resident = false;
    } else if (smVideoClip !== undefined) {
      smResource = videoBindingResource(
        materialWorld,
        runtime,
        entityKey,
        smVideoClip,
        videoHighPerfAvailable,
        smSlotExternal,
      );
    } else {
      const smHandle =
        field === 'emissiveTexture'
          ? submeshMaterial.emissiveTexture
          : field === 'occlusionTexture'
            ? submeshMaterial.occlusionTexture
            : field !== undefined
              ? submeshMaterial.textureHandles?.get(field)
              : undefined;
      if (smHandle !== undefined) {
        const view = residentTextureView(materialWorld, store, runtime, smHandle);
        if (view !== undefined) smView = view;
        else materialResources.resident = false;
      }
    }
    smBaseEntries.push(
      {
        binding: samplerBinding,
        resource: {
          kind: 'sampler' as const,
          value: materialBindingSampler(materialResources, field),
        },
      },
      {
        binding: textureBinding,
        resource: smResource ?? { kind: 'textureView' as const, value: smView },
      },
    );
  }
  // Physical Standard maps are deliberately appended after the stable IBL /
  // transmission tail.  Keep their resource projection separate from the
  // user-region loop so the slot order is the same as
  // `appendTextureInjection(effectiveSchema)` in the
  // layout owner.
  const physicalTextureInjections: TextureInjectionResource[] = [];
  for (let slot = 0; slot < physicalFields.length; slot += 1) {
    const field = physicalFields[slot];
    if (field === undefined) continue;
    let view =
      parameterTypes === undefined
        ? defaultViewForUserRegionField(field, pipelineState, smSchema)
        : defaultViewForParameterType(field, pipelineState, parameterTypes.get(field));
    const targetSource = materialRenderTargetSourceForField(
      submeshMaterial,
      field,
      resolveRenderTargetTextureSource,
    );
    const runtimeSource = submeshMaterial.textureSources?.get(field);
    if (isExternalTextureSource(runtimeSource)) {
      const resolved = runtime.externalTextures?.resolve(runtimeSource, false);
      if (resolved?.kind === 'textureView') view = resolved.value;
      else materialResources.resident = false;
    } else if (isCanvasTextureSource(runtimeSource)) {
      const canvasView = materialCanvasTextureView(submeshMaterial, field, materialWorld, runtime);
      if (canvasView !== undefined) view = canvasView;
      else materialResources.resident = false;
    } else if (targetSource !== undefined) {
      if (targetSource.textureView !== undefined) view = targetSource.textureView;
      else materialResources.resident = false;
    } else {
      const handle = submeshMaterial.textureHandles?.get(field);
      if (handle !== undefined) {
        const resident = residentTextureView(materialWorld, store, runtime, handle);
        if (resident !== undefined) view = resident;
        else materialResources.resident = false;
      }
    }
    physicalTextureInjections.push({
      slot: STANDARD_PHYSICAL_TEXTURE_FIELDS.indexOf(
        field as (typeof STANDARD_PHYSICAL_TEXTURE_FIELDS)[number],
      ),
      sampler: materialBindingSampler(materialResources, field),
      view,
    });
  }
  // The backdrop is a full mip-chain view owned by the pipeline. Reuse the
  // pipeline's existing filtering/clamp sampler for screen-space sampling;
  // the material default sampler intentionally keeps repeat addressing for
  // authored UV textures and is not a backdrop sampler.
  const transmissionSampler =
    transmissionBackdropView != null
      ? effectiveSkylightResources.prefilterSampler
      : pipelineState.defaultSampler;
  const smMergedEntries = assembleMaterialWithSkylightEntries(
    smBaseEntries,
    effectiveSkylightResources,
    transmissionAvailable
      ? ({
          sampler: transmissionSampler,
          ...(transmissionBackdropView === undefined
            ? { backdropView: pipelineState.defaultWhiteTextureView }
            : { backdropView: transmissionBackdropView }),
        } satisfies TransmissionBindGroupResources)
      : null,
    physicalTextureInjections,
    surfaceMediumResources,
  );
  let retainedEntries = 0;
  for (const entry of smMergedEntries) {
    if (!omittedTransmissionBindings.has(entry.binding)) smMergedEntries[retainedEntries++] = entry;
  }
  smMergedEntries.length = retainedEntries;
  if (derivedSchema?.parameterTypes.get('directMultiscatteringLut') === 'u32') {
    const lut = getOrCreateDirectDfgLut(runtime.device, runtime.deviceScope).unwrap();
    smMergedEntries.push({
      binding: STANDARD_DIRECT_DFG_LUT_BINDING,
      resource: { kind: 'textureView', value: lut.view },
    });
  }
  // Storage-capable devices share one Standard material BGL with the
  // scene-index GPU lane. Even direct draws need a complete entry for
  // binding(46), although their shader does not read the scene table. Reuse
  // the storage-backed mesh table as a neutral placeholder until a
  // producer-owned GPU scene table is available; GPU-driven draws replace it
  // with `deps.sceneMaterialBuffer`.
  if (runtime.device.caps.storageBuffer) {
    smMergedEntries.push({
      binding: 46,
      resource: {
        kind: 'buffer' as const,
        value: {
          buffer: deps.sceneMaterialBuffer ?? meshSsboBuffer(pipelineState.meshStorageBuffer, 0),
        },
      },
    });
  }
  const materialCacheHandles = smMergedEntries.map((entry) => extractEntryResourceHandle(entry));
  if (
    diagnosticsEnabled &&
    submeshMaterial.textureHandles === undefined &&
    smMaterialHandle !== undefined
  ) {
    console.error(
      `[render-material] scalar material cache handles: ${JSON.stringify({
        entityKey,
        materialHandle: smMaterialHandle,
        shader: smShaderId,
        surfaceModel: submeshMaterial.surfaceModel,
        layoutIdentity: getOpaqueResourceIdentity(smMaterialBgl as object),
        bindings: smMergedEntries.map((entry) => entry.binding),
        graphResources: {
          rawDepth: surfaceRawDepthView != null,
          nearestLayer: surfaceNearestLayerView != null,
          nearestDepth: surfaceNearestDepthView != null,
        },
        paramSnapshot: submeshMaterial.paramSnapshot,
        handleTypes: materialCacheHandles.map((handle) => typeof handle),
      })}`,
    );
  }
  if (
    diagnosticsEnabled &&
    materialCacheHandles.some((handle) => typeof handle !== 'object' || handle === null)
  ) {
    console.error(
      `[render-material] invalid material cache handle: ${JSON.stringify({
        entityKey,
        materialHandle: smMaterialHandle,
        shader: smShaderId,
        entries: smMergedEntries.map((entry, index) => ({
          index,
          binding: entry.binding,
          kind: entry.resource.kind,
          handleType: typeof materialCacheHandles[index],
        })),
      })}`,
    );
  }
  const smBindGroup = materialBindingGroup(
    runtime,
    smMaterialBgl,
    smMergedEntries,
    materialBgShared,
    smShaderId,
    materialCacheHandles,
    hasActiveTransmissionBackdrop,
    bindGroupCounts,
  );
  if (diagnosticsEnabled) {
    recordIblMaterialBinding(
      frameState,
      smMaterialBgl,
      smBindGroup,
      smMergedEntries,
      smBaseEntries.length,
      'miss',
    );
  }
  if (
    smMaterialHandle !== undefined &&
    !smHasVideoFields &&
    (submeshMaterial.textureSources?.size ?? 0) === 0 &&
    materialResources.resident &&
    !hasActiveTransmissionBackdrop
  ) {
    if (materialScopeIdentity !== undefined) {
      materialBgAssemblyCache.set(
        materialScopeIdentity,
        smMaterialHandle,
        materialShaderId,
        probeIndex,
        {
          material: submeshMaterial,
          materialResourceEpoch: store.materialResourceEpoch,
          materialBgl: smMaterialBgl,
          materialBuffer: materialBuffer,
          ...(sceneMaterialBuffer === undefined ? {} : { sceneMaterialBuffer }),
          skylightResources: effectiveSkylightResources,
          bindGroup: smBindGroup,
        },
      );
    }
  }
  return smBindGroup;
}

const ZERO_SKYLIGHT_PAYLOAD = new Float32Array([
  0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0,
]);

/** The same scene resources back material bindings in depth and color passes. */
/**
 * Resolve the renderer-owned Skylight bundle for both ordinary geometry and
 * prepared RenderFeature materials.  Feature preparation runs before the
 * main pass is encoded, so it cannot rely on the geometry pass to initialize
 * the intensity buffer or to select the current IBL views.  Keeping this
 * small argument-based helper as the single resolver makes the two paths use
 * identical resources while retaining the existing frame-local write.
 */
export function resolveMaterialSkylight(
  runtime: Pick<RenderSystemRuntime, 'device'>,
  pipelineState: Pick<PipelineState, 'skylightFallback'>,
  skylight: SkylightSnapshot | undefined,
  skylightCount: number,
  imageIbl: IblPrecomputeOutput | undefined,
  environmentIbl?: _InternalRenderPipelineContext['environmentIbl'],
) {
  const skylightFallback = pipelineState.skylightFallback;
  if (skylightFallback === null) {
    throw new RhiError({
      code: 'webgpu-runtime-error',
      expected: 'pipelineState.skylightFallback != null when PBR pipeline is active',
      hint: 'createRenderer must allocate skylightFallback alongside the PBR pipeline (D-5 round-4)',
    });
  }
  // Select only the completed output of this scene's authored image. Pipeline
  // caching is device-wide; image radiance is scoped to its source resource.
  let activeViews: { irr: TextureView; pref: TextureView; brdf: TextureView } | undefined;
  const uniformPayload = ZERO_SKYLIGHT_PAYLOAD.slice();
  if (
    skylight !== undefined &&
    skylightCount >= 1 &&
    skylight.equirectHandle !== 0 &&
    imageIbl !== undefined
  ) {
    activeViews = {
      irr: imageIbl.irradianceView,
      pref: imageIbl.prefilterView,
      brdf: imageIbl.brdfLutView,
    };
  }
  if (environmentIbl !== undefined && skylight !== undefined && skylight.equirectHandle === 0) {
    activeViews = {
      irr: environmentIbl.irradiance,
      pref: environmentIbl.prefilter,
      brdf: activeViews?.brdf ?? skylightFallback.brdfLutView,
    };
  }
  // White fallback is intentional solid-color ambient only without an authored
  // image. An explicit image whose IBL views are unavailable must not acquire
  // that unrelated white radiance while its resources are being prepared.
  if (
    skylight !== undefined &&
    skylightCount >= 1 &&
    (skylight.equirectHandle === 0 || activeViews !== undefined)
  ) {
    const [cr, cg, cb] = skylight.color;
    const [qx, qy, qz, qw] = skylight.rotation;
    uniformPayload.set([skylight.intensity, cr, cg, cb, qx, qy, qz, qw]);
  }
  if (skylight?.ambientIrradiance !== undefined) uniformPayload.set(skylight.ambientIrradiance, 16);
  runtime.device.queue.writeBuffer(skylightFallback.intensityBuffer, 0, uniformPayload);
  const skylightResources = skylightBindGroupResources(skylightFallback, activeViews);
  return { skylightResources, activeViews };
}

/** The same scene resources back material bindings in depth and color passes. */
export function prepareMaterialSkylight(c: _InternalRenderPipelineContext) {
  return resolveMaterialSkylight(
    c.runtime,
    c.pipelineState,
    c.skylight,
    c.skylightCount,
    c.skylight === undefined
      ? undefined
      : c.store.getCubemapIbl(c.skylight.equirectHandle, c.world),
    c.environmentIbl,
  );
}

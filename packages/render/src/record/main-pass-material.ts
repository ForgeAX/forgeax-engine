import {
  standardTransmissionAdmission,
  transmissionBackdropAvailable,
} from '../assembly/device-feature-admission';
import { meshSsboBuffer } from '../assembly/mesh-ssbo-grow';
import { getOrCreateDirectDfgLut } from '../device/direct-dfg-lut';
import { GPU_BUFFER_USAGE_UNIFORM } from '../gpu-usage';
import type { IblPrecomputeOutput } from '../ibl/IblPipelineCache';
import { SKY_SH_BYTES } from '../ibl/sky-sh';
import { derivedRenderState } from '../material-render-state';
import { materialResource } from '../material-resource';
import { materialSourceScope } from '../material-source';
import { type RenderResourceScope, renderAssetRevision } from '../publication/resource-scope';
import { CapturedSceneTransform, type ScenePoseStorage } from '../scene/captured-transform';
import { resolveTargetEnvironment } from '../targets/environment';
import { renderTextureSourceKey } from '../textures/source-token';
import { recordContext } from '../world/view-record-context';
import {
  type GraphBindingViews,
  graphBindingViewsCurrent,
  materialBindingViewsCurrent,
  sameGraphBindingViews,
} from './graph-binding-views';
import type { MaterialBgAssemblyCache } from './material-bg-assembly-cache';
import { materialBindingUniformResources, prepareMaterialUniform } from './material-uniforms';
import type { _InternalRenderPipelineContext, RasterMaterialLayout } from './render-context';
import {
  PLANAR_REFLECTION_DISABLED_UNIFORM_OFFSET,
  PLANAR_REFLECTION_UNIFORM_OFFSET,
} from './view-ubo';
// @forgeax/engine-runtime - RendererState record stage: main-pass-material.
// Extracted from render-system-record.ts (feat-20260704 M3/w17, pure move).

import { videoSourceExtent } from '@forgeax/engine-graphics-extras';
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
  STANDARD_DIRECT_DFG_LUT_BINDING,
  STANDARD_PHYSICAL_TEXTURE_FIELDS,
  STANDARD_PIPELINE_PARAM_SCHEMA,
  STANDARD_SHARED_TRANSMISSION_SLOTS,
} from '@forgeax/engine-shader';
import type {
  AssetHandle,
  ImageError,
  MaterialRenderState,
  ParamSchemaEntry,
  PrimitiveTopology,
  SamplerAsset,
  SampledTextureAsset as TextureAsset,
} from '@forgeax/engine-types';
import { derive, getAdmittedParamSchemaInterface } from '@forgeax/engine-types';

import type { GpuResidencyCache } from '../device/gpu-residency';
import { VideoUploadUnsupportedError } from '../errors/render';
import {
  isRenderFeatureTextureSource,
  type RenderFeatureTextureSource,
} from '../features/feature-texture-source';
import {
  assembleLitMaterialEntries,
  assembleMaterialWithSkylightEntries,
  type SkylightBindGroupResources,
  type SkylightFallback,
  type SurfaceMediumBindGroupResources,
  skylightBindGroupResources,
  skylightGroundLane,
  type TextureInjectionResource,
  type TransmissionBindGroupResources,
  type WaterFluidBindGroupResources,
} from '../ibl/skylight-bind-group';
import { writeMaterialTextureCoordinateRecord } from '../material-texture-coordinates';
import {
  isCanonicalStandardPbrMaterialShader,
  isStandardPbrMaterialShader,
  materialUsesLitSceneInputs,
  materialUsesSurfaceSceneInputs,
  omittedStandardMaterialBindings,
  physicalTextureFields,
  programDeclaresTransmissionBackdrop,
  projectedStandardMaterialLayout,
  projectMaterialLayoutEntries,
  sharedMaterialBindingDeclarations,
  standardInputField,
} from '../pbr-pipeline';
import { deriveTextureUvScale } from '../render-data';
import type { MaterialSnapshot, SkylightSnapshot } from '../render-system-extract';
import {
  type RenderTargetMaterialSourceBinding,
  resolveRenderTargetMaterialSource,
} from '../targets/material-source';
import {
  type CanvasSourceSlot,
  type CanvasTextureSource,
  canvasSourceSlot,
  isCanvasTextureSource,
  type MaterialTextureSource,
} from '../textures/canvas-texture';
import { isExternalTextureSource } from '../textures/external-texture';
import type {
  BindGroupCounts,
  CanvasFieldBinding,
  MaterialBgAssemblyCacheEntry,
  MaterialBindingSources,
  RenderFrameState,
} from './frame-snapshot';

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
  readonly storageCount: number;
  readonly samplerBindings: ReadonlyMap<string, number> | undefined;
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
  const storageCount = storageBindingCount(derived);
  let samplerBindings: Map<string, number> | undefined;
  if (storageCount > 0) {
    samplerBindings = new Map();
    for (const resource of derived.resourceBindings)
      if (
        resource.kind === 'sampler' &&
        resource.parameter !== undefined &&
        !samplerBindings.has(resource.parameter)
      )
        samplerBindings.set(resource.parameter, resource.binding);
  }
  const projection: MaterialTextureProjection = {
    storageCount,
    samplerBindings,
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
// Graph execution consumes RenderPipelineContext from render-contract.ts. Named
// asset, store, pipeline and runtime surfaces keep pass inputs explicit. Scene,
// shadow and post-process passes use the one RenderRecord encoder; graph ordering
// owns write/sample dependencies and render-frame-submit finishes/submits once.
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
  return derivedRenderState(renderState, 'line', lineRenderState);
}

const lineRenderState = (renderState: MaterialRenderState | undefined): MaterialRenderState => ({
  ...renderState,
  depthWriteEnabled: false,
  depthCompare: 'less-equal',
});

/**
 * feat-20260604-learn-render-4.10-anti-aliasing-msaa M2 / w9: pick the static
 * unlit geometry pipeline handle for a (tonemapActive x msaaActive)
 * combination. The four mode axes (LDR/HDR x single/MSAA) map to the 14 static
 * pipeline handles built in createRenderer (7 base + 7 count=4 variants). A
 * pipeline's `multisample.count` must match the colour-attachment sampleCount,
 * so the count=4 variant is required whenever the camera carries
 * the Camera's MSAA mode. Returns null when the requested pipeline was not
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
  pipelineState: Pick<
    PipelineState,
    'unlitPipeline' | 'unlitPipelineHdr' | 'unlitPipelineMsaa' | 'unlitPipelineHdrMsaa'
  >,
  tonemapActive: boolean,
  msaaActive: boolean,
): RenderPipeline | null {
  if (tonemapActive) {
    return msaaActive ? pipelineState.unlitPipelineHdrMsaa : pipelineState.unlitPipelineHdr;
  }
  return msaaActive ? pipelineState.unlitPipelineMsaa : pipelineState.unlitPipeline;
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

export function residentTextureView(
  world: RenderResourceScope,
  store: GpuResidencyCache,
  runtime: RenderSystemRuntime,
  handle: AssetHandle<'texture' | 'gpu-texture'>,
): TextureView | undefined {
  const podRes = world.resolveAsset<TextureAsset>(handle);
  if (!podRes.ok) return undefined;
  const residentRes = store.ensureResident(handle, podRes.value, world);
  if (!residentRes.ok) {
    // Preserve the concrete asset-capability boundary on the renderer error
    // channel. In particular, WebGL2 texture-dimension refusal must not
    // collapse into the later debug-pink asset-not-registered fallback.
    if (residentRes.error instanceof RhiError || isImageError(residentRes.error)) {
      runtime.errorRegistry.fire(residentRes.error);
    }
    return undefined;
  }
  return store.getTextureGpuView(handle, world);
}

function residentSampler(
  world: RenderResourceScope,
  store: GpuResidencyCache,
  runtime: RenderSystemRuntime,
  handle: AssetHandle<'sampler'>,
): Sampler | undefined {
  const podRes = world.resolveAsset<SamplerAsset>(handle);
  if (!podRes.ok) return undefined;
  const residentRes = store.ensureSamplerResident(handle, podRes.value, world);
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
  clip: AssetHandle<'video'>,
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
  const clipId = Number(clip);
  if (episodes.has(clipId)) return false;
  episodes.add(clipId);
  return true;
}

function clearVideoUploadFailureEpisode(
  store: DynamicTextureStore,
  entityKey: number,
  clip: AssetHandle<'video'>,
): void {
  const clips = VIDEO_UPLOAD_FAILURE_EPISODES.get(store);
  const episodes = clips?.get(entityKey);
  if (episodes === undefined) return;
  episodes.delete(Number(clip));
  if (episodes.size === 0) clips?.delete(entityKey);
  if (clips?.size === 0) VIDEO_UPLOAD_FAILURE_EPISODES.delete(store);
}

function videoSourceElement(
  world: RenderResourceScope,
  entityKey: number,
  clip: AssetHandle<'video'>,
): HTMLVideoElement | VideoFrame | undefined {
  return world.videoFrame(entityKey, clip);
}

/**
 * Copy path for one VideoPlayer field, also taken by `texture_external` slots
 * when zero-copy import is absent. Frames keep the source's top-left origin, the
 * same as image and canvas textures, so one mesh UV set reads both upright (UE
 * flips only bottom-up BMP samples, MediaShaders.usf:48).
 */
export function videoTextureView(
  world: RenderResourceScope,
  store: DynamicTextureStore | undefined,
  runtime: RenderSystemRuntime,
  entityKey: number,
  clip: AssetHandle<'video'>,
): TextureView | undefined {
  if (store === undefined) return undefined;
  const element = videoSourceElement(world, entityKey, clip);
  // Both upload paths need a host element. Bind the last good (or default)
  // view so the draw survives, but report the dead path once per episode.
  if (element === undefined) {
    if (markVideoUploadFailureEpisode(store, entityKey, clip)) {
      runtime.errorRegistry.fire(new VideoUploadUnsupportedError());
    }
    return store.getView(clip);
  }
  const extent = videoSourceExtent(element);
  if (extent === undefined) return store.getView(clip);
  const { width, height } = extent;
  const uploaded = store.uploadFrame(clip, element, width, height, { flipY: false });
  if (uploaded === undefined) return store.getView(clip);
  if (!uploaded.ok) {
    runtime.errorRegistry.fire(uploaded.error);
    return store.getView(clip);
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
  clip: AssetHandle<'video'>,
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
  const view = videoTextureView(world, runtime.dynamicTextureStore, runtime, entityKey, clip);
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
): AssetHandle<'texture' | 'gpu-texture'> | undefined {
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
  return source === undefined ||
    source.source === 'feature' ||
    isCanvasTextureSource(source) ||
    isExternalTextureSource(source)
    ? undefined
    : resolveSource === undefined
      ? resolveRenderTargetMaterialSource(source)
      : resolveSource(source);
}

function resolveCanvasView(
  source: CanvasTextureSource,
  localSlot: CanvasSourceSlot | undefined,
  world: RenderResourceScope,
  runtime: RenderSystemRuntime,
  binding?: CanvasFieldBinding,
): TextureView | undefined {
  const store = runtime.dynamicTextureStore;
  if (store === undefined) return undefined;
  const local = localSlot?.state;
  if (local !== undefined) {
    const snapshot = local.snapshot;
    return uploadCanvasView(
      store,
      runtime,
      local,
      snapshot?.frame ?? local.canvas,
      snapshot?.width ?? local.canvas.width,
      snapshot?.height ?? local.canvas.height,
      local.version,
      local.flipY,
      local.lifetime.signal,
      binding,
    );
  }
  const published = world.canvasFrame?.(binding?.publicationKey ?? renderTextureSourceKey(source));
  if (published === undefined) return undefined;
  if (published.frame === undefined) return store.getView(published.key);
  return uploadCanvasView(
    store,
    runtime,
    published.key,
    published.frame,
    published.frame.displayWidth,
    published.frame.displayHeight,
    published.version,
    published.flipY,
    published.signal,
    binding,
  );
}

function uploadCanvasView(
  store: DynamicTextureStore,
  runtime: RenderSystemRuntime,
  key: object,
  image: HTMLCanvasElement | OffscreenCanvas | VideoFrame,
  width: number,
  height: number,
  version: number,
  flipY: boolean,
  signal: AbortSignal,
  binding?: CanvasFieldBinding,
): TextureView | undefined {
  const uploaded = store.uploadCanvasFrame(
    key,
    image,
    width,
    height,
    version,
    flipY,
    signal,
    binding?.view,
  );
  if (uploaded === undefined && binding !== undefined) return undefined;
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
        handle === undefined ? undefined : world.resolveAsset<TextureAsset>(handle);
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
    const resolved = handle === undefined ? undefined : world.resolveAsset<TextureAsset>(handle);
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
  return defaultViewForParameter(field, pipelineState, parameterByName(schema, field));
}

function defaultViewForParameter(
  field: string,
  pipelineState: PipelineState,
  parameter: ParamSchemaEntry | undefined,
): TextureView {
  if (parameter?.type === 'texture_cube') {
    // The renderer already owns a valid white cube for the Skylight fallback.
    // Use it until a receipt-promoted RenderTarget source becomes available;
    // binding a 2D view here would invalidate the custom cube material BGL.
    return pipelineState.skylightFallback?.irradianceView ?? pipelineState.defaultWhiteTextureView;
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
 * `renderableIndex` per RendererState lifetime via the `seenIndices` Set
 * (the same warn-once anchor pattern used for missing-texture sprites).
 *
 * @param transformWorld The entity's addressed column-major world matrix.
 * @param slices         The four anchor distances `[left, top, right, bottom]`
 *                       (sentinel `bottom < 0` for tile mode is consumed via abs()).
 * @param renderableIndex The entity index into the validated renderables list.
 * @param seenIndices    The per-frame-state guard Set; entries are added on increment.
 * @param metrics        The owner-provided EngineMetrics counter.
 * @internal — exported for unit-test access (w17).
 */
export function detectNineSliceScaleTooSmall(
  transformWorld: ScenePoseStorage,
  slices: readonly [number, number, number, number],
  renderableIndex: number,
  seenIndices: Set<number>,
  metrics: { increment(name: string): void },
): void {
  const anyNonZero = slices[0] !== 0 || slices[1] !== 0 || slices[2] !== 0 || slices[3] !== 0;
  if (!anyNonZero) return;
  const world = CapturedSceneTransform.column(transformWorld);
  const at = CapturedSceneTransform.offset(transformWorld);
  const sx = Math.hypot(world[at] ?? 1, world[at + 1] ?? 0, world[at + 2] ?? 0);
  const sy = Math.hypot(world[at + 4] ?? 0, world[at + 5] ?? 1, world[at + 6] ?? 0);
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
  parameters = material.paramSnapshot,
): ReturnType<typeof derive> {
  if (buf.byteLength < STANDARD_PBR_UBO_SIZE) {
    throw new RangeError(
      `writePbrMaterialUboPayload: expected at least ${STANDARD_PBR_UBO_SIZE} bytes, got ${buf.byteLength}`,
    );
  }
  buf.fill(0);
  const dataView = view ?? materialNumericView(buf);
  const schema = materialParameterSchema(material) ?? STANDARD_PIPELINE_PARAM_SCHEMA;
  const snapshot = parameters;
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
      // A short vector keeps its declared trailing components, as prepared
      // materials do: an RGB baseColor keeps the default alpha 1.
      if (value.length < entry.size / 4) {
        const declared = (
          (parametersByName === undefined
            ? schema.find((item) => item.name === entry.name)
            : parametersByName.get(entry.name)) as { readonly default?: unknown } | undefined
        )?.default;
        if (Array.isArray(declared)) writeNumericParamValue(dataView, entry, declared);
      }
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
  writeMaterialUniformValues(dataView, derive(paramSchema).uboLayout, paramSnapshot);
}

/** Write precisely the layout whose identity was reserved for these parameters. */
export function writeMaterialUniformValues(
  dataView: DataView,
  uboLayout: ReturnType<typeof derive>['uboLayout'],
  paramSnapshot: Readonly<Record<string, number | readonly number[] | string | undefined>>,
): void {
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
 * Prepared materials supply a fresh linear-value record. With an owner-admitted
 * schema, seed defaults and apply that record in one layout walk. Keep the raw
 * schema's two observations: its accessors may change the layout between them.
 * Defaults still precede each override, including short vectors and integer bits.
 */
export function writePreparedMaterialUbo(
  payload: MaterialUboPayload,
  paramSchema: readonly ParamSchemaEntry[],
  values: Parameters<typeof applyParamSnapshotToUbo>[2],
): void {
  const admitted = getAdmittedParamSchemaInterface(paramSchema);
  if (admitted === undefined) {
    applyParamSchemaDefaultsToUbo(payload, paramSchema);
    applyParamSnapshotToUbo(payload, paramSchema, values);
    return;
  }
  const view = materialUboDataView(payload);
  const parameters = materialTextureProjection(paramSchema)?.parametersByName;
  for (const entry of admitted.uboLayout.entries) {
    const value = values?.[entry.name];
    // A scalar override replaces the whole numeric field, so its default need
    // not be looked up or uploaded first. Vectors keep their prefix overlays.
    if (
      typeof value === 'number' &&
      (entry.type === 'f32' || entry.type === 'i32' || entry.type === 'u32')
    ) {
      writeNumericParamValue(view, entry, value);
      continue;
    }
    const parameter = parameters?.get(entry.name);
    const fallback =
      parameter !== undefined && 'default' in parameter ? parameter.default : undefined;
    if (typeof fallback === 'number' || Array.isArray(fallback))
      writeNumericParamValue(view, entry, fallback as number | readonly number[]);
    if (typeof value === 'number' || Array.isArray(value))
      writeNumericParamValue(view, entry, value as number | readonly number[]);
  }
}

/**
 * feat-20260704 M3/w19: shared per-submesh material bind-group assembly, hoisted
 * from the `buildPerSubmeshMaterialBg` closure inside encodeMainPass so both the
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
  readonly graphViews?: GraphBindingViews;
  readonly planarReflectionView?: TextureView;
  readonly runtime: RenderSystemRuntime;
  readonly pipelineState: PipelineState;
  readonly world: RenderResourceScope;
  readonly store: GpuResidencyCache;
  readonly materialSlice: number;
  readonly videoHighPerfAvailable: boolean;
  readonly skylightResources: SkylightBindGroupResources;
  /** Pure reads of the actual scene/environment owners, detached from the recording frame. */
  readonly bindingSceneCurrent?: (
    skylight: SkylightBindGroupResources,
    probeIndex: number | undefined,
    planar: boolean,
  ) => boolean;
  readonly resolveRenderTargetTextureSource?: RenderSystemRuntime['resolveRenderTargetTextureSource'];
  readonly resolveFeatureTextureSource?: (name: string) => TextureView | undefined;
  readonly resolveReflectionProbeResources?: (
    materialWorld: RenderResourceScope,
    entityKey: number | undefined,
    resourceClass?: string,
  ) => { readonly resources: SkylightBindGroupResources; readonly probeIndex: number } | undefined;
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
  /** Graph-owned FoamRT, required only by a reflected connected foam branch. */
  readonly surfaceFoamSimulationView?: TextureView | null;
  readonly surfaceFluidSimulation?: { readonly fields: TextureView; readonly descriptors: Buffer };
  readonly bindGroupCounts: BindGroupCounts;
  readonly frameState: RenderFrameState;
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

/** Compare the resource inputs shared by synchronous draws and retained submissions. */
function sameMaterialBindingSources(
  left: MaterialBindingSources,
  right: MaterialBindingSources,
): boolean {
  return (
    left === right ||
    (left.standardTextureMask === right.standardTextureMask &&
      left.emissiveTexture === right.emissiveTexture &&
      left.occlusionTexture === right.occlusionTexture &&
      // On the minimum texture budget, declaring transmission remaps scalar slots.
      (left.paramSnapshot?.transmission === undefined) ===
        (right.paramSnapshot?.transmission === undefined) &&
      // A sparse cooked parallax root lends its metallic pair to the height by value.
      left.paramSnapshot?.displacementMode === right.paramSnapshot?.displacementMode &&
      sameMaterialHandleMap(left.textureHandles, right.textureHandles) &&
      sameMaterialHandleMap(left.samplerHandles, right.samplerHandles))
  );
}

function captureBindingInputs(
  material: MaterialSnapshot,
  retained: boolean,
): MaterialBindingSources {
  if (!retained || materialResource(material)?.ownsValues(material) === true) return material;
  const { paramSnapshot, textureHandles, samplerHandles } = material;
  return {
    standardTextureMask: material.standardTextureMask,
    emissiveTexture: material.emissiveTexture,
    occlusionTexture: material.occlusionTexture,
    paramSnapshot:
      paramSnapshot === undefined
        ? undefined
        : {
            transmission: paramSnapshot.transmission === undefined ? undefined : true,
            displacementMode: paramSnapshot.displacementMode,
          },
    textureHandles: textureHandles === undefined ? undefined : new Map(textureHandles),
    samplerHandles: samplerHandles === undefined ? undefined : new Map(samplerHandles),
  };
}

/** Accepted binding structure is distinct from numeric values and pending asset versions. */
function materialBindingCurrency(
  material: MaterialSnapshot,
  sources: MaterialBindingSources,
  shaderId: string | undefined,
  bgl: BindGroupLayout,
  perShader: BindGroupLayout | undefined,
  runtime: RenderSystemRuntime,
  pipeline: PipelineState,
  standardMaterialLayoutIndex: number,
  retained: boolean,
): (() => boolean) | undefined {
  if (!retained || (material.textureSources?.size ?? 0) > 0) return undefined;
  const owner = materialResource(material);
  // Only these values shape the binding ABI. Numeric uniforms and program payloads
  // have separate owners. Capture borrowed maps before a resolver may mutate them.
  const { materialShaderId, materialParamSchema } = material;
  const registry = runtime.shaderRegistry;
  const fallback = pipeline.skylightFallback === null ? null : { ...pipeline.skylightFallback };
  const declaration =
    shaderId === undefined ? undefined : registry?.materialArtifactDeclaration(shaderId);
  return () => {
    const value = owner?.snapshot ?? material;
    const current =
      shaderId === undefined ? undefined : registry?.materialArtifactDeclaration(shaderId);
    return (
      (value.textureSources?.size ?? 0) === 0 &&
      (value.videoTextureFields?.size ?? 0) === 0 &&
      value.materialShaderId === materialShaderId &&
      sameMaterialBindingSources(sources, value) &&
      runtime.shaderRegistry === registry &&
      sameMaterialProgramDeclaration(declaration, current) &&
      sameMaterialFallback(fallback, pipeline.skylightFallback) &&
      (perShader === undefined ||
        (shaderId !== undefined &&
          runtime.lookupMaterialBindGroupLayout?.(shaderId, materialParamSchema) === perShader)) &&
      resolveSubmeshMaterialLayout(
        pipeline.materialBindGroupLayout,
        perShader,
        standardMaterialLayoutIndex,
      ) === bgl
    );
  };
}

function sameMaterialFallback(a: SkylightFallback | null, b: SkylightFallback | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.skySh === b.skySh &&
    a.prefilterView === b.prefilterView &&
    a.brdfLutView === b.brdfLutView &&
    a.sampler === b.sampler &&
    a.intensityBuffer === b.intensityBuffer
  );
}

type MaterialProgramDeclaration = ReturnType<
  NonNullable<RenderSystemRuntime['shaderRegistry']>['materialArtifactDeclaration']
>;
function sameMaterialProgramDeclaration(
  a: MaterialProgramDeclaration,
  b: MaterialProgramDeclaration,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.kind === 'ready' && b.kind === 'ready') return a.entry === b.entry;
  return (
    a.kind === 'bytes' &&
    b.kind === 'bytes' &&
    a.paramSchema === b.paramSchema &&
    a.receipt === b.receipt
  );
}

function captureMaterialResources(
  material: MaterialSnapshot,
  world: RenderResourceScope,
  store: GpuResidencyCache,
  prepared:
    | ReadonlyMap<string, ReturnType<NonNullable<RenderSystemRuntime['preparedMaterialTexture']>>>
    | undefined,
): MaterialBgAssemblyCacheEntry['materialResources'] {
  const textureHandles = material.textureHandles;
  const samplerHandles = material.samplerHandles;
  if (
    !textureHandles?.size &&
    !samplerHandles?.size &&
    material.emissiveTexture === undefined &&
    material.occlusionTexture === undefined
  )
    return NO_MATERIAL_RESOURCES;
  const resources: MaterialBgAssemblyCacheEntry['materialResources'][number][] = [];
  const textures = new Set<AssetHandle<'texture' | 'gpu-texture'>>();
  if (textureHandles !== undefined) {
    for (const [field, handle] of textureHandles) {
      if (prepared?.get(field) === undefined) textures.add(handle);
    }
  }
  if (material.emissiveTexture !== undefined && prepared?.get('emissiveTexture') === undefined)
    textures.add(material.emissiveTexture);
  if (material.occlusionTexture !== undefined && prepared?.get('occlusionTexture') === undefined)
    textures.add(material.occlusionTexture);
  for (const handle of textures) {
    resources.push({
      handle,
      kind: 'texture',
      revision: renderAssetRevision(world, handle),
      view: store.getTextureGpuView(handle, world),
    });
  }
  if (samplerHandles?.size) {
    const samplers = new Set<number>();
    for (const [field, handle] of samplerHandles) {
      if (prepared?.get(field) === undefined) samplers.add(handle);
    }
    for (const handle of samplers)
      resources.push({
        handle,
        kind: 'sampler',
        revision: renderAssetRevision(world, handle),
        view: undefined,
      });
  }
  return resources;
}

/** Revalidate only resources actually retained by this material binding. */
export function materialBindingResourcesCurrent(
  entry: Pick<
    MaterialBgAssemblyCacheEntry,
    'preparedTextureDomain' | 'preparedTextures' | 'materialResources' | 'material'
  >,
  world: RenderResourceScope,
  store: GpuResidencyCache,
  runtime?: Pick<RenderSystemRuntime, 'preparedMaterialTexture'>,
  material = entry.material,
): boolean {
  const provider = runtime?.preparedMaterialTexture;
  if (entry.preparedTextureDomain !== (provider?.parameters ?? provider)) return false;
  const prepared = entry.preparedTextures;
  for (let index = 0; index < prepared.length; index++) {
    const resource = prepared[index] as (typeof prepared)[number];
    const current = runtime?.preparedMaterialTexture?.(material, resource.parameter);
    if (current?.textureView !== resource.textureView || current?.sampler !== resource.sampler)
      return false;
  }
  const resident = entry.materialResources;
  for (let index = 0; index < resident.length; index++) {
    const resource = resident[index] as (typeof resident)[number];
    if (
      resource.revision !== renderAssetRevision(world, resource.handle) ||
      (resource.kind !== 'sampler' &&
        resource.view !==
          store.getTextureGpuView(resource.handle as AssetHandle<'texture' | 'gpu-texture'>, world))
    )
      return false;
  }
  return true;
}

function samePlanarReflection(
  retained: MaterialBgAssemblyCacheEntry['planarReflection'],
  view: TextureView | undefined,
  uniform: Buffer | undefined,
): boolean {
  return retained === undefined || (retained.view === view && retained.uniform === uniform);
}

function sameSkylightBindings(
  a: SkylightBindGroupResources,
  b: SkylightBindGroupResources,
): boolean {
  return (
    a.skySh === b.skySh &&
    a.irradianceSampler === b.irradianceSampler &&
    a.prefilterView === b.prefilterView &&
    a.prefilterSampler === b.prefilterSampler &&
    a.brdfLutView === b.brdfLutView &&
    a.intensityBuffer === b.intensityBuffer
  );
}

/** @internal Exported only so buffer-generation invalidation stays regression-tested. */
export function isMaterialBgAssemblyCacheHit(
  cached: MaterialBgAssemblyCacheEntry | undefined,
  material: MaterialSnapshot,
  materialBgl: BindGroupLayout,
  materialBuffer: Buffer | undefined,
  skylightResources: SkylightBindGroupResources,
  resourcesCurrent: boolean,
  transmissionBackdropView?: TextureView | null,
  sceneMaterialBuffer?: Buffer,
  surfaceRawDepthView?: TextureView | null,
  planarReflectionView?: TextureView,
  planarReflectionUniform?: Buffer,
  graphViews?: GraphBindingViews,
  surfaceNearestLayerView?: TextureView | null,
  surfaceNearestDepthView?: TextureView | null,
  deps?: PerSubmeshMaterialBgDeps,
  world?: RenderResourceScope,
  schema?: readonly ParamSchemaEntry[],
): cached is MaterialBgAssemblyCacheEntry {
  // A live source must have resolved its physical views during this draw.
  if (
    !materialBindingViewsCurrent(
      graphViews,
      transmissionBackdropView,
      surfaceRawDepthView,
      surfaceNearestLayerView,
      surfaceNearestDepthView,
    ) ||
    (material.videoTextureFields?.size ?? 0) > 0
  )
    return false;
  return (
    cached !== undefined &&
    sameGraphBindingViews(cached.graphViews, graphViews) &&
    sameMaterialBindingSources(cached.inputs ?? cached.material, material) &&
    resourcesCurrent &&
    cached.materialBgl === materialBgl &&
    (cached.dynamicOffsetCount === 0 ||
      materialBuffer === undefined ||
      cached.materialBuffer === materialBuffer) &&
    cached.sceneMaterialBuffer === sceneMaterialBuffer &&
    sameSkylightBindings(cached.skylightResources, skylightResources) &&
    samePlanarReflection(cached.planarReflection, planarReflectionView, planarReflectionUniform) &&
    canvasMaterialBindingsCurrent(cached, material, deps, world, schema)
  );
}

/**
 * The state of one material bind-group assembly: the material subject, its
 * cooked layout, the resources it resolves against and whether every source
 * was resident. Prepared textures are resolved once per field.
 */
interface MaterialBgAssembly {
  /** Only an admitted shader with frame-independent non-Canvas bindings can own these slots. */
  canvas?: CanvasFieldBinding[];
  readonly acceptsCanvases: boolean;
  readonly selectedLayout: RasterMaterialLayout | undefined;
  readonly inputs: MaterialBindingSources;
  readonly bindingSourcesCurrent: (() => boolean) | undefined;
  readonly material: MaterialSnapshot;
  readonly entityKey: number | undefined;
  readonly world: RenderResourceScope;
  /** Material handle, scope identity and probe slot, each read once per build. */
  readonly materialHandle: number | undefined;
  readonly scopeIdentity: RenderResourceScope['identity'] | undefined;
  readonly probeIndex: number | undefined;
  readonly hasVideoFields: boolean;
  /** Skylight or selected reflection-probe resources bound by the IBL tail. */
  readonly skylight: SkylightBindGroupResources;
  readonly shaderId: string | undefined;
  readonly schema: readonly ParamSchemaEntry[] | undefined;
  readonly projection: MaterialTextureProjection | undefined;
  readonly surfaceMediumResources: SurfaceMediumBindGroupResources | undefined;
  readonly graphViews: GraphBindingViews | undefined;
  readonly perShaderBgl: BindGroupLayout | undefined;
  readonly bgl: BindGroupLayout;
  readonly store: GpuResidencyCache;
  readonly runtime: RenderSystemRuntime;
  readonly pipelineState: PipelineState;
  preparedTextures:
    | Map<string, ReturnType<NonNullable<RenderSystemRuntime['preparedMaterialTexture']>>>
    | undefined;
  resident: boolean;
  missingBaseColor: boolean;
  readonly standardMaterialLayoutIndex?: number;
}

function materialBindingSampler(assembly: MaterialBgAssembly, field: string | undefined): Sampler {
  const handle = field === undefined ? undefined : assembly.material.samplerHandles?.get(field);
  if (handle === undefined) return assembly.pipelineState.defaultSampler;
  const sampler = residentSampler(assembly.world, assembly.store, assembly.runtime, handle);
  if (sampler === undefined) assembly.resident = false;
  return sampler ?? assembly.pipelineState.defaultSampler;
}
function requireCurrentGraphViews(facts: GraphBindingViews | undefined): void {
  if (facts !== undefined && !graphBindingViewsCurrent(facts))
    throw new RhiError({
      code: 'rhi-descriptor-invalid',
      expected: 'the original graph-owned material views after native callbacks',
      hint: 'discard this recording and prepare bindings against the current graph',
    });
}

function materialAssemblyGraphViews(
  facts: GraphBindingViews | undefined,
  hasSurfaceMedium: boolean,
): GraphBindingViews | undefined {
  if (facts === undefined || hasSurfaceMedium) return facts;
  const backdrop = facts.views.find(([role]) => role === 'backdrop');
  if (backdrop === undefined) return undefined;
  return facts.views.length === 1 ? facts : { resources: facts.resources, views: [backdrop] };
}

/** Synchronously filled from the exact uniform page used to issue the group. */
export interface MaterialBindingAddress {
  capture?: { current: (() => boolean) | undefined };
  byteOffset: number;
  dynamicOffsetCount: 0 | 1;
  /** Raster consumers include the field when they need the selected primitive reflection. */
  reflection?: MainPassMaterialBinding['reflection'];
}

export interface MainPassMaterialBinding {
  readonly group: BindGroup;
  readonly byteOffset: number;
  readonly dynamicOffsetCount: 0 | 1;
  readonly reflection?: import('../reflection/primitive-bindings').PrimitiveReflection;
}

/** The recorder owns the output address until it submits this draw. */
export type MainPassMaterialBindingResolver = (
  slot: number,
  material: MaterialSnapshot,
  entityKey: number | undefined,
  world: RenderResourceScope,
  address: MaterialBindingAddress,
  shader?: string,
  standardMaterialLayoutIndex?: number,
  selectedLayout?: RasterMaterialLayout,
) => BindGroup;

export function buildPerSubmeshMaterialBg(
  deps: PerSubmeshMaterialBgDeps,
  submeshMaterial: MaterialSnapshot,
  entityKey: number | undefined,
  materialWorld: RenderResourceScope = deps.world,
  materialShaderId: string | undefined = submeshMaterial.materialShaderId,
  _materialSlot = 0,
  resourceClass?: string,
  standardMaterialLayoutIndex = 0,
  reflection?: ReturnType<
    NonNullable<PerSubmeshMaterialBgDeps['resolveReflectionProbeResources']>
  > | null,
  address?: MaterialBindingAddress,
  selectedLayout?: RasterMaterialLayout,
): BindGroup {
  const raster = selectedLayout?.shader === materialShaderId ? selectedLayout : undefined;
  materialWorld = materialSourceScope(materialWorld, submeshMaterial.sourceAssets);
  const { runtime, pipelineState, store } = deps;
  const primitiveReflection = isCanonicalStandardPbrMaterialShader(materialShaderId);
  const transmissionBackdropView = primitiveReflection ? undefined : deps.transmissionBackdropView;
  // The primitive and material layouts share source admission, while their
  // reflection bindings may live at different group addresses.
  const probe = resolveAcceptedMaterialProbe(
    deps,
    materialWorld,
    entityKey,
    resourceClass,
    reflection,
    primitiveReflection,
    address,
  );
  const selectedProbe = primitiveReflection ? undefined : probe;
  const effectiveSkylightResources = selectedProbe?.resources ?? deps.skylightResources;
  const smMaterialHandle = submeshMaterial.materialHandle;
  const probeIndex = selectedProbe?.probeIndex;
  const materialScopeIdentity = materialWorld.identity;
  const smHasVideoFields = (submeshMaterial.videoTextureFields?.size ?? 0) > 0;
  let surfaceMediumResources: SurfaceMediumBindGroupResources | undefined;
  let fluidSimulation: WaterFluidBindGroupResources | undefined;
  let smSchema: readonly ParamSchemaEntry[] | undefined;
  let smPerShaderBgl: BindGroupLayout | undefined;
  let smMaterialBgl: BindGroupLayout;
  if (raster !== undefined) {
    smSchema = raster.schema;
    smPerShaderBgl = raster.perShaderLayout;
    smMaterialBgl = raster.layout;
  } else {
    surfaceMediumResources = resolveSurfaceMediumResources(
      deps,
      materialShaderId,
      effectiveSkylightResources,
    );
    fluidSimulation = resolveWaterFluidResources(deps, materialShaderId);
    smSchema = bindingParameterSchema(runtime, materialShaderId, submeshMaterial);
    if (materialShaderId !== undefined)
      smPerShaderBgl = runtime.getMaterialBindGroupLayout?.(materialShaderId, smSchema);
    smMaterialBgl = resolveSubmeshMaterialLayout(
      pipelineState.materialBindGroupLayout,
      smPerShaderBgl,
      standardMaterialLayoutIndex,
    );
  }
  const graphViews = primitiveReflection
    ? undefined
    : materialAssemblyGraphViews(deps.graphViews, surfaceMediumResources !== undefined);
  const surfaceGraphInputs = surfaceMediumResources === undefined ? undefined : deps;
  const sceneMaterialBuffer = directSceneMaterialBuffer(deps);
  const reusable =
    smMaterialHandle !== undefined &&
    !smHasVideoFields &&
    fluidSimulation === undefined &&
    materialScopeIdentity !== undefined;
  if (reusable) {
    const cached = deps.materialBgAssemblyCache.get(
      materialScopeIdentity,
      smMaterialHandle,
      materialShaderId,
      probeIndex,
      graphViews,
      standardMaterialLayoutIndex,
    );
    if (
      isMaterialBgAssemblyCacheHit(
        cached,
        submeshMaterial,
        smMaterialBgl,
        undefined,
        effectiveSkylightResources,
        cached !== undefined &&
          materialBindingResourcesCurrent(cached, materialWorld, store, runtime, submeshMaterial),
        transmissionBackdropView,
        sceneMaterialBuffer,
        surfaceGraphInputs?.surfaceRawDepthView,
        deps.planarReflectionView,
        pipelineState.viewUniformBuffer,
        graphViews,
        surfaceGraphInputs?.surfaceNearestLayerView,
        surfaceGraphInputs?.surfaceNearestDepthView,
        deps,
        materialWorld,
        smSchema,
      )
    ) {
      const installed = bindInstalledMaterial(
        deps,
        cached,
        submeshMaterial,
        materialWorld,
        address,
      );
      if (installed !== undefined) {
        if (address?.capture !== undefined)
          address.capture.current = deps.materialBgAssemblyCache.captureBindingCurrent(
            materialScopeIdentity,
            smMaterialHandle,
            materialShaderId,
            probeIndex,
            standardMaterialLayoutIndex,
            cached,
          );
        return finishMaterialBinding(installed, address, probe, deps.skylightResources);
      }
    }
    if (cached?.canvas !== undefined)
      deps.materialBgAssemblyCache.releaseBinding(smMaterialHandle, cached);
  }
  const inputs = captureBindingInputs(submeshMaterial, reusable);
  const assembly: MaterialBgAssembly = {
    selectedLayout: raster,
    inputs,
    bindingSourcesCurrent: materialBindingCurrency(
      submeshMaterial,
      inputs,
      materialShaderId,
      smMaterialBgl,
      smPerShaderBgl,
      runtime,
      pipelineState,
      standardMaterialLayoutIndex,
      reusable,
    ),
    acceptsCanvases: reusable,
    material: submeshMaterial,
    entityKey,
    world: materialWorld,
    materialHandle: smMaterialHandle,
    scopeIdentity: materialScopeIdentity,
    probeIndex,
    hasVideoFields: smHasVideoFields,
    skylight: effectiveSkylightResources,
    shaderId: materialShaderId,
    schema: smSchema,
    projection: smSchema === undefined ? undefined : materialTextureProjection(smSchema),
    surfaceMediumResources,
    graphViews,
    perShaderBgl: smPerShaderBgl,
    bgl: smMaterialBgl,
    standardMaterialLayoutIndex,
    store,
    runtime,
    pipelineState,
    preparedTextures: undefined,
    resident: true,
    missingBaseColor: false,
  };
  const binding = assembleMaterialBg(deps, assembly, fluidSimulation, address);
  return finishMaterialBinding(binding, address, probe, deps.skylightResources);
}

function finishMaterialBinding(
  group: BindGroup,
  address: MaterialBindingAddress | undefined,
  probe: ReturnType<typeof resolveAcceptedMaterialProbe>,
  skylight: SkylightBindGroupResources,
): BindGroup {
  if (address !== undefined && 'reflection' in address)
    address.reflection = probe?.resources ?? skylight;
  return group;
}

/** The cooked shader owns the resource ABI even when the material only authored a subset. */
function bindingParameterSchema(
  runtime: RenderSystemRuntime,
  shader: string | undefined,
  material: MaterialSnapshot,
): readonly ParamSchemaEntry[] | undefined {
  return (
    (shader === undefined ? undefined : runtime.getParamSchema?.(shader)) ??
    material.materialParamSchema
  );
}

function resolveAcceptedMaterialProbe(
  deps: PerSubmeshMaterialBgDeps,
  world: RenderResourceScope,
  entityKey: number | undefined,
  resourceClass: string | undefined,
  reflection: ReturnType<
    NonNullable<PerSubmeshMaterialBgDeps['resolveReflectionProbeResources']>
  > | null,
  primitiveReflection: boolean,
  address: MaterialBindingAddress | undefined,
) {
  if (primitiveReflection && (address === undefined || !('reflection' in address)))
    return undefined;
  return reflection === undefined
    ? deps.resolveReflectionProbeResources?.(world, entityKey, resourceClass)
    : (reflection ?? undefined);
}

function bindInstalledMaterial(
  deps: PerSubmeshMaterialBgDeps,
  cached: MaterialBgAssemblyCacheEntry,
  material: MaterialSnapshot,
  world: RenderResourceScope,
  address?: MaterialBindingAddress,
): BindGroup | undefined {
  deps.frameState.iblBindings?.bindRetained(cached);
  let byteOffset = 0;
  if (cached.uniformResources !== undefined) {
    const offsets = deps.materialBgAssemblyCache.uniformOffsets;
    const buffer = prepareMaterialUniform(
      deps,
      material,
      world,
      cached.uniformResources,
      false,
      offsets,
    );
    if (buffer !== cached.materialBuffer) return undefined;
    byteOffset = offsets.local;
  }
  requireCurrentGraphViews(deps.graphViews);
  deps.materialBgAssemblyCache.use(cached.bindGroup);
  if (address !== undefined) {
    address.byteOffset = byteOffset;
    address.dynamicOffsetCount = cached.dynamicOffsetCount ?? 1;
  }
  return cached.bindGroup;
}

function resolveSubmeshMaterialLayout(
  full: BindGroupLayout,
  perShader: BindGroupLayout | undefined,
  layoutIndex: number,
): BindGroupLayout {
  return projectedStandardMaterialLayout(full, layoutIndex) ?? perShader ?? full;
}

/** Storage-capable devices bind the shared scene Material table (or its neutral placeholder). */
function directSceneMaterialBuffer(deps: PerSubmeshMaterialBgDeps): Buffer | undefined {
  return deps.runtime.device.caps.storageBuffer
    ? (deps.sceneMaterialBuffer ?? meshSsboBuffer(deps.pipelineState.meshStorageBuffer, 0))
    : undefined;
}

/** Producer-owned graph resources of the single-layer medium shader, else undefined. */
// One recording's draws share a few shaders; resolve each artifact's surface model once.
const mediumShaders = new WeakMap<PerSubmeshMaterialBgDeps, Map<string, boolean>>();

function mediumShaderOf(deps: PerSubmeshMaterialBgDeps, shaderId: string | undefined): boolean {
  if (shaderId === undefined) return false;
  if (shaderId === 'forgeax::single-layer-medium' || shaderId === 'forgeax::single-layer-water')
    return true;
  let shaders = mediumShaders.get(deps);
  const known = shaders?.get(shaderId);
  if (known !== undefined) return known;
  const medium = materialUsesSurfaceSceneInputs(deps.runtime.shaderRegistry, shaderId);
  if (shaders === undefined) {
    shaders = new Map();
    mediumShaders.set(deps, shaders);
  }
  shaders.set(shaderId, medium);
  return medium;
}

function resolveSurfaceMediumResources(
  deps: PerSubmeshMaterialBgDeps,
  shaderId: string | undefined,
  skylight: SkylightBindGroupResources,
): SurfaceMediumBindGroupResources | undefined {
  const { pipelineState, surfaceRawDepthView } = deps;
  if (!mediumShaderOf(deps, shaderId)) return undefined;
  if (surfaceRawDepthView == null) {
    throw new RhiError({
      code: 'rhi-descriptor-invalid',
      expected: 'single-layer medium material bind group has producer-owned raw depth',
      hint: 'admit the Surface material only from a graph pass with an available raw-depth pair',
    });
  }
  const nearestLayerView = deps.surfaceNearestLayerView ?? deps.transmissionBackdropView;
  const nearestDepthView = deps.surfaceNearestDepthView ?? pipelineState.shadowFallbackTextureView;
  const depthSampler = pipelineState.surfaceMediumDepthSampler;
  if (nearestLayerView == null || depthSampler === undefined) {
    throw new RhiError({
      code: 'rhi-descriptor-invalid',
      expected:
        'single-layer medium material bind group has paired nearest resources and depth sampler',
      hint: 'publish the nearest-layer target and the non-filtering raw-depth sampler before recording the Surface pass',
    });
  }
  const artifact =
    shaderId === undefined
      ? undefined
      : deps.runtime.shaderRegistry?.findMaterialArtifact(shaderId);
  const usesFoam =
    artifact?.ok === true &&
    artifact.value.program.materialBindings?.includes(
      derive(artifact.value.paramSchema ?? []).userRegionBindingEnd + 17,
    ) === true;
  if (usesFoam && deps.surfaceFoamSimulationView == null) {
    throw new RhiError({
      code: 'rhi-descriptor-invalid',
      expected: 'the connected Water foam branch has its graph-produced FoamRT',
      hint: 'publish the no-simulation initializer or simulation producer before recording this Water Surface pass',
    });
  }
  return {
    planarView: deps.planarReflectionView ?? skylight.brdfLutView,
    planarUniform: pipelineState.viewUniformBuffer,
    planarUniformOffset:
      deps.planarReflectionView === undefined
        ? PLANAR_REFLECTION_DISABLED_UNIFORM_OFFSET
        : PLANAR_REFLECTION_UNIFORM_OFFSET,
    rawDepthSampler: depthSampler,
    rawDepthView: surfaceRawDepthView,
    nearestLayerSampler: skylight.prefilterSampler,
    nearestLayerView,
    nearestDepthSampler: depthSampler,
    nearestDepthView,
    ...(usesFoam && deps.surfaceFoamSimulationView != null
      ? {
          foamSimulation: {
            view: deps.surfaceFoamSimulationView,
            sampler: skylight.irradianceSampler,
            heightSampler: pipelineState.defaultSampler,
          },
        }
      : {}),
  };
}

function resolveWaterFluidResources(
  deps: PerSubmeshMaterialBgDeps,
  shaderId: string | undefined,
): WaterFluidBindGroupResources | undefined {
  const artifact =
    shaderId === undefined
      ? undefined
      : deps.runtime.shaderRegistry?.findMaterialArtifact(shaderId);
  if (
    artifact?.ok !== true ||
    artifact.value.receipt?.systemInputs?.water !== 'water-frame/3' ||
    artifact.value.program.materialBindings?.includes(
      derive(artifact.value.paramSchema ?? []).userRegionBindingEnd + 19,
    ) !== true
  )
    return;
  if (deps.surfaceFluidSimulation === undefined)
    throw new RhiError({
      code: 'rhi-descriptor-invalid',
      expected: 'the reflected Water fluid branch has graph-owned fields and Body descriptors',
      hint: 'bind the same-frame simulation publication or its disabled neutral descriptor before every Water pass',
    });
  return deps.surfaceFluidSimulation;
}

function compactMaterialEntries(
  entries: BindGroupEntry[],
  omitted: ReadonlySet<number>,
  first: number,
): void {
  if (omitted.size === 0) return;
  let retained = first;
  for (let i = first; i < entries.length; i++) {
    const entry = entries[i] as BindGroupEntry;
    if (!omitted.has(entry.binding)) entries[retained++] = entry;
  }
  entries.length = retained;
}

/**
 * Assemble a material bind group from its user region, physical Standard
 * maps, the shared IBL/transmission/medium tail and the shared scene tables,
 * then retain it for reuse when every source was resident.
 */
function assembleMaterialBg(
  deps: PerSubmeshMaterialBgDeps,
  assembly: MaterialBgAssembly,
  fluidSimulation: WaterFluidBindGroupResources | undefined,
  address?: MaterialBindingAddress,
): BindGroup {
  const { runtime } = deps;
  const { skylight: effectiveSkylightResources, surfaceMediumResources } = assembly;
  const derivedSchema = assembly.schema === undefined ? undefined : derive(assembly.schema);
  // The admitted schema owns the same fixed physical slots as the BGL builder.
  // Cooked program keys are content digests, not Standard shader aliases.
  const litMaterial =
    assembly.selectedLayout?.lit ??
    materialUsesLitSceneInputs(runtime.shaderRegistry, assembly.shaderId);
  const emptyLit = litMaterial && assembly.schema?.length === 0;
  const physicalFields = litMaterial
    ? NO_MATERIAL_FIELDS
    : physicalTextureFieldsOf(assembly, derivedSchema);
  const smUserRegionFields = materialUserFields(
    assembly,
    derivedSchema,
    litMaterial,
    physicalFields,
  );
  // Binding zero is filled once the resolved textures select the physical uniform version.
  const uniformEntryCount = emptyLit ? 0 : 1;
  const smBaseEntries = new Array<BindGroupEntry>(uniformEntryCount);
  // The medium shader keeps the transmission backdrop pair in its fixed
  // group(1) ABI even on a device that cannot admit the ordinary Standard
  // transmission topology. Its Surface resources start at binding 10, so
  // retain a real backdrop pair here whenever the medium resources exist;
  // otherwise the raw-depth view would slide into binding 9 and Dawn would
  // reject the unfilterable r32float view as a filtering float texture.
  const sampledLimit = runtime.device.limits.maxSampledTexturesPerShaderStage;
  const dedicated = transmissionBackdropAvailable(sampledLimit);
  const standardLayout = assembly.perShaderBgl === undefined;
  const storageCount = assembly.projection?.storageCount ?? storageBindingCount(derivedSchema);
  const declarations =
    standardLayout || (litMaterial && dedicated)
      ? undefined
      : sharedMaterialBindingDeclarations(runtime.shaderRegistry, assembly.shaderId);
  const userRegionEnd = 1 + smUserRegionFields.length * 2 + storageCount;
  // A lit shader has its own region ABI. Its transmission declaration uses the
  // Standard projection even when its physical fields follow a different order.
  const declaresBackdrop = materialDeclaresBackdrop(
    assembly,
    derivedSchema,
    declarations,
    dedicated,
    litMaterial,
    userRegionEnd,
    storageCount,
  );
  const transmissionAvailable =
    dedicated || surfaceMediumResources !== undefined || declaresBackdrop;
  const omittedTransmissionBindings = litMaterial
    ? NO_OMITTED_BINDINGS
    : omittedStandardMaterialBindings(
        smUserRegionFields,
        transmissionAvailable,
        isStandardPbrMaterialShader(assembly.shaderId) || standardLayout,
        isCanonicalStandardPbrMaterialShader(assembly.shaderId) || standardLayout,
        declarations,
        userRegionEnd,
      );
  appendUserRegionEntries(
    smBaseEntries,
    deps,
    assembly,
    smUserRegionFields,
    derivedSchema,
    omittedTransmissionBindings,
    storageCount !== 0,
    !dedicated && !declaresBackdrop && usesSharedTransmissionSlots(assembly),
  );
  const physicalTextureInjections = physicalFields.map((field) =>
    physicalTextureInjection(deps, assembly, field),
  );
  const smMergedEntries = litMaterial
    ? assembleLitMaterialEntries(
        smBaseEntries,
        effectiveSkylightResources,
        derivedSchema?.userRegionBindingEnd ?? 1,
      )
    : assembleMaterialWithSkylightEntries(
        smBaseEntries,
        effectiveSkylightResources,
        transmissionAvailable ? transmissionResources(deps, effectiveSkylightResources) : null,
        physicalTextureInjections,
        surfaceMediumResources,
        fluidSimulation,
      );
  compactMaterialEntries(smMergedEntries, omittedTransmissionBindings, uniformEntryCount);
  if (!litMaterial)
    appendSharedMaterialTables(smMergedEntries, deps, derivedSchema, assembly.shaderId);
  return recordMaterialBinding(
    deps,
    assembly,
    smBaseEntries,
    smMergedEntries,
    physicalTextureInjections,
    emptyLit,
    address,
  );
}

function recordMaterialBinding(
  deps: PerSubmeshMaterialBgDeps,
  assembly: MaterialBgAssembly,
  smBaseEntries: BindGroupEntry[],
  smMergedEntries: BindGroupEntry[],
  physicalTextureInjections: readonly TextureInjectionResource[],
  emptyLit: boolean,
  address?: MaterialBindingAddress,
): BindGroup {
  const { runtime, materialSlice, transmissionBackdropView } = deps;
  // Allocate a numeric material address only when this physical layout binds it.
  let uniformResources: object | undefined;
  let uniformBuffer: Buffer | undefined;
  let absoluteOffset = 0;
  let byteOffset = 0;
  if (!emptyLit) {
    uniformResources = materialBindingUniformResources(smBaseEntries, physicalTextureInjections);
    const offsets = deps.materialBgAssemblyCache.uniformOffsets;
    uniformBuffer = prepareMaterialUniform(
      deps,
      assembly.material,
      assembly.world,
      uniformResources,
      assembly.missingBaseColor,
      offsets,
    );
    absoluteOffset = offsets.absolute;
    byteOffset = offsets.local;
    smMergedEntries[0] = {
      binding: 0,
      resource: {
        kind: 'buffer',
        value: { buffer: uniformBuffer, offset: 0, size: materialSlice },
      },
    };
  }
  smMergedEntries = projectMaterialLayoutEntries(assembly.bgl, smMergedEntries);
  requireCurrentGraphViews(deps.graphViews);
  const smBindGroup = deps.materialBgAssemblyCache.issue(
    runtime,
    assembly.bgl,
    smMergedEntries,
    !isCanonicalStandardPbrMaterialShader(assembly.shaderId) && transmissionBackdropView != null,
    deps.bindGroupCounts,
  );
  requireCurrentGraphViews(deps.graphViews);
  const installed = retainMaterialBgAssembly(
    deps,
    assembly,
    uniformResources,
    uniformBuffer,
    smBindGroup,
    smMergedEntries,
    absoluteOffset,
    smBaseEntries.length,
    emptyLit ? 0 : 1,
  );
  deps.frameState.iblBindings?.bindIssued(
    assembly.bgl,
    smBindGroup,
    smMergedEntries,
    smBaseEntries.length,
  );
  requireCurrentGraphViews(deps.graphViews);
  if (address !== undefined) {
    address.byteOffset = byteOffset;
    address.dynamicOffsetCount = emptyLit ? 0 : 1;
    if (address.capture !== undefined)
      address.capture.current = deps.materialBgAssemblyCache.captureBindingCurrent(
        assembly.scopeIdentity,
        assembly.materialHandle,
        assembly.shaderId,
        assembly.probeIndex,
        assembly.standardMaterialLayoutIndex,
        installed,
      );
  }
  return smBindGroup;
}

function materialUserFields(
  assembly: MaterialBgAssembly,
  derivedSchema: ReturnType<typeof derive> | undefined,
  litMaterial: boolean,
  physicalFields: readonly string[],
): readonly string[] {
  if (!litMaterial) return userRegionTextureFields(assembly, derivedSchema, physicalFields);
  return (
    assembly.projection?.textureFields ??
    (derivedSchema === undefined ? NO_MATERIAL_FIELDS : [...derivedSchema.textureFieldNames])
  );
}

function materialDeclaresBackdrop(
  assembly: MaterialBgAssembly,
  derivedSchema: ReturnType<typeof derive> | undefined,
  declarations: ReturnType<typeof sharedMaterialBindingDeclarations>,
  dedicated: boolean,
  litMaterial: boolean,
  userRegionEnd: number,
  storageCount: number,
): boolean {
  if (dedicated || declarations === undefined) return false;
  if (litMaterial) {
    const fields = userRegionTextureFields(
      assembly,
      derivedSchema,
      physicalTextureFieldsOf(assembly, derivedSchema),
    );
    userRegionEnd = 1 + fields.length * 2 + storageCount;
  }
  return programDeclaresTransmissionBackdrop(declarations, userRegionEnd);
}

const NO_MATERIAL_FIELDS: readonly string[] = [];
const NO_OMITTED_BINDINGS: ReadonlySet<number> = new Set();

function physicalTextureFieldsOf(
  assembly: MaterialBgAssembly,
  derivedSchema: ReturnType<typeof derive> | undefined,
): readonly string[] {
  if (derivedSchema === undefined) return NO_MATERIAL_FIELDS;
  return (
    assembly.projection?.physicalFields ??
    STANDARD_PHYSICAL_TEXTURE_FIELDS.filter((field) => derivedSchema.parameterTypes.has(field))
  );
}

/**
 * Admitted schemas share their immutable projection; compatibility schemas
 * retain the original per-field reads, including resolver reentrancy.
 */
function userRegionTextureFields(
  assembly: MaterialBgAssembly,
  derivedSchema: ReturnType<typeof derive> | undefined,
  physicalFields: readonly string[],
): readonly string[] {
  if (
    assembly.perShaderBgl === undefined ||
    isCanonicalStandardPbrMaterialShader(assembly.shaderId)
  )
    return BUILTIN_USER_REGION_TEXTURE_FIELDS;
  if (assembly.projection !== undefined) return assembly.projection.standardUserFields;
  return [...(derivedSchema?.textureFieldNames ?? BUILTIN_USER_REGION_TEXTURE_FIELDS)].filter(
    (field) => !physicalFields.includes(field),
  );
}

function storageBindingCount(derivedSchema: ReturnType<typeof derive> | undefined): number {
  let count = 0;
  if (derivedSchema !== undefined)
    for (const resource of derivedSchema.resourceBindings)
      if (resource.kind === 'storage-buffer') count++;
  return count;
}

function usesSharedTransmissionSlots(assembly: MaterialBgAssembly): boolean {
  const { shaderId, material } = assembly;
  if (shaderId === undefined) return false;
  return (
    standardTransmissionAdmission(
      shaderId === material.materialShaderId
        ? material
        : {
            materialShaderId: shaderId,
            surfaceModel: material.surfaceModel,
            paramSnapshot: material.paramSnapshot,
            standardTextureMask: material.standardTextureMask,
          },
      assembly.runtime.device.limits.maxSampledTexturesPerShaderStage,
    )?.kind === 'shared'
  );
}

function sharedTransmissionResource(canonicalSlot: string | undefined): string | undefined {
  for (const slot of STANDARD_SHARED_TRANSMISSION_SLOTS) {
    if (slot.host === canonicalSlot) return slot.resource;
  }
  return undefined;
}

/** A storage-bearing schema declares its sampler bindings; otherwise pairs are dense. */
function userRegionSamplerBinding(
  derivedSchema: ReturnType<typeof derive> | undefined,
  storageBound: boolean,
  canonicalSlot: string | undefined,
  pairIndex: number,
  projection: MaterialTextureProjection | undefined,
): number {
  const dense = 1 + pairIndex * 2;
  if (!storageBound || canonicalSlot === undefined) return dense;
  if (projection !== undefined) return projection.samplerBindings?.get(canonicalSlot) ?? dense;
  return (
    derivedSchema?.resourceBindings.find(
      (resource) => resource.kind === 'sampler' && resource.parameter === canonicalSlot,
    )?.binding ?? dense
  );
}

/** Sampler/texture pairs of the shader's user region, in binding order. */
function appendUserRegionEntries(
  entries: BindGroupEntry[],
  deps: PerSubmeshMaterialBgDeps,
  assembly: MaterialBgAssembly,
  fields: readonly string[],
  derivedSchema: ReturnType<typeof derive> | undefined,
  omitted: ReadonlySet<number>,
  storageBound: boolean,
  sharedSlots: boolean,
): void {
  const { pipelineState, material } = assembly;
  for (let fi = 0; fi < fields.length; fi++) {
    const canonicalSlot = fields[fi];
    const sharedResource = sharedSlots ? sharedTransmissionResource(canonicalSlot) : undefined;
    const samplerBinding = userRegionSamplerBinding(
      derivedSchema,
      storageBound,
      canonicalSlot,
      fi,
      assembly.projection,
    );
    const slot = sharedResource ?? canonicalSlot;
    const field =
      slot !== undefined && isStandardPbrMaterialShader(assembly.shaderId)
        ? standardInputField(
            slot,
            material.standardTextureMask,
            material.paramSnapshot?.displacementMode,
          )
        : slot;
    if (sharedResource === undefined && omitted.has(samplerBinding + 1)) {
      // Keep the logical region length until the shared IBL merger computes
      // its offsets. Omitted slots must not trigger residency requirements.
      entries.push(
        {
          binding: samplerBinding,
          resource: { kind: 'sampler', value: pipelineState.defaultSampler },
        },
        {
          binding: samplerBinding + 1,
          resource: { kind: 'textureView', value: pipelineState.defaultWhiteTextureView },
        },
      );
      continue;
    }
    appendUserRegionPair(entries, deps, assembly, field, samplerBinding);
  }
}

/**
 * One user-region sampler/texture pair. Source facts are read in their fixed
 * order before resolution; the texture follows source precedence: prepared,
 * external, canvas, render target, video, then the resident texture asset.
 * Unavailable sources keep the neutral fallback and mark the assembly
 * non-resident.
 */
function appendUserRegionPair(
  entries: BindGroupEntry[],
  deps: PerSubmeshMaterialBgDeps,
  assembly: MaterialBgAssembly,
  field: string | undefined,
  samplerBinding: number,
): void {
  const { material } = assembly;
  const parameter = field === undefined ? undefined : materialFieldParameter(assembly, field);
  const fallback =
    field !== undefined
      ? defaultViewForParameter(field, assembly.pipelineState, parameter)
      : assembly.pipelineState.defaultWhiteTextureView;
  const videoClip = field !== undefined ? material.videoTextureFields?.get(field) : undefined;
  // A caller-owned video map may edit a borrowed schema while serving get().
  const slotExternal =
    (assembly.projection === undefined && field !== undefined
      ? materialFieldParameter(assembly, field)?.type
      : parameter?.type) === 'texture_external';
  const runtimeSource = field === undefined ? undefined : material.textureSources?.get(field);
  const targetSource =
    field === undefined
      ? undefined
      : materialRenderTargetSourceForField(material, field, deps.resolveRenderTargetTextureSource);
  const preparedTexture = preparedMaterialTexture(assembly, field);
  let resource: RhiBindingResource | undefined;
  let view = fallback;
  if (isRenderFeatureTextureSource(runtimeSource)) {
    view = featureTextureView(assembly, runtimeSource, fallback);
  } else if (runtimeSource?.source === 'feature') {
    const current = deps.resolveFeatureTextureSource?.(runtimeSource.owner);
    if (current === undefined)
      throw new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: `current view graph producer for material texture ${runtimeSource.owner}`,
        hint: 'enable the declared producer and materialSource texture in this frame and device generation',
      });
    view = current;
  } else if (preparedTexture !== undefined) view = preparedTexture.textureView;
  else if (isExternalTextureSource(runtimeSource)) {
    resource = assembly.runtime.externalTextures?.resolve(runtimeSource, slotExternal);
    if (resource === undefined) assembly.resident = false;
  } else if (field !== undefined && isCanvasTextureSource(runtimeSource))
    view = canvasFieldView(assembly, field, runtimeSource, fallback);
  else if (targetSource !== undefined)
    view = renderTargetFieldView(assembly, field, targetSource, fallback);
  else if (videoClip !== undefined)
    resource = videoFieldResource(deps, assembly, videoClip, slotExternal);
  else view = userRegionAssetView(assembly, field, fallback);
  entries.push(
    {
      binding: samplerBinding,
      resource: {
        kind: 'sampler' as const,
        value: preparedTexture?.sampler ?? materialBindingSampler(assembly, field),
      },
    },
    {
      binding: samplerBinding + 1,
      resource: resource ?? { kind: 'textureView' as const, value: view },
    },
  );
}

function preparedMaterialTexture(assembly: MaterialBgAssembly, field: string | undefined) {
  const { runtime } = assembly;
  if (
    field === undefined ||
    runtime.preparedMaterialTexture === undefined ||
    runtime.preparedMaterialTexture.parameters?.has(field) === false
  )
    return undefined;
  assembly.preparedTextures ??= new Map();
  const preparedTextures = assembly.preparedTextures;
  if (!preparedTextures.has(field))
    preparedTextures.set(field, runtime.preparedMaterialTexture(assembly.material, field));
  return preparedTextures.get(field);
}

/** The declared type of a user-region slot, by the same lookup external routing uses. */
function materialFieldParameter(
  assembly: MaterialBgAssembly,
  field: string,
): ParamSchemaEntry | undefined {
  return assembly.projection === undefined
    ? assembly.schema?.find((entry) => entry.name === field)
    : assembly.projection.parametersByName.get(field);
}

function defaultMaterialFieldView(assembly: MaterialBgAssembly, field: string): TextureView {
  return defaultViewForParameter(
    field,
    assembly.pipelineState,
    materialFieldParameter(assembly, field),
  );
}

function canvasFieldView(
  assembly: MaterialBgAssembly,
  field: string,
  source: CanvasTextureSource,
  fallback: TextureView,
): TextureView {
  const local = canvasSourceSlot(source);
  const view = resolveCanvasView(source, local, assembly.world, assembly.runtime);
  if (view === undefined) {
    assembly.resident = false;
    return fallback;
  }
  if (!assembly.acceptsCanvases || assembly.projection === undefined) return view;
  assembly.canvas ??= [];
  const fields = assembly.canvas;
  for (const binding of fields) if (binding.field === field) return view;
  fields.push({
    field,
    owner: source.owner,
    id: source.id,
    publicationKey: renderTextureSourceKey(source),
    local,
    view,
  });
  return view;
}

function canvasMaterialBindingsCurrent(
  cached: MaterialBgAssemblyCacheEntry,
  material: MaterialSnapshot,
  deps?: PerSubmeshMaterialBgDeps,
  world?: RenderResourceScope,
  schema?: readonly ParamSchemaEntry[],
): boolean {
  const canvas = cached.canvas;
  if (canvas === undefined) return (material.textureSources?.size ?? 0) === 0;
  return (
    deps !== undefined &&
    world !== undefined &&
    canvas.schema === schema &&
    canvas.defaultSampler === deps.pipelineState.defaultSampler &&
    synchronizeBoundCanvases(canvas.fields, material, world, deps.runtime)
  );
}

/** Refresh pixels at their owner on every draw. Only a physical change needs a new descriptor. */
function synchronizeBoundCanvases(
  fields: readonly CanvasFieldBinding[],
  material: MaterialSnapshot,
  world: RenderResourceScope,
  runtime: RenderSystemRuntime,
): boolean {
  const sources = material.textureSources;
  if (sources === undefined || fields.length !== sources.size) return false;
  for (let index = 0; index < fields.length; index++) {
    const binding = fields[index] as CanvasFieldBinding;
    const source = sources.get(binding.field);
    if (
      !isCanvasTextureSource(source) ||
      source.owner !== binding.owner ||
      source.id !== binding.id ||
      resolveCanvasView(
        source,
        binding.local ?? canvasSourceSlot(source),
        world,
        runtime,
        binding,
      ) !== binding.view
    )
      return false;
  }
  return true;
}

/**
 * The Renderer host resolves the generation-checked physical view. A
 * candidate is never exposed here; until its matching FrameReceipt completes,
 * the material remains on the neutral fallback.
 */
function renderTargetFieldView(
  assembly: MaterialBgAssembly,
  field: string | undefined,
  targetSource: RenderTargetMaterialSourceBinding,
  fallback: TextureView,
): TextureView {
  const parameterTypes = assembly.projection?.parameterTypes;
  if (
    targetSource.textureView !== undefined &&
    (parameterTypes === undefined
      ? renderTargetSourceFitsParameter(targetSource, field, assembly.schema)
      : renderTargetSourceFitsParameterType(
          targetSource,
          field === undefined ? undefined : parameterTypes.get(field),
        ))
  )
    return targetSource.textureView;
  assembly.resident = false;
  return fallback;
}

function videoFieldResource(
  deps: PerSubmeshMaterialBgDeps,
  assembly: MaterialBgAssembly,
  videoClip: AssetHandle<'video'>,
  slotExternal: boolean,
): RhiBindingResource | undefined {
  if (assembly.entityKey === undefined)
    throw new RhiError({
      code: 'rhi-descriptor-invalid',
      expected: 'an entity-local video binding on the direct material path',
      hint: 'route video materials through their player before assembling resources',
    });
  return videoBindingResource(
    assembly.world,
    assembly.runtime,
    assembly.entityKey,
    videoClip,
    deps.videoHighPerfAvailable,
    slotExternal,
  );
}

function userRegionTextureHandle(
  material: MaterialSnapshot,
  field: string | undefined,
): AssetHandle<'texture' | 'gpu-texture'> | undefined {
  if (field === 'emissiveTexture') return material.emissiveTexture;
  if (field === 'occlusionTexture') return material.occlusionTexture;
  return field === undefined ? undefined : material.textureHandles?.get(field);
}

function residentAssetView(
  assembly: MaterialBgAssembly,
  handle: AssetHandle<'texture' | 'gpu-texture'>,
): TextureView | undefined {
  const view = residentTextureView(assembly.world, assembly.store, assembly.runtime, handle);
  if (view === undefined) assembly.resident = false;
  return view;
}

function userRegionAssetView(
  assembly: MaterialBgAssembly,
  field: string | undefined,
  fallback: TextureView,
): TextureView {
  const handle = userRegionTextureHandle(assembly.material, field);
  if (handle === undefined) return fallback;
  const view = residentAssetView(assembly, handle);
  if (view !== undefined) return view;
  if (field === 'baseColorTexture' && !assembly.store.isTexturePreparing(handle, assembly.world))
    assembly.missingBaseColor = true;
  return fallback;
}

/**
 * Physical Standard maps are deliberately appended after the stable IBL /
 * transmission tail. Keep their resource projection separate from the
 * user-region pairs so the slot order is the same as
 * `appendTextureInjection(effectiveSchema)` in the layout owner.
 */
function physicalTextureInjection(
  deps: PerSubmeshMaterialBgDeps,
  assembly: MaterialBgAssembly,
  field: string,
): TextureInjectionResource {
  const fallback = defaultMaterialFieldView(assembly, field);
  const targetSource = materialRenderTargetSourceForField(
    assembly.material,
    field,
    deps.resolveRenderTargetTextureSource,
  );
  const runtimeSource = assembly.material.textureSources?.get(field);
  const preparedTexture = preparedMaterialTexture(assembly, field);
  const view =
    preparedTexture !== undefined
      ? preparedTexture.textureView
      : physicalFieldView(assembly, field, targetSource, runtimeSource, fallback);
  return {
    slot: STANDARD_PHYSICAL_TEXTURE_FIELDS.indexOf(
      field as (typeof STANDARD_PHYSICAL_TEXTURE_FIELDS)[number],
    ),
    sampler: preparedTexture?.sampler ?? materialBindingSampler(assembly, field),
    view,
  };
}

function featureTextureView(
  assembly: MaterialBgAssembly,
  source: RenderFeatureTextureSource,
  fallback: TextureView,
): TextureView {
  const view = assembly.runtime.viewOwner?.preparedResolver.gpuWork.resolveTexture(
    source.owner,
    source.name,
  );
  if (view !== undefined) return view;
  assembly.resident = false;
  return fallback;
}

function physicalFieldView(
  assembly: MaterialBgAssembly,
  field: string,
  targetSource: RenderTargetMaterialSourceBinding | undefined,
  runtimeSource: MaterialTextureSource | undefined,
  fallback: TextureView,
): TextureView {
  if (isRenderFeatureTextureSource(runtimeSource))
    return featureTextureView(assembly, runtimeSource, fallback);
  if (isExternalTextureSource(runtimeSource)) {
    const resolved = assembly.runtime.externalTextures?.resolve(runtimeSource, false);
    if (resolved?.kind === 'textureView') return resolved.value;
    assembly.resident = false;
    return fallback;
  }
  if (isCanvasTextureSource(runtimeSource))
    return canvasFieldView(assembly, field, runtimeSource, fallback);
  if (targetSource !== undefined) {
    if (targetSource.textureView !== undefined) return targetSource.textureView;
    assembly.resident = false;
    return fallback;
  }
  const handle = assembly.material.textureHandles?.get(field);
  if (handle === undefined) return fallback;
  return residentAssetView(assembly, handle) ?? fallback;
}

/**
 * The backdrop is a full mip-chain view owned by the pipeline. Reuse the
 * pipeline's existing filtering/clamp sampler for screen-space sampling; the
 * material default sampler intentionally keeps repeat addressing for authored
 * UV textures and is not a backdrop sampler.
 */
function transmissionResources(
  deps: PerSubmeshMaterialBgDeps,
  skylight: SkylightBindGroupResources,
): TransmissionBindGroupResources {
  const { transmissionBackdropView, pipelineState } = deps;
  return {
    sampler:
      transmissionBackdropView != null ? skylight.prefilterSampler : pipelineState.defaultSampler,
    ...(transmissionBackdropView === undefined
      ? { backdropView: pipelineState.defaultWhiteTextureView }
      : { backdropView: transmissionBackdropView }),
  } satisfies TransmissionBindGroupResources;
}

/**
 * Storage-capable devices share one Standard material BGL with the
 * scene-index GPU lane. Even direct draws need a complete entry for
 * binding(46), although their shader does not read the scene table. Reuse the
 * storage-backed mesh table as a neutral placeholder until a producer-owned
 * GPU scene table is available; GPU-driven draws replace it with
 * `deps.sceneMaterialBuffer`.
 */
function appendSharedMaterialTables(
  entries: BindGroupEntry[],
  deps: PerSubmeshMaterialBgDeps,
  derivedSchema: ReturnType<typeof derive> | undefined,
  shaderId: string | undefined,
): void {
  if (
    derivedSchema?.parameterTypes.get('directMultiscatteringLut') === 'u32' &&
    !isCanonicalStandardPbrMaterialShader(shaderId) &&
    sharedMaterialBindingDeclarations(deps.runtime.shaderRegistry, shaderId)?.includes(
      STANDARD_DIRECT_DFG_LUT_BINDING,
    ) !== false
  ) {
    const lut = getOrCreateDirectDfgLut(
      deps.runtime.device,
      recordContext(deps.runtime).deviceScope,
    ).unwrap();
    entries.push({
      binding: STANDARD_DIRECT_DFG_LUT_BINDING,
      resource: { kind: 'textureView', value: lut.view },
    });
  }
  const sceneMaterialBuffer = directSceneMaterialBuffer(deps);
  if (sceneMaterialBuffer !== undefined) {
    entries.push({
      binding: 46,
      resource: { kind: 'buffer' as const, value: { buffer: sceneMaterialBuffer } },
    });
  }
}

const NO_MATERIAL_RESOURCES: MaterialBgAssemblyCacheEntry['materialResources'] = Object.freeze([]);
const NO_PREPARED_TEXTURES: MaterialBgAssemblyCacheEntry['preparedTextures'] = Object.freeze([]);

/** Retain a fully resident, frame-independent assembly for cross-frame reuse. */
function retainMaterialBgAssembly(
  deps: PerSubmeshMaterialBgDeps,
  assembly: MaterialBgAssembly,
  uniformResources: object | undefined,
  materialBuffer: Buffer | undefined,
  bindGroup: BindGroup,
  entries: readonly BindGroupEntry[],
  uniformOffset: number,
  iblStart: number,
  dynamicOffsetCount: 0 | 1,
): MaterialBgAssemblyCacheEntry | undefined {
  const {
    material,
    world,
    materialHandle,
    scopeIdentity,
    store,
    runtime,
    pipelineState,
    bindingSourcesCurrent,
    surfaceMediumResources,
    graphViews,
  } = assembly;
  const sceneCurrent = deps.bindingSceneCurrent;
  const skylight = assembly.skylight;
  const probeIndex = assembly.probeIndex;
  const surfaceGraphInputs = surfaceMediumResources === undefined ? undefined : deps;
  const canvas = assembly.canvas;
  if (
    (bindingSourcesCurrent === undefined && canvas === undefined) ||
    materialHandle === undefined ||
    assembly.hasVideoFields ||
    (material.textureSources?.size ?? 0) !== (canvas?.length ?? 0) ||
    !assembly.resident ||
    !materialBindingViewsCurrent(
      graphViews,
      isCanonicalStandardPbrMaterialShader(assembly.shaderId)
        ? undefined
        : deps.transmissionBackdropView,
      surfaceGraphInputs?.surfaceRawDepthView,
      surfaceGraphInputs?.surfaceNearestLayerView,
      surfaceGraphInputs?.surfaceNearestDepthView,
    ) ||
    scopeIdentity === undefined
  )
    return;
  const planar = surfaceMediumResources !== undefined;
  const sceneMaterialBuffer = directSceneMaterialBuffer(deps);
  const resourceFacts = {
    material,
    preparedTextureDomain:
      runtime.preparedMaterialTexture?.parameters ?? runtime.preparedMaterialTexture,
    materialResources: captureMaterialResources(material, world, store, assembly.preparedTextures),
    preparedTextures:
      assembly.preparedTextures === undefined
        ? NO_PREPARED_TEXTURES
        : [...assembly.preparedTextures].map(([parameter, source]) => ({
            parameter,
            textureView: source?.textureView,
            sampler: source?.sampler,
          })),
  };
  return deps.materialBgAssemblyCache.set(
    scopeIdentity,
    materialHandle,
    assembly.shaderId,
    assembly.probeIndex,
    {
      ...resourceFacts,
      inputs: assembly.inputs,
      dynamicOffsetCount,
      ...(canvas === undefined
        ? {}
        : {
            canvas: {
              fields: canvas,
              schema: assembly.schema,
              defaultSampler: pipelineState.defaultSampler,
            },
          }),
      ...(graphViews === undefined ? {} : { graphViews }),
      descriptor: {
        label: 'pbr-material-skylight-bg',
        layout: assembly.bgl,
        entries,
      },
      bindingsCurrent: () =>
        bindingSourcesCurrent?.() === true &&
        (graphViews === undefined || graphBindingViewsCurrent(graphViews)) &&
        (sceneCurrent?.(skylight, probeIndex, planar) ?? true) &&
        (materialBuffer === undefined ||
          meshSsboBuffer(pipelineState.materialUniformBuffer, uniformOffset) === materialBuffer) &&
        materialBindingResourcesCurrent(
          resourceFacts,
          world,
          store,
          runtime,
          materialResource(material)?.snapshot ?? material,
        ),
      skylightBindingStart: iblStart,
      uniformResources,
      materialBgl: assembly.bgl,
      materialBuffer,
      ...(sceneMaterialBuffer === undefined ? {} : { sceneMaterialBuffer }),
      skylightResources: assembly.skylight,
      ...(planar
        ? {
            planarReflection: {
              view: deps.planarReflectionView,
              uniform: deps.pipelineState.viewUniformBuffer,
            },
          }
        : {}),
      bindGroup,
    },
    assembly.standardMaterialLayoutIndex,
  );
}

const ZERO_SKYLIGHT_PAYLOAD = new Float32Array([
  0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0,
]);

function materialEnvironmentIbl(
  runtime: Pick<RenderSystemRuntime, 'device'>,
  skylight: SkylightSnapshot | undefined,
  environmentIbl: _InternalRenderPipelineContext['environmentIbl'],
) {
  if (skylight?.featureEnvironment) {
    const source = skylight.featureEnvironment,
      owner = recordContext(runtime as RenderSystemRuntime).sharedFeatureGpuWork;
    const skySh = owner?.resolveNamedBuffer(source.feature, source.skySh);
    const prefilter = owner?.resolveTexture(source.feature, source.prefilter);
    if (
      skySh !== undefined &&
      (skySh.size !== SKY_SH_BYTES || (skySh.physicalUsage & GPU_BUFFER_USAGE_UNIFORM) === 0)
    ) {
      throw new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'feature Skylight Sky SH is a 112-byte uniform buffer',
        hint: 'Publish seven packed vec4 coefficients with uniform usage before lighting.',
      });
    }
    environmentIbl =
      skySh !== undefined && prefilter !== undefined
        ? { skySh: skySh.buffer, prefilter }
        : undefined;
  }
  if (skylight?.targetEnvironment !== undefined) {
    environmentIbl = resolveTargetEnvironment(skylight.targetEnvironment, runtime.device);
    if (environmentIbl === undefined)
      throw new RhiError({
        code: 'webgpu-runtime-error',
        expected: 'a live renderer-owned target environment',
        hint: 'Prepare the cube environment and retain it until its consumers are removed.',
      });
  }
  return environmentIbl;
}

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
  let activeViews: { skySh: Buffer; pref: TextureView; brdf: TextureView } | undefined;
  const uniformPayload = ZERO_SKYLIGHT_PAYLOAD.slice();
  if (
    skylight !== undefined &&
    skylightCount >= 1 &&
    skylight.equirectHandle !== 0 &&
    imageIbl !== undefined
  ) {
    activeViews = {
      skySh: imageIbl.skySh,
      pref: imageIbl.prefilterView,
      brdf: imageIbl.brdfLutView,
    };
  }
  environmentIbl = materialEnvironmentIbl(runtime, skylight, environmentIbl);
  if (environmentIbl !== undefined && skylight !== undefined && skylight.equirectHandle === 0) {
    activeViews = {
      skySh: environmentIbl.skySh,
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
    ((skylight.equirectHandle === 0 && !skylight.featureEnvironment) || activeViews !== undefined)
  ) {
    const [cr, cg, cb] = skylight.color;
    const [qx, qy, qz, qw] = skylight.rotation;
    uniformPayload.set([skylight.intensity, cr, cg, cb, qx, qy, qz, qw]);
    uniformPayload.set(skylightGroundLane(skylight, true), 20);
  }
  if (skylight?.ambientIrradiance !== undefined) uniformPayload.set(skylight.ambientIrradiance, 16);
  runtime.device.queue.writeBuffer(skylightFallback.intensityBuffer, 0, uniformPayload);
  const skylightResources = skylightBindGroupResources(skylightFallback, activeViews);
  return { skylightResources, activeViews };
}

/** The same scene resources back material bindings in depth and color passes. */
export function prepareMaterialSkylight(
  c: Pick<
    _InternalRenderPipelineContext,
    | 'runtime'
    | 'pipelineState'
    | 'skylight'
    | 'skylightCount'
    | 'store'
    | 'world'
    | 'environmentIbl'
  >,
) {
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

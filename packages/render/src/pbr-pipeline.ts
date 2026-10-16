import { atmosphereViewLayoutEntries } from './environment/bindings';
// pbr-pipeline.ts -- PBR / unlit pipeline-layout factories (M4 round-4 D-5).
//
// Anchors:
//   - plan-strategy D-5 (round-4 REVISED): the PBR pipeline keeps a 4-slot
//     pipeline layout `[view, material, mesh-array, instances]`. The
//     material BGL grows from the derived user region by appending the 7
//     Skylight resources via `appendInjection(..., 'ibl')`. The
//     unlit pipeline keeps its 7-entry material BGL (no Skylight binding
//     7..12 contamination) so unlit demos don't carry IBL state.
//   - charter P4: same pipeline layout shape drives Skylight present +
//     absent paths -- AI users do not branch on Skylight existence.
//   - feat-20260520-skylight-ibl-cubemap M4 / t59 (round-4): the
//     pipeline-layout construction migrates out of `createRenderer.ts`
//     into this dedicated module so M4 round-4 tests can mock the device
//     and inspect the captured descriptors without standing up the full
//     createRenderer + asset registry + manifest stack.
//
// The factory functions return both the captured handles AND the
// `bindGroupLayouts` array passed to `device.createPipelineLayout`. Callers
// (the createRenderer step that wires the standard + standard-HDR
// `RenderPipeline` instances) consume the result by name; tests inspect
// `device.createBindGroupLayout.mock.calls` to verify shape (t57).

import type {
  BindGroup,
  BindGroupEntry,
  BindGroupLayout,
  Buffer,
  PipelineLayout,
  RhiDevice,
  Sampler,
  TextureView,
} from '@forgeax/engine-rhi';
import {
  type ShaderCatalog,
  STANDARD_DIRECT_DFG_LUT_BINDING,
  STANDARD_PHYSICAL_BINDING_START,
  STANDARD_PHYSICAL_TEXTURE_FIELDS,
  STANDARD_PIPELINE_PARAM_SCHEMA,
  standardPhysicalTextureFields,
  standardTextureMask,
} from '@forgeax/engine-shader';
import { derive, type ParamSchemaEntry } from '@forgeax/engine-types';
import { materialUsesDirectDfgLut } from './device/direct-dfg-lut';
import { GPU_SHADER_STAGE_FRAGMENT, GPU_SHADER_STAGE_VERTEX } from './gpu-stage';
import type { PipelineSpec } from './pipeline-spec-types';

// Boot layouts use the canonical Standard identity so material resource-budget
// omissions match the record path. Other BGL kinds depend only on caps.
const BGL_ONLY_SPEC_STUB: PipelineSpec = Object.freeze({
  shader: { id: 'forgeax::default-standard-pbr', passKind: 'forward', variantSet: undefined },
  attachments: { colorFormats: [], depthFormat: undefined, sampleCount: 1 },
  geometry: { topology: 'triangle-list', vertexLayout: {} },
  renderState: undefined,
}) as PipelineSpec;

// ─── Device owner ───────────────────────────────────────────────────────────

/** The PBR layout builder consumes only the two creation methods it owns. */
export type PbrPipelineDevice = Pick<RhiDevice, 'createBindGroupLayout' | 'createPipelineLayout'>;

// ─── Result shape ───────────────────────────────────────────────────────────

export interface PbrPipelineLayoutBundle {
  /** Pipeline layout passed to `createRenderPipeline({ layout })`. */
  readonly pipelineLayout: PipelineLayout;
  /** view BindGroupLayout (slot 0). */
  readonly viewBgl: BindGroupLayout;
  /**
   * PBR material BindGroupLayout (slot 1) -- derived user-region entries plus
   * Skylight and transmission injection.
   */
  readonly materialBgl: BindGroupLayout;
  /** Per-entity mesh BindGroupLayout (slot 2). */
  readonly meshArrayBgl: BindGroupLayout;
  /** Per-instance storage BindGroupLayout (slot 3). */
  readonly instancesBgl: BindGroupLayout;
  /** Probe-enabled slot-3 BGL; aliases `instancesBgl` when probes are unavailable. */
  readonly probeInstancesBgl: BindGroupLayout;
  /** Same pipeline layout with the probe-enabled slot-3 BGL, when supported. */
  readonly probePipelineLayout: PipelineLayout | null;
  /**
   * Same 4 layouts in slot order. Useful for assertion sites that check the
   * pipeline-layout `bindGroupLayouts` array shape (t57 (a) + (d)).
   */
  readonly bindGroupLayouts: readonly [
    BindGroupLayout,
    BindGroupLayout,
    BindGroupLayout,
    BindGroupLayout,
  ];
}

// ─── Base entries (round-4 SSOT) ────────────────────────────────────────────

/**
 * The built-in standard-PBR material paramSchema's texture/user-region shape,
 * used as the fallback when the material BGL is built without a registry
 * (the caps-driven `buildPbrPipelineLayouts` seam). Declares the canonical
 * Standard user-region textures + a numeric UBO run; `derive()` collapses the
 * numerics into binding 0 and emits one sampler/texture pair per declared
 * texture. Physical map pairs stay outside this boot region and are appended
 * only for an authored root that declares them. The shared PBR parameter
 * contract comes from the shader package; this module only derives the GPU
 * layout.
 */
/**
 * Build the PBR material BGL **user-region** from a paramSchema via the
 * `derive()` SSOT (D-1). The user-region is binding 0 (the run-merged material
 * UBO) followed by one sampler/texture pair per declared texture. Engine
 * injection (IBL + transmission) is appended AFTER this region by the caller via
 * `appendInjection`, with start binding = `userRegion.length` — so a 4-texture
 * custom schema (e.g. parallax + heightTexture) shifts the injection region by
 * one sampler/texture pair automatically.
 *
 * The canonical `STANDARD_PIPELINE_PARAM_SCHEMA` currently declares twelve
 * non-physical textures, so this derives to binding 0 UBO + twelve pairs = 25
 * entries. IBL and transmission injection are appended after that region;
 * authored physical maps are appended after the engine-owned injections.
 *
 * One material-UBO convention is layered on top of the pure `derive()` output:
 * binding 0 is patched to `{ type: 'uniform', hasDynamicOffset: true }` with
 * `VERTEX | FRAGMENT` visibility. The material UBO is bound with a per-submesh
 * dynamic offset (`render-system-record.ts setBindGroup(1, bg, [offset])`) and
 * the vertex stage reads material params, so this is required for GPU
 * validation. `derive()` stays FRAGMENT-only / no-dynamic-offset for its other
 * consumers (it is the generic SSOT, not the material-UBO authority).
 *
 * @param paramSchema - the material shader's paramSchema (defaults to the
 *   built-in standard-PBR shape when omitted, for the caps-driven seam).
 */
export function buildPbrMaterialUserRegionEntries(
  paramSchema: readonly ParamSchemaEntry[] = STANDARD_PIPELINE_PARAM_SCHEMA,
  excludedTextureFields: readonly string[] = [],
  vertexOnlyTextureFields: readonly string[] = [],
): GPUBindGroupLayoutEntry[] {
  const excluded = new Set(excludedTextureFields);
  for (const field of standardPhysicalTextureFields(paramSchema)) excluded.add(field);
  const derived = derive(
    excluded.size === 0
      ? paramSchema
      : paramSchema.filter(
          (entry) => !excluded.has(entry.name) || !entry.type.startsWith('texture'),
        ),
  );
  // Project the engine-owned entry shape into the DOM WebGPU descriptor. Omit
  // absent optional members so exactOptionalPropertyTypes remains true at the
  // boundary instead of leaking an `undefined` property into the descriptor.
  const vertexOnlyBindings = new Set(
    derived.resourceBindings
      .filter(
        (resource) =>
          resource.parameter !== undefined && vertexOnlyTextureFields.includes(resource.parameter),
      )
      .map((resource) => resource.binding),
  );
  let entries = derived.bglEntries.map(
    (entry): GPUBindGroupLayoutEntry => ({
      binding: entry.binding,
      visibility: vertexOnlyBindings.has(entry.binding)
        ? GPU_SHADER_STAGE_VERTEX
        : entry.texture !== undefined ||
            entry.sampler !== undefined ||
            entry.externalTexture !== undefined
          ? GPU_SHADER_STAGE_VERTEX | GPU_SHADER_STAGE_FRAGMENT
          : entry.visibility,
      ...(entry.buffer === undefined ? {} : { buffer: entry.buffer }),
      ...(entry.sampler === undefined ? {} : { sampler: entry.sampler }),
      ...(entry.texture === undefined ? {} : { texture: entry.texture }),
      ...(entry.storageTexture === undefined ? {} : { storageTexture: entry.storageTexture }),
      ...(entry.externalTexture === undefined ? {} : { externalTexture: entry.externalTexture }),
    }),
  );
  // The record path always owns one dynamic material-UBO slot, even when an
  // authored shader declares no numeric parameters (an empty paramSchema).
  // Reserve that slot here so the IBL/transmission injection starts at the
  // same binding used by `buildPerSubmeshMaterialBg`; otherwise binding 0 in
  // the layout is a cube texture while the record path submits a UBO.
  const ubo = entries[0];
  if (ubo !== undefined && ubo.binding === 0 && ubo.buffer?.type === 'uniform') {
    entries[0] = {
      binding: 0,
      visibility: GPU_SHADER_STAGE_VERTEX | GPU_SHADER_STAGE_FRAGMENT,
      buffer: { type: 'uniform', hasDynamicOffset: true },
    };
  } else {
    entries = [
      {
        binding: 0,
        visibility: GPU_SHADER_STAGE_VERTEX | GPU_SHADER_STAGE_FRAGMENT,
        buffer: { type: 'uniform', hasDynamicOffset: true },
      },
      ...entries.map((entry) => ({ ...entry, binding: entry.binding + 1 })),
    ];
  }
  return entries;
}

const STANDARD_NORMAL_BIT = standardTextureMask([{ name: 'normalTexture', type: 'texture2d' }]);
const STANDARD_BUMP_BIT = standardTextureMask([{ name: 'bumpTexture', type: 'texture2d' }]);

/** Normal takes precedence; canonical shaders bind the selected input in the normal slot. */
export function standardNormalInputField(field: string, mask: number | undefined): string {
  if (field !== 'normalTexture' || mask === undefined) return field;
  return (mask & STANDARD_NORMAL_BIT) === 0 && (mask & STANDARD_BUMP_BIT) !== 0
    ? 'bumpTexture'
    : field;
}

/** A shared layout may prune from a complete, single-source registration only. */
export function sharedMaterialBindingDeclarations(
  registry: ShaderCatalog | undefined,
  materialShaderId: string | undefined,
): readonly number[] | undefined {
  if (registry === undefined || materialShaderId === undefined) return undefined;
  // Renderer assembly finishes the registry's one-time manifest load before layouts.
  // Variant selection changes the program, not the per-shader shared layout.
  // Preserve its existing conservative contract instead of pruning by one variant.
  if ((registry.materialShaderManifestEntry(materialShaderId)?.variants.length ?? 0) > 0)
    return undefined;
  const lookup = registry.findMaterialArtifact(materialShaderId);
  // Surface medium layouts use their fixed engine ABI under an alias.
  if (
    materialShaderId === 'forgeax::single-layer-medium' ||
    (lookup.ok && lookup.value.receipt?.surface?.model === 'single-layer-medium')
  )
    return undefined;
  return lookup.ok ? lookup.value.program.materialBindings : undefined;
}

/** Preserve resource slots while dropping unavailable or shared resources. */
export function omittedStandardMaterialBindings(
  textureFields: readonly string[],
  transmissionAvailable: boolean,
  standard: boolean,
  canonical = false,
  materialBindings?: readonly number[],
): ReadonlySet<number> {
  const omitted = new Set<number>();
  if (standard && !transmissionAvailable) {
    textureFields.forEach((name, index) => {
      if (name === 'transmissionTexture' || name === 'thicknessTexture') {
        omitted.add(1 + index * 2);
        omitted.add(2 + index * 2);
      }
    });
  }
  if (canonical) {
    const index = textureFields.indexOf('bumpTexture');
    if (index >= 0 && textureFields.includes('normalTexture')) {
      omitted.add(1 + index * 2);
      omitted.add(2 + index * 2);
    }
  }
  // Standard backdrop sampling uses the existing clamp/linear IBL prefilter
  // sampler, keeping the complete clustered layout within 16 sampler slots.
  const backdropSampler = 1 + textureFields.length * 2 + 6;
  if (materialBindings === undefined ? standard : !materialBindings.includes(backdropSampler)) {
    omitted.add(backdropSampler);
  }
  return omitted;
}

// ─── appendInjection — generic engine-injection BGL appender (M3 / w15) ──────
//
// Decision anchors (plan-strategy §2):
//   - D-6 appendInjection(bgl, kind) replaces the previous hardcoded
//        emissive/AO start-binding literal (=14). The starting binding
//        number is computed from `bgl.length`, byte-equivalent to
//        `derive(schema).userRegionBindingEnd` when `bgl` is the BGL list
//        derive returned for the user paramSchema.
//   - R-1 the 14-slot user-region assumption breaks once D-3 merges UBO;
//        appendInjection lets the material BGL grow / shrink without
//        churning every injection site.
//
// Closed union of injection kinds (plan-strategy §2 D-6):
//   - 'shadow'   reserved for future material-level shadow injection
//                (sampler_comparison + texture_depth_2d, 2 entries).
//                The active shadow bindings live in the view BGL today
//                (group(0) bindings 3..7); this kind is the seam for
//                each per-material shadow override surface a future feat
//                wires onto group(1).
//   - 'ibl'      the 6 IBL / Skylight entries (irradiance / prefilter
//                cube + brdfLut 2d + 2 samplers + intensity uniform).
//                Used by `buildPbrPipelineLayouts` after the user-region
//                user paramSchema entries are emitted.
//   - 'transmission' the engine-owned sampler + backdrop texture pair. The
//                record stage supplies a real backdrop only for the active
//                transmission pass; all other variants bind layout-safe
//                placeholders because their shaders do not read these slots.
export type InjectionKind = keyof typeof INJECTION_KIND_LENGTHS;

const IBL_INJECTION_LENGTH = 6;
const SHADOW_INJECTION_LENGTH = 2;
const TRANSMISSION_INJECTION_LENGTH = 2;

/**
 * Append the engine-injection BGL entries for the given `kind` after the
 * user-region BGL entries, with binding numbers starting at `bgl.length`.
 *
 * The function reads `bgl.length` (NOT a hardcoded constant) so each
 * user-region size — derived from `derive(schema).userRegionBindingEnd` or
 * computed manually — flows through to the injection start binding without
 * a coupled edit.
 *
 * Returns ONLY the injected entries; the caller spreads them after `bgl`:
 *
 * ```ts
 * const merged = [...userBgl, ...appendInjection(userBgl, 'ibl')];
 * device.createBindGroupLayout({ entries: merged });
 * ```
 */
export function appendInjection(
  bgl: readonly GPUBindGroupLayoutEntry[],
  kind: InjectionKind,
): GPUBindGroupLayoutEntry[] {
  const start = bgl.length;
  switch (kind) {
    case 'ibl':
      return [
        // binding start+0: irradianceMap (texture_cube)
        {
          binding: start,
          visibility: GPU_SHADER_STAGE_FRAGMENT,
          texture: { sampleType: 'float', viewDimension: 'cube' },
        },
        // binding start+1: irradianceSampler
        {
          binding: start + 1,
          visibility: GPU_SHADER_STAGE_FRAGMENT,
          sampler: { type: 'filtering' },
        },
        // binding start+2: prefilterMap (texture_cube)
        {
          binding: start + 2,
          visibility: GPU_SHADER_STAGE_FRAGMENT,
          texture: { sampleType: 'float', viewDimension: 'cube' },
        },
        // binding start+3: prefilterSampler
        {
          binding: start + 3,
          visibility: GPU_SHADER_STAGE_FRAGMENT,
          sampler: { type: 'filtering' },
        },
        // binding start+4: brdfLut (texture_2d)
        {
          binding: start + 4,
          visibility: GPU_SHADER_STAGE_FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
        // binding start+5: uniform { intensity: f32 }
        {
          binding: start + 5,
          visibility: GPU_SHADER_STAGE_FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ];
    case 'shadow':
      return [
        {
          binding: start,
          visibility: GPU_SHADER_STAGE_FRAGMENT,
          sampler: { type: 'comparison' },
        },
        {
          binding: start + 1,
          visibility: GPU_SHADER_STAGE_FRAGMENT,
          texture: { sampleType: 'depth', viewDimension: '2d' },
        },
      ];
    case 'transmission':
      return [
        {
          binding: start,
          visibility: GPU_SHADER_STAGE_FRAGMENT,
          sampler: { type: 'filtering' },
        },
        {
          binding: start + 1,
          visibility: GPU_SHADER_STAGE_FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
      ];
  }
}

/**
 * Append the renderer-owned inputs required by the Engine single-layer
 * medium template. They intentionally live after the normal IBL and
 * transmission injections so authored parameter schemas remain the only
 * source of the prefix. The raw-depth texture is an r32float producer
 * resource and therefore uses the unfilterable-float/non-filtering pair.
 */
export function appendSingleLayerMediumInjection(
  bgl: readonly GPUBindGroupLayoutEntry[],
): GPUBindGroupLayoutEntry[] {
  const start = bgl.length;
  return [
    {
      binding: start,
      visibility: GPU_SHADER_STAGE_FRAGMENT,
      sampler: { type: 'non-filtering' },
    },
    {
      binding: start + 1,
      visibility: GPU_SHADER_STAGE_FRAGMENT,
      texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
    },
    {
      binding: start + 2,
      visibility: GPU_SHADER_STAGE_FRAGMENT,
      sampler: { type: 'filtering' },
    },
    {
      binding: start + 3,
      visibility: GPU_SHADER_STAGE_FRAGMENT,
      texture: { sampleType: 'float', viewDimension: '2d' },
    },
    {
      binding: start + 4,
      visibility: GPU_SHADER_STAGE_FRAGMENT,
      sampler: { type: 'non-filtering' },
    },
    {
      binding: start + 5,
      visibility: GPU_SHADER_STAGE_FRAGMENT,
      texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
    },
    {
      binding: start + 6,
      visibility: GPU_SHADER_STAGE_FRAGMENT,
      texture: { sampleType: 'float', viewDimension: '2d' },
    },
    {
      binding: start + 7,
      visibility: GPU_SHADER_STAGE_FRAGMENT,
      buffer: { type: 'uniform', minBindingSize: 96 },
    },
  ];
}

// Closed-set length sentinels — the map is the membership owner.
export const INJECTION_KIND_LENGTHS = {
  shadow: SHADOW_INJECTION_LENGTH,
  ibl: IBL_INJECTION_LENGTH,
  transmission: TRANSMISSION_INJECTION_LENGTH,
};

export function physicalTextureFields(paramSchema: readonly ParamSchemaEntry[]): readonly string[] {
  return standardPhysicalTextureFields(paramSchema);
}

export function appendTextureInjection(
  paramSchema: readonly ParamSchemaEntry[],
): GPUBindGroupLayoutEntry[] {
  // Physical resources use the Standard root's fixed slots (STANDARD_PHYSICAL_BINDING_START + canonical
  // index * 2).  Do not compact an authored subset: the shader template and
  // scene-index receipt share these canonical bindings, while gaps simply
  // represent physical axes omitted by the selected root contract.
  return standardPhysicalTextureFields(paramSchema).flatMap((field) => {
    const parameter = paramSchema.find((entry) => entry.name === field);
    const sampleType =
      parameter?.type === 'texture2d' ? (parameter.sampleType ?? 'float') : 'float';
    const canonicalIndex = STANDARD_PHYSICAL_TEXTURE_FIELDS.indexOf(field);
    const binding = STANDARD_PHYSICAL_BINDING_START + canonicalIndex * 2;
    return [
      {
        binding,
        visibility: GPU_SHADER_STAGE_FRAGMENT,
        sampler: { type: 'filtering' as const },
      },
      {
        binding: binding + 1,
        visibility: GPU_SHADER_STAGE_FRAGMENT,
        texture: { sampleType, viewDimension: '2d' as const },
      },
    ];
  });
}

/**
 * Return the stable identity of the merged material bind-group layout.
 *
 * This is deliberately derived from the same descriptor builder consumed by
 * the device path. Callers use it to keep pipeline, bind-group, and
 * frame-local lookup caches on one layout identity even when equivalent
 * paramSchema arrays were allocated independently.
 */
export function materialBindGroupLayoutIdentity(
  shaderId: string,
  paramSchema: readonly ParamSchemaEntry[],
): string {
  const descriptor = buildBindGroupLayoutDescriptor(
    {
      shader: { id: shaderId, passKind: 'forward', variantSet: undefined },
      attachments: { colorFormats: [], depthFormat: undefined, sampleCount: 1 },
      geometry: { topology: 'triangle-list', vertexLayout: {} },
      renderState: undefined,
    },
    { kind: 'pbr-material-merged', materialParamSchema: paramSchema },
  );
  // Descriptor shape alone cannot distinguish two Standard roots that expose
  // the same number of physical texture pairs under different semantic names.
  // The resource order is part of the admitted root contract, so include the
  // canonical physical projection in the cache identity while keeping the
  // actual WebGPU descriptor owned by the builder above.
  return JSON.stringify({
    entries: descriptor.entries,
    physicalTextureFields: physicalTextureFields(paramSchema),
  });
}

/**
 * Caps shape consumed by the BGL factory functions for storage-buffer vs
 * uniform-buffer branching. Mirrors the two fields the engine reads from
 * `RhiCaps` (plan D-4 + D-5).
 */
export interface PbrCaps {
  readonly atmosphere?: boolean;
  readonly storageBuffer: boolean;
  /**
   * Whether the selected material variant declares the optional extended
   * lighting view resources.  The default keeps the historical helper shape
   * for callers that build the canonical full PBR layout; the renderer passes
   * the device/variant decision explicitly.
   */
  readonly extendedLighting?: boolean;
  /** Selects the optional binding(1) ProbeBlendRecord lane. */
  readonly probeBlend?: boolean;
  /** Whether the device can carry the optional SpotLight projector texture. */
  readonly projectorAvailable?: boolean;
  /** Omit unused backdrop slots on minimum-limit devices; physical slots stay fixed. */
  readonly transmissionBackdrop?: boolean;
}

/**
 * The view BGL entry list. binding 0 = view UBO (vertex + fragment);
 * binding 3 = directional shadowMap (texture_depth_2d_array, vertex+fragment).
 *   One layer per CSM cascade, so a cascade that re-rasters clears only its
 *   own layer while cached cascades keep their depth. The texture always has
 *   at least two layers so WebGL2 allocates a real 2D array texture.
 * binding 4 = shadow comparison sampler (shared by directional + point);
 * binding 5 = point shadow cube_array depth atlas (texture_depth_cube_array;
 *   fragment-only). feat-20260612-point-light-shadows-urp-hdrp Round-2 F-1.
 * binding 6 = point shadow params UBO (`array<vec4<f32>, 4>`, 64 B;
 *   fragment-only). One lane per shadow-casting point light slot
 *   (shadowAtlasLayer in [0, 4)) carrying `(near, far, depthBias, normalBias)`.
 * binding 7 = shadowCasterCascade UBO (16 B; vertex + fragment). Per-pass
 *   cascade-index uniform consumed exclusively by `shadow_caster.wgsl` to
 *   pick `view.lightViewProj_X` for the cascade currently being rasterized
 *   (feat-20260613-csm-cascaded-shadow-maps M5 / w28). Forward PBR shaders
 *   declare the binding via `common.wgsl` but do not reference it; WebGPU
 *   still requires a populated entry on every view BG so the host writes a
 *   stable singleton buffer.
 * binding 8 = spot shadow array (texture_depth_2d_array; fragment-only).
 *   feat-20260625-spot-light-shadow-mapping M3 / w14 (D-5). One depth layer
 *   per spot `shadowAtlasTile` (cap 4). ALWAYS-ON (no caps
 *   gate — `texture_depth_2d_array` is compat-safe everywhere), matching the
 *   unconditional `spotShadowMap` WGSL declaration in common.wgsl. Reuses the
 *   comparison sampler at binding 4 (no binding 9). Every view BG must populate
 *   binding 8 (real spotShadowDepth view when spot shadows run, else a 1x1
 *   fallback depth view cleared to fully-lit).
 *
 * Mirrors feat-20260519-light-casters M3 D-S1 layout +
 * feat-20260520-directional-light-shadow-mapping M2 / w14 (D-1) shadow
 * map binding +
 * feat-20260612-point-light-shadows-urp-hdrp Round-2 F-1 BGL hookup
 * (bindings 5/6 follow the storage-capable `POINT_SHADOW_AVAILABLE` profile
 * registered in vite-plugin-shader) +
 * feat-20260613-csm-cascaded-shadow-maps M5 / w28 (binding 7 cascade UBO).
 *   binding 10 (Points/Lines viewport UBO; always bound for the shared view
 *   layout and consumed only by the dedicated points-lines shader).
 * Isolated here so M4 round-4 tests can recreate the layout.
 *
 * Local lights are not part of the view group. Standard material variants
 * consume the one Cluster payload in group(2), while this group retains only
 * camera and shadow resources.
 */
export function buildPbrViewBglEntries(caps: PbrCaps): GPUBindGroupLayoutEntry[] {
  const entries: GPUBindGroupLayoutEntry[] = [
    {
      binding: 0,
      visibility: GPU_SHADER_STAGE_VERTEX | GPU_SHADER_STAGE_FRAGMENT,
      // View captures use the same bind group with a per-face view slot.
      // Keeping this dynamic is also valid for the display slot at offset 0.
      buffer: { type: 'uniform', hasDynamicOffset: true },
    },
    {
      binding: 3,
      visibility: GPU_SHADER_STAGE_VERTEX | GPU_SHADER_STAGE_FRAGMENT,
      texture: { sampleType: 'depth', viewDimension: '2d-array' },
    },
    {
      binding: 4,
      visibility: GPU_SHADER_STAGE_FRAGMENT,
      sampler: { type: 'comparison' },
    },
    // The no-storage shader profile has no cube-array point-shadow resources.
    ...(caps.storageBuffer
      ? [
          {
            binding: 5,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            texture: { sampleType: 'depth' as const, viewDimension: 'cube-array' as const },
          },
          {
            binding: 6,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            buffer: { type: 'uniform' as const },
          },
        ]
      : []),
    // feat-20260613-csm-cascaded-shadow-maps M5 / w28: shadowCasterCascade
    // UBO (16 B). Carries the 0-based cascade index of the shadow pass
    // currently being rasterized so `shadow_caster.wgsl` can index into
    // `view.lightViewProj_X` per cascade. Shifted from binding 5 to
    // binding 7 on 2026-06-13 to make room for point-shadow bindings 5/6
    // (they predate this feat in main; CSM's slot was the optimal-yield
    // give since point-shadow needs FRAGMENT-only and the cascade UBO
    // needs vertex-stage too — keeping cascade higher avoids interleaving
    // visibility flags within the contiguous shadow-binding cluster).
    {
      binding: 7,
      visibility: GPU_SHADER_STAGE_VERTEX | GPU_SHADER_STAGE_FRAGMENT,
      buffer: { type: 'uniform' },
    },
    // feat-20260625-spot-light-shadow-mapping M3 / w14 (D-5): spot shadow
    // array: one `texture_depth_2d_array` layer per spot shadow tile.
    // FRAGMENT-only — the spot
    // shadow factor is reconstructed at fragment time via perspective-divide in
    // `evalSpotShadowed` (lighting-punctual.wgsl).
    //
    // ALWAYS-ON (no caps gate, unlike the point cube_array atlas at binding 5
    // which rides POINT_SHADOW_AVAILABLE): spot uses `texture_depth_2d_array` which is
    // compat-safe in every WebGPU profile, so the binding is unconditionally
    // declared. The matching WGSL declaration is `spotShadowMap` at @group(0)
    // binding 8 in common.wgsl (also unconditional) — the two must stay in
    // lock-step or WebGPU validation rejects the bind group at smoke time
    // (memory: BGL shape mismatch is a browser-path-only bug). No binding 9
    // sampler: spot reuses the comparison sampler at binding 4.
    // feat-20260625-spot-light-shadow-mapping M3 / w14 (D-5): spot shadow
    // array, the LAST view-BG binding. The per-spot fragment-read perspective
    // lightViewProj matrices that w24 originally declared at a standalone
    // binding 9 uniform buffer were folded into the View UBO (binding 0,
    // `view.spotLightViewProj`) in w25 (scope-amend webkit-fallback): the
    // standalone binding pushed the WebGL2 fallback fragment uniform-buffer
    // count to 12, over GLES 3.0's `max_uniform_buffers_per_shader_stage = 11`,
    // crashing pipeline-layout creation on the compat path (this feat's target).
    {
      binding: 8,
      visibility: GPU_SHADER_STAGE_FRAGMENT,
      texture: { sampleType: 'depth', viewDimension: '2d-array' },
    },
  ];
  if (caps.atmosphere === true) entries.push(...atmosphereViewLayoutEntries());
  const extendedLighting = caps.extendedLighting ?? true;
  const lowLimitCloudBindings = extendedLighting === false && caps.projectorAvailable === false;
  if (extendedLighting) {
    entries.push(
      {
        binding: 9,
        visibility: GPU_SHADER_STAGE_FRAGMENT,
        sampler: { type: 'filtering' },
      },
      {
        binding: 11,
        visibility: GPU_SHADER_STAGE_FRAGMENT,
        texture: { sampleType: 'float', viewDimension: '2d-array' },
      },
      {
        binding: 12,
        visibility: GPU_SHADER_STAGE_FRAGMENT,
        texture: { sampleType: 'float', viewDimension: '2d-array' },
      },
      {
        binding: 13,
        visibility: GPU_SHADER_STAGE_FRAGMENT,
        texture: { sampleType: 'float', viewDimension: '2d' },
      },
      {
        binding: 14,
        visibility: GPU_SHADER_STAGE_FRAGMENT,
        texture: { sampleType: 'float', viewDimension: '2d' },
      },
      {
        binding: 15,
        visibility: GPU_SHADER_STAGE_FRAGMENT,
        buffer: { type: 'uniform' },
      },
    );
  } else if (caps.projectorAvailable !== false) {
    entries.push(
      {
        binding: 11,
        visibility: GPU_SHADER_STAGE_FRAGMENT,
        texture: { sampleType: 'float', viewDimension: '2d' },
      },
      {
        binding: 12,
        visibility: GPU_SHADER_STAGE_FRAGMENT,
        sampler: { type: 'filtering' },
      },
    );
  }
  entries.push({
    binding: 10,
    visibility: GPU_SHADER_STAGE_VERTEX,
    buffer: { type: 'uniform', hasDynamicOffset: true },
  });
  // Cloud direct-solar transport is a renderer-owned view resource. The
  // minimum 16-texture profile has no spare sampled texture lane; its shader
  // variant returns the direct-sun fallback without declaring this pair.
  if (!lowLimitCloudBindings) {
    entries.push(
      {
        binding: 16,
        visibility: GPU_SHADER_STAGE_FRAGMENT,
        texture: { sampleType: 'float', viewDimension: '2d' },
      },
      {
        binding: 17,
        visibility: GPU_SHADER_STAGE_FRAGMENT,
        sampler: { type: 'filtering' },
      },
    );
  }
  return entries;
}

// ─── PBR pipeline layout factory ────────────────────────────────────────────

/**
 * Build the PBR pipeline layout under D-5 round-4: 4 slots `[view,
 * material, mesh-array, instances]`; the material BGL is derived from the
 * standard material schema and engine injection chain.
 *
 * `caps.storageBuffer===false` switches the mesh-array and instances entries
 * to `uniform`; local-light resources are never part of this view group.
 *
 * Throws on each `createBindGroupLayout` / `createPipelineLayout` Result
 * failure -- the engine bootstrap path (createRenderer) wraps the call in
 * `runShimSyncStep` to fold the throw into the structured error pipe.
 */
export function buildPbrPipelineLayouts(
  device: PbrPipelineDevice,
  caps: PbrCaps,
): PbrPipelineLayoutBundle {
  // All four boot BGLs share the Standard descriptor builder and capability policy.
  const viewBglRes = device.createBindGroupLayout(
    buildBindGroupLayoutDescriptor(BGL_ONLY_SPEC_STUB, { kind: 'pbr-view', caps }),
  );
  if (!viewBglRes.ok) throw viewBglRes.error;

  // Material slots and the following Skylight/transmission injections derive
  // from the same canonical schema as the shader and bind-group record path.
  const materialBglRes = device.createBindGroupLayout(
    buildBindGroupLayoutDescriptor(BGL_ONLY_SPEC_STUB, {
      kind: 'pbr-material-merged',
      caps,
    }),
  );
  if (!materialBglRes.ok) throw materialBglRes.error;

  // mesh-array BGL.
  const meshArrayBglRes = device.createBindGroupLayout(
    buildBindGroupLayoutDescriptor(BGL_ONLY_SPEC_STUB, { kind: 'pbr-mesh-array', caps }),
  );
  if (!meshArrayBglRes.ok) throw meshArrayBglRes.error;

  // instances BGL.
  const instancesBglRes = device.createBindGroupLayout(
    buildBindGroupLayoutDescriptor(BGL_ONLY_SPEC_STUB, {
      kind: 'pbr-instances',
      caps: { ...caps, probeBlend: false },
    }),
  );
  if (!instancesBglRes.ok) throw instancesBglRes.error;
  // ProbeBlendRecord is a storage-buffer-only ABI extension. A uniform
  // fallback cannot afford the extra fragment-stage uniform binding on
  // WebGL2/GLES, so do not even construct the probe BGL on that capability
  // route. The record stage gates the matching variant and bind group with
  // the same storage capability; aliasing the ordinary BGL keeps the bundle
  // total and makes an accidental probe request fail closed at layout select.
  const probeInstancesBglRes = caps.storageBuffer
    ? device.createBindGroupLayout(
        buildBindGroupLayoutDescriptor(BGL_ONLY_SPEC_STUB, {
          kind: 'pbr-instances',
          caps: { ...caps, probeBlend: true },
        }),
      )
    : { ok: true as const, value: instancesBglRes.value };
  if (!probeInstancesBglRes.ok) throw probeInstancesBglRes.error;

  // Pipeline layout (4 slots).
  const layouts: readonly [BindGroupLayout, BindGroupLayout, BindGroupLayout, BindGroupLayout] = [
    viewBglRes.value,
    materialBglRes.value,
    meshArrayBglRes.value,
    instancesBglRes.value,
  ];
  const pipelineLayoutRes = device.createPipelineLayout({
    label: 'pbr-pl',
    bindGroupLayouts: layouts,
  });
  if (!pipelineLayoutRes.ok) throw pipelineLayoutRes.error;
  const probeLayouts: readonly [
    BindGroupLayout,
    BindGroupLayout,
    BindGroupLayout,
    BindGroupLayout,
  ] = [viewBglRes.value, materialBglRes.value, meshArrayBglRes.value, probeInstancesBglRes.value];
  let probePipelineLayout: PipelineLayout | null = null;
  if (caps.storageBuffer) {
    const probePipelineLayoutRes = device.createPipelineLayout({
      label: 'pbr-probe-pl',
      bindGroupLayouts: probeLayouts,
    });
    if (!probePipelineLayoutRes.ok) throw probePipelineLayoutRes.error;
    probePipelineLayout = probePipelineLayoutRes.value;
  }

  return {
    pipelineLayout: pipelineLayoutRes.value,
    viewBgl: viewBglRes.value,
    materialBgl: materialBglRes.value,
    meshArrayBgl: meshArrayBglRes.value,
    instancesBgl: instancesBglRes.value,
    probeInstancesBgl: probeInstancesBglRes.value,
    probePipelineLayout,
    bindGroupLayouts: layouts,
  };
}

// ─── PBR skin material-shader identifier (SSOT) ────────────────────────────

/**
 * SSOT for the skin material shader's registered identifier. The shader
 * package registers under this string (see register-default-standard-pbr-skin.ts
 * `RESERVED_ID`); runtime dispatch sites import this constant rather than
 * carrying a literal so a future rename is a one-line change. AC-09 grep
 * gate: the body of `selectPipelineLayoutForVariant` MUST NOT contain a
 * literal `'forgeax::pbr-skin'` -- callers map this constant to
 * `LayoutKind = 'pbr-skin'` upstream.
 */
export const SKIN_MATERIAL_SHADER_ID = 'forgeax::pbr-skin' as const;
/** Skinned G-buffer entry for visible-surface passes: writes the uncovered row 0. */
export const SKIN_UNCOVERED_GBUFFER_ENTRY = 'fs_gbuffer_uncovered' as const;
export const SHADOW_CASTER_SHADER_ID = 'forgeax::default-shadow-caster' as const;

// Authored Standard templates are published under a unique module id for each
// root contract.  Keep the family marker in the id so every downstream render
// owner (extract, layout, and record) can make the same Standard-vs-custom and
// rigid-vs-skinned decision without a second registry or a runtime shader
// inspection pass.
const AUTHORED_STANDARD_ID_RE = /::(?:standard|pbr-skin)(?:-|$)/;

export function isStandardPbrSkinMaterialShader(shaderId: string | undefined): boolean {
  return (
    shaderId === SKIN_MATERIAL_SHADER_ID ||
    shaderId === 'forgeax::default-standard-pbr-skin' ||
    (shaderId !== undefined && /::pbr-skin(?:-|$)/.test(shaderId))
  );
}

// Five booleans define a closed 32-entry vocabulary. Reuse these identities
// instead of allocating/sorting a define map for every caster and cascade.
const SHADOW_CASTER_VARIANTS = Array.from(
  { length: 32 },
  (_, flags) =>
    `ALPHA_MASK=${(flags & 8) !== 0}` +
    `+GPU_DRIVEN_SCENE_INDEX_AVAILABLE=${(flags & 4) !== 0}` +
    '+GPU_DRIVEN_SCENE_INDEX_EXPLICIT=false' +
    `+SKINNING_DISABLED=${(flags & 2) === 0}` +
    `+STORAGE_BUFFER_AVAILABLE=${(flags & 1) !== 0}` +
    ((flags & 16) !== 0 ? '+VERTEX_COLOR_AVAILABLE=true' : ''),
);

export function shadowCasterVariantSet(
  storageBuffer: boolean,
  skinned: boolean,
  gpuDrivenSceneIndex = false,
  alphaMask = false,
  vertexColorAvailable = false,
): string {
  return SHADOW_CASTER_VARIANTS[
    Number(storageBuffer) |
      (Number(skinned) << 1) |
      (Number(gpuDrivenSceneIndex) << 2) |
      (Number(alphaMask) << 3) |
      (Number(vertexColorAvailable) << 4)
  ] as string;
}

/** Returns true for the engine-shipped standard-PBR material shader family. */
export function isStandardPbrMaterialShader(shaderId: string | undefined): boolean {
  return (
    shaderId === 'forgeax::default-standard-pbr' ||
    shaderId === SKIN_MATERIAL_SHADER_ID ||
    shaderId === 'forgeax::default-standard-pbr-skin' ||
    (shaderId !== undefined && AUTHORED_STANDARD_ID_RE.test(shaderId))
  );
}

/**
 * Return true only for the two engine-owned Standard roots. Authored Standard
 * aliases intentionally remain outside this set: their cooked root schema may
 * omit transmission or other optional resources, so their compact user-region
 * layout must be derived from that artifact instead of borrowing the boot
 * layout's reserved slots.
 */
export function isCanonicalStandardPbrMaterialShader(shaderId: string | undefined): boolean {
  return (
    shaderId === 'forgeax::default-standard-pbr' ||
    shaderId === SKIN_MATERIAL_SHADER_ID ||
    shaderId === 'forgeax::default-standard-pbr-skin'
  );
}

// ─── PBR skin pipeline layout factory (bug-20260611) ───────────────────────
//
// The skin material shader (`forgeax::pbr-skin`, registered by
// `register-default-standard-pbr-skin.ts`) needs the same 4-slot layout shape
// as standard PBR EXCEPT for slot 2: its mesh-array BGL declares **2**
// dynamic-offset entries (binding 0 = meshes, binding 1 = palette) versus
// standard PBR's single binding 0. Without a dedicated pipeline layout the
// skin shader's `@group(2) @binding(1) palette : array<mat4x4<f32>>` reference
// trips a `Binding doesn't exist in [BindGroupLayoutInternal "pbr-mesh-array-bgl"]`
// validation error in `device.createRenderPipeline`, surfaced as
// `RhiError limit-exceeded` and an invalid command buffer (Playwright TDD trace
// captured 2026-06-11 in apps/hello/skin).
//
// The factory **reuses** view / material / instances BGL handles produced by
// `buildPbrPipelineLayouts` (charter P4: a single SSOT BGL for each slot the
// shapes actually share) and only creates a new mesh-array BGL + new pipeline
// layout. This keeps the per-binding-shape SSOT in one place and avoids an
// alternate skin-only material BGL (the skin shader's group(0) and group(1)
// are byte-for-byte the standard-PBR contract).

/**
 * Build the PBR skin pipeline layout (4 slots `[view, material,
 * mesh-array(3-entry), instances]`). View / material / instances BGLs are
 * shared with the standard-PBR layout (passed in via `pbr` bundle); the only
 * new BGL is the 3-entry mesh-array slot for `meshes` + current/previous
 * `palette` buffers.
 *
 * Throws on each `createBindGroupLayout` / `createPipelineLayout` Result
 * failure -- the engine bootstrap path wraps the call in `runShimSyncStep`
 * to fold the throw into the structured error pipe.
 */
export function buildPbrSkinLayouts(
  device: PbrPipelineDevice,
  caps: PbrCaps,
  pbr: PbrPipelineLayoutBundle,
): PbrPipelineLayoutBundle {
  // 3-entry mesh-array BGL: binding 0 meshes + binding 1 current palette
  // + binding 2 previous palette. All use dynamic offsets for the same
  // per-entity window contract.
  const skinMeshArrayBglRes = device.createBindGroupLayout(
    buildBindGroupLayoutDescriptor(BGL_ONLY_SPEC_STUB, {
      kind: 'pbr-skin-mesh-array',
      caps,
    }),
  );
  if (!skinMeshArrayBglRes.ok) throw skinMeshArrayBglRes.error;

  const layouts: readonly [BindGroupLayout, BindGroupLayout, BindGroupLayout, BindGroupLayout] = [
    pbr.viewBgl,
    pbr.materialBgl,
    skinMeshArrayBglRes.value,
    pbr.instancesBgl,
  ];
  const pipelineLayoutRes = device.createPipelineLayout({
    label: 'pbr-skin-pl',
    bindGroupLayouts: layouts,
  });
  if (!pipelineLayoutRes.ok) throw pipelineLayoutRes.error;
  const probeLayouts: readonly [
    BindGroupLayout,
    BindGroupLayout,
    BindGroupLayout,
    BindGroupLayout,
  ] = [pbr.viewBgl, pbr.materialBgl, skinMeshArrayBglRes.value, pbr.probeInstancesBgl];
  let probePipelineLayout: PipelineLayout | null = null;
  if (caps.storageBuffer) {
    const probePipelineLayoutRes = device.createPipelineLayout({
      label: 'pbr-skin-probe-pl',
      bindGroupLayouts: probeLayouts,
    });
    if (!probePipelineLayoutRes.ok) throw probePipelineLayoutRes.error;
    probePipelineLayout = probePipelineLayoutRes.value;
  }

  return {
    pipelineLayout: pipelineLayoutRes.value,
    viewBgl: pbr.viewBgl,
    materialBgl: pbr.materialBgl,
    meshArrayBgl: skinMeshArrayBglRes.value,
    instancesBgl: pbr.instancesBgl,
    probeInstancesBgl: pbr.probeInstancesBgl,
    probePipelineLayout,
    bindGroupLayouts: layouts,
  };
}

/**
 * Build the dedicated slot-3 layout used by scene-index GPU-driven draws.
 *
 * Direct material draws deliberately keep `pbr-instances-bgl` at binding(0),
 * and ProbeBlend deliberately owns binding(1).  The scene-index stream is
 * therefore a separate BGL at binding(2), rather than an optional entry added
 * to the direct layout.  This keeps every bind group complete for its shader
 * and prevents a direct draw from having to bind a dummy visible stream.
 */
export function buildGpuDrivenPbrInstancesBindGroupLayout(
  device: PbrPipelineDevice,
  caps: PbrCaps,
): BindGroupLayout {
  if (!caps.storageBuffer) {
    throw new Error('GPU-driven PBR instances layout requires storage-buffer capability');
  }
  const result = device.createBindGroupLayout(
    buildBindGroupLayoutDescriptor(BGL_ONLY_SPEC_STUB, {
      kind: 'pbr-gpu-driven-instances',
      caps,
    }),
  );
  if (!result.ok) throw result.error;
  return result.value;
}

/**
 * Build the slot-3 layout used by direct single-layer-medium draws.
 *
 * Direct Surface draws retain their ordinary instance transforms at binding
 * zero, but consume the same producer-owned ProbeBlend, dynamic page, frame
 * rows, and shared time resources as the scene-index lane. Binding six is the
 * per-draw frame-row base; it keeps a local instance index independent from
 * the renderer's compact scene-index address.
 */
export function buildSurfaceDirectInstancesBindGroupLayout(
  device: PbrPipelineDevice,
  caps: PbrCaps,
): BindGroupLayout {
  if (!caps.storageBuffer) {
    throw new Error('Direct Surface instances layout requires storage-buffer capability');
  }
  const result = device.createBindGroupLayout(
    buildBindGroupLayoutDescriptor(BGL_ONLY_SPEC_STUB, {
      kind: 'pbr-surface-direct-instances',
      caps,
    }),
  );
  if (!result.ok) throw result.error;
  return result.value;
}

/** Build the four-slot rigid scene-index pipeline layout. */
export function buildGpuDrivenPbrPipelineLayout(
  device: PbrPipelineDevice,
  pbr: PbrPipelineLayoutBundle,
  gpuDrivenInstancesBgl: BindGroupLayout,
): PipelineLayout {
  const result = device.createPipelineLayout({
    label: 'pbr-gpu-driven-pl',
    bindGroupLayouts: [pbr.viewBgl, pbr.materialBgl, pbr.meshArrayBgl, gpuDrivenInstancesBgl],
  });
  if (!result.ok) throw result.error;
  return result.value;
}

/** Build the four-slot skinned scene-index pipeline layout. */
export function buildGpuDrivenPbrSkinPipelineLayout(
  device: PbrPipelineDevice,
  pbrSkin: PbrPipelineLayoutBundle,
  gpuDrivenInstancesBgl: BindGroupLayout,
): PipelineLayout {
  const result = device.createPipelineLayout({
    label: 'pbr-skin-gpu-driven-pl',
    bindGroupLayouts: [
      pbrSkin.viewBgl,
      pbrSkin.materialBgl,
      pbrSkin.meshArrayBgl,
      gpuDrivenInstancesBgl,
    ],
  });
  if (!result.ok) throw result.error;
  return result.value;
}

/** Project the canonical group(2) resources for a PBR skin draw. */
export function createPbrSkinMeshBindGroupEntries(
  meshBuffer: Buffer,
  meshSize: number,
  paletteBuffer: Buffer,
  paletteWindowBytes: number,
): BindGroupEntry[] {
  return [
    {
      binding: 0,
      resource: { kind: 'buffer', value: { buffer: meshBuffer, offset: 0, size: meshSize } },
    },
    ...[1, 2].map((binding) => ({
      binding,
      resource: {
        kind: 'buffer' as const,
        value: {
          buffer: paletteBuffer,
          offset: 0,
          size: paletteWindowBytes,
        },
      },
    })),
  ];
}

/** Project all dynamic offsets for the canonical PBR skin group(2) shape. */
export function pbrSkinMeshDynamicOffsets(
  meshOffset: number,
  paletteOffset: number,
): readonly [number, number, number] {
  return [meshOffset, paletteOffset, paletteOffset];
}

// ─── Unlit material BGL factory ─────────────────────────────────────────────

/**
 * Build a stand-alone 7-entry unlit material BGL. Round-4 D-5 keeps unlit
 * material BG isolated from Skylight binding 7..12 -- unlit demos do not
 * pay for IBL state. The unlit pipeline still binds material at slot 1,
 * just with a 7-entry layout.
 *
 * Note: at the moment the runtime still routes both unlit + standard
 * through a single 14-entry pipeline layout; the unlit material BG
 * carries fallback identity resources at binding 7..12. This factory is
 * exported as a future-proof seam for the moment when unlit demos own
 * their own pipeline layout (t57 (e) test pins the contract today so the
 * eventual split has a green target).
 */
export function buildUnlitMaterialBgl(device: PbrPipelineDevice): BindGroupLayout {
  const res = device.createBindGroupLayout(
    buildBindGroupLayoutDescriptor(BGL_ONLY_SPEC_STUB, { kind: 'unlit-material' }),
  );
  if (!res.ok) throw res.error;
  return res.value;
}

// ─── Material BG assembly helpers (unlit) ───────────────────────────────────

/**
 * Inputs for `buildUnlitMaterialBindGroupEntries`. The fields mirror the
 * record-stage's local variables; isolating the assembler here lets t58
 * (e) test exercise the contract without recreating the entire record
 * stage.
 */
export interface UnlitMaterialBindGroupEntryInputs {
  readonly materialUniform: Buffer;
  readonly materialOffset: number;
  readonly materialSize: number;
  readonly defaultSampler: Sampler;
  readonly baseColorView: TextureView;
  readonly defaultWhiteView: TextureView;
}

/**
 * Build the 7 BindGroupEntry values for the unlit material BG (binding
 * 0..6). Output flows into `device.createBindGroup({ layout:
 * unlitMaterialBgl, entries })`.
 */
export function buildUnlitMaterialBindGroupEntries(
  inputs: UnlitMaterialBindGroupEntryInputs,
): BindGroupEntry[] {
  return [
    {
      binding: 0,
      resource: {
        kind: 'buffer' as const,
        value: {
          buffer: inputs.materialUniform,
          offset: inputs.materialOffset,
          size: inputs.materialSize,
        },
      },
    },
    { binding: 1, resource: { kind: 'sampler' as const, value: inputs.defaultSampler } },
    { binding: 2, resource: { kind: 'textureView' as const, value: inputs.baseColorView } },
    { binding: 3, resource: { kind: 'sampler' as const, value: inputs.defaultSampler } },
    { binding: 4, resource: { kind: 'textureView' as const, value: inputs.defaultWhiteView } },
    { binding: 5, resource: { kind: 'sampler' as const, value: inputs.defaultSampler } },
    { binding: 6, resource: { kind: 'textureView' as const, value: inputs.defaultWhiteView } },
  ];
}

// Surface re-export so consumers can build a complete BindGroup pipeline
// without reaching into multiple modules.
export type { BindGroup };

// ─── feat-20260625 M3 / w10 — sprite-pass variantSet selector ────────────────
//
// Plan-strategy D-1 + D-4: when an entity carries `SpriteInstances` the
// sprite-pass record stage must pick the `PER_INSTANCE_REGION=true` sprite
// shader variant compiled in M2 (w7) so the WGSL `InstanceData` struct
// includes the per-instance `region: vec4<f32>` field and reads region from
// the interleaved 80B-per-instance buffer (not from the material UBO).
//
// Non-`SpriteInstances` sprite entities (e.g. the sprite-atlas demo) keep
// the default variant where `PER_INSTANCE_REGION` is undefined and the
// shader's `#else` branch reads region from material UBO — preserving
// existing behaviour (plan-strategy D-4 "pbr / unlit / sprite-atlas
// behaviour unchanged" / requirements Edge Cases).
//
// Variant set string format mirrors the Standard boot variant /
// HDRP variant set string idiom in `pipeline-spec.ts` (`+`-separated kv
// pairs); the record stage threads this string through the per-shader
// pipeline-cache key + lazy-build `getMaterialShaderPipeline` lookup.

/**
 * variantSet string fired into the sprite-pass pipeline cache when the
 * entity carries `SpriteInstances` (plan-strategy D-1 interleaved single
 * buffer + D-4 axis on `sprite.wgsl`).
 *
 * bug-20260708 M2 (c): aligned with the canonical all-true variant key
 * `''` — sprite's manifest emits `{PIR:true, SBA:true}` under the empty-
 * string key (all variant axes true → canonical). The runtime's
 * `getMaterialShaderPipeline` variant-substitution branch
 * (`createRenderer.ts:1730`) resolves this via
 * `findVariantByKey(msEntry, '')` returning the 5653B PIR=true variant.
 * Combined with the `cacheKeyOf` sentinel `~` (bug-20260708 M2 (b)) this
 * value produces a cache key distinct from the `variantSet=undefined`
 * character/default path (which now resolves to the PIR=false 5575B boot-
 * registered variant). Sprite pipeline layout routing is anchored via
 * `LayoutKind='sprite-urp'` so `variantSet=''` here does NOT trigger the
 * HDRP-layout branch of `selectPipelineLayoutForVariant` (research R-12
 * flow; plan-strategy §4 R-1' guard).
 */
export const SPRITE_PASS_PER_INSTANCE_REGION_VARIANT_SET = '';

// BglKind dispatch (M3 / D-13) — closed union of BGL shapes the runtime ships
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Closed union of bind-group-layout shapes the runtime constructs.
 *
 * Each kind names one physically distinct BGL the runtime has historically
 * built by hand. {@link buildBindGroupLayoutDescriptor} dispatches on this
 * union so every `device.createBindGroupLayout(...)` call site shares one
 * SSOT for entries / labels (plan-strategy §3.2; D-13 round-2 decision).
 *
 * Three groups by derivation source:
 * 1. Shader-derived (paramSchema reflection + injection chain):
 *    - `'pbr-material-merged'` — derived user region + Skylight 6 + transmission 2
 *    - `'unlit-material'` — 7 entries: base PBR material only (no inject)
 *    - `'hdrp-7-slot'` — 7 entries (binding 0 + 3..8): HDRP cluster + SSAO group(2) BGL
 * 2. Caps-driven literal shapes (no shader):
 *    - `'pbr-view'` — camera/shadow bindings, optional projector
 *      texture/sampler (11/12), and the Points/Lines UBO (10). Local lights
 *      are carried exclusively by the Standard Cluster group(2).
 *      (directional 3/4, point 5/6, cascade 7, spot atlas 8; the former
 *      spot lightViewProj matrices moved into the View UBO)
 *    - `'pbr-mesh-array'` — 1 entry: per-entity mesh SSBO (dynamic-offset)
 *    - `'pbr-instances'` — 2 entries: per-instance SSBO plus the compact
 *      visible-item index stream (the second entry is used only by the
 *      scene-index vertex entry and shares the frame's instance bind group)
 *    - `'pbr-skin-mesh-array'` — 3 entries: meshes + current/previous palette
 * 3. Attachment-driven (fullscreen post-process):
 *    - `'fullscreen-post'` — 2 entries: input texture + sampler. The texture
 *      `sampleType` is derived from `spec.attachments` (plan §R3 fix):
 *      `'depth32float'` → `'depth'`; `'r32float'` → `'unfilterable-float'`;
 *      else → `'float'`.
 *    - `'fullscreen-post-with-params'` — 3 entries: the same texture@0 +
 *      sampler@1 as `'fullscreen-post'`, plus a `buffer@2` uniform for the
 *      per-frame params UBO (feat-20260621 D-2: `entry.params !== undefined`
 *      passes route here; the layout stays group(1), q3=B). `'fullscreen-post'`
 *      stays byte-identical so param-less consumers degrade with no change.
 *    - `'fullscreen-post-with-scene-depth-msaa'` — the depth-read layout with
 *      `texture.multisampled=true`, selected for a 4-sample scene depth target.
 */
export type BglKind =
  | 'pbr-view'
  | 'pbr-material-merged'
  | 'pbr-mesh-array'
  | 'pbr-instances'
  | 'pbr-gpu-driven-instances'
  | 'pbr-surface-direct-instances'
  | 'pbr-skin-mesh-array'
  | 'unlit-material'
  | 'hdrp-7-slot'
  | 'fullscreen-post'
  | 'fullscreen-post-with-params'
  | 'fullscreen-post-with-scene-depth'
  | 'fullscreen-post-with-scene-depth-msaa'
  | 'fullscreen-post-with-paired-msaa';

/**
 * Output shape of {@link buildBindGroupLayoutDescriptor}: matches the RHI
 * `BindGroupLayoutDescriptor` (label + entries with `ExplicitUndefined`) so
 * the result can be passed directly to `device.createBindGroupLayout(...)`.
 *
 * `entries` is a mutable `Array` to match `GPUBindGroupLayoutDescriptor`
 * (WebGPU types declare it mutable). Callers MUST treat the array as
 * read-only — the dispatcher freezes neither the array nor its entries
 * for hot-path performance.
 */
export interface BindGroupLayoutDescriptorOutput {
  readonly label: string | undefined;
  readonly entries: GPUBindGroupLayoutEntry[];
}

/** Build the canonical HDRP group(2) bind-group layout. */
export function createHdrpBindGroupLayoutDescriptor(
  storageBuffer = true,
): BindGroupLayoutDescriptorOutput {
  const meshBufType: GPUBufferBindingType = storageBuffer ? 'read-only-storage' : 'uniform';
  const clusterBufType: GPUBufferBindingType = 'read-only-storage';
  return {
    label: 'hdrp-unified-bgl-group2',
    entries: [
      {
        binding: 0,
        // Standard fragment lighting (transmission/refraction and clustered
        // evaluation) reads the same mesh transform window as the vertex
        // stage. Keep this visibility in the HDRP descriptor aligned with
        // the URP mesh-array descriptor; restricting it to vertex makes the
        // HDRP pipeline invalid when fs_main accesses `meshes[0]`.
        visibility: GPU_SHADER_STAGE_VERTEX | GPU_SHADER_STAGE_FRAGMENT,
        buffer: { type: meshBufType, hasDynamicOffset: true },
      },
      // Bindings 1 and 2 stay absent for the URP physical isolation gap.
      ...(storageBuffer
        ? [
            {
              binding: 3,
              visibility: GPU_SHADER_STAGE_FRAGMENT,
              buffer: { type: clusterBufType, hasDynamicOffset: false },
            },
            {
              binding: 4,
              visibility: GPU_SHADER_STAGE_FRAGMENT,
              buffer: { type: clusterBufType, hasDynamicOffset: false },
            },
            {
              binding: 5,
              visibility: GPU_SHADER_STAGE_FRAGMENT,
              buffer: { type: clusterBufType, hasDynamicOffset: false },
            },
          ]
        : [
            {
              binding: 3,
              visibility: GPU_SHADER_STAGE_FRAGMENT,
              texture: {
                sampleType: 'uint' as const,
                viewDimension: '2d' as const,
                multisampled: false,
              },
            },
          ]),
      {
        binding: 6,
        visibility: GPU_SHADER_STAGE_FRAGMENT,
        buffer: { type: 'uniform', hasDynamicOffset: false },
      },
      ...(storageBuffer
        ? [
            {
              binding: 7,
              visibility: GPU_SHADER_STAGE_FRAGMENT,
              texture: {
                sampleType: 'float' as const,
                viewDimension: '2d' as const,
                multisampled: false,
              },
            },
            {
              binding: 8,
              visibility: GPU_SHADER_STAGE_FRAGMENT,
              sampler: { type: 'filtering' as const },
            },
          ]
        : []),
    ],
  };
}

/** Build the HDRP group(2) layout for the clustered skin variant. */
export function createHdrpSkinBindGroupLayoutDescriptor(
  storageBuffer = true,
): BindGroupLayoutDescriptorOutput {
  const base = createHdrpBindGroupLayoutDescriptor(storageBuffer);
  const baseEntries = base.entries;
  if (baseEntries === undefined || baseEntries[0] === undefined) {
    throw new Error('HDRP base group(2) layout must declare mesh binding 0');
  }
  const paletteType: GPUBufferBindingType = storageBuffer ? 'read-only-storage' : 'uniform';
  return {
    label: 'hdrp-skin-unified-bgl-group2',
    entries: [
      baseEntries[0],
      {
        binding: 1,
        visibility: GPU_SHADER_STAGE_VERTEX,
        buffer: { type: paletteType, hasDynamicOffset: true },
      },
      {
        binding: 2,
        visibility: GPU_SHADER_STAGE_VERTEX,
        buffer: { type: paletteType, hasDynamicOffset: true },
      },
      ...baseEntries.slice(1),
    ],
  };
}

/**
 * Build a `GPUBindGroupLayoutDescriptor` from a PipelineSpec, dispatching on
 * `options.kind` to one of 9 closed BGL shapes (D-13 round-2).
 *
 * Shader-derived kinds (`'pbr-material-merged'` / `'unlit-material'` /
 * `'hdrp-7-slot'`) require `options.registry` to look up the shader entry
 * and reflect its `paramSchema` via {@link deriveBglShapeFromShader}; they
 * compose the per-entry injection chain (Skylight + transmission for material;
 * HDRP variantSet for cluster-forward).
 *
 * Caps-driven kinds (`'pbr-view'` / `'pbr-mesh-array'` / `'pbr-instances'` /
 * `'pbr-skin-mesh-array'`) require `options.caps` for the storage-buffer
 * vs uniform-buffer fallback (RhiCaps.storageBuffer; PBR feat-20260526 M3 /
 * w9). They are wholly determined by the caps shape.
 *
 * Attachment-driven kind (`'fullscreen-post'`) reads
 * `spec.attachments.depthFormat` and `spec.attachments.colorFormats[0]` to
 * pick the texture binding's `sampleType` (R3 fix: `'depth32float'` → `'depth'`,
 * `'r32float'` → `'unfilterable-float'`, else → `'float'`).
 *
 * @param spec - the pipeline spec (axis source for reflection / caps fallback)
 * @param options.kind - which BGL shape to build (closed {@link BglKind} union)
 * @param options.registry - ShaderCatalog for shader-derived kinds
 * @param options.caps - caps shape for caps-driven kinds (storageBuffer)
 * @returns a WebGPU bind-group-layout descriptor (entries + label)
 * @see plan-strategy §3.2 · plan-decisions D-13 · requirements AC-02
 */
/**
 * Resolve the material paramSchema for a per-shader user-region BGL derivation.
 *
 * Priority (D-1): explicit `options.materialParamSchema` > registry lookup of
 * `spec.shader.id` > `undefined` (the user-region builder then falls back to
 * the built-in standard-PBR 4-texture schema, whose user region is 9 entries).
 */
function resolveMaterialParamSchema(
  spec: PipelineSpec,
  options: { registry?: ShaderCatalog; materialParamSchema?: readonly ParamSchemaEntry[] },
): readonly ParamSchemaEntry[] | undefined {
  if (options.materialParamSchema !== undefined) return options.materialParamSchema;
  if (options.registry !== undefined) {
    const lookup = options.registry.findMaterialArtifact(spec.shader.id);
    if (lookup.ok) return lookup.value.paramSchema;
  }
  return undefined;
}

export function buildBindGroupLayoutDescriptor(
  spec: PipelineSpec,
  options: {
    kind: BglKind;
    registry?: ShaderCatalog;
    caps?: PbrCaps;
    /**
     * Material paramSchema for the per-shader user-region derivation
     * (`'pbr-material-merged'` / `'unlit-material'`). When supplied it is the
     * authoritative source for the user-region BGL shape (D-1); when omitted,
     * `buildPbrMaterialUserRegionEntries` falls back to the built-in
     * standard-PBR 4-texture schema (user region is 9 entries), so
     * the caps-driven `buildPbrPipelineLayouts` seam keeps working unchanged.
     * A registry + resolvable shader id takes precedence over this field.
     */
    materialParamSchema?: readonly ParamSchemaEntry[];
  },
): BindGroupLayoutDescriptorOutput {
  switch (options.kind) {
    case 'pbr-view': {
      const caps = options.caps ?? { storageBuffer: true };
      return {
        label: 'pbr-view-bgl',
        entries: buildPbrViewBglEntries(caps),
      };
    }
    case 'pbr-mesh-array': {
      const caps = options.caps ?? { storageBuffer: true };
      const meshBufType: GPUBufferBindingType = caps.storageBuffer
        ? 'read-only-storage'
        : 'uniform';
      // sprite-lit's fragment stage does not read the mesh SSBO -- worldPos
      // is carried through the VsOut interpolant. Visibility is kept widened
      // to VERTEX|FRAGMENT because the BGL JSON is compared byte-identically
      // across the sprite / sprite-lit / PBR pipelines that share this
      // descriptor; narrowing here would change every sibling pipeline's
      // BGL fingerprint. WebGPU rejects createRenderPipeline when a fragment
      // stage accesses a binding whose BGL visibility excludes FRAGMENT --
      // widening is permissive (validation-only, no perf cost).
      return {
        label: 'pbr-mesh-array-bgl',
        entries: [
          {
            binding: 0,
            visibility: GPU_SHADER_STAGE_VERTEX | GPU_SHADER_STAGE_FRAGMENT,
            buffer: { type: meshBufType, hasDynamicOffset: true },
          },
        ],
      };
    }
    case 'pbr-instances': {
      const caps = options.caps ?? { storageBuffer: true };
      const meshBufType: GPUBufferBindingType = caps.storageBuffer
        ? 'read-only-storage'
        : 'uniform';
      const entries: GPUBindGroupLayoutEntry[] = [
        {
          binding: 0,
          visibility: GPU_SHADER_STAGE_VERTEX,
          buffer: { type: meshBufType, hasDynamicOffset: false },
        },
        ...(caps.probeBlend === true
          ? [
              {
                // Per-object fragment lane; the record is always exactly 160B.
                binding: 1,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                buffer: { type: meshBufType, hasDynamicOffset: true },
              },
            ]
          : []),
      ];
      return {
        label: caps.probeBlend === true ? 'pbr-probe-instances-bgl' : 'pbr-instances-bgl',
        entries: entries.map((entry) =>
          entry.binding === 0
            ? {
                ...entry,
                // Standard transmission reads the same per-instance transform in
                // fs_main to convert glTF unit-space thickness into world metres.
                visibility: GPU_SHADER_STAGE_VERTEX | GPU_SHADER_STAGE_FRAGMENT,
              }
            : entry,
        ),
      };
    }
    case 'pbr-gpu-driven-instances': {
      const caps = options.caps ?? { storageBuffer: true };
      const meshBufType: GPUBufferBindingType = caps.storageBuffer
        ? 'read-only-storage'
        : 'uniform';
      // GPU-driven scene-index draws use a physically distinct slot-3 layout.
      // The ordinary instances BGL intentionally stays one-entry for direct
      // draws, while ProbeBlend owns binding(1). Keep the compact visible
      // `(instanceRow, materialRow, palette, fade)` stream at binding(2) so a future probe-enabled
      // GPU variant can coexist without colliding with the probe record.
      return {
        label: 'pbr-gpu-driven-instances-bgl',
        entries: [
          {
            binding: 0,
            visibility: GPU_SHADER_STAGE_VERTEX,
            buffer: { type: meshBufType, hasDynamicOffset: false },
          },
          {
            // ProbeBlend is fragment-only. Both scene-index color and shadow
            // vertex stages read the visible row through binding(2).
            binding: 1,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            buffer: { type: meshBufType, hasDynamicOffset: false },
          },
          {
            binding: 2,
            visibility: GPU_SHADER_STAGE_VERTEX,
            buffer: { type: meshBufType, hasDynamicOffset: false },
          },
          {
            // Generic Surface dynamic pages are read by authored Surface
            // accessors. The binding is present for every scene-index group
            // so Standard and custom Surface batches share one owner shape.
            binding: 3,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            buffer: { type: meshBufType, hasDynamicOffset: false },
          },
          {
            // Frame time, explicit event ranges, and paired background/depth
            // facts use separate read-only pages. This keeps live state out
            // of the material row and leaves skin's address lane untouched.
            binding: 4,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            buffer: { type: meshBufType, hasDynamicOffset: false },
          },
          {
            // Frame time is one frame-global fact. Keeping it outside the
            // member row prevents a stable frame from issuing one 4-byte
            // queue write for every visible Surface member.
            binding: 5,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            buffer: { type: 'uniform', hasDynamicOffset: false },
          },
          {
            // GPU Scene primitive table. Scene-index vertex stages resolve
            // visible.x (instance row) -> primitive root transform and
            // temporal flags here; binding(0) is the instance table, which
            // this variant declares instead of the direct instance array.
            binding: 6,
            visibility: GPU_SHADER_STAGE_VERTEX,
            buffer: { type: meshBufType, hasDynamicOffset: false },
          },
          {
            // Submitted-frame receiver address indexed by the rigid candidate row.
            binding: 7,
            visibility: GPU_SHADER_STAGE_VERTEX,
            buffer: { type: meshBufType, hasDynamicOffset: false },
          },
        ],
      };
    }
    case 'pbr-surface-direct-instances': {
      return {
        label: 'pbr-surface-direct-instances-bgl',
        entries: [
          {
            binding: 0,
            // Direct instance transforms are consumed only by vs_main. Keep
            // them out of the fragment-stage storage budget; Surface already
            // needs the retained ProbeBlend/page/frame records there and the
            // portable WebGPU limit is eight storage buffers per stage.
            visibility: GPU_SHADER_STAGE_VERTEX,
            buffer: { type: 'read-only-storage', hasDynamicOffset: false },
          },
          {
            binding: 1,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            buffer: { type: 'read-only-storage', hasDynamicOffset: true },
          },
          {
            binding: 3,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            buffer: { type: 'read-only-storage', hasDynamicOffset: false },
          },
          {
            binding: 4,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            buffer: { type: 'read-only-storage', hasDynamicOffset: false },
          },
          {
            binding: 5,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            buffer: { type: 'uniform', hasDynamicOffset: false },
          },
          {
            binding: 6,
            visibility: GPU_SHADER_STAGE_VERTEX,
            buffer: { type: 'uniform', hasDynamicOffset: false },
          },
        ],
      };
    }
    case 'pbr-skin-mesh-array': {
      const caps = options.caps ?? { storageBuffer: true };
      const meshBufType: GPUBufferBindingType = caps.storageBuffer
        ? 'read-only-storage'
        : 'uniform';
      return {
        label: 'pbr-skin-mesh-array-bgl',
        entries: [
          {
            binding: 0,
            visibility: GPU_SHADER_STAGE_VERTEX | GPU_SHADER_STAGE_FRAGMENT,
            buffer: { type: meshBufType, hasDynamicOffset: true },
          },
          {
            binding: 1,
            visibility: GPU_SHADER_STAGE_VERTEX,
            buffer: { type: meshBufType, hasDynamicOffset: true },
          },
          {
            binding: 2,
            visibility: GPU_SHADER_STAGE_VERTEX,
            buffer: { type: meshBufType, hasDynamicOffset: true },
          },
        ],
      };
    }
    case 'pbr-material-merged': {
      // Material BGL: per-shader user-region (derive(paramSchema).bglEntries)
      // + IBL injection (6) + transmission injection (up to 2). The user-region
      // size is the only variable; injection start = userRegion.length so a
      // custom schema shifts IBL/transmission by its sampler/texture pairs.
      // The built-in standard-PBR user region has 25 entries;
      // scene rows follow injection, and physical texture pairs follow the effective root schema.
      //
      // Schema source priority (D-1): explicit materialParamSchema option >
      // registry lookup of spec.shader.id > built-in standard-PBR fallback.
      const resolvedSchema = resolveMaterialParamSchema(spec, options);
      const effectiveSchema = resolvedSchema ?? STANDARD_PIPELINE_PARAM_SCHEMA;
      const physicalFields = physicalTextureFields(effectiveSchema);
      // Standard's built-in shader keeps the transmission user-region slots
      // reserved even when a particular root omits those values.  Physical
      // maps extend that canonical region; they must not compact the IBL
      // bindings to the smaller authored subset.  A compact user region is
      // still correct for authored (non-engine) material shaders.
      const userRegionSchema = isCanonicalStandardPbrMaterialShader(spec.shader.id)
        ? STANDARD_PIPELINE_PARAM_SCHEMA.map(
            (field) =>
              effectiveSchema.find(
                (entry) =>
                  entry.name === field.name &&
                  entry.type === field.type &&
                  entry.type.startsWith('texture'),
              ) ?? field,
          )
        : effectiveSchema;
      // Standard height never samples in fragment. Keep that stage policy out
      // of custom shaders, where the same parameter name may be fragment input.
      const userRegion = buildPbrMaterialUserRegionEntries(
        userRegionSchema,
        [],
        isStandardPbrMaterialShader(spec.shader.id) || spec.shader.id === SHADOW_CASTER_SHADER_ID
          ? ['displacementTexture']
          : [],
      );
      const afterIbl = [...userRegion, ...appendInjection(userRegion, 'ibl')];
      const afterTransmission = [...afterIbl, ...appendInjection(afterIbl, 'transmission')];
      const engineRegion =
        options.caps?.transmissionBackdrop === false &&
        spec.shader.id !== 'forgeax::single-layer-medium'
          ? afterIbl
          : afterTransmission;
      const afterSurfaceMedium =
        spec.shader.id === 'forgeax::single-layer-medium'
          ? [...engineRegion, ...appendSingleLayerMediumInjection(engineRegion)]
          : engineRegion;
      const merged = [...afterSurfaceMedium, ...appendTextureInjection(effectiveSchema)];
      // Scene-index Standard variants reserve binding 46 for the producer-owned
      // material row. Physical texture pairs start after this reserved region,
      // so no authored physical subset can alias the row.
      if (options.caps?.storageBuffer ?? true) {
        merged.push({
          binding: 46,
          visibility: GPU_SHADER_STAGE_VERTEX | GPU_SHADER_STAGE_FRAGMENT,
          buffer: { type: 'read-only-storage', hasDynamicOffset: false },
        });
      }
      const entries = [
        ...merged,
        ...(materialUsesDirectDfgLut(effectiveSchema)
          ? [
              {
                binding: STANDARD_DIRECT_DFG_LUT_BINDING,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                texture: { sampleType: 'float' as const, viewDimension: '2d' as const },
              },
            ]
          : []),
        ...(spec.shader.id === 'forgeax::single-layer-medium'
          ? []
          : [
              {
                binding: 47,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                texture: { sampleType: 'float' as const, viewDimension: 'cube' as const },
              },
            ]),
      ];
      const excluded = omittedStandardMaterialBindings(
        [
          ...derive(userRegionSchema.filter((field) => !physicalFields.includes(field.name)))
            .textureFieldNames,
        ],
        options.caps?.transmissionBackdrop !== false ||
          spec.shader.id === 'forgeax::single-layer-medium',
        isStandardPbrMaterialShader(spec.shader.id),
        isCanonicalStandardPbrMaterialShader(spec.shader.id),
        sharedMaterialBindingDeclarations(options.registry, spec.shader.id),
      );
      return {
        label: 'pbr-material-skylight-bgl',
        entries: entries.filter((entry) => !excluded.has(entry.binding)),
      };
    }
    case 'unlit-material': {
      // Unlit material BGL: per-shader user-region only. No IBL/transmission
      // injection (D-5 round-4: unlit demos do not pay for IBL state).
      const resolvedSchema = resolveMaterialParamSchema(spec, options);
      return {
        label: 'unlit-material-bgl',
        entries: buildPbrMaterialUserRegionEntries(resolvedSchema),
      };
    }
    case 'hdrp-7-slot': {
      // The device selects storage resources or the complete integer texture;
      // both layouts retain the existing mesh and Cluster uniform bindings.
      const desc = createHdrpBindGroupLayoutDescriptor(options.caps?.storageBuffer ?? true);
      return {
        label: desc.label ?? 'hdrp-unified-bgl-group2',
        entries: [...(desc.entries ?? [])],
      };
    }
    case 'fullscreen-post': {
      // Fullscreen post-process BGL: 2 entries (input texture + sampler).
      // R3 fix: derive sampleType from spec.attachments. Depth attachments
      // (depth32float) need `sampleType: 'depth'`; r32float needs
      // `'unfilterable-float'`; everything else (rgba8unorm-srgb, rgba16float,
      // bgra8unorm, …) is filterable `'float'`.
      return {
        label: 'fullscreen-post-bgl',
        entries: buildFullscreenPostInputEntries(spec),
      };
    }
    case 'fullscreen-post-with-params': {
      // feat-20260621 D-2: the same input texture@0 + sampler@1 as
      // 'fullscreen-post', plus binding 2 = per-frame params UBO (uniform).
      // The first two entries reuse buildFullscreenPostInputEntries so the
      // sampleType derivation stays a single SSOT; 'fullscreen-post' is
      // untouched (param-less zero-regression, R-A7).
      return {
        label: 'fullscreen-post-with-params-bgl',
        entries: [
          ...buildFullscreenPostInputEntries(spec),
          {
            binding: 2,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            buffer: { type: 'uniform' },
          },
        ],
      };
    }
    case 'fullscreen-post-with-scene-depth': {
      // plan-strategy D-3: 5-entry BGL for post-process passes that read the
      // camera scene depth. color@0 + sampler@1 reuse buildFullscreenPostInputEntries
      // (float+filtering for color). depthTex@3 uses `sampleType: 'depth'` and
      // `dimension: '2d'`; depthSampler@4 uses `type: 'non-filtering'` (nearest
      // + clamp-to-edge, D-2 — NOT comparison). params@2 is always present
      // (uniform) to avoid a 2x2 kind explosion per D-3.
      return {
        label: 'fullscreen-post-with-scene-depth-bgl',
        entries: [
          ...buildFullscreenPostInputEntries(spec),
          {
            binding: 2,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            buffer: { type: 'uniform' },
          },
          {
            binding: 3,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            texture: { sampleType: 'depth', viewDimension: '2d' },
          },
          {
            binding: 4,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            sampler: { type: 'non-filtering' },
          },
        ],
      };
    }
    case 'fullscreen-post-with-scene-depth-msaa': {
      return {
        label: 'fullscreen-post-with-scene-depth-msaa-bgl',
        entries: [
          ...buildFullscreenPostInputEntries(spec),
          {
            binding: 2,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            buffer: { type: 'uniform' },
          },
          {
            binding: 3,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            texture: { sampleType: 'depth', viewDimension: '2d', multisampled: true },
          },
          {
            binding: 4,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            sampler: { type: 'non-filtering' },
          },
        ],
      };
    }
    case 'fullscreen-post-with-paired-msaa': {
      return {
        label: 'fullscreen-post-with-paired-msaa-bgl',
        entries: [
          {
            binding: 0,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            texture: {
              sampleType: 'unfilterable-float',
              viewDimension: '2d',
              multisampled: true,
            },
          },
          {
            binding: 1,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            sampler: { type: 'filtering' },
          },
          {
            binding: 2,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            buffer: { type: 'uniform' },
          },
          {
            binding: 3,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            texture: { sampleType: 'depth', viewDimension: '2d', multisampled: true },
          },
          {
            binding: 4,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            sampler: { type: 'non-filtering' },
          },
        ],
      };
    }
  }
}

/**
 * The shared texture@0 + sampler@1 entries for fullscreen post-process BGLs.
 * sampleType is derived from `spec.attachments` (R3 fix): depth attachments →
 * `'depth'` + `'comparison'` sampler; `'r32float'` → `'unfilterable-float'`;
 * else → `'float'` + `'filtering'`. Both `'fullscreen-post'` and
 * `'fullscreen-post-with-params'` reuse this so the derivation is one SSOT.
 */
function buildFullscreenPostInputEntries(spec: PipelineSpec): GPUBindGroupLayoutEntry[] {
  const inputFormat: GPUTextureFormat | undefined =
    spec.attachments.depthFormat ?? spec.attachments.colorFormats[0];
  const sampleType: GPUTextureSampleType =
    inputFormat === 'depth32float' ||
    inputFormat === 'depth24plus' ||
    inputFormat === 'depth32float-stencil8' ||
    inputFormat === 'depth24plus-stencil8' ||
    inputFormat === 'depth16unorm'
      ? 'depth'
      : inputFormat === 'r32float'
        ? 'unfilterable-float'
        : 'float';
  return [
    {
      binding: 0,
      visibility: GPU_SHADER_STAGE_FRAGMENT,
      texture: { sampleType, viewDimension: '2d' },
    },
    {
      binding: 1,
      visibility: GPU_SHADER_STAGE_FRAGMENT,
      sampler: {
        type: sampleType === 'depth' ? 'comparison' : 'filtering',
      },
    },
  ];
}

// ══════════════════════════════════════════════════════════════════════════════

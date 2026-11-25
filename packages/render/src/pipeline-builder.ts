import { findMaterialShaderEntry, STANDARD_TEXTURE_MASK_OVERRIDE } from '@forgeax/engine-shader';
import { isStripTopology } from '@forgeax/engine-types';
import { markPositionOnlyMeshPipeline } from './device/mesh-vertex-streams';
import { pipelineVertexConstants } from './material-stage-constants';
import { standardMaskDisplacesVertices } from './standard-displacement-bounds';
// pipeline-builder.ts -- runtime-internal helper for building per-MaterialShader
// render pipelines (feat-20260523-shader-template-instance-split M9-T01).
//
// Anchors:
//   - plan-strategy D-PipelineBuilder: M9 introduces a runtime-internal
//     pipeline builder helper. `render-system-record` calls it once per
//     `materialShaderId` cache miss; the cache (M9-T03) is owned by the
//     record stage, not this helper.
//   - requirements AC-08: record on cache miss correctly constructs pipeline.
//   - requirements AC-14: the visible-pulse demo's per-frame values.time
//     mutation depends on a real GPU pipeline being built for the user
//     shader (`my-game::pulse-material`).
//   - plan-strategy R-H: pipeline construction must reuse the existing
//     4-BindGroupLayout chain so existing PBR-heavy demos do not regress.
//
// API shape (per plan-task M9-T01 acceptanceCheck):
//   buildPipelineForMaterialShader(id, entry, ctx) -> Result<RenderPipeline, RhiError>
//
// The helper is intentionally **pure**: it does not cache, does not look up
// the catalog, does not maintain state. The caller (render-system-record's
// per-MaterialShader pipeline cache, M9-T03) is responsible for both the
// `ShaderCatalog.findMaterialArtifact(id)` call and the
// `Map<materialShaderId, RenderPipeline>` cache. Splitting the concerns
// keeps the helper trivially mockable (M9-T02 covers it with vi.fn-based
// mocks; no real device required).
//
// Pipeline shape:
//   - layout       = caller-supplied PipelineLayout (forgeax R-H: same
//                    4-BGL chain `[view, material, mesh-array, instances]`
//                    reused across all MaterialShader entries; D-5 round-4)
//   - vertex stage = entry.source compiled as a ShaderModule, entry point
//                    `vs_main`, vertex buffer layout from ctx
//   - fragment     = same ShaderModule, entry point `fs_main`, color
//                    attachment format from ctx
//   - depth        = ctx.depthFormat with `less` compare + `depthWriteEnabled`
//   - primitive    = `geometry.topology` (default `triangle-list`) + `back`
//                    cull + `ccw` front face; strip topologies also bake
//                    `stripIndexFormat`
//
// Capability gating: device.caps deviates only at the call site that
// computes ctx; the helper consumes the resolved `ctx` without further
// branching (charter P4 consistent abstraction).

import {
  err,
  ok,
  type PipelineLayout,
  PipelineRecipeState,
  type RenderPipeline,
  type RenderPipelineDescriptor,
  type Result,
  type RhiDevice,
  RhiError,
  type ShaderModule,
} from '@forgeax/engine-rhi';
import {
  type MaterialShaderEntry,
  type MaterialShaderProgram,
  type RegisteredMaterialShaderEntry,
  SCENE_VELOCITY_WITH_DEPTH_OVERRIDE,
} from '@forgeax/engine-shader';
import type { MaterialRenderState, PassKind, PrimitiveTopology } from '@forgeax/engine-types';
import { materialColorTarget, materialDepthStencil } from './material-render-state';
import { colorFormatsForPassKind } from './pipeline-spec';
import { validateVertexInputLayout } from './vertex-input-guard';

/**
 * feat-20260604-mesh-topology-debug-draw M3 / w8: per-mesh geometry facts that
 * are baked into the immutable GPURenderPipeline `primitive` block. Distinct
 * from {@link MaterialRenderState} (material-authored state); these are
 * geometry properties of the mesh being drawn (requirements D-2 / D-A3).
 */
interface PipelineGeometry {
  /** Primitive topology baked into `primitive.topology`. Defaults to 'triangle-list'. */
  readonly topology?: PrimitiveTopology;
  /**
   * Index format for strip topologies (`line-strip` / `triangle-strip`), baked
   * into `primitive.stripIndexFormat`. WebGPU spec: only valid for strip
   * topologies; ignored (left undefined in the descriptor) for list topologies.
   */
  readonly stripIndexFormat?: 'uint16' | 'uint32';
}

/**
 * Sync shader-module factory consumed by `buildPipelineForMaterialShader`.
 * Mirrors `ShaderCatalogDevice.createShaderModule` (sync Result shape) so
 * the same `makeShaderDeviceAdapter` in `createRenderer.ts` can satisfy
 * both surfaces (charter P4 consistent abstraction). The adapter caches
 * the underlying async `pack.createShaderModule` so subsequent sync calls
 * return cached modules; first call typically returns
 * `Result.err('rhi-not-available')` while the async build is in flight,
 * letting the caller fall back to the existing `standardPipeline` for
 * one frame and retry on the next (matches `render-system-record`'s
 * 1-frame-warmup idiom).
 */
export interface PipelineBuilderShaderModuleFactory {
  createShaderModule(desc: {
    readonly code: string;
    readonly label?: string | undefined;
  }): Result<ShaderModule, RhiError>;
  /** True only when this live factory owns the exact pending module request. */
  isPending?(error: RhiError): boolean;
  /** Non-allocating original-owner evidence used by off-frame native preparation. */
  peekShaderModule?(desc: {
    readonly code: string;
    readonly label?: string | undefined;
  }): ShaderModule | undefined;
  pendingShaderModuleCompletion?(signal: RhiError): Promise<Result<void, RhiError>> | undefined;
}

/**
 * Build context for `buildPipelineForMaterialShader`. Caller (createRenderer
 * + render-system-record) computes this once per renderer and reuses across
 * cache misses; the values mirror the existing PBR pipeline construction
 * (createRenderer.ts ~line 2712 standardPipelineResult) so user shaders
 * land on the same 4-BindGroupLayout chain (charter P4 + plan-strategy
 * R-H).
 */
export interface PipelineBuilderContext {
  /** RHI device that owns the pipeline allocation. */
  readonly device: RhiDevice;
  /** Generation-owned async requests expose a synchronous pending/ready Result here. */
  readonly createRenderPipeline?: RhiDevice['createRenderPipeline'] | undefined;
  readonly createRenderPipelineRecipeState?: (
    state: PipelineRecipeState,
    dependencies: { layout: PipelineLayout; vertex: ShaderModule; fragment?: ShaderModule },
    materialize: () => RenderPipelineDescriptor,
  ) => Result<RenderPipeline, RhiError>;

  /**
   * Sync shader-module factory (see {@link PipelineBuilderShaderModuleFactory}).
   * In production the engine wires the same `makeShaderDeviceAdapter` it
   * already uses for `ShaderCatalog.get(hash)`; tests pass a
   * `vi.fn`-based stub.
   */
  readonly shaderModuleFactory: PipelineBuilderShaderModuleFactory;
  /**
   * Shared pipeline layout (4 BindGroupLayouts: view + material + mesh-array
   * + instances). User shaders bind through the same slots as
   * default-standard-pbr; D-5 round-4 SSOT.
   */
  readonly pipelineLayout: PipelineLayout;
  /**
   * Color attachment format. The LDR / HDR variants pick `bgra8unorm-srgb` /
   * `rgba16float` respectively; record-stage gate matches the camera's
   * tonemap field (M9 keeps the LDR shape; HDR variants are OOS-M9).
   */
  readonly colorFormat: GPUTextureFormat;
  /** Additional color targets for an MRT pass; the first target is colorFormat. */
  readonly colorFormats?: readonly GPUTextureFormat[] | undefined;
  /** Common pipeline-time overrides, including vertex displacement texture selection. */
  readonly constants?: Readonly<Record<string, number>> | undefined;
  /** Explicit vertex-stage values; omitted uses the common overrides. */
  readonly vertexConstants?: Readonly<Record<string, number>> | undefined;
  /** Depth attachment format, or `undefined` for a color-only pass. */
  readonly depthFormat: GPUTextureFormat | undefined;
  /**
   * Vertex buffer layout descriptors. Procedural geometry uses the 12-floats
   * stride (position + normal + uv + tangent); user shaders share this
   * layout for v1 (OOS-9 leaves alternative vertex layouts for a follow-up
   * feat).
   */
  readonly vertexBuffers: readonly GPUVertexBufferLayout[];
  /** Renderer-resolved identity for the engine's rigid Standard vertex program. */
  readonly stockStandardVertexProgram?: boolean | undefined;
  /** Explicit layout family selected by the renderer assembly. */
  readonly layoutKind?: 'pbr-skin' | 'gpu-driven-skin' | 'gpu-driven-cluster-skin' | undefined;
  /** Pipeline label (for GPU debug captures); defaults to `pbr-pipeline-${id}`. */
  readonly label?: string | undefined;
  /**
   * feat-20260604-mesh-topology-debug-draw w16-b: the shader-MODULE cache
   * identity, decoupled from the PSO `label` and the `id` arg. The WGSL module
   * depends ONLY on (source + defines), NOT on topology / renderState / isHdr /
   * indexFormat -- all of which WebGPU bakes into the immutable PSO, never the
   * module. `makeShaderDeviceAdapter` keys its `moduleCache` on this label, so
   * passing a stable per-(shader-source, defines) value here lets every
   * topology / renderState / HDR pipeline variant of the same shader SHARE one
   * compiled module: the first variant warms it, every later variant reuses it
   * synchronously (no per-variant async recompile, no event-loop yield).
   * Falls back to `shader-${id}` when omitted (pre-w16-b behaviour: the `id`
   * arg doubled as both PSO cache key and module label). The defines dimension
   * is NOT folded in here because the engine pre-resolves define variants into
   * distinct registered `source` strings (createRenderer.ts variant
   * resolution); callers that thread `defines` directly must include them in
   * `moduleLabel` so two `#define` prefixes do not collide on one module.
   */
  readonly moduleLabel?: string | undefined;
  /** Device facts used to reject a temporal PSO before it reaches submit. */
  readonly capabilities?: {
    readonly storageBuffer: boolean;
    readonly rgba16floatRenderable: boolean;
  };
  /** The output-domain binary coverage variant uses an r8unorm attachment. */
  readonly coverageOnly?: boolean | undefined;
}

function hasStandardCoverageEntries(source: string | MaterialShaderProgram): boolean {
  if (typeof source !== 'string' && source.entryPoints !== undefined) {
    return findMaterialShaderEntry(source.entryPoints, 'fs_coverage', 'fragment') !== undefined;
  }
  const code = typeof source === 'string' ? source : source.source;
  return code.includes('fn vs_coverage') && code.includes('fn fs_coverage');
}

/**
 * Validate the temporal material contract at the PSO creation boundary.
 *
 * Downlevel WebGL2 implementations can accept a pipeline whose shader/layout
 * pair is invalid and report the failure only when the command buffer is
 * submitted. The temporal producer is the one material path where this is
 * especially damaging: the invalid handle is cached and every frame then
 * fails. Keep this check beside descriptor construction so the caller gets a
 * structured shader failure before a handle is cached.
 */
export function validateTemporalPipelineContract(
  source: string | MaterialShaderProgram,
  ctx: Pick<
    PipelineBuilderContext,
    'colorFormat' | 'depthFormat' | 'capabilities' | 'coverageOnly'
  >,
  fragmentEntry?: string,
): Result<void, RhiError> {
  const standardCoverage = fragmentEntry === 'fs_coverage' && ctx.coverageOnly === true;
  const hasEntries = standardCoverage
    ? hasStandardCoverageEntries(source)
    : typeof source === 'string'
      ? source.includes('fn vs_temporal') && source.includes('fn fs_temporal')
      : source.hasTemporalEntries;
  if (!hasEntries) {
    return err(
      new RhiError({
        code: 'shader-compile-failed',
        expected: standardCoverage
          ? 'Standard material source declares coverage entry points'
          : 'temporal material source declares vs_temporal and fs_temporal entry points',
        hint: 'compile the temporal material variant that owns the temporal producer ABI',
      }),
    );
  }
  const validCoverageTarget = ctx.coverageOnly === true && ctx.colorFormat === 'r8unorm';
  const validVelocityTarget =
    fragmentEntry === 'fs_scene_velocity' &&
    (ctx.colorFormat === 'r32uint' || ctx.colorFormat === 'rg32uint');
  if (ctx.colorFormat !== 'rgba16float' && !validCoverageTarget && !validVelocityTarget) {
    return err(
      new RhiError({
        code: 'shader-compile-failed',
        expected: 'temporal material target format is rgba16float',
        hint:
          ctx.coverageOnly === true
            ? `coverage temporal producer received unsupported color format ${ctx.colorFormat}; use r8unorm`
            : `temporal producer received color format ${ctx.colorFormat}; use its physical rgba16float target`,
      }),
    );
  }
  if (ctx.depthFormat === undefined) {
    return err(
      new RhiError({
        code: 'shader-compile-failed',
        expected: 'temporal material pipeline has a depth format',
        hint: 'provide the shared scene depth attachment for the temporal producer',
      }),
    );
  }
  const capabilities = ctx.capabilities;
  if (capabilities !== undefined) {
    const sourceUsesStorageBuffer =
      typeof source === 'string'
        ? /var\s*<\s*storage(?:\s*,|\s*>)/u.test(source)
        : source.usesStorageBuffer;
    if (sourceUsesStorageBuffer !== capabilities.storageBuffer) {
      return err(
        new RhiError({
          code: 'shader-compile-failed',
          expected: `temporal shader storage-buffer variant matches device capability (${capabilities.storageBuffer})`,
          hint: 'resolve the material variant against the active WebGL2/native capability before creating the PSO',
        }),
      );
    }
    if (!capabilities.rgba16floatRenderable) {
      return err(
        new RhiError({
          code: 'shader-compile-failed',
          expected: 'rgba16float temporal target is renderable on the active device',
          hint: 'preserve the structured capability refusal instead of creating a deferred-invalid PSO',
        }),
      );
    }
  }
  return ok(undefined);
}

/** Reject a mesh layout that lacks a vertex input before compiling or creating anything. */
function createVertexCompatibleModule(
  id: string,
  source: string | MaterialShaderProgram,
  vertexEntry: string,
  ctx: PipelineBuilderContext,
): Result<ShaderModule, RhiError> {
  const vertexLayout = validateVertexInputLayout(id, source, vertexEntry, ctx.vertexBuffers);
  if (!vertexLayout.ok) return vertexLayout;
  const label = ctx.moduleLabel ?? `shader-${id}`;
  return ctx.shaderModuleFactory.createShaderModule(
    typeof source === 'string' ? { code: source, label } : source.sourceReference.descriptor(label),
  );
}

function pipelineCreationHint(error: RhiError): string {
  return `inspect compiler messages on the shader module; verify pipeline layout matches shader bindings (cause: ${error.code}; underlying hint: ${error.hint}; raw: ${error.message})`;
}

export function defaultMaterialVertexEntry(passKind: PassKind): string {
  return passKind === 'temporal' ? 'vs_temporal' : 'vs_main';
}

export function defaultMaterialFragmentEntry(passKind: PassKind): string {
  switch (passKind) {
    case 'temporal':
      return 'fs_temporal';
    case 'deferred':
      return 'fs_gbuffer';
    case 'shadow-caster':
      return 'fs_shadow';
    default:
      return 'fs_main';
  }
}

export function pipelineVertexEntry(
  vertexEntry: string | undefined,
  passKind: PassKind,
  buffers: PipelineBuilderContext['vertexBuffers'],
): string {
  const requestedVertexEntry = vertexEntry ?? defaultMaterialVertexEntry(passKind);
  for (const buffer of buffers) {
    for (const attribute of buffer.attributes) {
      if (attribute.shaderLocation === 14 && attribute.format === 'uint32')
        return requestedVertexEntry.endsWith('_packed')
          ? requestedVertexEntry
          : `${requestedVertexEntry}_packed`;
    }
  }
  return requestedVertexEntry;
}

/**
 * Build a render pipeline for a material shader entry. Returns
 * `Result.err(RhiError)` on shader-module compile failure or pipeline
 * descriptor rejection (closed union RhiErrorCode pattern; AGENTS.md
 * "Errors are structured" + charter P3 explicit failure).
 *
 * Caller flow (M9-T03):
 * ```ts
 * let pipeline = pipelineCache.get(materialShaderId);
 * if (pipeline === undefined) {
 *   const lookup = registry.findMaterialArtifact(materialShaderId);
 *   if (!lookup.ok) {
 *     // fallback to default-standard-pbr pipelineState.standardPipeline
 *   } else {
 *     const built = buildPipelineForMaterialShader(materialShaderId, lookup.value, ctx);
 *     if (built.ok) pipelineCache.set(materialShaderId, built.value);
 *     else if (built.error.code === 'rhi-not-available') {
 *       // shader module still compiling async; retry next frame.
 *     }
 *   }
 * }
 * ```
 */
const materialRasterSources = new WeakMap<
  RenderPipeline,
  {
    readonly descriptor: RenderPipelineDescriptor;
    readonly fragmentSource: string | MaterialShaderProgram;
    readonly fragmentEffects: import('@forgeax/engine-types').ShaderEntryPointEffects | undefined;
  }
>();

/** Exact admitted vertex state and rasterization facts for requested editor observations. */
export function materialRasterSource(pipeline: RenderPipeline) {
  return materialRasterSources.get(pipeline);
}

function materialPipelineSource(
  entry: MaterialShaderEntry,
  defines: Record<string, string> | undefined,
): Result<string | MaterialShaderProgram, RhiError> {
  const source = (entry as Partial<RegisteredMaterialShaderEntry>).program ?? entry.source;
  if (defines === undefined || Object.keys(defines).length === 0) return ok(source);
  const defineKeyRe = /^[A-Z_][A-Z0-9_]*$/;
  for (const key of Object.keys(defines)) {
    if (!defineKeyRe.test(key)) {
      return err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: `define key matching /^[A-Z_][A-Z0-9_]*$/`,
          hint: `illegal define key '${key}' — use uppercase letters, digits, and underscores, starting with a letter or underscore`,
        }),
      );
    }
  }
  const prefix = `${Object.entries(defines)
    .map(([k, v]) => `#define ${k} ${v}`)
    .join('\n')}\n`;
  return ok(prefix + (typeof source === 'string' ? source : source.source));
}

function materialVertexInput(
  entry: MaterialShaderEntry,
  ctx: PipelineBuilderContext,
  renderState: MaterialRenderState | undefined,
  vertexEntry: string | undefined,
  fragmentEntry: string | null | undefined,
  passKind: PassKind,
  colorAttachmentCount: number,
) {
  const position = positionOnlyMaterialBuffer(
    entry,
    ctx,
    renderState,
    vertexEntry,
    fragmentEntry,
    passKind,
    colorAttachmentCount,
  );
  if (position === undefined)
    return {
      vsEntry: pipelineVertexEntry(vertexEntry, passKind, ctx.vertexBuffers),
      vertexBuffers: ctx.vertexBuffers,
      vertexContext: ctx,
      positionOnly: false,
    };
  const vertexBuffers = [position];
  return {
    vsEntry: 'vs_position_only',
    vertexBuffers,
    vertexContext: { ...ctx, vertexBuffers },
    positionOnly: true,
  };
}

function materialFragmentConstants(
  source: string | MaterialShaderProgram,
  entry: string,
  format: GPUTextureFormat | undefined,
  constants: PipelineBuilderContext['constants'],
): PipelineBuilderContext['constants'] {
  if (entry !== 'fs_scene_velocity' || format !== 'rg32uint') return constants;
  const supportsExtendedVelocity =
    typeof source === 'string'
      ? source.includes('override sceneVelocityWithDepthOutput')
      : source.overrideIds.includes(SCENE_VELOCITY_WITH_DEPTH_OVERRIDE);
  return supportsExtendedVelocity
    ? { ...constants, [SCENE_VELOCITY_WITH_DEPTH_OVERRIDE]: 1 }
    : constants;
}

export function buildPipelineForMaterialShader(
  id: string,
  entry: MaterialShaderEntry,
  ctx: PipelineBuilderContext,
  renderState?: MaterialRenderState,
  geometry?: PipelineGeometry,
  vertexEntry?: string,
  // null explicitly selects vertex-only depth; omitted preserves authored coverage.
  fragmentEntry?: string | null,
  defines?: Record<string, string>,
  passKind: PassKind = 'forward',
  // bug-20260615 M2 / m2-1: sampleCount is a CAMERA fact (per-frame antialias
  // setting) threaded from getMaterialShaderPipeline -> buildAndCachePipeline
  // -> here. Default 1 produces `multisample: undefined` — byte-identical to
  // the pre-M2 descriptor for every existing count=1 caller. count > 1 sets
  // `multisample: { count: sampleCount }` matching the `createMsaaVariant`
  // shape on the built-in geometry side.
  sampleCount: number = 1,
): Result<RenderPipeline, RhiError> {
  const label = ctx.label ?? `pbr-pipeline-${id}`;

  const fsEntry = fragmentEntry ?? defaultMaterialFragmentEntry(passKind);

  const resolvedSource = materialPipelineSource(entry, defines);
  if (!resolvedSource.ok) return resolvedSource;
  const source = resolvedSource.value;
  const attachmentFormats = ctx.colorFormats ?? colorFormatsForPassKind(passKind, ctx.colorFormat);
  const { positionOnly, vertexBuffers, vsEntry, vertexContext } = materialVertexInput(
    entry,
    ctx,
    renderState,
    vertexEntry,
    fragmentEntry,
    passKind,
    attachmentFormats.length,
  );
  const moduleResult = createVertexCompatibleModule(id, source, vsEntry, vertexContext);
  if (!moduleResult.ok) return moduleResult;
  const shaderModule = moduleResult.value;

  if (passKind === 'temporal') {
    const temporalContract = validateTemporalPipelineContract(source, ctx, fsEntry);
    if (!temporalContract.ok) return temporalContract;
  }

  const hasFragmentStage =
    attachmentFormats.length > 0 ||
    (fragmentEntry !== null &&
      (typeof source === 'string' ? source.includes('@fragment') : source.hasFragmentStage));
  const dependencies = {
    layout: ctx.pipelineLayout,
    vertex: shaderModule,
    ...(hasFragmentStage ? { fragment: shaderModule } : {}),
  };
  // One projection defines both equality against warmup state and cold admission.
  // A hit visits one field at a time, without building the complete dictionary.
  const vertexConstants = positionOnly ? undefined : pipelineVertexConstants(ctx);
  const fragmentConstants = materialFragmentConstants(
    source,
    fsEntry,
    attachmentFormats[0],
    ctx.constants,
  );
  const fields = function* (): Iterable<readonly [string, unknown]> {
    yield [
      'vertex',
      {
        entryPoint: vsEntry,
        ...(vertexConstants === undefined ? {} : { constants: vertexConstants }),
        buffers: vertexBuffers,
      },
    ];
    if (hasFragmentStage)
      yield [
        'fragment',
        {
          entryPoint: fsEntry,
          ...(fragmentConstants === undefined ? {} : { constants: fragmentConstants }),
          targets: attachmentFormats.map((format, index) =>
            materialColorTarget(format, renderState, index),
          ),
        },
      ];
    yield [
      'primitive',
      {
        topology: geometry?.topology ?? 'triangle-list',
        cullMode: renderState?.cullMode ?? 'back',
        frontFace: renderState?.frontFace ?? 'ccw',
        // A colorless forward PSO (depth-only scene prepass) still draws indexed strips.
        ...((attachmentFormats.length > 0 || passKind === 'forward') &&
        geometry?.topology !== undefined &&
        isStripTopology(geometry.topology)
          ? { stripIndexFormat: geometry.stripIndexFormat }
          : {}),
      },
    ];
    const depthFormat =
      attachmentFormats.length === 0 ? (ctx.depthFormat ?? 'depth32float') : ctx.depthFormat;
    if (depthFormat !== undefined)
      yield ['depthStencil', materialDepthStencil(depthFormat, renderState)];
    if (sampleCount > 1)
      yield [
        'multisample',
        {
          count: sampleCount,
          ...(attachmentFormats.length > 0 && renderState?.alphaToCoverageEnabled === true
            ? { alphaToCoverageEnabled: true }
            : {}),
        },
      ];
  };
  const derive = (): PipelineRecipeState =>
    ctx.device.pipelineLibrary?.findRenderState?.(dependencies, (state) =>
      state.matches(fields()),
    ) ?? new PipelineRecipeState('render', Object.fromEntries(fields()));
  const state = derive();
  const materialize = (): RenderPipelineDescriptor =>
    ({
      ...state.value,
      label,
      layout: ctx.pipelineLayout,
      vertex: { ...(state.value.vertex as object), module: shaderModule },
      fragment: hasFragmentStage
        ? ({
            ...(state.value.fragment as object),
            module: shaderModule,
          } as RenderPipelineDescriptor['fragment'])
        : undefined,
    }) as RenderPipelineDescriptor;
  let pipelineResult: Result<RenderPipeline, RhiError>;
  if (ctx.createRenderPipelineRecipeState !== undefined)
    pipelineResult = ctx.createRenderPipelineRecipeState(state, dependencies, materialize);
  else if (ctx.createRenderPipeline !== undefined)
    pipelineResult = ctx.createRenderPipeline(materialize());
  else {
    const selected = ctx.device.pipelineLibrary?.selectRender?.(state, dependencies, false);
    // A synchronous lookup cannot join an outstanding asynchronous request.
    if (
      selected !== undefined &&
      'ok' in selected &&
      (!selected.ok || selected.value !== undefined)
    )
      pipelineResult = selected as Result<RenderPipeline, RhiError>;
    else
      pipelineResult = (
        ctx.createRenderPipeline ?? ctx.device.createRenderPipeline.bind(ctx.device)
      )(materialize());
  }

  if (!pipelineResult.ok) {
    // Wrap the underlying RhiError with a `shader-compile-failed` envelope
    // when the originating code is not already canonical -- this preserves
    // the canonical error code consumers expect at the standard-pipeline
    // build site (createRenderer.ts standardPipelineResult).
    if (
      pipelineResult.error.code === 'shader-compile-failed' ||
      pipelineResult.error.code === 'rhi-not-available'
    ) {
      return pipelineResult;
    }
    return err(
      new RhiError({
        code: 'shader-compile-failed',
        expected: `pipeline for material shader '${id}' builds successfully`,
        hint: pipelineCreationHint(pipelineResult.error),
      }),
    );
  }
  if (positionOnly) markPositionOnlyMeshPipeline(pipelineResult.value);
  retainMaterialRasterSource(
    pipelineResult.value,
    passKind,
    attachmentFormats.length,
    materialize,
    source,
    entry,
    fsEntry,
  );
  return pipelineResult;
}

/** A known stock vertex path, with no per-material vertex displacement. */
export function positionOnlyMaterialBuffer(
  entry: MaterialShaderEntry,
  ctx: Pick<
    PipelineBuilderContext,
    'device' | 'vertexBuffers' | 'stockStandardVertexProgram' | 'constants'
  >,
  renderState: MaterialRenderState | undefined,
  vertex: string | undefined,
  fragment: string | null | undefined,
  passKind: PassKind,
  colorCount: number,
): GPUVertexBufferLayout | undefined {
  return fragment === null &&
    passKind === 'forward' &&
    colorCount === 0 &&
    renderState?.alphaToCoverageEnabled !== true
    ? positionOnlyBuffer(entry, ctx, vertex)
    : undefined;
}

function positionOnlyBuffer(
  entry: MaterialShaderEntry,
  ctx: Pick<
    PipelineBuilderContext,
    'device' | 'vertexBuffers' | 'stockStandardVertexProgram' | 'constants'
  >,
  vertexEntry: string | undefined,
): GPUVertexBufferLayout | undefined {
  if (
    ctx.stockStandardVertexProgram !== true ||
    (ctx.device.caps.backendKind !== 'webgpu' && ctx.device.caps.backendKind !== 'wgpu-native') ||
    entry.receipt?.positionBounds !== 'standard-input' ||
    entry.receipt.surface !== undefined ||
    (vertexEntry !== undefined && vertexEntry !== 'vs_main' && vertexEntry !== 'vs_scene_index')
  )
    return undefined;
  const mask = ctx.constants?.[STANDARD_TEXTURE_MASK_OVERRIDE];
  if (mask === undefined || standardMaskDisplacesVertices(mask)) return undefined;
  // Terrain, Water and older cooked variants do not publish this entry.
  const entries =
    (entry as Partial<RegisteredMaterialShaderEntry>).program?.entryPoints ?? entry.entryPoints;
  if (!entries?.some(({ stage, name }) => stage === 'vertex' && name === 'vs_position_only'))
    return undefined;
  const buffer = ctx.vertexBuffers[0];
  if (buffer === undefined || buffer.stepMode === 'instance') return undefined;
  for (const attribute of buffer.attributes) {
    if (attribute.shaderLocation === 0 && attribute.format === 'float32x3') {
      return { ...buffer, attributes: [attribute] };
    }
  }
  return undefined;
}

function retainMaterialRasterSource(
  pipeline: RenderPipeline,
  passKind: PassKind,
  colorTargets: number,
  materialize: () => RenderPipelineDescriptor,
  source: string | MaterialShaderProgram,
  entry: MaterialShaderEntry,
  fragmentEntry: string,
): void {
  if ((passKind !== 'forward' && passKind !== 'deferred') || colorTargets === 0) return;
  if (materialRasterSources.has(pipeline)) return;
  const entries =
    (typeof source === 'string' ? entry.entryPoints : source.entryPoints) ??
    entry.receipt?.entryPoints;
  materialRasterSources.set(pipeline, {
    descriptor: materialize(),
    fragmentSource: source,
    fragmentEffects: findMaterialShaderEntry(entries, fragmentEntry, 'fragment')?.effects,
  });
}

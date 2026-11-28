// @forgeax/engine-render - low-level record/encode graph primitives.
//
// Standard owns pass topology through typed-render-graph-primitives. This module
// retains the RHI-facing record helpers used by that typed graph: SSAO record
// closures, fullscreen dispatch, depth resolution, and encoding.
//
// Public graph assembly does not depend on legacy add* wrappers.
import type {
  GraphResourceResolver,
  GraphTextureView,
  ResolveContext,
} from '@forgeax/engine-render-graph';
import type {
  BindGroupEntry,
  Buffer,
  RhiComputePassEncoder,
  RhiRenderPassEncoder,
  Sampler,
  Texture,
  TextureFormat,
  TextureView,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import {
  buildFullscreenPostProcessPass,
  createFullscreenBindGroup,
} from './fullscreen-post-process-pass';
import { buildBeginRenderPassDescriptor } from './pipeline-spec';
import { PostProcessError } from './post-process-errors';
import { getOrCreateFromChain } from './record/mesh-ssbo';
import type { _InternalRenderPipelineContext, LegacySsaoResources } from './record/render-context';
import { recordFxaaPass } from './record/skybox-post-pass';
import type { RenderPipelineContext } from './render-contract';
import {
  getOrCreateSsaoBuffers,
  getOrCreateSsaoFallbackTexture,
  type SsaoBuffers,
} from './ssao-buffers';
import type { DeferredAoNormalLayout } from './ssao-config';
import { SSR_SCENE_COLOR_HISTORY_PROGRAM } from './ssr/scene-color-input';
import { getTemporalGpuState, stageTemporalGpuWrite } from './temporal/gpu';
import { recordContext } from './world/view-record-context';

type DepthResolutionContext = Pick<_InternalRenderPipelineContext, 'runtime'> & {
  readonly frameState: {
    readonly compiledFrameGraph?: {
      readonly targets: {
        readonly getColorTargetTexture: (key: string) => Texture | undefined;
      };
    } | null;
  };
};

type RenderGraphRecordContext = _InternalRenderPipelineContext & {
  readonly frameState: _InternalRenderPipelineContext['frameState'] & {
    readonly compiledFrameGraph: {
      readonly targets: {
        readonly getColorTargetDescriptor: (
          key: string,
        ) => { readonly format: TextureFormat } | undefined;
        readonly getColorTargetView: (key: string) => TextureView | undefined;
        readonly getColorTargetTexture: (key: string) => Texture | undefined;
      };
    } | null;
  };
};

function requireRenderGraphRecordContext(ctx: RenderPipelineContext): RenderGraphRecordContext {
  if (!('frameState' in ctx) || !('bindGroupCounts' in ctx) || !('geometryDepthKey' in ctx)) {
    throw new Error('typed render graph frame lacks the built-in record context');
  }
  return ctx as RenderGraphRecordContext;
}

/**
 * Resolve a depth-only view of a graph color target by key.
 *
 * On dawn the BindGroup validation rejects a default-view (aspect=all on a
 * depth+stencil texture) with "Multiple aspects (Depth|Stencil) selected".
 * A separate createTextureView({aspect:'depth-only'}) is required.
 *
 * @param internals - internal render pipeline context
 * @param key - graph color-target key to resolve depth from
 * @param label - debug label for the depth-only TextureView
 * @returns a depth-only TextureView, or null if the graph / texture is absent
 *   or creation fires a structured error
 */
export function resolveDepthOnlyView(
  internals: DepthResolutionContext,
  key: string,
  label: string,
  preferredKey?: string | null,
): TextureView | null {
  const graph = internals.frameState.compiledFrameGraph?.targets;
  if (graph === undefined) return null;
  const preferredTexture =
    preferredKey === null || preferredKey === undefined
      ? undefined
      : graph.getColorTargetTexture(preferredKey);
  const tex = preferredTexture ?? graph.getColorTargetTexture(key);
  if (tex === undefined) return null;
  const res = internals.runtime.device.createTextureView(tex as never, {
    label,
    dimension: '2d',
    aspect: 'depth-only',
    baseMipLevel: 0,
    mipLevelCount: 1,
    baseArrayLayer: 0,
    arrayLayerCount: 1,
  });
  if (!res.ok) {
    internals.runtime.errorRegistry.fire(res.error);
    return null;
  }
  return res.value;
}

/**
 * Resolve a depth-only view of the graph's hdrDepth texture.
 *
 * Thin delegate to {@link resolveDepthOnlyView} (plan-strategy D-5: extract
 * the shared depth-only view helper, SSAO delegates). Behaviour is byte-identical
 * to the pre-extraction inline version. The SSAO BGL / bindings / sampler are
 * untouched (OOS-4).
 */
function resolveHdrDepthDepthOnlyView(
  internals: DepthResolutionContext,
  hdrDepthKey: string,
): TextureView | null {
  return resolveDepthOnlyView(internals, hdrDepthKey, 'ssao-hdr-depth-only-view');
}

function ensureSsaoRecordCompanions(internals: _InternalRenderPipelineContext): {
  filteringSampler: Sampler;
  depthSampler: Sampler;
  fallbackRawView: TextureView;
} | null {
  const pp = internals.pipelineState.perPassResources;
  if (
    pp.ssaoFilteringSampler !== null &&
    pp.ssaoDepthSampler !== null &&
    pp.ssaoFallbackRawView !== null
  ) {
    return {
      filteringSampler: pp.ssaoFilteringSampler,
      depthSampler: pp.ssaoDepthSampler,
      fallbackRawView: pp.ssaoFallbackRawView as TextureView,
    };
  }

  const device = internals.runtime.device;

  if (pp.ssaoFilteringSampler === null) {
    // Despite the field name, this sampler is non-filtering (NEAREST):
    // bindings 3 (noise sampler) + 8 (ssaoSampler) pair with unfilterable
    // float textures (rgba32float noise / rgba8unorm ssaoRaw on dawn without
    // float32-filterable). The "filtering" label in the field name predates
    // the sampler-type split; the resource itself is non-filtering.
    const res = device.createSampler({
      label: 'ssao-noise-sampler',
      magFilter: 'nearest',
      minFilter: 'nearest',
      mipmapFilter: 'nearest',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    });
    if (!res.ok) {
      internals.runtime.errorRegistry.fire(res.error);
      return null;
    }
    pp.ssaoFilteringSampler = res.value;
  }

  if (pp.ssaoDepthSampler === null) {
    const res = device.createSampler({
      label: 'ssao-depth-sampler',
      magFilter: 'nearest',
      minFilter: 'nearest',
      mipmapFilter: 'nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    if (!res.ok) {
      internals.runtime.errorRegistry.fire(res.error);
      return null;
    }
    pp.ssaoDepthSampler = res.value;
  }

  if (pp.ssaoFallbackRawView === null) {
    const fb = getOrCreateSsaoFallbackTexture(internals.runtime);
    if (fb === null) return null;
    pp.ssaoFallbackRawView = fb.view;
  }

  return {
    filteringSampler: pp.ssaoFilteringSampler,
    depthSampler: pp.ssaoDepthSampler,
    fallbackRawView: pp.ssaoFallbackRawView as TextureView,
  };
}

function ssaoBindGroupEntries(
  buffers: SsaoBuffers,
  companions: NonNullable<ReturnType<typeof ensureSsaoRecordCompanions>>,
  normal: TextureView | null,
  depth: TextureView,
  raw: TextureView,
): readonly BindGroupEntry[] {
  return [
    { binding: 0, resource: { kind: 'buffer', value: { buffer: buffers.uniformBuffer } } },
    { binding: 1, resource: { kind: 'buffer', value: { buffer: buffers.kernelBuffer } } },
    { binding: 2, resource: { kind: 'textureView', value: buffers.noiseView } },
    {
      binding: 3,
      resource: { kind: 'sampler', value: companions.filteringSampler },
    },
    // The depth-only layout has no normal slot.
    ...(normal === null
      ? []
      : [{ binding: 4, resource: { kind: 'textureView', value: normal } } as const]),
    { binding: 5, resource: { kind: 'textureView', value: depth } },
    { binding: 6, resource: { kind: 'sampler', value: companions.depthSampler } },
    { binding: 7, resource: { kind: 'textureView', value: raw } },
    { binding: 8, resource: { kind: 'sampler', value: companions.filteringSampler } },
  ];
}

/**
 * recordSsaoCalcPass — fullscreen SSAO occlusion calculation (M8 / w38).
 *
 * Resolves the graph-owned half-resolution ssaoRaw color target, writes the
 * 256 B SSAO uniform (view/proj/invProj/intensity) once per frame, then runs
 * a 3-vertex fullscreen-triangle draw with fs_ssao_calc.
 *
 * Bind group entries (must match the 9-entry SSAO BGL declared in
 * createRenderer.ts; see hdrp-ssao.wgsl §BGL layout):
 *   0 ssao_uniform UBO            5 hdr_depth view
 *   1 ssao_kernel UBO             6 ssao_depth_sampler (non-filtering)
 *   2 ssao_noise_texture          7 fallback ssaoRaw view (calc never samples)
 *   3 ssao_noise_sampler          8 ssaoSampler (unused by calc, BGL slot)
 *   4 gbuffer_normal view
 *
 * Skips with no GPU work when the optional SSAO pipelines are unavailable
 * (manifest without hdrp-ssao.wgsl), when the dedicated BGL is null, when
 * the SSAO buffers fail to allocate, or when the graph cannot resolve the
 * required views.
 */
export interface SsaoCalcPassViews {
  readonly gbufferLayout?: DeferredAoNormalLayout | undefined;
  readonly output: TextureView;
  readonly normal: TextureView;
  readonly depth: TextureView;
  readonly depthCacheKey: TextureView;
}

export interface GtaoComputePassViews {
  readonly gbufferV2?: boolean;
  readonly output: TextureView;
  readonly normal: TextureView;
  readonly depth: TextureView;
  readonly width: number;
  readonly height: number;
}

/** Encode the production raw GTAO entry into the graph-owned storage target. */
export function recordGtaoComputePass(
  context: _InternalRenderPipelineContext,
  pass: RhiComputePassEncoder,
  views: GtaoComputePassViews,
): void {
  const { runtime, pipelineState } = context;
  const perPass = pipelineState.perPassResources;
  const pp = perPass.getLegacyGtaoResources?.() ?? perPass;
  const pipeline =
    views.gbufferV2 === true ? pp.gtaoGBufferComputePipeline?.() : pp.gtaoComputePipeline;
  const layout = pp.gtaoComputeBgl;
  if (pipeline == null || layout == null) {
    throw new RhiError({
      code: 'feature-not-enabled',
      expected: 'the selected GTAO compute entry and bind-group layout are available',
      hint: 'prepare a compute-capable shader generation or select the admitted GTAO fragment entry',
    });
  }
  const config = context.frameState.installedPipelineConfig?.ambientOcclusion;
  if (config?.enabled !== true || config.method !== 'gtao') {
    throw new RhiError({
      code: 'feature-not-enabled',
      expected: 'the GTAO compute entry is selected only for the GTAO algorithm',
      hint: 'retain the SSAO fragment path when algorithm is hemisphere SSAO',
    });
  }
  const buffers = getOrCreateSsaoBuffers(runtime);
  if (buffers === null) {
    throw new RhiError({
      code: 'feature-not-enabled',
      expected: 'GTAO uniform resources are allocated for the current device generation',
      hint: 'repair the SSAO resource preparation failure before recording GTAO',
    });
  }
  const written = buffers.uniformPage.upload(
    runtime.device.queue,
    buffers.uniformBuffer,
    context.camera,
    config,
  );
  if (!written.ok) throw written.error;
  const group = runtime.device.createBindGroup({
    label: 'gtao-compute-bind-group',
    layout,
    entries: [
      { binding: 0, resource: { kind: 'buffer', value: { buffer: buffers.uniformBuffer } } },
      { binding: 4, resource: { kind: 'textureView', value: views.normal } },
      { binding: 5, resource: { kind: 'textureView', value: views.depth } },
      { binding: 9, resource: { kind: 'textureView', value: views.output } },
    ],
  });
  if (!group.ok) throw group.error;
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, group.value);
  pass.dispatchWorkgroups(Math.ceil(views.width / 8), Math.ceil(views.height / 8), 1);
}

function resolveLegacySsao(
  resources: _InternalRenderPipelineContext['pipelineState']['perPassResources'],
): LegacySsaoResources {
  return resources.getLegacySsaoResources?.() ?? resources;
}

function ssaoSurfacePipeline(
  resources: LegacySsaoResources,
  stage: 'calc' | 'blur',
  gbufferLayout: DeferredAoNormalLayout | undefined,
) {
  if (gbufferLayout !== undefined) return resources.ssaoGBufferPipelines?.(gbufferLayout)?.[stage];
  return stage === 'calc' ? resources.ssaoCalcPipeline : resources.ssaoBlurPipeline;
}

export function recordSsaoCalcPass(
  _c: _InternalRenderPipelineContext,
  resolveCtx?: ResolveContext,
  ssaoRawKey?: string,
  gbuf0Key?: string,
  hdrDepthKey?: string,
  graphPass?: RhiRenderPassEncoder,
  graphViews?: SsaoCalcPassViews,
): void {
  const { runtime, pipelineState, encoder } = _c;
  const pp = resolveLegacySsao(pipelineState.perPassResources);

  const pipeline = ssaoSurfacePipeline(pp, 'calc', graphViews?.gbufferLayout);
  if (pipeline == null || pp.ssaoBgl === null) {
    throw new PostProcessError({
      code: 'post-process-not-found',
      detail: { id: 'forgeax::post::ssao-calc' },
    });
  }
  if (graphViews === undefined && (resolveCtx === undefined || ssaoRawKey === undefined)) return;

  const ssaoRawView =
    graphViews?.output ?? (resolveCtx?.resolve(ssaoRawKey as string) as TextureView | undefined);
  const gbuf0View =
    graphViews?.normal ??
    (gbuf0Key !== undefined
      ? (resolveCtx?.resolve(gbuf0Key) as TextureView | undefined)
      : undefined);
  if (!ssaoRawView || !gbuf0View || (graphViews === undefined && hdrDepthKey === undefined)) return;

  // hdrDepth needs a depth-only view (BGL binding 5 sampleType=depth);
  // resolveCtx returns a default all-aspects view that dawn rejects when
  // paired with a depth sampler.
  const hdrDepthView = graphViews?.depth ?? resolveHdrDepthDepthOnlyView(_c, hdrDepthKey as string);
  if (hdrDepthView === null) return;

  // Cache key: the graph's pooled hdrDepth view (stable object per size, new
  // object on resize). The depth-only view above is created fresh every frame
  // so it cannot key the cache; the pooled all-aspects view co-varies with it
  // (both are views of the same transient hdrDepth texture) and changes exactly
  // on resize. Used only as a WeakMap key, never bound.
  const hdrDepthPooledView =
    graphViews?.depthCacheKey ??
    (resolveCtx?.resolve(hdrDepthKey as string) as TextureView | undefined);
  if (hdrDepthPooledView === undefined) return;

  const ssaoBufs = getOrCreateSsaoBuffers(runtime);
  if (ssaoBufs === null) return;

  const companions = ensureSsaoRecordCompanions(_c);
  if (companions === null) return;

  // Per-frame uniform write (D-C: view+proj+invProj+intensity at one queue
  // call). 256 B Float32Array (64 f32) lands in ssao_uniform UBO offset 0.
  const writeRes = ssaoBufs.uniformPage.upload(
    runtime.device.queue,
    ssaoBufs.uniformBuffer,
    _c.camera,
    _c.frameState.installedPipelineConfig?.ambientOcclusion,
  );
  if (!writeRes.ok) {
    runtime.errorRegistry.fire(writeRes.error);
    return;
  }

  // Identity-cached bind group: 9 entries mirror the BGL declared in
  // createRenderer. Keyed on the graph-pooled gbuf0 + hdrDepth views (both
  // retire + reallocate on resize), so the WeakMap misses after a resize and
  // rebuilds against the live textures. The noise / depth-only views bound
  // below back stable textures; keying on the
  // resize-varying graph views is what makes invalidation correct. Replaces
  // the prior `=== null` slot cache that submitted a destroyed gbuf0/hdrDepth
  // after resize.
  const ssaoBgl = pp.ssaoBgl;
  const bindGroup = getOrCreateFromChain(
    _c.frameState.postProcessBgCache,
    [gbuf0View, hdrDepthPooledView],
    'ssao-calc',
    () => {
      const bgRes = runtime.device.createBindGroup({
        label: 'ssao-calc-bg',
        layout: ssaoBgl,
        entries: ssaoBindGroupEntries(
          ssaoBufs,
          companions,
          gbuf0View,
          hdrDepthView,
          companions.fallbackRawView,
        ),
      });
      if (!bgRes.ok) throw bgRes.error;
      return bgRes.value;
    },
    _c.bindGroupCounts,
  );

  const pass: RhiRenderPassEncoder =
    graphPass ??
    encoder.beginRenderPass(
      buildBeginRenderPassDescriptor(
        { colorFormats: ['rgba8unorm'], depthFormat: undefined, sampleCount: 1 },
        { colorViews: [ssaoRawView] },
        'post-process',
      ) as never,
    );
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3, 1, 0, 0);
  if (graphPass === undefined) pass.end();
}

/**
 * recordSsaoBlurPass — fullscreen SSAO 5x5 depth/normal-aware blur.
 *
 * Reads the half-resolution ssaoRaw (visibility + encoded center normal),
 * writes the single-channel blurred result to ssaoBlurred. The BGL is the same 9-entry SSAO BGL
 * as the calc pass; the only difference is binding 7 carries the real
 * ssaoRaw view (vs the 1x1 fallback the calc pass binds).
 */
export interface SsaoBlurPassViews extends SsaoCalcPassViews {
  readonly raw: TextureView;
}

export interface SsaoDepthPassViews {
  readonly output: TextureView;
  readonly depth: TextureView;
  /** Real AO input for the blur; the calc binds the 1x1 fallback. */
  readonly raw?: TextureView | undefined;
}

/**
 * Depth-only prepass AO: fs_ssao_calc_depth / fs_ssao_blur_depth reconstruct
 * view normals from depth, so the layout omits the normal binding (4).
 */
export function recordSsaoDepthPass(
  _c: _InternalRenderPipelineContext,
  stage: 'calc' | 'blur',
  pass: RhiRenderPassEncoder,
  views: SsaoDepthPassViews,
): void {
  const pp = resolveLegacySsao(_c.pipelineState.perPassResources);
  const pipeline = stage === 'calc' ? pp.ssaoDepthCalcPipeline : pp.ssaoDepthBlurPipeline;
  const layout = pp.ssaoDepthBgl;
  if (pipeline == null || layout == null) {
    throw new PostProcessError({
      code: 'post-process-not-found',
      detail: { id: `forgeax::post::ssao-${stage}-depth` },
    });
  }
  const buffers = getOrCreateSsaoBuffers(_c.runtime);
  const companions = ensureSsaoRecordCompanions(_c);
  if (buffers === null || companions === null) return;
  if (stage === 'calc') {
    const written = buffers.uniformPage.upload(
      _c.runtime.device.queue,
      buffers.uniformBuffer,
      _c.camera,
      _c.frameState.installedPipelineConfig?.ambientOcclusion,
    );
    if (!written.ok) {
      _c.runtime.errorRegistry.fire(written.error);
      return;
    }
  }
  const raw = views.raw ?? companions.fallbackRawView;
  const group = getOrCreateFromChain(
    _c.frameState.postProcessBgCache,
    [raw, views.depth],
    `ssao-${stage}-depth`,
    () => {
      const created = _c.runtime.device.createBindGroup({
        label: `ssao-${stage}-depth-bg`,
        layout,
        entries: ssaoBindGroupEntries(buffers, companions, null, views.depth, raw),
      });
      if (!created.ok) throw created.error;
      return created.value;
    },
    _c.bindGroupCounts,
  );
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, group);
  pass.draw(3, 1, 0, 0);
}

export function recordSsaoBlurPass(
  _c: _InternalRenderPipelineContext,
  resolveCtx?: ResolveContext,
  ssaoBlurredKey?: string,
  ssaoRawKey?: string,
  gbuf0Key?: string,
  hdrDepthKey?: string,
  graphPass?: RhiRenderPassEncoder,
  graphViews?: SsaoBlurPassViews,
): void {
  const { runtime, pipelineState, encoder } = _c;
  const pp = resolveLegacySsao(pipelineState.perPassResources);

  const pipeline = ssaoSurfacePipeline(pp, 'blur', graphViews?.gbufferLayout);
  if (pipeline == null || pp.ssaoBgl === null) {
    throw new PostProcessError({
      code: 'post-process-not-found',
      detail: { id: 'forgeax::post::ssao-blur' },
    });
  }
  if (
    graphViews === undefined &&
    (resolveCtx === undefined || ssaoBlurredKey === undefined || ssaoRawKey === undefined)
  )
    return;

  const ssaoBlurredView =
    graphViews?.output ??
    (resolveCtx?.resolve(ssaoBlurredKey as string) as TextureView | undefined);
  const ssaoRawView =
    graphViews?.raw ?? (resolveCtx?.resolve(ssaoRawKey as string) as TextureView | undefined);
  const gbuf0View =
    graphViews?.normal ??
    (gbuf0Key !== undefined
      ? (resolveCtx?.resolve(gbuf0Key) as TextureView | undefined)
      : undefined);
  if (!ssaoBlurredView || !ssaoRawView) return;

  // hdrDepth depth-only view (see recordSsaoCalcPass).
  const hdrDepthView =
    graphViews?.depth ??
    (hdrDepthKey !== undefined ? resolveHdrDepthDepthOnlyView(_c, hdrDepthKey) : null);
  // Pooled hdrDepth view for the cache key (the depth-only view above is
  // recreated every frame; see recordSsaoCalcPass).
  const hdrDepthPooledView =
    graphViews?.depthCacheKey ??
    (hdrDepthKey !== undefined
      ? (resolveCtx?.resolve(hdrDepthKey) as TextureView | undefined)
      : undefined);

  const ssaoBufs = getOrCreateSsaoBuffers(runtime);
  if (ssaoBufs === null) return;

  const companions = ensureSsaoRecordCompanions(_c);
  if (companions === null) return;

  // The blur reads ssaoRaw via binding 7 + ssaoSampler at binding 8. The
  // remaining slots 0..6 are bound for BGL completeness (BGL is shared with
  // the calc pass): WebGPU requires every BGL slot carry a valid resource
  // even when the active fragment entry does not statically reference it.
  // gbuf0 + hdr_depth views are resolved from the graph; they must exist
  // because the typed SSAO graph declares them as reads on the blur node.
  if (gbuf0View === undefined || hdrDepthView === null || hdrDepthPooledView === undefined) return;
  // Identity-cached bind group keyed on the graph-pooled ssaoRaw + gbuf0 +
  // hdrDepth views (all retire + reallocate on resize). Replaces the prior
  // `=== null` slot cache that submitted destroyed transients after resize.
  const ssaoBgl = pp.ssaoBgl;
  const bindGroup = getOrCreateFromChain(
    _c.frameState.postProcessBgCache,
    [ssaoRawView, gbuf0View, hdrDepthPooledView],
    'ssao-blur',
    () => {
      const bgRes = runtime.device.createBindGroup({
        label: 'ssao-blur-bg',
        layout: ssaoBgl,
        entries: ssaoBindGroupEntries(ssaoBufs, companions, gbuf0View, hdrDepthView, ssaoRawView),
      });
      if (!bgRes.ok) throw bgRes.error;
      return bgRes.value;
    },
    _c.bindGroupCounts,
  );

  const pass: RhiRenderPassEncoder =
    graphPass ??
    encoder.beginRenderPass(
      buildBeginRenderPassDescriptor(
        { colorFormats: ['r8unorm'], depthFormat: undefined, sampleCount: 1 },
        { colorViews: [ssaoBlurredView] },
        'post-process',
      ) as never,
    );
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3, 1, 0, 0);
  if (graphPass === undefined) pass.end();
}

export interface FullscreenPassInputs {
  readonly name: string;
  readonly shader: string;
  readonly input: GraphTextureView;
  readonly depth: GraphTextureView | undefined;
  readonly named: ReadonlyMap<string, GraphTextureView>;
  readonly outputFormats: readonly GPUTextureFormat[];
  readonly fragmentEntryPoint: string | undefined;
  readonly msaaDepth: boolean | undefined;
}

export function encodeFullscreenPass(
  ctx: RenderPipelineContext,
  pass: RhiRenderPassEncoder,
  inputs: FullscreenPassInputs,
  resources: GraphResourceResolver,
  paramsOverride?: Uint8Array,
): void {
  const { shader, name } = inputs;
  const inputView = resources.textureView(inputs.input).unwrap();
  const declaredDepth =
    inputs.depth === undefined ? null : resources.textureView(inputs.depth).unwrap();
  if (shader === 'fxaa') {
    recordFxaaPass(
      requireRenderGraphRecordContext(ctx),
      inputView,
      pass,
      paramsOverride,
      inputs.outputFormats[0],
    );
    return;
  }
  const runtime = ctx.runtime;
  const entry = runtime.lookupPostProcess?.(shader);
  if (entry === undefined)
    throw new PostProcessError({ code: 'post-process-not-found', detail: { id: shader } });
  const built = buildFullscreenPostProcessPass(runtime, entry, inputs.msaaDepth ?? ctx.msaaActive);
  if (built === null) return;
  let depthView = declaredDepth;
  if (depthView === null && built.depthKey !== undefined) {
    const frame = requireRenderGraphRecordContext(ctx);
    depthView = resolveDepthOnlyView(
      frame,
      built.depthKey,
      'post-process-scene-depth-only-view',
      frame.geometryDepthKey,
    );
    if (depthView === null)
      throw new PostProcessError({
        code: 'fullscreen-input-not-found',
        detail: { readsKey: built.depthKey, passName: name },
      });
  }

  let paramsBuffer: Buffer | null = null;
  if (entry.params !== undefined) {
    paramsBuffer = runtime.getPostProcessParamsBuffer?.(shader, 'write') ?? null;
    if (paramsBuffer !== null) {
      const data = paramsOverride ?? ctx.postProcessParams.get(shader);
      if (data !== undefined && data.byteLength !== entry.params.byteSize)
        throw new PostProcessError({
          code: 'params-update-size-mismatch',
          detail: { byteSize: entry.params.byteSize, actualLength: data.byteLength },
        });
      const written = runtime.device.queue.writeBuffer(
        paramsBuffer,
        0,
        data ?? entry.params.defaultValue,
      );
      if (!written.ok) return;
    }
  } else if (built.depthKey !== undefined) {
    paramsBuffer = runtime.getPostProcessParamsBuffer?.(shader) ?? null;
  }
  let additional: { binding: number; view: TextureView }[] | undefined;
  for (const { binding, key } of built.extraColorBindings) {
    const target = inputs.named.get(key);
    if (target === undefined)
      throw new PostProcessError({
        code: 'fullscreen-input-not-found',
        detail: { readsKey: key, passName: name },
      });
    additional ??= [];
    additional.push({ binding, view: resources.textureView(target).unwrap() });
  }
  const group = createFullscreenBindGroup(
    runtime.device,
    built.bindGroupLayout,
    built.primaryDepth ? (depthView ?? inputView) : inputView,
    built.sampler,
    paramsBuffer,
    built.primaryDepth ? null : depthView,
    built.depthKey === undefined ? null : built.depthSampler,
    additional,
  );
  if (group === null) return;
  const pipeline = runtime.getPostProcessPipeline?.(
    shader,
    built.bindGroupLayout,
    inputs.outputFormats,
    entry,
    inputs.fragmentEntryPoint,
  );
  if (pipeline == null) return;
  pass.setBindGroup(1, group);
  built.draw(pass, pipeline);
  if (shader === SSR_SCENE_COLOR_HISTORY_PROGRAM.name) {
    const internal = requireRenderGraphRecordContext(ctx);
    const state = getTemporalGpuState(
      internal.frameState,
      runtime.device,
      recordContext(internal.runtime).deviceScope,
      ctx.targetW,
      ctx.targetH,
      false,
      internal.camera,
      'scene-color',
    );
    stageTemporalGpuWrite(internal.frameState, state);
  }
}

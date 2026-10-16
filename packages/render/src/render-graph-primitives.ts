// @forgeax/engine-render - low-level record/encode graph primitives.
//
// Standard owns pass topology through typed-render-graph-primitives. This module
// retains the RHI-facing record helpers used by that typed graph: SSAO record
// closures, fullscreen dispatch, depth resolution, and encoding.
//
// Public graph assembly does not depend on legacy add* wrappers.
import { mat4 } from '@forgeax/engine-math';
import type { ResolveContext } from '@forgeax/engine-render-graph';
import type {
  Buffer,
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
  entryHasDepthRead,
} from './fullscreen-post-process-pass';
import { buildBeginRenderPassDescriptor } from './pipeline-spec';
import { PostProcessError } from './post-process-errors';
import { computeProjectionMatrix, computeViewMatrix } from './record/helpers';
import { getOrCreateFromChain } from './record/mesh-ssbo';
import type { _InternalRenderPipelineContext } from './record/render-context';
import { recordFxaaPass } from './record/skybox-post-pass';
import type { RenderPipelineContext } from './render-contract';
import { getOrCreateSsaoBuffers, getOrCreateSsaoFallbackTexture } from './ssao-buffers';
import { getSsaoParameters, SSAO_SAMPLE_COUNTS } from './ssao-config';

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

/**
 * Pack the 256B SSAO uniform payload from the camera + config.ssao.
 *
 * Layout (plan-strategy D-1 + D-C):
 *   floats [0..15]   view              mat4
 *   floats [16..31]  projection        mat4
 *   floats [32..47]  inverseProjection mat4
 *   floats [48..51]  intensityPad      vec4  (x=intensity, y=radius, z=bias)
 *   floats [52..55]  algorithmPad (x: 0 = SSAO, 1 = GTAO)
 *   floats [56..63]  trailing zero-pad to round to 256B / 64f UBO alignment.
 */
function buildSsaoUniformPayload(internals: _InternalRenderPipelineContext): Float32Array {
  const { camera, frameState } = internals;
  const sProj = computeProjectionMatrix(camera);
  if (camera.temporal?.currentJitterUv !== undefined) {
    const jitter = mat4.identity(mat4.create());
    jitter[12] = camera.temporal.currentJitterUv[0] * 2;
    jitter[13] = camera.temporal.currentJitterUv[1] * -2;
    mat4.multiply(sProj, jitter, sProj);
  }
  const sView = computeViewMatrix(camera);
  const invProj = mat4.create();
  mat4.invert(invProj, sProj);

  const out = new Float32Array(64);
  out.set(sView, 0);
  out.set(sProj, 16);
  out.set(invProj, 32);

  const ssaoConfig = frameState.installedPipelineConfig?.ssao;
  const parameters = getSsaoParameters(
    ssaoConfig !== undefined && ssaoConfig.enabled === true ? ssaoConfig : undefined,
  );
  out[48] = parameters.intensity;
  out[49] = parameters.radius;
  out[50] = parameters.bias;
  out[51] = SSAO_SAMPLE_COUNTS[parameters.quality];
  out[52] = parameters.algorithm === 'gtao' ? 1 : 0;
  return out;
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
  readonly output: TextureView;
  readonly normal: TextureView;
  readonly depth: TextureView;
  readonly depthCacheKey: TextureView;
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
  const pp = pipelineState.perPassResources;

  if (runtime.device.caps.backendKind === 'wgpu-webgl2') {
    throw new RhiError({
      code: 'feature-not-enabled',
      expected: 'SSAO raw depth sampling on a WebGPU-capable backend',
      hint: 'use WebGPU for SSAO or disable StandardProfile.ssao on the GLES fallback',
    });
  }
  if (pp.ssaoCalcPipeline === null || pp.ssaoBgl === null) {
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

  const noiseViewRes = runtime.device.createTextureView(ssaoBufs.noiseTexture, {
    label: 'hdrp-ssao-noise-view',
    format: 'rgba32float',
    dimension: '2d',
    aspect: 'all',
    baseMipLevel: 0,
    mipLevelCount: 1,
    baseArrayLayer: 0,
    arrayLayerCount: 1,
  });
  if (!noiseViewRes.ok) {
    runtime.errorRegistry.fire(noiseViewRes.error);
    return;
  }

  const companions = ensureSsaoRecordCompanions(_c);
  if (companions === null) return;

  // Per-frame uniform write (D-C: view+proj+invProj+intensity at one queue
  // call). 256 B Float32Array (64 f32) lands in ssao_uniform UBO offset 0.
  const payload = buildSsaoUniformPayload(_c);
  const writeRes = runtime.device.queue.writeBuffer(ssaoBufs.uniformBuffer, 0, payload);
  if (!writeRes.ok) {
    runtime.errorRegistry.fire(writeRes.error);
    return;
  }

  // Identity-cached bind group: 9 entries mirror the BGL declared in
  // createRenderer. Keyed on the graph-pooled gbuf0 + hdrDepth views (both
  // retire + reallocate on resize), so the WeakMap misses after a resize and
  // rebuilds against the live textures. The noise / depth-only views bound
  // below are created fresh each frame but back stable textures; keying on the
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
        entries: [
          { binding: 0, resource: { kind: 'buffer', value: { buffer: ssaoBufs.uniformBuffer } } },
          { binding: 1, resource: { kind: 'buffer', value: { buffer: ssaoBufs.kernelBuffer } } },
          { binding: 2, resource: { kind: 'textureView', value: noiseViewRes.value } },
          {
            binding: 3,
            resource: { kind: 'sampler', value: companions.filteringSampler },
          },
          { binding: 4, resource: { kind: 'textureView', value: gbuf0View } },
          { binding: 5, resource: { kind: 'textureView', value: hdrDepthView } },
          { binding: 6, resource: { kind: 'sampler', value: companions.depthSampler } },
          { binding: 7, resource: { kind: 'textureView', value: companions.fallbackRawView } },
          { binding: 8, resource: { kind: 'sampler', value: companions.filteringSampler } },
        ],
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
  pass.setPipeline(pp.ssaoCalcPipeline);
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
  const pp = pipelineState.perPassResources;

  if (pp.ssaoBlurPipeline === null || pp.ssaoBgl === null) {
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

  const noiseViewRes = runtime.device.createTextureView(ssaoBufs.noiseTexture, {
    label: 'hdrp-ssao-noise-view',
    format: 'rgba32float',
    dimension: '2d',
    aspect: 'all',
    baseMipLevel: 0,
    mipLevelCount: 1,
    baseArrayLayer: 0,
    arrayLayerCount: 1,
  });
  if (!noiseViewRes.ok) {
    runtime.errorRegistry.fire(noiseViewRes.error);
    return;
  }

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
        entries: [
          { binding: 0, resource: { kind: 'buffer', value: { buffer: ssaoBufs.uniformBuffer } } },
          { binding: 1, resource: { kind: 'buffer', value: { buffer: ssaoBufs.kernelBuffer } } },
          { binding: 2, resource: { kind: 'textureView', value: noiseViewRes.value } },
          {
            binding: 3,
            resource: { kind: 'sampler', value: companions.filteringSampler },
          },
          { binding: 4, resource: { kind: 'textureView', value: gbuf0View } },
          { binding: 5, resource: { kind: 'textureView', value: hdrDepthView } },
          { binding: 6, resource: { kind: 'sampler', value: companions.depthSampler } },
          { binding: 7, resource: { kind: 'textureView', value: ssaoRawView } },
          { binding: 8, resource: { kind: 'sampler', value: companions.filteringSampler } },
        ],
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
  pass.setPipeline(pp.ssaoBlurPipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3, 1, 0, 0);
  if (graphPass === undefined) pass.end();
}

/**
 * F-3 fix-up + feat-20260609 M1 / T-3 patch: per-frame fullscreen-post-process
 * dispatcher.
 *
 * Two-branch fan-out by shader id:
 * - `'fxaa'` (engine-built-in hardwire): delegate to `recordFxaaPass`. The
 *   FXAA implementation owns its graph input view, surface output attachment,
 *   pipeline cache, and bindgroup-resize invalidation; that mechanics is engine-internal and
 *   not expressible through the generic public primitive. recordFxaaPass's
 *   body is intentionally unchanged across this refactor to preserve the
 *   AC-09 dualPassDiff=1069 (hello-fxaa) / 768 (learn-render-4-10-MSAA)
 *   byte-equivalence with the pre-feat baseline.
 * - every other id (AI-user path): the M1 patch wires `reads[0]` through the
 *   render-graph `resolveCtx` so the bind group samples the upstream
 *   graph-owned color target (e.g. the typed scene pass writes `'offscreenColor'`,
 *   a custom post-process pass declares `reads: ['offscreenColor']`).
 *   Failure modes (charter P3 fail-fast):
 *     - `lookupPostProcess(shader) === undefined` -> throw
 *       `PostProcessError({code:'post-process-not-found'})`
 *     - `reads.length > 0` but `resolveCtx.resolve(reads[0]) === undefined`
 *       -> throw `PostProcessError({code:'fullscreen-input-not-found',
 *       detail:{readsKey, passName}})`. AI users read err.detail.readsKey
 *       to find the missing graph.addColorTarget declaration.
 *   On success the dispatcher builds the input-texture BGL + sampler via
 *   `buildFullscreenPostProcessPass`, composes the per-frame bind group
 *   via `createFullscreenBindGroup`, opens a render pass writing the
 *   declared `color` (resolved through the graph's color-target view, or
 *   the swap-chain `ctx.view` when the graph has not allocated a target),
 *   binds the input bind group at slot 1 (the 0 slot is reserved for
 *   future view bind groups), and calls `handle.draw(pass)` which
 *   internally does `setPipeline(pipeline)` + `draw(3, 1, 0, 0)` over the
 *   fullscreen-triangle vertex shader.
 *
 * Extracted from the addPass execute closure so the topology fan-out is in
 * one named place; the typed graph has a single
 * call site, and future post-process branches (e.g. tonemap migrated onto
 * this dispatcher per OOS-3) extend this function rather than the addPass
 * inline closure.
 */
function dispatchFullscreenPass(
  ctx: RenderPipelineContext,
  name: string,
  shader: string,
  color: string,
  reads: readonly string[],
  resolveCtx?: ResolveContext,
  compositeOverSwapchain = false,
  rawSwapchainOutput = false,
  graphPass?: RhiRenderPassEncoder,
  graphOutputFormats?: readonly GPUTextureFormat[],
  graphDepthView?: TextureView,
  paramsOverride?: Uint8Array,
  fragmentEntryPoint?: string,
  msaaActive = false,
): void {
  if (shader === 'fxaa') {
    if (resolveCtx === undefined) {
      throw new PostProcessError({
        code: 'fullscreen-input-not-found',
        detail: { readsKey: reads[0] ?? 'ldrColor', passName: name },
      });
    }
    recordFxaaPass(
      requireRenderGraphRecordContext(ctx),
      resolveCtx,
      graphPass,
      paramsOverride,
      graphOutputFormats?.[0],
    );
    return;
  }
  const lookup = ctx.runtime.lookupPostProcess;
  const entry = lookup === undefined ? undefined : lookup(shader);
  if (entry === undefined) {
    throw new PostProcessError({
      code: 'post-process-not-found',
      detail: { id: shader },
    });
  }
  // feat-20260621 M4' composite-over-swap-chain: copy the current swap-chain
  // into the `color` scratch target BEFORE sampling, so the effect reads the
  // already-composited final image (shadows + tonemap + fxaa). Generalises the
  // built-in FXAA copy idiom. The `color` key is BOTH the copy dst and the
  // sampled input (resolve its GPU texture via `${color}::tex` for the copy,
  // its TextureView via `${color}` for the bind group).
  let inputView: TextureView | null;
  if (compositeOverSwapchain) {
    const scratchTex = resolveCtx?.resolve(`${color}::tex`);
    const scratchView = resolveCtx?.resolve(color);
    if (scratchTex === undefined || scratchView === undefined) {
      throw new PostProcessError({
        code: 'fullscreen-input-not-found',
        detail: { readsKey: color, passName: name },
      });
    }
    ctx.encoder.copyTextureToTexture(
      { texture: ctx.currentTexture as never, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
      { texture: scratchTex as never, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
      { width: ctx.targetW, height: ctx.targetH, depthOrArrayLayers: 1 },
    );
    inputView = scratchView as TextureView;
  } else if (reads.length === 0) {
    // reads === [] preserves the legacy swap-chain sample path (used by
    // tonemap-style passes that read the framebuffer directly).
    inputView = ctx.view;
  } else {
    // reads with a key MUST resolve through the graph compile output, otherwise
    // the dispatcher throws fullscreen-input-not-found (charter P3 fail-fast).
    const readsKey = reads[0] as string;
    const resolved = resolveCtx?.resolve(readsKey);
    if (resolved === undefined) {
      throw new PostProcessError({
        code: 'fullscreen-input-not-found',
        detail: { readsKey, passName: name },
      });
    }
    inputView = resolved as TextureView;
  }
  if (inputView === null) return;

  // ── BGL/Pipeline build (before depth resolution so built.depthSampler is
  //    available for the depth threading block below; ctx.msaaActive selects
  //    the multisampled depth BGL when the scene target uses sample=4) ───────
  const built = buildFullscreenPostProcessPass(
    { device: ctx.runtime.device, errorRegistry: ctx.runtime.errorRegistry },
    entry,
    msaaActive,
  );
  if (built === null) return;

  // ── plan-strategy D-6: depth read resolution (pipeline-agnostic, AC-02) ────
  // Iterate entry.reads looking for sampleType:'depth' entries. For each depth
  // entry, resolve a depth-only TextureView from the graph via
  // resolveDepthOnlyView, fail-fast on unresolvable keys. The depth sampler
  // is produced by buildFullscreenPostProcessPass (via createDepthSampler,
  // plan-strategy D-2: non-filtering nearest+clamp-to-edge).
  //
  // Both composite and non-composite branches handle depth symmetrically —
  // the depth resolution block is branch-agnostic (AC-02: no URP/HDRP
  // discrimination). Color input logic is unchanged (AC-03 zero-regression).
  let depthTexView: TextureView | null = graphDepthView ?? null;
  let depthSampler: Sampler | null = null;
  if (entry.reads && entry.reads.length > 0) {
    const internals = requireRenderGraphRecordContext(ctx);
    for (const read of entry.reads) {
      if (typeof read !== 'string' && read.sampleType === 'depth') {
        const depthKey = read.key;
        depthTexView ??= resolveDepthOnlyView(
          internals,
          depthKey,
          'post-process-scene-depth-only-view',
          internals.geometryDepthKey,
        );
        if (depthTexView === null) {
          throw new PostProcessError({
            code: 'fullscreen-input-not-found',
            detail: { readsKey: depthKey, passName: name },
          });
        }
        depthSampler = built.depthSampler;
      }
    }
  }

  // feat-20260621 M4' composite-over-swap-chain write target: the swap-chain's
  // NON-srgb storage view (R-COLORSPACE — the scratch holds an already-sRGB-
  // encoded copy, so writing through the srgb view would double-encode; mirrors
  // recordFxaaPass). Otherwise resolve the declared color through the graph and
  // fall back to ctx.view (swap-chain srgb view) for normal post passes.
  let writeView: TextureView | null | undefined;
  // The attachment format follows the actual write target. Graph-owned
  // targets may be linear HDR/LDR textures (for example rgba16float), while
  // the swap-chain path uses the backend-selected surface view format.
  let writeFormat = ctx.pipelineState?.colorAttachmentFormat ?? 'rgba8unorm-srgb';
  if (graphPass !== undefined) {
    // Typed graph passes must write their declared output target. The frame
    // surface view is only the fallback for legacy passes; using it here
    // leaves a typed output target cleared while the next pass samples it.
    writeView = (resolveCtx?.resolve(color) as TextureView | undefined) ?? ctx.view;
    writeFormat = graphOutputFormats?.[0] ?? writeFormat;
  } else if (rawSwapchainOutput && color === 'swapchain') {
    const rawViewRes = ctx.runtime.device.createTextureView(ctx.currentTexture, {});
    if (!rawViewRes.ok) {
      ctx.runtime.errorRegistry.fire(rawViewRes.error);
      return;
    }
    writeView = rawViewRes.value;
    writeFormat = ctx.pipelineState?.format ?? 'rgba8unorm';
  } else if (compositeOverSwapchain) {
    const storageViewRes = ctx.runtime.device.createTextureView(ctx.currentTexture, {});
    if (!storageViewRes.ok) {
      ctx.runtime.errorRegistry.fire(storageViewRes.error);
      return;
    }
    writeView = storageViewRes.value;
    writeFormat = ctx.pipelineState?.format ?? 'rgba8unorm';
  } else {
    const legacyGraph = requireRenderGraphRecordContext(ctx).frameState.compiledFrameGraph?.targets;
    const graphColorFormat = legacyGraph?.getColorTargetDescriptor(color)?.format;
    if (graphColorFormat !== undefined) writeFormat = graphColorFormat;
    const resolvedColor = (resolveCtx?.resolve(color) as TextureView | undefined) ?? null;
    writeView = legacyGraph?.getColorTargetView(color) ?? resolvedColor ?? ctx.view;
  }
  if (writeView === null || writeView === undefined) return;

  // feat-20260621 M-A2 / w8: per-frame data-driven params channel. When the
  // entry declares params, look up the per-id eager-created UBO + the per-frame
  // bytes from the PostProcessParams snapshot, fail-fast on a byteLength
  // mismatch, then writeBuffer + bind the UBO at group(1) binding(2). When
  // entry.params is undefined this whole block is skipped and the BGL degrades
  // to 2-entry (param-less zero-regression, R-A7).
  let paramsBuffer: Buffer | null = null;
  if (entry.params !== undefined) {
    const ubo = ctx.runtime.getPostProcessParamsBuffer?.(shader);
    if (ubo !== undefined) {
      // Typed graph passes may make a narrow, per-pass copy of the payload
      // (for example enabling final-surface dither without changing the
      // camera-owned SSOT).  Use it when present, while preserving the normal
      // frame snapshot for legacy callers.
      const data = paramsOverride ?? ctx.postProcessParams.get(shader);
      if (data !== undefined) {
        if (data.byteLength !== entry.params.byteSize) {
          throw new PostProcessError({
            code: 'params-update-size-mismatch',
            detail: { byteSize: entry.params.byteSize, actualLength: data.byteLength },
          });
        }
        const writeResult = ctx.runtime.device.queue.writeBuffer(ubo, 0, data);
        if (!writeResult.ok) return;
      } else {
        const writeResult = ctx.runtime.device.queue.writeBuffer(ubo, 0, entry.params.defaultValue);
        if (!writeResult.ok) return;
      }
      paramsBuffer = ubo;
    }
  } else if (entryHasDepthRead(entry)) {
    // D-3: a param-less depth entry still binds the minimal UBO auto-allocated
    // at register (the 'fullscreen-post-with-scene-depth' BGL always declares
    // params@2). No per-frame write -- the buffer stays zero-filled.
    paramsBuffer = ctx.runtime.getPostProcessParamsBuffer?.(shader) ?? null;
  }

  const bindGroup = createFullscreenBindGroup(
    ctx.runtime.device,
    built.bindGroupLayout,
    inputView,
    built.sampler,
    paramsBuffer,
    depthTexView,
    depthSampler,
    built.extraColorBindings.map((binding, index) => {
      const read = entry.reads?.filter(
        (candidate) => typeof candidate === 'string' || candidate.sampleType !== 'depth',
      )[index + 1];
      const key = typeof read === 'string' ? read : read?.key;
      const view = key === undefined ? undefined : resolveCtx?.resolve(key);
      if (view === undefined) {
        throw new PostProcessError({
          code: 'fullscreen-input-not-found',
          detail: { readsKey: key ?? 'additional-read', passName: name },
        });
      }
      return { binding, view: view as TextureView };
    }),
  );
  if (bindGroup === null) return;

  // Pipeline source-of-truth (M4 / T-10-a, solving M1 CONCERN-1):
  // RenderSystemRuntime.getPostProcessPipeline is the sync wrapper over the
  // shared shader-module adapter (1-frame warmup). First frame after
  // fullscreen effect registration: shader compile is in flight -> returns null -> we
  // skip the pass for that frame. Second frame onward: cached pipeline is
  // returned synchronously.
  //
  // Color format SSOT: graph-owned writes use their resolved descriptor format;
  // swap-chain writes use the backend-aware surface format in pipelineState.
  // This keeps the PSO target and render-pass attachment identical when a
  // fullscreen pass writes an intermediate rgba16float target (for example
  // tonemap -> FXAA), while preserving the native surface storage/sRGB split.
  const lookupPipeline = ctx.runtime.getPostProcessPipeline;
  if (lookupPipeline === undefined) return;
  const postColorFormat = writeFormat;
  const pipelineEntry = fragmentEntryPoint === undefined ? entry : { ...entry, fragmentEntryPoint };
  const pipeline = lookupPipeline(
    shader,
    built.bindGroupLayout,
    graphOutputFormats ?? [postColorFormat],
    pipelineEntry,
  );
  if (pipeline === null) return;
  const handle = built.createHandle(name, pipeline, paramsBuffer);

  // Open a render pass writing into the resolved color target. Fullscreen
  // post-process passes are non-MSAA and depth-less; the typed graph owns MRT attachments.
  // setBindGroup(1, ...) (group=1 reserved per plan-strategy convention;
  // group=0 is reserved for future view bind groups, mirroring the
  // recordTonemap / recordSkybox pattern that uses slot 0 only when the
  // pipeline declares a single bind group at slot 0).
  const pass =
    graphPass ??
    ctx.encoder.beginRenderPass(
      buildBeginRenderPassDescriptor(
        {
          colorFormats: [writeFormat],
          depthFormat: undefined,
          sampleCount: 1,
        },
        { colorViews: [writeView] },
        'post-process',
      ) as never,
    );
  pass.setBindGroup(1, bindGroup);
  handle.draw(pass, inputView);
  if (graphPass === undefined) pass.end();
}

export function encodeFullscreenPass(
  ctx: RenderPipelineContext,
  pass: RhiRenderPassEncoder,
  input: {
    readonly name: string;
    readonly shader: string;
    readonly color: string;
    readonly reads: readonly string[];
    readonly resolve: ResolveContext;
    readonly outputFormats: readonly GPUTextureFormat[];
    readonly rawSwapchainOutput?: boolean | undefined;
    readonly depthView?: TextureView | undefined;
    readonly paramsOverride?: Uint8Array | undefined;
    readonly fragmentEntryPoint?: string | undefined;
    /** The depth target's actual sample count, when this typed pass reads depth. */
    readonly msaaActive?: boolean | undefined;
  },
): void {
  dispatchFullscreenPass(
    ctx,
    input.name,
    input.shader,
    input.color,
    input.reads,
    input.resolve,
    false,
    input.rawSwapchainOutput ?? false,
    pass,
    input.outputFormats,
    input.depthView,
    input.paramsOverride,
    input.fragmentEntryPoint,
    // Legacy callers rely on the frame context's MSAA state. Typed callers
    // pass the actual depth target sample count explicitly so a single-sample
    // view can never select the multisampled shader by camera policy alone.
    input.msaaActive ?? ctx.msaaActive,
  );
}

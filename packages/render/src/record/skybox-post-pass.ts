import type { ResolveContext } from '@forgeax/engine-render-graph';
import { RhiError, type RhiRenderPassEncoder, type TextureView } from '@forgeax/engine-rhi';
import { toShared } from '@forgeax/engine-types';
import { BLOOM_UNIFORM_PARAMS_STRIDE_BYTES } from '../assembly/webgpu-ready-contract';
import { standardBloomAdmitted } from '../bloom-admission';
import { buildBeginRenderPassDescriptor } from '../pipeline-spec';
import { FXAA_POST_PROCESS_ID } from '../render-contract';
import { resolveOutputDither } from '../render-pipeline';
import type { BloomFrameReceipts } from './frame-snapshot';
import { getOrCreateFromChain } from './mesh-ssbo';
import type { _InternalRenderPipelineContext } from './render-context';
import { VIEW_UNIFORM_BYTES } from './view-ubo';

/**
 * feat-20260531-skybox-env-background M2 / w8: skybox pass recording stub.
 * Renders a fullscreen triangle that samples a cubemap using the camera's
 * inverseViewProj from the View UBO and writes the result to the hdrColor
 * render target. The pass runs after shadow and before main (D-1 topology).
 *
 * This stub early-returns when skyboxActive is false -- the actual execute
 * body is implemented in M3 / w16 (recordSkyboxPass execute). The render-
 * graph still declares the pass so the compile() step validates the
 * dependency edges (shadow -> skybox -> main) even before the execute
 * body is filled in.
 */
export function recordSkyboxPass(
  c: _InternalRenderPipelineContext,
  graphPass?: RhiRenderPassEncoder,
): void {
  // Early-return when skybox is not active (no SkyboxBackground entity,
  // or tonemap is disabled -- plan-strategy D-2 NOTE). The graph still
  // compiles because the pass declaration is unconditional; only the
  // execute body is gated on skyboxActive.
  if (!c.skyboxActive) return;
  const skyboxSnapshot = c.skybox;
  if (skyboxSnapshot === undefined) return;

  const { runtime, store, encoder, pipelineState } = c;

  // Guard: hdrColorView must be allocated (tonemapActive implies it)
  const hdrColorView = pipelineState.perPassResources.hdrColorView;
  if (graphPass === undefined && hdrColorView === null) return;

  // feat-20260604 M2 / w10: under MSAA the skybox + main passes share the
  // count=4 multisample target (hdrColorMsaa); only the main pass (last to
  // write) resolves to the single-sample hdrColor (D-8 -- avoids a wasteful
  // mid-chain resolve). The skybox pass writes the multisample target with no
  // resolveTarget and uses the count=4 skybox pipeline variant.
  const skyboxColorView =
    graphPass === undefined
      ? c.msaaActive
        ? pipelineState.perPassResources.hdrColorMsaaView
        : hdrColorView
      : null;
  if (graphPass === undefined && skyboxColorView === null) return;

  // Guard: pipeline resources must exist (null when manifest has no
  // skybox entry -- legacy manifests continue to boot)
  const skyboxPipeline = c.msaaActive
    ? pipelineState.perPassResources.skyboxPipelineMsaa
    : pipelineState.perPassResources.skyboxPipeline;
  const skyboxBgl = pipelineState.perPassResources.skyboxBindGroupLayout;
  const skyboxSampler = pipelineState.perPassResources.skyboxSampler;
  const skyboxRotationBuffer = pipelineState.perPassResources.skyboxRotationBuffer;
  if (
    skyboxPipeline === null ||
    skyboxBgl === null ||
    skyboxSampler === null ||
    skyboxRotationBuffer === null
  )
    return;

  const rotation = skyboxSnapshot.rotation;
  const rotationUpload = runtime.device.queue.writeBuffer(
    skyboxRotationBuffer,
    0,
    new Float32Array([rotation[0], rotation[1], rotation[2], rotation[3]]),
  );
  if (!rotationUpload.ok) throw rotationUpload.error;

  // Resolve cubemap GPU view from AssetRegistry. Returns undefined if
  // the cubemap has not been uploaded yet (async equirect upload in
  // progress). In that case, degradation to main pass loadOp:'clear'
  // is handled by the passCtx.skyboxActive gate above -- if the
  // cubemap isn't ready, skyboxActive is already false (see w18).
  const cubemapView = store.getCubemapGpuView(
    toShared<'EquirectAsset'>(skyboxSnapshot.equirectHandle),
  );
  if (cubemapView === undefined) return;

  // Identity-cached skybox BindGroup keyed on the cubemap GpuView. The only
  // varying binding is the cubemap view (sampler + View UBO are stable); it is
  // recreated on each internal equirect-to-cubemap projection (which may happen
  // mid-app asynchronously), so keying on its identity rebuilds exactly when the
  // cubemap changes. This supersedes the prior `hdrTextureWidth`/`Height`
  // size-guard, which tracked the wrong resource (the skybox BindGroup never
  // binds hdrColor -- it writes the color attachment) and missed cubemap
  // re-projections that reused the old cached bind group.
  const skyboxBg = getOrCreateFromChain(
    c.frameState.postProcessBgCache,
    [cubemapView],
    'skybox',
    () => {
      const skyboxBgRes = runtime.device.createBindGroup({
        label: 'skybox-bg',
        layout: skyboxBgl,
        entries: [
          {
            binding: 0,
            resource: { kind: 'textureView', value: cubemapView },
          },
          {
            binding: 1,
            resource: { kind: 'sampler', value: skyboxSampler },
          },
          {
            binding: 2,
            resource: {
              kind: 'buffer',
              value: { buffer: pipelineState.viewUniformBuffer, size: VIEW_UNIFORM_BYTES },
            },
          },
          {
            binding: 3,
            resource: {
              kind: 'buffer',
              value: { buffer: skyboxRotationBuffer },
            },
          },
        ],
      });
      if (!skyboxBgRes.ok) throw skyboxBgRes.error;
      return skyboxBgRes.value;
    },
    c.bindGroupCounts,
  );

  // Skybox pass: clear hdrColor (first pass writing to it),
  // draw fullscreen triangle, write cubemap colour.
  // No depth/stencil -- skybox is the far plane; main pass depth test rejects
  // occluded skybox pixels (plan-strategy D-1). HDR target ('rgba16float') is
  // declared on specAttachments for descriptor parity, even though color-only
  // policies do not gate on format.
  const skyboxPass =
    graphPass ??
    encoder.beginRenderPass(
      buildBeginRenderPassDescriptor(
        { colorFormats: ['rgba16float'], depthFormat: undefined, sampleCount: 1 },
        { colorViews: [skyboxColorView as TextureView] },
        'skybox',
      ) as never,
    );

  skyboxPass.setPipeline(skyboxPipeline);
  skyboxPass.setBindGroup(0, skyboxBg);
  skyboxPass.draw(3);
  if (graphPass === undefined) skyboxPass.end();
}

export function encodeSkyboxPass(
  c: _InternalRenderPipelineContext,
  pass: RhiRenderPassEncoder,
): void {
  recordSkyboxPass(c, pass);
}

// Bloom records its admitted downsample/upsample passes on the shared encoder.
// Disabled Bloom or zero intensity performs no uploads, bindings or encoding.

const EMPTY_BLOOM_RECEIPTS: BloomFrameReceipts = {
  uploadCount: 0,
  bindGroupCount: 0,
  encodeCount: 0,
};

function updateBloomReceipts(
  c: _InternalRenderPipelineContext,
  field: keyof BloomFrameReceipts,
): void {
  const current = c.frameState.bloomFrameReceipts ?? EMPTY_BLOOM_RECEIPTS;
  c.frameState.bloomFrameReceipts = {
    ...current,
    [field]: current[field] + 1,
  };
}

function stageBloomUpload(c: _InternalRenderPipelineContext): void {
  updateBloomReceipts(c, 'uploadCount');
}

function stageBloomBindGroup(c: _InternalRenderPipelineContext): void {
  updateBloomReceipts(c, 'bindGroupCount');
}

function stageBloomEncode(c: _InternalRenderPipelineContext): void {
  updateBloomReceipts(c, 'encodeCount');
}

function throwBloomRecordFailure(expected: string): never {
  throw new RhiError({
    code: 'webgpu-runtime-error',
    expected,
    hint: 'repair the Bloom candidate resources before retrying the frame',
  });
}

function bloomRecordActive(c: _InternalRenderPipelineContext): boolean {
  return standardBloomAdmitted(c.camera) && c.tonemapActive;
}

export function recordBloomDownsamplePass(
  _c: _InternalRenderPipelineContext,
  resolve?: ResolveContext,
  graphPass?: RhiRenderPassEncoder,
  level = 0,
  destinationSize?: { readonly width: number; readonly height: number },
): void {
  const { runtime, encoder, camera, frameState, bindGroupCounts } = _c;
  const pp = _c.bloomResources;
  if (!bloomRecordActive(_c)) return;
  if (
    pp === undefined ||
    pp === null ||
    pp.bloomDownsamplePipeline === null ||
    pp.bloomDownsampleBindGroupLayout === null ||
    pp.bloomSampler === null ||
    pp.bloomDownsampleParamsBuffer === null
  ) {
    throwBloomRecordFailure('Bloom downsample resources are ready before encoding');
  }
  const downsamplePipeline = pp.bloomDownsamplePipeline;
  const downsampleLayout = pp.bloomDownsampleBindGroupLayout;
  const bloomSampler = pp.bloomSampler;
  const downsampleParamsBuffer = pp.bloomDownsampleParamsBuffer;
  const sourceName = level === 0 ? 'hdrColor' : `bloomDownsample${level - 1}`;
  const targetName = `bloomDownsample${level}`;
  const sourceView = resolve?.resolve(sourceName) as TextureView | undefined;
  const targetView = resolve?.resolve(targetName) as TextureView | undefined;
  if (sourceView === undefined || targetView === undefined) {
    throwBloomRecordFailure(`Bloom downsample level ${level} resolves source and target views`);
  }
  const size = destinationSize ?? {
    width: Math.max(1, Math.ceil(_c.targetW / 2)),
    height: Math.max(1, Math.ceil(_c.targetH / 2)),
  };
  const params = new Float32Array([
    camera.bloomThreshold,
    camera.bloomSoftKnee,
    size.width,
    size.height,
    level,
    0,
    0,
    0,
  ]);
  const offset = level * BLOOM_UNIFORM_PARAMS_STRIDE_BYTES;
  const upload = runtime.device.queue.writeBuffer(pp.bloomDownsampleParamsBuffer, offset, params);
  if (!upload.ok) throw upload.error;
  stageBloomUpload(_c);
  const bindGroup = getOrCreateFromChain(
    frameState.postProcessBgCache,
    [sourceView, downsampleParamsBuffer],
    `bloom-downsample-${level}`,
    () => {
      const created = runtime.device.createBindGroup({
        label: `bloom-downsample-${level}-bg`,
        layout: downsampleLayout,
        entries: [
          { binding: 0, resource: { kind: 'textureView', value: sourceView } },
          { binding: 1, resource: { kind: 'sampler', value: bloomSampler } },
          {
            binding: 2,
            resource: {
              kind: 'buffer',
              value: { buffer: downsampleParamsBuffer, offset, size: 32 },
            },
          },
        ],
      });
      if (!created.ok) throw created.error;
      return created.value;
    },
    bindGroupCounts,
  );
  const pass =
    graphPass ??
    encoder.beginRenderPass(
      buildBeginRenderPassDescriptor(
        { colorFormats: ['rgba16float'], depthFormat: undefined, sampleCount: 1 },
        { colorViews: [targetView] },
        'bloom-downsample',
      ) as never,
    );
  pass.setPipeline(downsamplePipeline);
  pass.setBindGroup(0, bindGroup);
  stageBloomBindGroup(_c);
  pass.draw(3, 1, 0, 0);
  stageBloomEncode(_c);
  if (graphPass === undefined) pass.end();
}

export function recordBloomUpsamplePass(
  _c: _InternalRenderPipelineContext,
  resolve?: ResolveContext,
  graphPass?: RhiRenderPassEncoder,
  level = 0,
): void {
  const { runtime, encoder, frameState, bindGroupCounts } = _c;
  const pp = _c.bloomResources;
  if (!bloomRecordActive(_c)) return;
  if (
    pp === undefined ||
    pp === null ||
    pp.bloomUpsamplePipeline === null ||
    pp.bloomUpsampleBindGroupLayout === null ||
    pp.bloomSampler === null ||
    pp.bloomUpsampleParamsBuffer === null
  ) {
    throwBloomRecordFailure('Bloom upsample resources are ready before encoding');
  }
  const upsamplePipeline = pp.bloomUpsamplePipeline;
  const upsampleLayout = pp.bloomUpsampleBindGroupLayout;
  const bloomSampler = pp.bloomSampler;
  const upsampleParamsBuffer = pp.bloomUpsampleParamsBuffer;
  const currentView = resolve?.resolve(`bloomDownsample${level}`) as TextureView | undefined;
  // The top upsample edge reconstructs from the next downsample level. Every
  // finer edge then consumes the already reconstructed coarser upsample. A
  // resolver miss is the single source of truth for the one-level pyramid
  // boundary; no alternate level-count or legacy H/V path is needed.
  const nextUpsampleView = resolve?.resolve(`bloomUpsample${level + 1}`) as TextureView | undefined;
  const coarseView =
    nextUpsampleView ??
    (resolve?.resolve(`bloomDownsample${level + 1}`) as TextureView | undefined);
  const targetView = resolve?.resolve(`bloomUpsample${level}`) as TextureView | undefined;
  if (currentView === undefined || coarseView === undefined || targetView === undefined) {
    throwBloomRecordFailure(`Bloom upsample level ${level} resolves adjacent pyramid views`);
  }
  const params = new Float32Array([_c.camera.bloomScatter, 0, 0, 0]);
  const offset = level * BLOOM_UNIFORM_PARAMS_STRIDE_BYTES;
  const upload = runtime.device.queue.writeBuffer(pp.bloomUpsampleParamsBuffer, offset, params);
  if (!upload.ok) throw upload.error;
  stageBloomUpload(_c);
  const bindGroup = getOrCreateFromChain(
    frameState.postProcessBgCache,
    [currentView, coarseView, upsampleParamsBuffer],
    `bloom-upsample-${level}`,
    () => {
      const created = runtime.device.createBindGroup({
        label: `bloom-upsample-${level}-bg`,
        layout: upsampleLayout,
        entries: [
          { binding: 0, resource: { kind: 'textureView', value: currentView } },
          { binding: 1, resource: { kind: 'textureView', value: coarseView } },
          { binding: 2, resource: { kind: 'sampler', value: bloomSampler } },
          {
            binding: 3,
            resource: { kind: 'buffer', value: { buffer: upsampleParamsBuffer, offset, size: 16 } },
          },
        ],
      });
      if (!created.ok) throw created.error;
      return created.value;
    },
    bindGroupCounts,
  );
  const pass =
    graphPass ??
    encoder.beginRenderPass(
      buildBeginRenderPassDescriptor(
        { colorFormats: ['rgba16float'], depthFormat: undefined, sampleCount: 1 },
        { colorViews: [targetView] },
        'bloom-upsample',
      ) as never,
    );
  pass.setPipeline(upsamplePipeline);
  pass.setBindGroup(0, bindGroup);
  stageBloomBindGroup(_c);
  pass.draw(3, 1, 0, 0);
  stageBloomEncode(_c);
  if (graphPass === undefined) pass.end();
}

export function recordBloomCompositePass(
  _c: _InternalRenderPipelineContext,
  resolve?: ResolveContext,
  graphPass?: RhiRenderPassEncoder,
): void {
  const { runtime, encoder, camera, frameState, bindGroupCounts } = _c;
  const pp = _c.bloomResources;

  if (!bloomRecordActive(_c)) return;
  if (pp === null || pp === undefined) {
    throwBloomRecordFailure('Bloom persistent resources are ready before composite encoding');
  }
  if (
    pp.bloomCompositePipeline === null ||
    pp.bloomCompositeBindGroupLayout === null ||
    pp.bloomSampler === null ||
    pp.bloomCompositeParamsBuffer === null
  ) {
    throwBloomRecordFailure(
      'Bloom composite pass has pipeline, layout, sampler, and params buffer',
    );
  }

  // hdrColor + reconstructed Bloom textures are owned by render-graph.
  // bug-20260625: composite READS hdrColor (scene, binding 0) and WRITES the
  // separate hdrComposited target -- never the same texture in one pass.
  const hdrColorView = resolve?.resolve('hdrColor') as TextureView | undefined;
  const bloomView = resolve?.resolve('bloomUpsample0') as TextureView | undefined;
  const finestBloomView =
    bloomView ?? (resolve?.resolve('bloomDownsample0') as TextureView | undefined);
  const hdrCompositedView = resolve?.resolve('hdrComposited') as TextureView | undefined;
  if (!hdrColorView || !finestBloomView || !hdrCompositedView) {
    throwBloomRecordFailure('Bloom composite pass resolves scene, finest Bloom, and target views');
  }
  const bglComposite = pp.bloomCompositeBindGroupLayout;
  const bloomSampler = pp.bloomSampler;
  const paramsBuffer = pp.bloomCompositeParamsBuffer;

  // 1. Write composite params UBO (16 B std140: intensity + 12 B pad).
  const compositeParams = new Float32Array(4);
  compositeParams[0] = camera.bloomIntensity;
  compositeParams[1] = 0;
  compositeParams[2] = 0;
  compositeParams[3] = 0;
  const paramsWrite = runtime.device.queue.writeBuffer(paramsBuffer, 0, compositeParams);
  if (!paramsWrite.ok) throw paramsWrite.error;
  stageBloomUpload(_c);

  // 2. Identity-cached BindGroup (2 tex: hdrColor + finest Bloom, 1 sampler,
  // 1 UBO). Keys on both sampled views: resize retires both hdrColor and
  // finest Bloom view, so a two-node chain rebuilds when either identity changes.
  const bindGroup = getOrCreateFromChain(
    frameState.postProcessBgCache,
    [hdrColorView, finestBloomView],
    'bloom-composite',
    () => {
      const bgRes = runtime.device.createBindGroup({
        label: 'bloom-composite-bg',
        layout: bglComposite,
        entries: [
          { binding: 0, resource: { kind: 'textureView', value: hdrColorView } },
          { binding: 1, resource: { kind: 'textureView', value: finestBloomView } },
          { binding: 2, resource: { kind: 'sampler', value: bloomSampler } },
          {
            binding: 3,
            resource: { kind: 'buffer', value: { buffer: paramsBuffer } },
          },
        ],
      });
      if (!bgRes.ok) throw bgRes.error;
      return bgRes.value;
    },
    bindGroupCounts,
  );

  // 3. Render pass: write the separate hdrComposited target (bug-20260625).
  // The fragment shader outputs the COMPLETE composited colour
  // (scene + intensity*bloom, sampling scene from hdrColor itself), so the
  // destination needs no prior content -> loadOp='clear' (no stale dependency
  // on hdrComposited's previous-frame content, and no in-place hazard).
  const pass: RhiRenderPassEncoder =
    graphPass ??
    encoder.beginRenderPass(
      buildBeginRenderPassDescriptor(
        { colorFormats: ['rgba16float'], depthFormat: undefined, sampleCount: 1 },
        { colorViews: [hdrCompositedView] },
        'bloom-composite',
        { colorLoadOp: 'clear' },
      ) as never,
    );
  pass.setPipeline(pp.bloomCompositePipeline);
  pass.setBindGroup(0, bindGroup);
  stageBloomBindGroup(_c);
  pass.draw(3, 1, 0, 0);
  stageBloomEncode(_c);
  if (graphPass === undefined) pass.end();
}

export function recordFxaaPass(
  c: _InternalRenderPipelineContext,
  resolve: ResolveContext,
  graphPass?: RhiRenderPassEncoder,
  paramsOverride?: Uint8Array,
  graphOutputFormat?: GPUTextureFormat,
): void {
  const { runtime, pipelineState, encoder, camera, currentTexture } = c;
  // FXAA samples the graph-owned LDR target and writes the current surface.
  // The surface is an output attachment only: no COPY_SRC usage, no
  // copyTextureToTexture, and no backend-specific surface sampling path.
  const fxaaActive = camera.antialias === 'fxaa';
  if (
    fxaaActive &&
    pipelineState.perPassResources.fxaaPipeline !== null &&
    pipelineState.perPassResources.fxaaBindGroupLayout !== null &&
    pipelineState.perPassResources.fxaaSampler !== null &&
    runtime.getPostProcessParamsBuffer !== undefined
  ) {
    // Typed graph calls provide explicit input/output keys. The legacy
    // ldrColor fallback is retained only for the direct surface owner.
    const inputView = (resolve.resolve('input') ?? resolve.resolve('ldrColor')) as
      | TextureView
      | undefined;
    if (inputView === undefined) return;

    const fxaaParams = runtime.getPostProcessParamsBuffer(FXAA_POST_PROCESS_ID);
    if (fxaaParams === undefined) return;
    const params = paramsOverride?.byteLength === 16 ? paramsOverride : new Float32Array(4);
    if (paramsOverride === undefined) {
      // Direct legacy FXAA remains the configured final surface writer. The
      // Standard LUT path supplies an explicit zero-valued override through
      // the graph dispatcher, so no graph shape or output-key inference is
      // used to select dither policy.
      params[0] = resolveOutputDither(c.frameState.installedPipelineConfig) ? 1 : 0;
    }
    const paramsWrite = runtime.device.queue.writeBuffer(fxaaParams, 0, params);
    if (!paramsWrite.ok) throw paramsWrite.error;

    // Compose the 3-entry FXAA BindGroup (input texture + sampler + params).
    // graph view identity changes when the graph reallocates on resize, so
    // the identity-keyed cache rebuilds against the live target. The params
    // buffer is also a key so a device recovery cannot retain a bind group
    // pointing at the retired resource.
    const fxaaBglLayout = pipelineState.perPassResources.fxaaBindGroupLayout;
    const fxaaSampler = pipelineState.perPassResources.fxaaSampler;
    const fxaaBg = getOrCreateFromChain(
      c.frameState.postProcessBgCache,
      [inputView, fxaaParams],
      'fxaa',
      () => {
        const fxaaBgRes = runtime.device.createBindGroup({
          label: 'fxaa-bg',
          layout: fxaaBglLayout,
          entries: [
            {
              binding: 0,
              resource: {
                kind: 'textureView',
                value: inputView,
              },
            },
            {
              binding: 1,
              resource: { kind: 'sampler', value: fxaaSampler },
            },
            {
              binding: 2,
              resource: { kind: 'buffer', value: { buffer: fxaaParams } },
            },
          ],
        });
        if (!fxaaBgRes.ok) throw fxaaBgRes.error;
        return fxaaBgRes.value;
      },
      c.bindGroupCounts,
    );

    // Typed graph passes own their attachment format.  In particular, the
    // barrel/LUT split keeps FXAA in the graph-owned rgba16float domain before
    // the final output encoding; falling back to the swapchain format here
    // builds a BGRA pipeline against an RGBA16F attachment and invalidates the
    // command buffer on WebGPU.
    const fxaaColorFormat =
      graphPass !== undefined && graphOutputFormat !== undefined
        ? graphOutputFormat
        : runtime.device.caps.storageBuffer
          ? pipelineState.format
          : pipelineState.colorAttachmentFormat;
    let fxaaPass = graphPass;
    if (fxaaPass === undefined) {
      const fxaaOutputView = runtime.device.createTextureView(currentTexture, {
        format: fxaaColorFormat as GPUTextureFormat,
      });
      if (!fxaaOutputView.ok) {
        runtime.errorRegistry.fire(fxaaOutputView.error);
        return;
      }
      fxaaPass = encoder.beginRenderPass(
        buildBeginRenderPassDescriptor(
          {
            colorFormats: [fxaaColorFormat as GPUTextureFormat],
            depthFormat: undefined,
            sampleCount: 1,
          },
          { colorViews: [fxaaOutputView.value] },
          'fxaa',
        ) as never,
      );
    }
    let fxaaPipeline = pipelineState.perPassResources.fxaaPipeline;
    if (graphPass !== undefined && graphOutputFormat !== undefined) {
      const entry = runtime.lookupPostProcess?.(FXAA_POST_PROCESS_ID);
      const rebuilt =
        entry === undefined || runtime.getPostProcessPipeline === undefined
          ? null
          : runtime.getPostProcessPipeline(
              FXAA_POST_PROCESS_ID,
              fxaaBglLayout,
              [graphOutputFormat],
              entry,
            );
      if (rebuilt !== null) fxaaPipeline = rebuilt;
    }
    if (fxaaPipeline === null) return;
    fxaaPass.setPipeline(fxaaPipeline);
    fxaaPass.setBindGroup(0, fxaaBg);
    fxaaPass.draw(3, 1, 0, 0);
    if (graphPass === undefined) fxaaPass.end();
  }
}

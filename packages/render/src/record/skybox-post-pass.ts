import type { ResolveContext } from '@forgeax/engine-render-graph';
import type { RhiRenderPassEncoder, TextureView } from '@forgeax/engine-rhi';
import type { AssetHandle } from '@forgeax/engine-types';
import { isFxaaAntialias } from '../components/camera';
import { RendererContractFailureError } from '../errors/render';
import { buildBeginRenderPassDescriptor } from '../pipeline-spec';
import { FXAA_POST_PROCESS_ID } from '../render-contract';
import { resolveOutputDither } from '../render-pipeline';
import { getOrCreateFromChain } from './mesh-ssbo';
import type { _InternalRenderPipelineContext } from './render-context';
import { VIEW_UNIFORM_BYTES } from './view-ubo';

/**
 * Draws the cubemap background as a fullscreen triangle into the skybox graph
 * pass. The graph owns the HDR (or multisample HDR) attachment; disabled or
 * not-yet-uploaded skyboxes record nothing.
 */
export function encodeSkyboxPass(
  c: _InternalRenderPipelineContext,
  pass: RhiRenderPassEncoder,
  depthFormat?: GPUTextureFormat,
  colorFormat: GPUTextureFormat = 'rgba16float',
): void {
  if (!c.skyboxActive) return;
  const skyboxSnapshot = c.skybox;
  if (skyboxSnapshot === undefined) return;

  const { runtime, store, pipelineState } = c;

  // Guard: pipeline resources must exist (null when manifest has no
  // skybox entry -- legacy manifests continue to boot)
  if (depthFormat !== undefined && pipelineState.perPassResources.skyboxScenePipeline === undefined)
    throw new RendererContractFailureError(
      'draw',
      'a scene sky requires its depth-compatible pipeline producer',
    );
  const skyboxPipeline =
    depthFormat !== undefined
      ? pipelineState.perPassResources.skyboxScenePipeline?.(
          c.msaaActive ? 4 : 1,
          depthFormat,
          colorFormat,
        )
      : c.msaaActive
        ? pipelineState.perPassResources.skyboxPipelineMsaa
        : pipelineState.perPassResources.skyboxPipeline;
  const skyboxBgl = pipelineState.perPassResources.skyboxBindGroupLayout;
  const skyboxSampler = pipelineState.perPassResources.skyboxSampler;
  const skyboxRotationBuffer = pipelineState.perPassResources.skyboxRotationBuffer;
  if (
    skyboxPipeline === null ||
    skyboxPipeline === undefined ||
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
  const featureSource = skyboxSnapshot.featureEnvironment;
  const cubemapView = featureSource
    ? runtime.viewOwner?.preparedResolver.gpuWork.resolveTextureCube(
        featureSource.feature,
        featureSource.sky,
      )
    : store.getCubemapGpuView(skyboxSnapshot.equirectHandle as AssetHandle<'equirect'>, c.world);
  if (cubemapView === undefined) return;

  // Identity-cached skybox BindGroup keyed on the cubemap GpuView. The only
  // varying binding is the cubemap view (sampler + View UBO are stable); it is
  // recreated on each internal equirect-to-cubemap projection (which may happen
  // mid-app asynchronously), so keying on its identity rebuilds exactly when the
  // cubemap changes.
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

  pass.setPipeline(skyboxPipeline);
  pass.setBindGroup(0, skyboxBg);
  pass.draw(3);
}

export function recordFxaaPass(
  c: _InternalRenderPipelineContext,
  source: ResolveContext | TextureView,
  graphPass?: RhiRenderPassEncoder,
  paramsOverride?: Uint8Array,
  graphOutputFormat?: GPUTextureFormat,
): void {
  const { runtime, pipelineState, encoder, camera } = c;
  // FXAA samples the graph-owned LDR target and writes the current surface.
  // The surface is an output attachment only: no COPY_SRC usage, no
  // copyTextureToTexture, and no backend-specific surface sampling path.
  const fxaaActive = isFxaaAntialias(camera.antialias);
  if (
    fxaaActive &&
    pipelineState.perPassResources.fxaaPipeline !== null &&
    pipelineState.perPassResources.fxaaBindGroupLayout !== null &&
    pipelineState.perPassResources.fxaaSampler !== null &&
    runtime.getPostProcessParamsBuffer !== undefined
  ) {
    // Typed graph calls provide explicit input/output keys. The legacy
    // ldrColor fallback is retained only for the direct surface owner.
    const inputView =
      'resolve' in source
        ? ((source.resolve('input') ?? source.resolve('ldrColor')) as TextureView | undefined)
        : source;
    if (inputView === undefined) return;

    const fxaaParams = runtime.getPostProcessParamsBuffer(FXAA_POST_PROCESS_ID, 'write');
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
      const fxaaOutputView = runtime.device.createTextureView(c.outputTarget().texture, {
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

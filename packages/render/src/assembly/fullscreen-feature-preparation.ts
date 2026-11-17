import type { BindGroupLayout, RenderPipeline } from '@forgeax/engine-rhi';
import {
  err,
  ok,
  type Result,
  type RhiDevice,
  RhiError,
  type ShaderModule,
} from '@forgeax/engine-rhi';
import type { RenderFeature } from '../features/types';
import type { PostProcessShaderEntry } from '../fullscreen-post-process-pass';
import { postProcessShaderModuleLabel } from '../fullscreen-post-process-pass';
import { FXAA_POST_PROCESS_ID } from '../render-contract';
import {
  invokeDeviceCreateShaderModule,
  type ShaderDeviceAdapterInternal,
} from './material-shader-policy';
import type { WebGPURendererInternals } from './webgpu-renderer-bootstrap';
import { CLIP_POSITION_COLOR_VERTEX_BUFFERS } from './webgpu-vertex-layouts';

// forgeax-async-whitelist: dom-native - prepare the declared native shader modules.
export async function prewarmFullscreenFeatureModules(
  internals: Pick<WebGPURendererInternals, 'pack' | 'errorRegistry'>,
  feature: RenderFeature<unknown>,
  device: RhiDevice,
  adapter: ShaderDeviceAdapterInternal,
  retain: (label: string, module: ShaderModule) => void,
  generationIsCurrent: () => boolean,
): Promise<Result<void, RhiError>> {
  for (const postProcess of feature.requiredFullscreenPostProcesses ?? []) {
    const label = postProcessShaderModuleLabel(postProcess.source);
    const shaderResult = internals.pack.createShaderModule
      ? await internals.pack.createShaderModule(device, {
          code: postProcess.source,
          label,
        })
      : await invokeDeviceCreateShaderModule(device, {
          code: postProcess.source,
          label,
        });
    if (!shaderResult.ok) {
      internals.errorRegistry.fire(shaderResult.error);
      return err(shaderResult.error);
    }
    if (!generationIsCurrent())
      return err(
        new RhiError({
          code: 'rhi-not-available',
          expected: 'the installing Feature keeps its device generation',
          hint: 'retry Feature installation after Renderer recovery',
        }),
      );
    retain(label, shaderResult.value);
    adapter.seedModule(label, shaderResult.value, postProcess.source);
  }
  return ok(undefined);
}

/** Assemble a fullscreen native pipeline through the current generation's shader/layout owners. */
export function buildFullscreenFeaturePipeline(
  entry: PostProcessShaderEntry,
  bgl: BindGroupLayout,
  colorFormats: readonly GPUTextureFormat[],
  label: string,
  context: {
    readonly device: RhiDevice;
    readonly modules: ShaderDeviceAdapterInternal;
    readonly errorRegistry: { fire(error: RhiError): void };
    readonly viewLayout: BindGroupLayout | undefined;
    readonly emptyLayout: BindGroupLayout | null;
    readonly publishEmptyLayout: (layout: BindGroupLayout) => void;
  },
): RenderPipeline | null {
  let emptyLayout = context.emptyLayout;
  const isFxaaPipeline = label.startsWith(`post-process-${FXAA_POST_PROCESS_ID}-pso-`);
  const moduleFactory = context.modules;
  const moduleResult = moduleFactory.createShaderModule({
    code: entry.source,
    label: postProcessShaderModuleLabel(entry.source),
  });
  if (!moduleResult.ok) {
    // 'rhi-not-available' = async compile in flight: caller falls back one frame.
    // Other codes are real failures: surface through the error registry so AI
    // users see a structured RhiError instead of a silent black screen (charter P3).
    if (moduleResult.error.code !== 'rhi-not-available') {
      context.errorRegistry.fire(moduleResult.error);
    }
    return null;
  }
  if (!isFxaaPipeline && entry.usesView !== true && emptyLayout === null) {
    const bglRes = context.device.createBindGroupLayout({ entries: [] });
    if (!bglRes.ok) {
      context.errorRegistry.fire(bglRes.error);
      return null;
    }
    emptyLayout = bglRes.value;
    context.publishEmptyLayout(bglRes.value);
  }
  const viewLayout = entry.usesView === true ? context.viewLayout : undefined;
  const group0Layout = viewLayout ?? emptyLayout;
  if (group0Layout === null || group0Layout === undefined) {
    context.errorRegistry.fire(
      new Error('fullscreen post-process View layout is unavailable') as never,
    );
    return null;
  }
  const layoutRes = context.device.createPipelineLayout({
    label: `${label}-layout`,
    bindGroupLayouts: isFxaaPipeline ? [bgl] : [group0Layout as BindGroupLayout, bgl],
  });
  if (!layoutRes.ok) {
    context.errorRegistry.fire(layoutRes.error);
    return null;
  }
  const pipelineRes = context.device.createRenderPipeline({
    label,
    layout: layoutRes.value,
    vertex: {
      module: moduleResult.value,
      entryPoint: 'vs_main',
      buffers:
        entry.vertexLayout === 'clip-position-color' ? [...CLIP_POSITION_COLOR_VERTEX_BUFFERS] : [],
    },
    fragment: {
      module: moduleResult.value,
      // The typed graph reuses the composed tonemap module for separate
      // linear-LDR and final-encoding passes.  Preserve the selected entry
      // point; forcing fs_main encodes the linear-LDR intermediate a second
      // time and breaks the Three.js stage contract.
      entryPoint: entry.fragmentEntryPoint ?? 'fs_main',
      targets: colorFormats.map((format) => ({
        format,
        ...(entry.vertexLayout === undefined
          ? {}
          : {
              blend: {
                color: {
                  operation: 'add' as const,
                  srcFactor: 'src-alpha' as const,
                  dstFactor: 'one-minus-src-alpha' as const,
                },
                alpha: {
                  operation: 'add' as const,
                  srcFactor: 'one' as const,
                  dstFactor: 'one-minus-src-alpha' as const,
                },
              },
            }),
      })),
    },
    primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
    depthStencil:
      entry.depthOutput === undefined
        ? undefined
        : {
            format: entry.depthOutput,
            depthWriteEnabled: true,
            depthCompare: 'always',
          },
    multisample: undefined,
  });
  if (!pipelineRes.ok) {
    context.errorRegistry.fire(pipelineRes.error);
    return null;
  }
  return pipelineRes.value;
}

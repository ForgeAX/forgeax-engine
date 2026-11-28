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
import { materialColorTarget } from '../material-render-state';
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
    const label = postProcessShaderModuleLabel(postProcess);
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

/** Only the renderer's own deferred sources can bypass the async module wait. */
export function createFullscreenPipelineBuilder(input: {
  readonly device: () => RhiDevice;
  readonly adapter: (mode?: 'validated' | 'immediate') => ShaderDeviceAdapterInternal;
  readonly nativeImmediate: boolean;
  readonly errorRegistry: { fire(error: RhiError): void };
  readonly viewLayout: () => BindGroupLayout | undefined;
  readonly emptyLayout: () => BindGroupLayout | null;
  readonly publishEmptyLayout: (layout: BindGroupLayout) => void;
}) {
  return (
    entry: PostProcessShaderEntry,
    bgl: BindGroupLayout,
    colorFormats: readonly GPUTextureFormat[],
    label: string,
    colorState?: import('@forgeax/engine-types').MaterialRenderState,
    rendererOwnedSource = false,
  ): RenderPipeline | null => {
    const device = input.device();
    const immediate =
      rendererOwnedSource && input.nativeImmediate && device.caps.backendKind === 'webgpu';
    return buildFullscreenFeaturePipeline(
      entry,
      bgl,
      colorFormats,
      label,
      {
        device,
        modules: input.adapter(immediate ? 'immediate' : 'validated'),
        errorRegistry: input.errorRegistry,
        viewLayout: input.viewLayout(),
        emptyLayout: input.emptyLayout(),
        publishEmptyLayout: input.publishEmptyLayout,
      },
      colorState,
    );
  };
}

/** Assemble a fullscreen native pipeline through the current generation's shader/layout owners. */
function fullscreenDepthStencil(entry: PostProcessShaderEntry): GPUDepthStencilState | undefined {
  if (entry.stencilMask === undefined) {
    return entry.depthOutput === undefined
      ? undefined
      : { format: entry.depthOutput, depthWriteEnabled: true, depthCompare: 'always' };
  }
  const write = entry.stencilMask === 'write';
  const face: GPUStencilFaceState = write
    ? { compare: 'always', passOp: 'replace' }
    : { compare: 'equal' };
  return {
    format: 'depth24plus-stencil8',
    depthWriteEnabled: false,
    depthCompare: 'always',
    stencilFront: face,
    stencilBack: face,
    stencilReadMask: 1,
    stencilWriteMask: write ? 1 : 0,
  };
}

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
  colorState?: import('@forgeax/engine-types').MaterialRenderState,
): RenderPipeline | null {
  let emptyLayout = context.emptyLayout;
  const isFxaaPipeline = label.startsWith(`post-process-${FXAA_POST_PROCESS_ID}-pso-`);
  const moduleFactory = context.modules;
  const moduleResult = moduleFactory.createShaderModule({
    code: entry.source,
    label: postProcessShaderModuleLabel(entry),
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
      targets: colorFormats.map((format, index) =>
        colorState === undefined
          ? {
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
            }
          : materialColorTarget(format, colorState, index),
      ),
    },
    primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
    depthStencil: fullscreenDepthStencil(entry),
    multisample: undefined,
  });
  if (!pipelineRes.ok) {
    context.errorRegistry.fire(pipelineRes.error);
    return null;
  }
  return pipelineRes.value;
}

import type { BindGroupLayout, RenderPipeline } from '@forgeax/engine-rhi';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
import type { PostProcessShaderEntry } from '../fullscreen-post-process-pass';
import { buildFullscreenPostProcessPass } from '../fullscreen-post-process-pass';
import type { SkylightBindGroupResources } from '../ibl/skylight-bind-group';
import {
  createPreparedGraphicsResolver,
  type PreparedGraphicsResolver,
} from '../prepare/prepared-graphics-resolver';
import type { RenderResourceScope } from '../publication/resource-scope';
import {
  type PreparedResolverCaches,
  preparedMaterialBindings,
} from '../record/prepared-material-bindings';
import type { RenderSystemInternals } from '../record/render-context';
import { recordContext } from '../world/view-record-context';
import type { RenderFeaturePreparedGraphicsResolverInput } from './host';
import type { RenderFeatureGpuWorkOwner } from './prepared-gpu-work';

function makePreparedPipelinePendingError(): RhiError {
  return new RhiError({
    code: 'rhi-not-available',
    expected: 'prepared pipeline shader module warm-up to finish asynchronously',
    hint: 'retry the prepared graphics pass on the next frame',
  });
}

/** Render-system state a prepared graphics resolver reads; every field is live. */
export interface PreparedResolverDeps {
  readonly runtime: RenderSystemInternals;
  readonly gpuWork: RenderFeatureGpuWorkOwner;
  readonly caches: PreparedResolverCaches;
  readonly builtinPostProcessEntries: ReadonlyMap<string, PostProcessShaderEntry>;
  readonly skylightResources: () => SkylightBindGroupResources | undefined;
}

export function createPreparedResolver(
  deps: PreparedResolverDeps,
  input: RenderFeaturePreparedGraphicsResolverInput,
  worlds: readonly RenderResourceScope[],
): PreparedGraphicsResolver {
  const { runtime, gpuWork, caches } = deps;
  const {
    materialBindings,
    preparedPipelineIds,
    preparedMaterialPipelineShaders,
    preparedGroup0Pipelines,
    preparedViewOnlyPipelines,
    preparedRenderMaterialPipelines,
  } = caches;
  return createPreparedGraphicsResolver({
    device: runtime.device,
    featureIdentity: input.featureIdentity,
    generation: input.generation,
    capabilityAvailable: true,
    featureOrder: input.order,
    lookup: input.lookup,
    resolveGpuBuffer: (reference) => gpuWork.resolveBuffer(input.featureIdentity, reference),
    resolvePipeline: (descriptor) => {
      const postProcessEntry =
        input.fullscreenEffects.get(descriptor.shader) ??
        deps.builtinPostProcessEntries.get(descriptor.shader);
      if (postProcessEntry !== undefined) {
        const fullscreen = buildFullscreenPostProcessPass(
          { device: runtime.device, errorRegistry: runtime.errorRegistry },
          postProcessEntry,
        );
        if (fullscreen === null) return err(new Error('prepared post-process layout failed'));
        const pipeline = runtime.getPostProcessPipeline?.(
          descriptor.shader,
          fullscreen.bindGroupLayout,
          descriptor.colorFormats as readonly GPUTextureFormat[],
          postProcessEntry,
        );
        if (pipeline !== null && pipeline !== undefined) {
          preparedPipelineIds.set(pipeline as object, descriptor.shader);
          if (
            runtime.getMaterialShaderBindingContract?.(descriptor.shader).bindings === 'group-0'
          ) {
            preparedGroup0Pipelines.add(pipeline as object);
          }
        }
        return pipeline === null || pipeline === undefined
          ? err(makePreparedPipelinePendingError())
          : ok(pipeline);
      }
      const clusteredParticleMesh =
        runtime.device.caps.storageBuffer &&
        (descriptor.shader === 'forgeax::vfx-render.particles.mesh' ||
          descriptor.shader === 'forgeax::vfx-render.particles.mesh-inputs');
      const requestedVariantSet = clusteredParticleMesh
        ? 'CLUSTER_FORWARD_AVAILABLE=true'
        : undefined;
      // A colorless prepared program is a depth-only pass. Vertex-only
      // shadow programs must use the depth policy; resolving them as
      // forward asks Dawn for a non-existent `fs_main` entry point.
      const preparedPassKind = descriptor.colorFormats.length === 0 ? 'shadow-caster' : 'forward';
      const preparedPipelineEntry = (
        descriptor.preparePipelines
          ? (runtime.prepareMaterialShaderPipelineEntry ?? runtime.getMaterialShaderPipelineEntry)
          : runtime.getMaterialShaderPipelineEntry
      )?.(
        descriptor.shader,
        descriptor.colorFormats[0] === 'rgba16float',
        descriptor.renderState,
        descriptor.topology,
        descriptor.indexFormat,
        requestedVariantSet,
        preparedPassKind,
        undefined,
        descriptor.sampleCount ?? 1,
        // Prepared graphics own their declared attachment format. Passing
        // it through keeps the PSO compatible with feature-target views
        // (the ordinary material path intentionally defaults to the
        // swap-chain view format).
        descriptor.colorFormats[0] as GPUTextureFormat,
        undefined,
        descriptor.depthFormat === undefined ? null : (descriptor.depthFormat as GPUTextureFormat),
        descriptor.vertexLayout,
        undefined,
        input.shaderModuleMode,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        descriptor.particleInputLanes,
      );
      const preparedPipeline =
        preparedPipelineEntry === undefined
          ? ((descriptor.preparePipelines
              ? (runtime.prepareMaterialShaderPipeline ?? runtime.getMaterialShaderPipeline)
              : runtime.getMaterialShaderPipeline)?.(
              descriptor.shader,
              descriptor.colorFormats[0] === 'rgba16float',
              descriptor.renderState,
              descriptor.topology,
              descriptor.indexFormat,
              requestedVariantSet,
              preparedPassKind,
              undefined,
              descriptor.sampleCount ?? 1,
              descriptor.colorFormats[0] as GPUTextureFormat,
              undefined,
              descriptor.depthFormat === undefined
                ? null
                : (descriptor.depthFormat as GPUTextureFormat),
              descriptor.vertexLayout,
              undefined,
              input.shaderModuleMode,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              descriptor.particleInputLanes,
            ) ?? null)
          : (preparedPipelineEntry?.pipeline ?? null);
      // A requested material shader is an exact pipeline contract. During
      // async shader warmup, substituting the generic unlit pipeline can
      // mismatch vertex layouts and HDR attachment formats, turning a
      // retryable next-frame prepare into an invalid GPU command buffer.
      const pipeline = preparedPipeline ?? null;
      if (pipeline !== null) {
        preparedMaterialPipelineShaders.set(pipeline as object, descriptor.shader);
        const bindingContract = runtime.getMaterialShaderBindingContract?.(
          descriptor.shader,
        ).bindings;
        if (bindingContract === 'group-0') {
          preparedGroup0Pipelines.add(pipeline as object);
        } else if (bindingContract === 'view-only') {
          preparedViewOnlyPipelines.add(pipeline as object);
        } else {
          preparedRenderMaterialPipelines.add(pipeline as object);
        }
      }
      return pipeline === null
        ? err(makePreparedPipelinePendingError())
        : ok({
            handle: pipeline,
            standardLighting: preparedPipelineEntry?.group2Contract === 'cluster',
          });
    },
    resolveBindings: (descriptor, pipeline) => {
      const materialShaderId = preparedMaterialPipelineShaders.get(pipeline as object);
      const bindingContract =
        materialShaderId === undefined
          ? undefined
          : runtime.getMaterialShaderBindingContract?.(materialShaderId).bindings;
      if (bindingContract === 'group-0-resource') {
        return descriptor.values.sceneDepth === undefined
          ? err(new Error('prepared group-0 resource pipeline requires a scene target'))
          : ok(undefined);
      }
      if (bindingContract === 'view-and-scene-depth') {
        return ok(undefined);
      }
      if (
        preparedRenderMaterialPipelines.has(pipeline as object) &&
        descriptor.values.group === 0 &&
        descriptor.values.sceneDepth === undefined &&
        descriptor.values.sceneDepthBinding !== undefined
      ) {
        return err(new Error('prepared scene-depth pipeline requires a scene target'));
      }
      // The typed graph composes fullscreen feature bindings from its
      // current graph views and post-process parameter snapshot at encode
      // time. Do not manufacture a fallback bind group here: during
      // registration/recovery its params buffer can still be absent, and
      // a two-entry fallback cannot satisfy a params-aware layout.
      if (
        preparedPipelineIds.has(pipeline as object) &&
        (descriptor.values.fullscreen === true || descriptor.values.view === true)
      ) {
        return ok(undefined);
      }
      if (preparedGroup0Pipelines.has(pipeline as object)) {
        const layout =
          (materialShaderId === undefined
            ? undefined
            : runtime.getMaterialBindGroupLayout?.(materialShaderId)) ??
          (
            pipeline as RenderPipeline & {
              getBindGroupLayout?: (index: number) => BindGroupLayout;
            }
          ).getBindGroupLayout?.(0);
        return layout === undefined
          ? err(new Error('prepared group-0 pipeline bind group layout is unavailable'))
          : runtime.device.createBindGroup({ layout, entries: [] });
      }
      if (
        preparedViewOnlyPipelines.has(pipeline as object) ||
        (preparedRenderMaterialPipelines.has(pipeline as object) &&
          descriptor.values.group === 0) ||
        pipeline === recordContext(runtime).getPipelineState()?.unlitPipeline
      ) {
        return ok(undefined);
      }
      const group = descriptor.values.group;
      const layout =
        (materialShaderId !== undefined
          ? (runtime.getMaterialBindGroupLayout?.(materialShaderId) ??
            (group === 0
              ? recordContext(runtime).getPipelineState()?.materialBindGroupLayout
              : undefined))
          : undefined) ??
        (
          pipeline as RenderPipeline & {
            getBindGroupLayout?: (index: number) => BindGroupLayout;
          }
        ).getBindGroupLayout?.(group === 1 ? 1 : 0);
      const material = descriptor.values.material;
      if (
        group === 1 &&
        layout !== undefined &&
        materialShaderId !== undefined &&
        typeof material === 'object' &&
        material !== null &&
        'world' in material &&
        'handle' in material &&
        typeof material.world === 'number' &&
        typeof material.handle === 'number'
      ) {
        return preparedMaterialBindings(
          runtime,
          worlds,
          materialShaderId,
          material.world,
          material.handle,
          layout,
          deps.skylightResources(),
          materialBindings,
        );
      }
      return layout === undefined
        ? err(new Error('prepared pipeline bind group layout is unavailable'))
        : runtime.device.createBindGroup({
            layout,
            entries:
              group === 1 && preparedPipelineIds.has(pipeline as object)
                ? [
                    {
                      binding: 0,
                      resource: {
                        kind: 'textureView',
                        value: recordContext(runtime).getPipelineState()
                          ?.fallbackTextureView as never,
                      },
                    },
                    {
                      binding: 1,
                      resource: {
                        kind: 'sampler',
                        value: recordContext(runtime).getPipelineState()?.defaultSampler as never,
                      },
                    },
                    ...(runtime.getPostProcessParamsBuffer?.(
                      preparedPipelineIds.get(pipeline as object) ?? '',
                    ) === undefined
                      ? []
                      : [
                          {
                            binding: 2,
                            resource: {
                              kind: 'buffer' as const,
                              value: {
                                buffer: runtime.getPostProcessParamsBuffer?.(
                                  preparedPipelineIds.get(pipeline as object) ?? '',
                                ) as never,
                              },
                            },
                          },
                        ]),
                  ]
                : [],
          });
    },
  });
}

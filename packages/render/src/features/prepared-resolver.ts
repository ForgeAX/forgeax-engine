import type { BindGroupLayout, RenderPipeline } from '@forgeax/engine-rhi';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
import type { Result } from '@forgeax/engine-types';
import type { PostProcessShaderEntry } from '../fullscreen-post-process-pass';
import { buildFullscreenPostProcessPass } from '../fullscreen-post-process-pass';
import type { SkylightBindGroupResources } from '../ibl/skylight-bind-group';
import { isMaterialSourceSnapshot } from '../material-source';
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
import { waterMaterialEntryPointsUseWaterInfo } from '../water/wave-material';
import { recordContext } from '../world/view-record-context';
import type { RenderFeaturePreparedGraphicsResolverInput } from './host';
import type { RenderFeatureMaterialShaderContract } from './plan';
import type { RenderFeatureGpuWorkOwner } from './prepared-gpu-work';
import type {
  RenderFeaturePreparedRef,
  RenderFeatureWaterMaterialInput,
} from './prepared-graphics';
import type { PreparedGraphicsNormalizedDescriptor } from './prepared-graphics-store';

function makePreparedPipelinePendingError(): RhiError {
  return new RhiError({
    code: 'rhi-not-available',
    expected: 'prepared pipeline shader module warm-up to finish asynchronously',
    hint: 'retry the prepared graphics pass on the next frame',
  });
}

function preparedWaterInfoFormat(
  runtime: RenderSystemInternals,
  input: RenderFeaturePreparedGraphicsResolverInput,
  pipeline: RenderFeaturePreparedRef<'pipeline'>,
  contract: RenderFeatureMaterialShaderContract | undefined,
): Result<'rgba16float' | 'rgba32float' | undefined, RhiError> {
  if (contract?.systemInputs?.water !== 'water-frame/3') return ok(undefined);
  const unavailable = preparedWaterFrameUnavailable;
  let selected: RenderFeatureWaterMaterialInput | undefined;
  for (const reference of input.graphicsBindings?.values() ?? []) {
    const binding = input.lookup(reference)?.descriptor;
    if (
      binding?.kind !== 'bindings' ||
      binding.pipeline !== pipeline ||
      binding.values.waterMaterial === undefined
    )
      continue;
    const next = binding.values.waterMaterial;
    if (
      selected !== undefined &&
      (selected.bodyKey !== next.bodyKey ||
        selected.viewIdentity !== next.viewIdentity ||
        selected.bodyGeneration !== next.bodyGeneration ||
        selected.zoneGeneration !== next.zoneGeneration)
    )
      return unavailable();
    selected = next;
  }
  if (
    selected === undefined ||
    selected.viewIdentity !== input.viewIdentity ||
    input.frameGeneration === undefined ||
    input.deviceGeneration === undefined ||
    contract.entryPoints === undefined
  )
    return unavailable();
  return resolvePreparedWaterPublication(
    runtime,
    selected,
    input.frameGeneration,
    input.deviceGeneration,
    contract.entryPoints,
  );
}

function resolvePreparedWaterPublication(
  runtime: RenderSystemInternals,
  selected: RenderFeatureWaterMaterialInput,
  frameGeneration: number,
  deviceGeneration: number,
  entryPoints: NonNullable<RenderFeatureMaterialShaderContract['entryPoints']>,
): Result<'rgba16float' | 'rgba32float' | undefined, RhiError> {
  const unavailable = preparedWaterFrameUnavailable;
  const publication = runtime.getWaterMaterialFramePublication?.(
    selected.viewIdentity,
    frameGeneration,
    deviceGeneration,
  );
  if (
    publication === undefined ||
    publication.viewIdentity !== selected.viewIdentity ||
    publication.frameGeneration !== frameGeneration ||
    publication.deviceGeneration !== deviceGeneration
  )
    return unavailable();
  const index = publication.waveUploadPlan.bodyIndices.get(selected.bodyKey);
  const body = index === undefined ? undefined : publication.waveUploadPlan.bodyData[index];
  if (
    body?.bodyGeneration !== selected.bodyGeneration ||
    publication.waveUploadPlan.bodyZoneGenerations.get(selected.bodyKey) !== selected.zoneGeneration
  )
    return unavailable();
  const row = publication.rows.get(selected.bodyKey);
  if (row === undefined) {
    if (!waterMaterialEntryPointsUseWaterInfo(entryPoints)) return ok(undefined);
    const availability = publication.waterInfoAvailability.get(selected.bodyKey);
    if (availability?.kind === 'pending')
      return err(
        new RhiError({
          code: 'rhi-not-available',
          expected: `WaterInfo dependency ${availability.guid} for the accepted Body generation finishes loading`,
          hint: 'retry after the WaterInfo producer publishes the real same-generation descriptor and target',
        }),
      );
    return unavailable();
  }
  if (
    row.bodyGeneration !== selected.bodyGeneration ||
    row.zoneGeneration !== selected.zoneGeneration ||
    row.frameGeneration !== frameGeneration ||
    row.deviceGeneration !== deviceGeneration ||
    !publication.targets.some(
      (target) => target.targetName === row.targetName && target.targetFormat === row.targetFormat,
    )
  )
    return unavailable();
  return ok(row.targetFormat);
}

function preparedWaterFrameUnavailable() {
  return err(
    new RhiError({
      code: 'rhi-descriptor-invalid',
      expected:
        'the selected Water program has a same-view generation-qualified prepared Water frame',
      hint: 'prepare the accepted Body and WaterInfo publication before requesting its pipeline',
    }),
  );
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
  sourceScope: RenderResourceScope,
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
    resolvePipeline: (descriptor, reference) => {
      const postProcessEntry =
        input.fullscreenEffects.get(descriptor.shader) ??
        deps.builtinPostProcessEntries.get(descriptor.shader);
      if (postProcessEntry !== undefined) {
        return resolveInlinePipeline(deps, descriptor, postProcessEntry);
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
      const materialContract = runtime.getMaterialShaderBindingContract?.(descriptor.shader);
      const storageBindings = Array.from(input.graphicsBindings?.values() ?? []).some(
        (bindingRef) => {
          const binding = input.lookup(bindingRef)?.descriptor;
          return (
            binding?.kind === 'bindings' &&
            binding.pipeline === reference &&
            binding.values.bufferBindings !== undefined
          );
        },
      );
      const waterInfoFormat = preparedWaterInfoFormat(runtime, input, reference, materialContract);
      if (!waterInfoFormat.ok) return waterInfoFormat;
      const resolvePreparedPipelineEntry = (
        waterInfoFormat: Extract<ReturnType<typeof preparedWaterInfoFormat>, { ok: true }>,
      ) => {
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
          (descriptor.colorFormats[0] ?? null) as GPUTextureFormat | null,
          undefined,
          descriptor.depthFormat === undefined
            ? null
            : (descriptor.depthFormat as GPUTextureFormat),
          descriptor.vertexLayout,
          undefined,
          input.shaderModuleMode,
          undefined,
          undefined,
          descriptor.colorFormats.slice(1) as readonly GPUTextureFormat[],
          undefined,
          undefined,
          descriptor.particleInputLanes,
          undefined,
          waterInfoFormat.value,
          storageBindings,
        );
        return preparedPipelineEntry;
      };
      const preparedPipelineEntry = resolvePreparedPipelineEntry(waterInfoFormat);
      const resolvePreparedPipeline = (
        waterInfoFormat: Extract<ReturnType<typeof preparedWaterInfoFormat>, { ok: true }>,
      ) => {
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
                (descriptor.colorFormats[0] ?? null) as GPUTextureFormat | null,
                undefined,
                descriptor.depthFormat === undefined
                  ? null
                  : (descriptor.depthFormat as GPUTextureFormat),
                descriptor.vertexLayout,
                undefined,
                input.shaderModuleMode,
                undefined,
                undefined,
                descriptor.colorFormats.slice(1) as readonly GPUTextureFormat[],
                undefined,
                undefined,
                descriptor.particleInputLanes,
                undefined,
                waterInfoFormat.value,
                storageBindings,
              ) ?? null)
            : (preparedPipelineEntry?.pipeline ?? null);
        return preparedPipeline;
      };
      const preparedPipeline = resolvePreparedPipeline(waterInfoFormat);
      // A requested material shader is an exact pipeline contract. During
      // async shader warmup, substituting the generic unlit pipeline can
      // mismatch vertex layouts and HDR attachment formats, turning a
      // retryable next-frame prepare into an invalid GPU command buffer.
      const pipeline = preparedPipeline ?? null;
      const rememberPipelineContract = (): void => {
        if (pipeline !== null) {
          preparedMaterialPipelineShaders.set(pipeline as object, descriptor.shader);
          const bindingContract = materialContract?.bindings;
          if (bindingContract === 'group-0') {
            preparedGroup0Pipelines.add(pipeline as object);
          } else if (bindingContract === 'view-only') {
            preparedViewOnlyPipelines.add(pipeline as object);
          } else {
            preparedRenderMaterialPipelines.add(pipeline as object);
          }
        }
      };
      rememberPipelineContract();
      return pipeline === null
        ? err(makePreparedPipelinePendingError())
        : ok({
            handle: pipeline,
            ...(materialContract === undefined
              ? {}
              : { bindingContract: materialContract.bindings }),
            standardLighting:
              preparedPipelineEntry?.group2Contract === 'cluster' &&
              materialContract?.bindings !== 'post-process',
          });
    },
    resolveBindings: (descriptor, pipeline) => {
      if (descriptor.values.bufferBindings !== undefined) return ok(undefined);
      const materialShaderId = preparedMaterialPipelineShaders.get(pipeline as object);
      const bindingContract =
        materialShaderId === undefined
          ? undefined
          : runtime.getMaterialShaderBindingContract?.(materialShaderId).bindings;
      const resolveGraphOwnedBindings = () => {
        if (bindingContract === 'group-0-resource') {
          return descriptor.values.sceneDepth === undefined
            ? err(new Error('prepared group-0 resource pipeline requires a scene target'))
            : ok(undefined);
        }
        if (bindingContract === 'view-and-scene-depth') {
          return ok(undefined);
        }
        if (bindingContract === 'post-process' && descriptor.values.group === 0) {
          return descriptor.values.sceneColor !== undefined &&
            descriptor.values.sceneDepth !== undefined &&
            typeof descriptor.values.passInputBuffer === 'string'
            ? ok(undefined)
            : err(
                new Error(
                  'post-process bindings require current scene color, depth and pass inputs',
                ),
              );
        }
        if (
          bindingContract === 'post-process' &&
          descriptor.values.group === 2 &&
          descriptor.values.waterMaterial !== undefined
        )
          return ok(undefined);
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
        return undefined;
      };
      const graphOwned = resolveGraphOwnedBindings();
      if (graphOwned !== undefined) return graphOwned;
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
        'handle' in material &&
        typeof material.handle === 'number'
      ) {
        return preparedMaterialBindings(
          runtime,
          sourceScope,
          materialShaderId,
          material.handle,
          layout,
          deps.skylightResources(),
          materialBindings,
          'revision' in material && typeof material.revision === 'number'
            ? material.revision
            : undefined,
          'sourceAssets' in material && isMaterialSourceSnapshot(material.sourceAssets)
            ? material.sourceAssets
            : undefined,
          input.assetVersion === undefined
            ? undefined
            : (handle, revision) => input.assetVersion?.(0, handle, revision),
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

function resolveInlinePipeline(
  deps: PreparedResolverDeps,
  descriptor: PreparedGraphicsNormalizedDescriptor & { readonly kind: 'pipeline' },
  postProcessEntry: PostProcessShaderEntry,
) {
  const { runtime, caches } = deps;
  const { preparedPipelineIds, preparedGroup0Pipelines } = caches;
  if (
    postProcessEntry.vertexLayout !== undefined &&
    descriptor.vertexLayout !== postProcessEntry.vertexLayout
  )
    return err(new Error('inline graphics vertex layout does not match its declared source'));
  const fullscreen = buildFullscreenPostProcessPass(
    { device: runtime.device, errorRegistry: runtime.errorRegistry },
    postProcessEntry,
    postProcessEntry.depthSampleCount === 4,
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
    if (runtime.getMaterialShaderBindingContract?.(descriptor.shader).bindings === 'group-0') {
      preparedGroup0Pipelines.add(pipeline as object);
    }
  }
  return pipeline === null || pipeline === undefined
    ? err(makePreparedPipelinePendingError())
    : ok(pipeline);
}

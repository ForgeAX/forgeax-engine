import type {
  GraphResourceResolver,
  GraphTexture,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import type {
  BindGroupLayout,
  Buffer,
  RenderPipeline,
  Texture,
  TextureView,
} from '@forgeax/engine-rhi';
import {
  type AssetHandle,
  err,
  MATERIAL_POST_PROCESS_SCENE_INPUTS,
  ok,
  type Result,
  type TextureAsset,
} from '@forgeax/engine-types';
import {
  type AtmosphereViews,
  atmosphereBindings,
  atmosphereMaterialVisibilityBindings,
} from '../environment/bindings';
import { atmosphereVolumeViews, type GraphAtmosphere } from '../environment/luts';
import { CloudLayerResourceFailureError } from '../errors/cloud';
import { RenderFeatureStageFailedError } from '../errors/render';
import type { RenderFeatureResolvedGpuBuffer } from '../features/prepared-gpu-work';
import type { RenderFeatureBindingsDescriptor } from '../features/prepared-graphics';
import type {
  RenderFeatureGraphBindingsResolution,
  RenderFeatureGraphTargetResolver,
} from '../features/render-graph-raster';
import { isRenderFeatureTargetHandle } from '../features/targets';
import type { PostProcessShaderEntry } from '../fullscreen-post-process-pass';
import {
  buildFullscreenPostProcessPass,
  createFullscreenBindGroup,
  isTemporalFullscreenBinding,
} from '../fullscreen-post-process-pass';
import { waterProgramEntryPoints } from '../material-program-inputs';
import type { WaterInfoGraphTargets } from '../pipeline/standard-build-context';
import type { PreparedGraphicsResolvedResource } from '../prepare/prepared-graphics-resolver';
import type {
  RenderPipelineFeatureTarget,
  RenderPipelineFrame,
  RenderPipelineTarget,
} from '../render-pipeline';
import { getTemporalGpuState, stageTemporalGpuWrite } from '../temporal/gpu';
import {
  isSceneDataTarget,
  SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA,
  SCENE_DATA_TEMPORAL_V1_SCHEMA,
  sceneDataTargetOwner,
} from '../temporal/scene-data';
import {
  requireWaterMaterialBakedSources,
  waterMaterialBodyIndex,
  waterMaterialFrameBindGroupEntries,
  waterMaterialFrameDynamicOffsets,
} from '../water/wave-material';
import { recordContext } from '../world/view-record-context';
import { buildPerFrameBindGroups, buildViewBindGroup } from './frame-lighting';
import { extractEntryResourceHandle, getOrCreateFromChainResult } from './mesh-ssbo';
import type { _InternalRenderPipelineContext, RenderSystemInternals } from './render-context';
import {
  POST_PROCESS_VIEW_UNIFORM_OFFSET,
  translucentViewOffset,
  VIEW_UNIFORM_BYTES,
} from './view-ubo';

/** Build semantic sampled views without changing the graph's attachment views. */
export function projectSceneDataSampledViews(
  builder: RenderGraphBuilder<RenderPipelineFrame>,
  semanticTargets: readonly RenderPipelineTarget[],
  depthViews: Map<GraphTexture, GraphTextureView>,
): Result<readonly RenderPipelineTarget[], RenderGraphError> {
  let projected: RenderPipelineTarget[] | undefined;
  for (const [index, target] of semanticTargets.entries()) {
    if (
      !target.sceneDataBindings?.some(
        (binding) => binding.schema === SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA,
      )
    ) {
      projected?.push(target);
      continue;
    }

    projected ??= semanticTargets.slice(0, index);
    let view = depthViews.get(target.texture);
    if (view === undefined) {
      const created = builder.view(target.texture, { aspect: 'depth-only' });
      if (!created.ok) return err(created.error);
      view = created.value;
      depthViews.set(target.texture, view);
    }
    projected.push({ ...target, view });
  }
  return ok(projected ?? semanticTargets);
}

export function targetResolver(
  targets: readonly RenderPipelineFeatureTarget[],
  semanticTargets: readonly RenderPipelineTarget[] = [],
  namedTargets: Readonly<Record<string, RenderPipelineTarget>> = {},
): RenderFeatureGraphTargetResolver {
  return (resource) => {
    const namedKey =
      typeof resource === 'string'
        ? resource
        : isRenderFeatureTargetHandle(resource)
          ? resource.name
          : undefined;
    if (namedKey !== undefined) {
      const named = namedTargets[namedKey];
      if (named !== undefined) {
        return {
          texture: named.texture,
          view: named.view,
          ...(named.resolveTarget === undefined ? {} : { resolveTarget: named.resolveTarget }),
        };
      }
      if (typeof resource === 'string') {
        const target = targets.find((candidate) => candidate.name === resource);
        if (target !== undefined) {
          return {
            texture: target.texture,
            view: target.view,
            ...(target.resolveTarget === undefined ? {} : { resolveTarget: target.resolveTarget }),
          };
        }
        // Standard lanes expose the depth attachment as a semantic target
        // without duplicating the public `depth` name on every concrete graph
        // projection. Keep the string alias stable for feature-authored
        // fullscreen bindings while preserving the typed target identity.
        if (resource === 'depth') {
          const depth = targets.find((candidate) => candidate.kind === 'scene-depth');
          if (depth !== undefined) {
            return {
              texture: depth.texture,
              view: depth.view,
              ...(depth.resolveTarget === undefined ? {} : { resolveTarget: depth.resolveTarget }),
            };
          }
        }
      }
    }
    if (isSceneDataTarget(resource)) {
      const owner = sceneDataTargetOwner(resource);
      if (owner === undefined) return undefined;
      const surfaceSchema = resource.schema !== SCENE_DATA_TEMPORAL_V1_SCHEMA;
      const semantic = semanticTargets.find((candidate) => {
        if (candidate.format !== resource.format || candidate.sampleCount !== resource.sampleCount)
          return false;
        return (
          candidate.sceneDataBindings?.some(
            (binding) =>
              binding.schema === resource.schema &&
              binding.owners.some(
                (candidateOwner) =>
                  candidateOwner.featureIdentity === owner.featureIdentity &&
                  candidateOwner.viewIdentity === owner.viewIdentity &&
                  candidateOwner.planIdentity === owner.planIdentity &&
                  candidateOwner.generation === owner.generation &&
                  candidateOwner.deviceGeneration === owner.deviceGeneration &&
                  (!surfaceSchema ||
                    (candidateOwner.surfaceAdmissionIdentity === owner.surfaceAdmissionIdentity &&
                      candidateOwner.surfaceAdmissionRevision === owner.surfaceAdmissionRevision)),
              ),
          ) === true
        );
      });
      return semantic === undefined
        ? undefined
        : { texture: semantic.texture, view: semantic.view };
    }
    if (!isRenderFeatureTargetHandle(resource)) return undefined;
    // A typed feature handle is an identity, not a format request. Falling
    // back to another same-format target can silently bind scene color in
    // place of a missing cloud history/shadow resource and turn a producer
    // failure into plausible but incorrect pixels.
    // Standard lanes expose scene depth as a semantic target without a
    // duplicated public name, while feature plans use the stable `depth`
    // handle name. Preserve that one semantic alias here as well as above for
    // string-authored fullscreen bindings.
    const target = targets.find(
      (candidate) =>
        candidate.kind === resource.kind &&
        candidate.format === resource.format &&
        candidate.sampleCount === resource.sampleCount &&
        (resource.name === undefined ||
          candidate.name === resource.name ||
          (resource.kind === 'scene-color' &&
            resource.name === 'color' &&
            candidate.kind === 'scene-color') ||
          (resource.kind === 'scene-depth' &&
            resource.name === 'depth' &&
            candidate.kind === 'scene-depth')),
    );
    return target === undefined
      ? undefined
      : {
          texture: target.texture,
          view: target.view,
          ...(target.resolveTarget === undefined ? {} : { resolveTarget: target.resolveTarget }),
        };
  };
}

export interface TargetBindingsInput {
  readonly frame: RenderPipelineFrame;
  readonly binding: PreparedGraphicsResolvedResource & {
    readonly kind: 'bindings';
  };
  readonly resources: GraphResourceResolver;
  readonly resolveTarget: RenderFeatureGraphTargetResolver;
  readonly resolveGpuResource?: (name: string) => RenderFeatureResolvedGpuBuffer | undefined;
}

type BindingValues = RenderFeatureBindingsDescriptor['values'];
type LayoutPipeline = RenderPipeline & {
  getBindGroupLayout?: (index: number) => BindGroupLayout;
};
type ResolvedTarget = NonNullable<ReturnType<RenderFeatureGraphTargetResolver>>;
type FullscreenPass = NonNullable<ReturnType<typeof buildFullscreenPostProcessPass>>;

export function resolveTargetBindings(
  input: TargetBindingsInput,
  featurePostProcessEntries?: ReadonlyMap<string, PostProcessShaderEntry>,
  atmosphere?: GraphAtmosphere,
  waterInfoTargets?: WaterInfoGraphTargets,
  postProcessView?: 'unjittered',
): RenderFeatureGraphBindingsResolution | undefined {
  const frame = input.frame as _InternalRenderPipelineContext;
  const atmosphereViews = atmosphereVolumeViews(input.resources, atmosphere);
  const cloudShadow = cloudShadowViewOf(input.resources, atmosphere);
  const directionalShadow = directionalShadowViewOf(frame, input.resources, atmosphere);
  const descriptor = input.binding.descriptor;
  const pipeline = input.binding.pipeline as LayoutPipeline | undefined;
  const sceneDepth = descriptor?.values.sceneDepth;
  if (pipeline === undefined) return undefined;
  if (descriptor?.values.bufferBindings !== undefined) {
    const layout = pipeline.getBindGroupLayout?.(Number(descriptor.values.group ?? 0));
    if (layout === undefined) return undefined;
    const entries: import('@forgeax/engine-rhi').BindGroupEntry[] =
      descriptor.values.bufferBindings.map((binding) => {
        const buffer = input.resolveGpuResource?.(binding.resource);
        if (buffer === undefined)
          throw new RenderFeatureStageFailedError(
            'graphics-storage-bindings',
            -1,
            'record',
            'next-frame',
            { resource: binding.resource },
          );
        return {
          binding: binding.binding,
          resource: {
            kind: 'buffer' as const,
            value: { buffer: buffer.buffer, size: buffer.size },
          },
        };
      });
    if (
      descriptor.values.sceneDepth !== undefined &&
      typeof descriptor.values.sceneDepthBinding === 'number'
    ) {
      const depth = input.resolveTarget(descriptor.values.sceneDepth as never);
      const view = depth === undefined ? undefined : depthOnlyViewOf(frame, input.resources, depth);
      if (view === undefined) return undefined;
      entries.push({
        binding: descriptor.values.sceneDepthBinding,
        resource: { kind: 'textureView', value: view },
      });
    }
    return frame.runtime.device.createBindGroup({ layout, entries }).unwrap();
  }
  if (descriptor?.values.waterMaterial !== undefined) {
    const resolveFeatureWaterMaterialBindings = () => {
      const selected = descriptor.values.waterMaterial as {
        readonly bodyKey: string;
        readonly viewIdentity: string;
        readonly bodyGeneration: number;
        readonly zoneGeneration: number;
        readonly programInputs: import('../material-program-inputs').MaterialProgramInputs;
      };
      const expected = {
        viewIdentity: selected.viewIdentity,
        bodyGeneration: selected.bodyGeneration,
        zoneGeneration: selected.zoneGeneration,
        deviceGeneration: frame.runtime.deviceGeneration ?? 0,
        frameGeneration: frame.runtime.rendererFrameNumber ?? -1,
      };
      const views = new Map<string, TextureView>();
      for (const [name, target] of waterInfoTargets ?? [])
        views.set(name, input.resources.textureView(target.view).unwrap());
      const [viewX, viewY, viewZ] = frame.camera.position;
      if (viewX === undefined || viewY === undefined || viewZ === undefined)
        throw new RenderFeatureStageFailedError(
          'water-frame-system-input',
          -1,
          'record',
          'next-frame',
          {
            reason: 'view-origin-unavailable',
          },
        );
      const bindings = frame.runtime.getWaterMaterialFrameBindings?.({
        ...expected,
        viewOriginM: [viewX, viewY, viewZ],
        waterInfoTextureViews: views,
        waterMeshDraws: [],
      });
      const resources = [...(bindings?.values() ?? [])].find(
        (candidate) =>
          candidate.bodyTargetNames.get(selected.bodyKey) === candidate.waterInfoTargetName,
      );
      const index =
        resources === undefined
          ? undefined
          : waterMaterialBodyIndex(resources, selected.bodyKey, expected);
      const layout = pipeline.getBindGroupLayout?.(2);
      if (resources === undefined || index?.ok !== true || layout === undefined)
        throw new RenderFeatureStageFailedError(
          'water-frame-system-input',
          -1,
          'record',
          'next-frame',
          {
            reason: 'selected-water-frame-unavailable',
            selected,
            expected,
            ...(index?.ok === false ? { cause: index.error } : {}),
          },
        );
      const infoOffset = resources.waterInfoDescriptorDynamicOffsets.get(selected.bodyKey);
      const drawOffset = resources.bodyIndexDynamicOffsets.get(selected.bodyKey);
      if (drawOffset === undefined) return undefined;
      const entryPoints = waterProgramEntryPoints(selected.programInputs);
      if (entryPoints === undefined)
        throw new RenderFeatureStageFailedError(
          'water-frame-system-input',
          -1,
          'record',
          'next-frame',
          {
            reason: 'selected-water-frame-program-uncertified',
            selected,
          },
        );
      requireWaterMaterialBakedSources(resources, [index.value], selected.programInputs);
      return {
        handle: frame.runtime.device
          .createBindGroup({
            layout,
            entries: waterMaterialFrameBindGroupEntries(resources, 16, entryPoints),
          })
          .unwrap(),
        dynamicOffsets: waterMaterialFrameDynamicOffsets(
          {
            ...(infoOffset === undefined ? {} : { waterInfo: infoOffset }),
            body: drawOffset,
            mesh: 0,
          },
          entryPoints,
          resources.waterInfoTextureView !== undefined,
        ),
      };
    };
    return resolveFeatureWaterMaterialBindings();
  }
  if (descriptor?.values.postProcess === true) {
    const resolveFeaturePostProcessBindings = () => {
      const color = input.resolveTarget(descriptor.values.sceneColor as never);
      const depth = input.resolveTarget(descriptor.values.sceneDepth as never);
      const inputName = descriptor.values.passInputBuffer;
      const passInputs =
        typeof inputName === 'string' ? input.resolveGpuResource?.(inputName) : undefined;
      const layout = pipeline.getBindGroupLayout?.(0);
      if (
        color === undefined ||
        depth === undefined ||
        passInputs === undefined ||
        layout === undefined
      )
        return undefined;
      const colorView = input.resources.textureView(color.view).unwrap();
      const depthView = depthOnlyViewOf(frame, input.resources, depth);
      if (depthView === undefined) return undefined;
      return frame.runtime.device
        .createBindGroup({
          layout,
          entries: [
            {
              binding: MATERIAL_POST_PROCESS_SCENE_INPUTS.view,
              resource: {
                kind: 'buffer',
                value: {
                  buffer: frame.pipelineState.viewUniformBuffer,
                  offset: postProcessView === 'unjittered' ? POST_PROCESS_VIEW_UNIFORM_OFFSET : 0,
                  size: VIEW_UNIFORM_BYTES,
                },
              },
            },
            {
              binding: MATERIAL_POST_PROCESS_SCENE_INPUTS.color,
              resource: { kind: 'textureView', value: colorView },
            },
            {
              binding: MATERIAL_POST_PROCESS_SCENE_INPUTS.depth,
              resource: { kind: 'textureView', value: depthView },
            },
            {
              binding: MATERIAL_POST_PROCESS_SCENE_INPUTS.passInputs,
              resource: {
                kind: 'buffer',
                value: { buffer: passInputs.buffer, size: passInputs.size },
              },
            },
          ],
        })
        .unwrap();
    };
    return resolveFeaturePostProcessBindings();
  }
  const resolveFeatureSceneViewBindings = () => {
    // Blended feature draws (particles) read the View copy for their blend so
    // they fog themselves at their own depth over the already-fogged scene.
    const viewOffset =
      input.binding.fogComposition === undefined
        ? 0
        : translucentViewOffset(input.binding.fogComposition);
    if (descriptor?.values.view === true) {
      return perFrameViewBindings(
        frame,
        atmosphereViews,
        directionalShadow,
        cloudShadow,
        viewOffset,
      );
    }
    // Generic fullscreen producers (for example the CloudLayer scene pass)
    // share the renderer-owned post-process bind-group contract without opting
    // into the temporal two-input path below. Their input/depth aliases are
    // resolved from the active typed graph, so they cannot accidentally sample
    // a stale surface view or manufacture a second resource owner.
    if (descriptor?.values.fullscreen === true) {
      return isTemporalFullscreenBinding(descriptor.values)
        ? resolveTemporalFullscreenBindings(
            input,
            frame,
            pipeline,
            descriptor.values,
            featurePostProcessEntries,
          )
        : resolveFullscreenBindings(
            input,
            frame,
            pipeline,
            descriptor.values,
            featurePostProcessEntries,
          );
    }
    if (
      input.binding.bindingContract === 'view-and-scene-depth' ||
      input.binding.bindingContract === 'render-material-and-scene-depth'
    ) {
      return resolveViewDepthBindings(
        input,
        frame,
        pipeline,
        sceneDepth,
        viewOffset,
        atmosphereViews,
        directionalShadow,
        cloudShadow,
      );
    }
    if (input.binding.bindingContract === 'render-standard-material-and-scene-depth') {
      return resolveStandardViewDepthBindings(
        input,
        frame,
        pipeline,
        sceneDepth,
        viewOffset,
        atmosphereViews,
        directionalShadow,
        cloudShadow,
      );
    }
    if (sceneDepth === undefined) {
      // This callback is reached only for an actual feature draw. A scene
      // containing only particles still needs the pipeline's View/light ABI.
      return perFrameViewBindings(
        frame,
        atmosphereViews,
        directionalShadow,
        cloudShadow,
        viewOffset,
      );
    }
    return resolveSceneDepthBindings(input, frame, pipeline, sceneDepth, descriptor?.values.group);
  };
  return resolveFeatureSceneViewBindings();
}

function cloudShadowViewOf(
  resources: GraphResourceResolver,
  atmosphere: GraphAtmosphere | undefined,
): TextureView | undefined {
  const cloud = atmosphere?.visibility.cloud;
  return cloud === undefined ? undefined : resources.textureView(cloud).unwrap();
}

function directionalShadowViewOf(
  frame: _InternalRenderPipelineContext,
  resources: GraphResourceResolver,
  atmosphere: GraphAtmosphere | undefined,
): TextureView | undefined {
  const directional = atmosphere?.visibility.directional;
  return directional === undefined
    ? (frame.frameState.frameOutputs.directionalShadowView ?? undefined)
    : resources.textureView(directional).unwrap();
}

/** The renderer-owned View/light group shared with the scene passes. */
function perFrameViewBindings(
  frame: _InternalRenderPipelineContext,
  atmosphereViews: AtmosphereViews | undefined,
  directionalShadow: TextureView | undefined,
  cloudShadow: TextureView | undefined,
  viewOffset: number,
): RenderFeatureGraphBindingsResolution | undefined {
  const viewBindGroup = buildPerFrameBindGroups(
    frame.runtime as RenderSystemInternals,
    frame.frameState,
    frame.pipelineState,
    true,
    frame.bindGroupCounts,
    {
      atmosphere: atmosphereViews,
      directionalShadow,
      cloudShadow,
      spotShadow: frame.frameState.frameOutputs.spotShadowView ?? undefined,
    },
    true,
    frame.standardLighting,
  ).viewBindGroup;
  return viewBindGroup === null
    ? undefined
    : { handle: viewBindGroup, dynamicOffsets: [viewOffset, 0] };
}

function postProcessEntryOf(
  frame: _InternalRenderPipelineContext,
  shader: string,
  featurePostProcessEntries: ReadonlyMap<string, PostProcessShaderEntry> | undefined,
): PostProcessShaderEntry | undefined {
  return featurePostProcessEntries?.get(shader) ?? frame.runtime.lookupPostProcess?.(shader);
}

function depthOnlyViewOf(
  frame: _InternalRenderPipelineContext,
  resources: GraphResourceResolver,
  target: ResolvedTarget,
): TextureView | undefined {
  const depthTexture = resources.texture(target.texture);
  if (!depthTexture.ok) return undefined;
  const created = frame.runtime.device.createTextureView(depthTexture.value as Texture, {
    aspect: 'depth-only',
    dimension: '2d',
  });
  return created.ok ? created.value : undefined;
}

/** Upload the authored params; false when a declared params block cannot be written. */
function writePostProcessParams(
  frame: _InternalRenderPipelineContext,
  shader: string,
  entry: PostProcessShaderEntry,
  paramsBuffer: Buffer | undefined,
): boolean {
  if (entry.params === undefined) return true;
  if (paramsBuffer === undefined) return false;
  const data = frame.postProcessParams.get(shader) ?? entry.params.defaultValue;
  if (data.byteLength !== entry.params.byteSize) return false;
  return frame.runtime.device.queue.writeBuffer(paramsBuffer, 0, data).ok;
}

function fullscreenDepthTarget(
  input: TargetBindingsInput,
  values: BindingValues,
): ResolvedTarget | undefined {
  if (values.depthFallback === true || values.depth === undefined) return undefined;
  return input.resolveTarget(values.depth as never);
}

function fullscreenInputView(
  input: TargetBindingsInput,
  frame: _InternalRenderPipelineContext,
  values: BindingValues,
): TextureView | undefined {
  const inputTarget =
    values.input === false ? undefined : input.resolveTarget(values.input as never);
  if (inputTarget === undefined) return frame.pipelineState.defaultWhiteTextureView;
  const view = input.resources.textureView(inputTarget.view);
  return view.ok ? view.value : undefined;
}

function fullscreenDepthView(
  input: TargetBindingsInput,
  frame: _InternalRenderPipelineContext,
  values: BindingValues,
  depthTarget: ResolvedTarget | undefined,
): TextureView | undefined {
  if (values.depthFallback === true) return frame.pipelineState.shadowFallbackTextureView;
  return depthTarget === undefined
    ? undefined
    : depthOnlyViewOf(frame, input.resources, depthTarget);
}

/** Named extra color inputs; undefined when any declared input is unavailable. */
function fullscreenAdditionalViews(
  frame: _InternalRenderPipelineContext,
  input: TargetBindingsInput,
  values: BindingValues,
  fullscreen: FullscreenPass,
): { readonly binding: number; readonly view: TextureView }[] | undefined {
  const additionalViews: { readonly binding: number; readonly view: TextureView }[] = [];
  const additionalNames = values.additionalTextures;
  if (!Array.isArray(additionalNames)) return additionalViews;
  for (const [index, value] of additionalNames.entries()) {
    const assetCount = Array.isArray(values.assetTextures) ? values.assetTextures.length : 0;
    const binding = fullscreen.extraColorBindings[assetCount + index];
    if (binding === undefined) return undefined;
    if (value === false) {
      additionalViews.push({ binding, view: frame.pipelineState.defaultWhiteTextureView });
      continue;
    }
    if (typeof value !== 'string') return undefined;
    const target = input.resolveTarget(value);
    if (target === undefined) return undefined;
    const view = input.resources.textureView(target.view);
    if (!view.ok) return undefined;
    additionalViews.push({ binding, view: view.value });
  }
  return additionalViews;
}

/** Exact published cloud texture versions; the ordinary residency cache owns views and lifetimes. */
function fullscreenAssetViews(
  frame: _InternalRenderPipelineContext,
  facts: BindingValues[string],
  fullscreen: FullscreenPass,
  additionalCount = 0,
): readonly { readonly binding: number; readonly view: TextureView }[] {
  const fail = (cause: string): never => {
    throw new CloudLayerResourceFailureError({
      stage: 'view',
      generation: recordContext(frame.runtime).deviceScope.generation,
      cause,
    });
  };
  if (
    !Array.isArray(facts) ||
    facts.length + additionalCount !== fullscreen.extraColorBindings.length
  )
    return fail('The published cloud texture roster does not match the prepared bind group.');
  return facts.map((fact: unknown, index) => {
    if (
      fact === null ||
      typeof fact !== 'object' ||
      !('handle' in fact) ||
      typeof fact.handle !== 'number' ||
      !('revision' in fact) ||
      typeof fact.revision !== 'number' ||
      !('guid' in fact) ||
      typeof fact.guid !== 'string' ||
      !('dimension' in fact) ||
      (fact.dimension !== '2d' && fact.dimension !== '3d')
    )
      return fail('Invalid published cloud texture fact.');
    const binding = fullscreen.extraColorBindings[index];
    const handle = fact.handle as AssetHandle<'texture'>;
    const scope = frame.world;
    if (
      binding === undefined ||
      scope.assetRevision(handle) !== fact.revision ||
      scope.sourceForAsset(handle)?.guid !== fact.guid
    )
      return fail(
        `Cloud texture ${fact.guid} has no accepted publication for revision ${fact.revision}.`,
      );
    // The active publication/version was checked immediately above. Local
    // Worlds expose this same current snapshot without a historical pin.
    const resolved = scope.resolveAsset<TextureAsset>(handle);
    if (
      !resolved.ok ||
      resolved.value.kind !== 'texture' ||
      resolved.value.shape.viewDimension !== fact.dimension
    )
      return fail(`Cloud texture ${fact.guid} does not match its cooked view dimension.`);
    const resident = frame.store.ensureResident(handle, resolved.value, scope);
    if (!resident.ok)
      return fail(`Cloud texture ${fact.guid} could not become resident: ${resident.error.code}.`);
    return { binding, view: resident.value.view };
  });
}

function fullscreenStorageBindings(
  input: TargetBindingsInput,
  values: BindingValues,
  fullscreen: FullscreenPass,
): { readonly binding: number; readonly buffer: Buffer }[] {
  return fullscreen.extraStorageBindings.map((binding, index) => {
    const names = values.storageBuffers;
    const name = Array.isArray(names) ? names[index] : undefined;
    if (typeof name !== 'string') throw new Error('fullscreen storage buffer name missing');
    const buffer = input.resolveGpuResource?.(name);
    if (buffer === undefined) throw new Error(`fullscreen storage buffer unavailable: ${name}`);
    return { binding, buffer: buffer.buffer };
  });
}

// Cloud history is a producer of the shared temporal ping-pong state even
// when TAA is disabled. Stage the write at encode time; execute's finish
// guard and submit transaction then give it the same abort/commit/fence
// semantics as the TAA resolve.
function stageCloudHistoryWrite(frame: _InternalRenderPipelineContext): void {
  const state = getTemporalGpuState(
    frame.frameState,
    frame.runtime.device,
    recordContext(frame.runtime).deviceScope,
    frame.targetW,
    frame.targetH,
    true,
    frame.camera,
  );
  stageTemporalGpuWrite(frame.frameState, state);
}

/** One-input fullscreen producer with optional depth and named extra inputs. */
function resolveFullscreenBindings(
  input: TargetBindingsInput,
  frame: _InternalRenderPipelineContext,
  pipeline: LayoutPipeline,
  values: BindingValues,
  featurePostProcessEntries: ReadonlyMap<string, PostProcessShaderEntry> | undefined,
): RenderFeatureGraphBindingsResolution | undefined {
  const shader = values.shader;
  if (typeof shader !== 'string') return undefined;
  const entry = postProcessEntryOf(frame, shader, featurePostProcessEntries);
  if (entry === undefined) return undefined;
  const depthTarget = fullscreenDepthTarget(input, values);
  const fullscreen = buildFullscreenPostProcessPass(
    { device: frame.runtime.device, errorRegistry: frame.runtime.errorRegistry },
    entry,
    depthTarget?.resolveTarget !== undefined,
  );
  if (fullscreen === null || fullscreen.sampler === null) return undefined;
  const inputView = fullscreenInputView(input, frame, values);
  if (inputView === undefined) return undefined;
  const depthView = fullscreenDepthView(input, frame, values, depthTarget);
  if (depthTarget !== undefined && (depthView === undefined || fullscreen.depthSampler === null)) {
    return undefined;
  }
  const logicalViews = fullscreenAdditionalViews(frame, input, values, fullscreen);
  if (logicalViews === undefined) return undefined;
  const additionalViews =
    values.assetTextures === undefined
      ? logicalViews
      : [
          ...fullscreenAssetViews(frame, values.assetTextures, fullscreen, logicalViews.length),
          ...logicalViews,
        ];
  const layout = pipeline.getBindGroupLayout?.(1);
  if (layout === undefined) return undefined;
  const paramsBuffer = frame.runtime.getPostProcessParamsBuffer?.(shader);
  if (!writePostProcessParams(frame, shader, entry, paramsBuffer)) return undefined;
  const createdBindGroup = createFullscreenBindGroup(
    frame.runtime.device,
    layout,
    inputView,
    fullscreen.sampler,
    paramsBuffer,
    depthView ?? null,
    fullscreen.depthSampler,
    additionalViews,
    fullscreenStorageBindings(input, values, fullscreen),
  );
  if (createdBindGroup === null) return undefined;
  if (shader === 'cloud-layer-resolve') stageCloudHistoryWrite(frame);
  return createdBindGroup;
}

/** Temporal fullscreen producer: current input, depth and the temporal history input. */
function resolveTemporalFullscreenBindings(
  input: TargetBindingsInput,
  frame: _InternalRenderPipelineContext,
  pipeline: LayoutPipeline,
  values: BindingValues,
  featurePostProcessEntries: ReadonlyMap<string, PostProcessShaderEntry> | undefined,
): RenderFeatureGraphBindingsResolution | undefined {
  const shader = values.shader;
  if (typeof shader !== 'string') return undefined;
  const entry = postProcessEntryOf(frame, shader, featurePostProcessEntries);
  if (entry === undefined) return undefined;
  const fullscreen = buildFullscreenPostProcessPass(
    { device: frame.runtime.device, errorRegistry: frame.runtime.errorRegistry },
    entry,
    isRenderFeatureTargetHandle(values.depth) && values.depth.sampleCount === 4,
  );
  if (fullscreen === null || fullscreen.sampler === null) return undefined;
  const inputTarget = input.resolveTarget(values.input as never);
  if (inputTarget === undefined) return undefined;
  const inputView = input.resources.textureView(inputTarget.view);
  if (!inputView.ok) return undefined;
  const layout = pipeline.getBindGroupLayout?.(1);
  if (layout === undefined) return undefined;
  const depth = input.resolveTarget(values.depth as never);
  const depthView =
    depth === undefined ? undefined : depthOnlyViewOf(frame, input.resources, depth);
  if (depth !== undefined && (depthView === undefined || fullscreen.depthSampler === null)) {
    return undefined;
  }
  const paramsBuffer = frame.runtime.getPostProcessParamsBuffer?.(shader);
  if (!writePostProcessParams(frame, shader, entry, paramsBuffer)) return undefined;
  const temporalTarget = input.resolveTarget(values.temporal as never);
  if (temporalTarget === undefined) return undefined;
  const temporalView = input.resources.textureView(temporalTarget.view);
  if (!temporalView.ok) return undefined;
  return (
    createFullscreenBindGroup(
      frame.runtime.device,
      layout,
      inputView.value,
      fullscreen.sampler,
      paramsBuffer,
      depthView ?? null,
      fullscreen.depthSampler,
      [{ binding: fullscreen.extraColorBindings[0] ?? 5, view: temporalView.value }],
    ) ?? undefined
  );
}

/** View uniform plus scene depth (binding 1) and atmosphere visibility, cached per pipeline. */
function resolveViewDepthBindings(
  input: TargetBindingsInput,
  frame: _InternalRenderPipelineContext,
  pipeline: LayoutPipeline,
  sceneDepth: BindingValues['sceneDepth'],
  viewOffset: number,
  atmosphereViews: AtmosphereViews | undefined,
  directionalShadow: TextureView | undefined,
  cloudShadow: TextureView | undefined,
): RenderFeatureGraphBindingsResolution | undefined {
  const target = sceneDepth === undefined ? undefined : input.resolveTarget(sceneDepth);
  const texture = target === undefined ? undefined : input.resources.texture(target.texture);
  if (texture !== undefined && !texture.ok) throw texture.error;
  const depth = texture?.value ?? frame.pipelineState.shadowFallbackTextureView;
  const getLayout = pipeline.getBindGroupLayout;
  const layout = getLayout?.call(pipeline, 0);
  if (layout === undefined) {
    // Preserve depth-view failure reporting even for a pipeline that cannot
    // supply this layout; this branch never publishes a cached binding.
    if (texture !== undefined) {
      const view = frame.runtime.device.createTextureView(texture.value as Texture, {
        aspect: 'depth-only',
        dimension: '2d',
      });
      if (!view.ok) throw view.error;
    }
    return undefined;
  }
  const extraEntries = [
    ...atmosphereBindings(frame.pipelineState, atmosphereViews),
    ...atmosphereMaterialVisibilityBindings(frame.pipelineState, directionalShadow, cloudShadow),
  ];
  const extraLayout = extraEntries
    .map((entry) => {
      const resource = entry.resource;
      return `${entry.binding}:${resource.kind}${
        resource.kind === 'buffer' ? `:${resource.value.offset}:${resource.value.size}` : ''
      }`;
    })
    .join(',');
  // Auto layouts are exclusive to their immutable pipeline even when each
  // getBindGroupLayout call returns a new wrapper. Keep that actual pipeline
  // and every current physical input in the existing device-local View cache.
  // Texture contents and View uploads do not replace either binding resource.
  const created = getOrCreateFromChainResult(
    frame.frameState.viewBindGroupCache,
    [
      frame.runtime.device,
      recordContext(frame.runtime).deviceScope ?? frame.runtime.device,
      pipeline,
      getLayout as object,
      frame.pipelineState.viewUniformBuffer,
      depth,
      ...extraEntries.map(extractEntryResourceHandle),
    ],
    `feature-depth-view:${texture === undefined ? 'fallback' : 'texture'}:${viewOffset}:${extraLayout}`,
    () => {
      const depthView =
        texture === undefined
          ? ok(frame.pipelineState.shadowFallbackTextureView)
          : frame.runtime.device.createTextureView(texture.value as Texture, {
              aspect: 'depth-only',
              dimension: '2d',
            });
      if (!depthView.ok) return depthView;
      return frame.runtime.device.createBindGroup({
        layout,
        entries: [
          {
            binding: 0,
            resource: {
              kind: 'buffer',
              value: {
                buffer: frame.pipelineState.viewUniformBuffer,
                offset: viewOffset,
                size: VIEW_UNIFORM_BYTES,
              },
            },
          },
          { binding: 1, resource: { kind: 'textureView', value: depthView.value } },
          ...extraEntries,
        ],
      });
    },
    frame.bindGroupCounts,
  );
  if (!created.ok) throw created.error;
  return created.value;
}

/** Full Standard View resources plus the prepared material's scene depth. */
function resolveStandardViewDepthBindings(
  input: TargetBindingsInput,
  frame: _InternalRenderPipelineContext,
  pipeline: LayoutPipeline,
  sceneDepth: BindingValues['sceneDepth'],
  viewOffset: number,
  atmosphereViews: AtmosphereViews | undefined,
  directionalShadow: TextureView | undefined,
  cloudShadow: TextureView | undefined,
): RenderFeatureGraphBindingsResolution | undefined {
  const target = sceneDepth === undefined ? undefined : input.resolveTarget(sceneDepth);
  const texture = target === undefined ? undefined : input.resources.texture(target.texture);
  if (texture !== undefined && !texture.ok) throw texture.error;
  const getLayout = pipeline.getBindGroupLayout;
  const layout = getLayout?.call(pipeline, 0);
  if (getLayout === undefined || layout === undefined) {
    // Preserve depth-view failure reporting even for a pipeline that cannot
    // supply this layout; this branch never publishes a cached binding.
    if (texture !== undefined) {
      const view = frame.runtime.device.createTextureView(texture.value as Texture, {
        aspect: 'depth-only',
        dimension: '2d',
      });
      if (!view.ok) throw view.error;
    }
    return undefined;
  }
  const viewBindGroup = buildViewBindGroup(
    frame.runtime as RenderSystemInternals,
    frame.frameState,
    frame.pipelineState,
    frame.bindGroupCounts,
    {
      atmosphere: atmosphereViews,
      directionalShadow,
      cloudShadow,
      spotShadow: frame.frameState.frameOutputs.spotShadowView ?? undefined,
      viewBindGroupLayout: layout,
      viewLayoutIdentity: [pipeline, getLayout],
      ...(texture === undefined
        ? { sceneDepth: frame.pipelineState.shadowFallbackTextureView }
        : { sceneDepthTexture: texture.value as Texture }),
    },
  );
  return viewBindGroup === null
    ? undefined
    : { handle: viewBindGroup, dynamicOffsets: [viewOffset, 0] };
}

/** A standalone scene-depth group at the declared group index. */
function resolveSceneDepthBindings(
  input: TargetBindingsInput,
  frame: _InternalRenderPipelineContext,
  pipeline: LayoutPipeline,
  sceneDepth: NonNullable<BindingValues['sceneDepth']>,
  declaredGroup: number | undefined,
): RenderFeatureGraphBindingsResolution | undefined {
  const target = input.resolveTarget(sceneDepth);
  if (target === undefined) return undefined;
  const texture = input.resources.texture(target.texture);
  if (!texture.ok) throw texture.error;
  const depthView = frame.runtime.device.createTextureView(texture.value as Texture, {
    aspect: 'depth-only',
    dimension: '2d',
  });
  if (!depthView.ok) throw depthView.error;
  const group = declaredGroup === 1 ? 1 : 0;
  const layout = pipeline.getBindGroupLayout?.(group);
  if (layout === undefined) return undefined;
  const created = frame.runtime.device.createBindGroup({
    layout,
    entries: [{ binding: 0, resource: { kind: 'textureView', value: depthView.value } }],
  });
  if (!created.ok) throw created.error;
  return created.value;
}

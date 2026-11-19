import {
  runtimeAssetReference,
  runtimeAssetRegistry,
} from '@forgeax/engine-assets-runtime/internal';
import { type EntityHandle, Time } from '@forgeax/engine-ecs';
import { PhysicsWorldResource } from '@forgeax/engine-physics';
import {
  type AssetHandle,
  err,
  isCurrentOutputPostProcessAbi,
  type MaterialAsset,
  materialPassLightMode,
  ok,
  type Result,
} from '@forgeax/engine-types';
import type { WaterSystem, WaterViewState } from '@forgeax/engine-water';
import { WATER_SYSTEM_RESOURCE, waterBodyOwnerKey } from '@forgeax/engine-water';
import { type RenderError, RenderFeatureStageFailedError } from '../errors/render';
import type {
  RenderFeaturePlan,
  RenderFeaturePlanContext,
  RenderFeatureWork,
} from '../features/plan';
import { captureFeatureSourceAssetVersion } from '../features/source';
import type { RenderFeature, RenderFeatureExtractContext } from '../features/types';
import { materialProgramInputs, waterProgramEntryPoints } from '../material-program-inputs';
import {
  captureMaterialSource,
  type MaterialSourceReferences,
  type MaterialSourceSnapshot,
  materialSourceMatchesCurrent,
  materialSourceReferences,
} from '../material-source';
import { worldRenderResources } from '../publication/resource-scope';
import { cameraNearPlaneCornerDistanceM } from '../record/helpers';
import { materialProgramSelectionsForMaterial } from '../render-system-extract';
import {
  requireWaterBodyBakedSources,
  waterMaterialEntryPointReferences,
} from './material-admission';
import type { WaterRenderView } from './view-projection';

export const WATER_UNDERWATER_FEATURE_IDENTITY = 'water-underwater-post-process';
const COPY_PROGRAM = 'forgeax.water-underwater-scene-copy';
const COPY_SOURCE = /* wgsl */ `
struct Output { @builtin(position) position: vec4<f32> };
@group(1) @binding(0) var scene: texture_2d<f32>;
@group(1) @binding(1) var sceneSampler: sampler;
@vertex fn vs_main(@builtin(vertex_index) index: u32) -> Output {
  let xy = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
  return Output(vec4<f32>(xy * 2.0 - 1.0, 0.0, 1.0));
}
@fragment fn fs_main(input: Output) -> @location(0) vec4<f32> {
  return textureLoad(scene, vec2<i32>(input.position.xy), 0);
}`;

type UnderwaterProgramInputs = Readonly<{
  entryPoints: ReturnType<typeof waterMaterialEntryPointReferences>;
  systemInputs?: Readonly<{ water: 'water-frame/3' }>;
}>;
interface UnderwaterMaterialFrame {
  readonly view: string;
  readonly world: number;
  readonly handle: number;
  readonly revision: number;
  readonly shader: string;
  readonly sourceAssets: MaterialSourceReferences;
  readonly selection: Float32Array;
  readonly state: WaterViewState;
  readonly waterMaterial?: Readonly<{
    bodyKey: string;
    viewIdentity: string;
    bodyGeneration: number;
    zoneGeneration: number;
    programInputs: UnderwaterProgramInputs;
  }>;
}
interface AcceptedUnderwaterMaterial {
  readonly contextKey: string;
  readonly source: MaterialSourceSnapshot;
  readonly references: MaterialSourceReferences;
  readonly shader: string;
  readonly views: Set<string>;
  readonly waterProgramInputs?: UnderwaterProgramInputs;
}
type UnderwaterMaterials = Map<WaterSystem, Map<string, AcceptedUnderwaterMaterial>>;
interface UnderwaterFeatureFrame {
  readonly views: readonly {
    readonly view: string;
    readonly waterView: WaterRenderView;
    readonly material?: UnderwaterMaterialFrame;
  }[];
  readonly inspection: readonly { readonly view: string; readonly waterView: WaterRenderView }[];
}

const INACTIVE_UNDERWATER_FRAME: UnderwaterFeatureFrame = Object.freeze({
  views: Object.freeze([]),
  inspection: Object.freeze([]),
});

function underwaterSourceFrame(
  context: RenderFeatureExtractContext,
  views: UnderwaterFeatureFrame['views'],
): UnderwaterFeatureFrame {
  if (views.length === 0 && !context.world.hasResource(WATER_SYSTEM_RESOURCE))
    return INACTIVE_UNDERWATER_FRAME;
  return { views, inspection: views.map(({ view, waterView }) => ({ view, waterView })) };
}

function failure(
  expected: string,
  detail: Readonly<Record<string, unknown>>,
  stage: 'extract' | 'plan' = 'extract',
): RenderError {
  return new RenderFeatureStageFailedError(
    WATER_UNDERWATER_FEATURE_IDENTITY,
    -1,
    stage,
    'next-frame',
    { expected, ...detail },
  );
}

function extractUnderwater(
  context: RenderFeatureExtractContext,
  retainedViews: Map<WaterSystem, ReadonlySet<string>>,
  retainedMaterials: UnderwaterMaterials,
): Result<UnderwaterFeatureFrame, RenderError> {
  const views: UnderwaterFeatureFrame['views'][number][] = [];
  const currentViews = new Map<WaterSystem, Set<string>>();
  for (const view of context.views) {
    const camera = view.selectedCamera;
    if (!view.render || camera === undefined) continue;
    const position = view.selectedView?.position ?? camera.position;
    const [positionX, positionY, positionZ] = position;
    if (positionX === undefined || positionY === undefined || positionZ === undefined)
      return err(
        failure('a selected camera position with three coordinates', {
          reason: 'camera-position-unavailable',
          view: view.identity,
        }),
      );
    const candidates: Extract<WaterRenderView, { kind: 'available' }>[] = [];
    const errors: Extract<WaterRenderView, { kind: 'unavailable' }>['errors'][number][] = [];
    const captureUnderwaterCandidates = () => {
      for (const [worldIndex, world] of [context.world].entries()) {
        if (!world.hasResource(WATER_SYSTEM_RESOURCE)) continue;
        const water = world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE);
        let activeViews = currentViews.get(water);
        if (activeViews === undefined) {
          activeViews = new Set();
          currentViews.set(water, activeViews);
        }
        activeViews.add(view.identity);
        const physics = world.hasResource(PhysicsWorldResource)
          ? world.getResource(PhysicsWorldResource)
          : undefined;
        const timeSeconds = world.getResource(Time).elapsed;
        const visibility = context.visibilitySnapshot;
        const selected = water.updateViewState(
          {
            viewId: view.identity,
            traceGeneration: context.frameNumber,
            positionM: [positionX, positionY, positionZ],
            timeSeconds,
            nearPlaneCornerDistanceM: cameraNearPlaneCornerDistanceM(camera),
            postProcessEnabled: camera.postProcessing !== false,
          },
          physics,
          visibility === undefined
            ? undefined
            : (body) =>
                body.instanceEntity === undefined ||
                visibility.effective(body.instanceEntity as EntityHandle) !== 'hidden',
        );
        if (!selected.ok) {
          errors.push({ world: worldIndex, error: selected.error });
          context.reportError?.(
            failure(selected.error.expected, { cause: selected.error, world: worldIndex }),
          );
        } else candidates.push({ kind: 'available', world: worldIndex, state: selected.value });
      }
    };
    captureUnderwaterCandidates();
    candidates.sort(
      (a, b) =>
        Number(b.state.selectedBody !== undefined) - Number(a.state.selectedBody !== undefined) ||
        (b.state.postProcess?.priority ?? 0) - (a.state.postProcess?.priority ?? 0) ||
        a.world - b.world,
    );
    const selected = candidates[0];
    if (selected === undefined) {
      if (errors.length > 0)
        views.push({ view: view.identity, waterView: { kind: 'unavailable', errors } });
      continue;
    }
    const state = selected.state;
    const projection: {
      view: string;
      waterView: WaterRenderView;
      material?: UnderwaterMaterialFrame;
    } = { view: view.identity, waterView: selected };
    views.push(projection);
    if (!state.visualPpActive || state.postProcess === undefined) continue;
    const worldIndex = selected.world;
    const world = context.world;
    if (world === undefined)
      return err(
        failure('the selected Water world is retained for this frame', {
          reason: 'selected-world-unavailable',
          world: worldIndex,
        }),
      );
    const timeSeconds = world.getResource(Time).elapsed;
    if (world.assets === undefined) {
      context.reportError?.(
        failure('an ordinary loaded underwater material', {
          reason: 'asset-owner-unavailable',
          world: worldIndex,
        }),
      );
      continue;
    }
    const water = world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE);
    const registry = runtimeAssetRegistry(world.assets);
    const resources = worldRenderResources(world);
    const handle = runtimeAssetReference(registry, state.postProcess.materialGuid);
    const contextKey = JSON.stringify(context.materialContext ?? null) ?? 'null';
    const consumer = state.selectedBody ?? `view:${view.identity}`;
    let materials = retainedMaterials.get(water);
    if (materials === undefined) {
      materials = new Map();
      retainedMaterials.set(water, materials);
    }
    const previous = materials.get(consumer);
    let accepted = previous?.contextKey === contextKey ? previous : undefined;
    const refreshUnderwaterMaterial = (
      checkedState: WaterViewState & {
        readonly postProcess: NonNullable<WaterViewState['postProcess']>;
      },
    ) => {
      if (
        accepted === undefined ||
        accepted.source.root !== handle ||
        !materialSourceMatchesCurrent(resources, accepted.source)
      ) {
        const admitUnderwaterMaterial = (
          state: WaterViewState & {
            readonly postProcess: NonNullable<WaterViewState['postProcess']>;
          },
        ) => {
          try {
            const current =
              handle === undefined ? undefined : resources.resolveAsset<MaterialAsset>(handle);
            if (handle === undefined || current?.ok !== true || current.value.kind !== 'material')
              throw failure('an ordinary loaded underwater material', {
                reason: 'material-unavailable',
              });
            const material = current.value;
            const pass = material.passes?.find(
              (entry) => materialPassLightMode(entry) === 'PostProcess',
            );
            if (pass === undefined)
              throw failure('an explicit PostProcess pass', {
                reason: 'post-process-pass-missing',
              });
            const program = materialProgramSelectionsForMaterial(
              material,
              registry,
              context.materialContext,
            )?.find((entry) => entry.pass === pass.name);
            if (program === undefined || !isCurrentOutputPostProcessAbi(program.abi))
              throw failure('a cooked reflected fullscreen PostProcess ABI', {
                reason: 'post-process-abi-unavailable',
              });
            const artifact = registry.shaderRegistry.findMaterialArtifact(
              program.specializationKey,
            );
            const inputs = artifact.ok ? materialProgramInputs(artifact.value) : undefined;
            const points = waterProgramEntryPoints(inputs);
            if (program.abi.systemInputs?.water === 'water-frame/3' && points === undefined)
              throw failure('cooked Water system resource reflection', {
                reason: 'post-process-water-reflection-unavailable',
              });
            if (points !== undefined) {
              const body =
                state.selectedBody === undefined ? undefined : water.snapshot(state.selectedBody);
              if (body === undefined || body.sceneGeneration !== state.selectedBodyGeneration)
                throw failure('a selected current Body for the candidate Water material', {
                  reason: 'selected-water-frame-source-unavailable',
                });
              requireWaterBodyBakedSources(
                water,
                [{ guid: body.guid, generation: body.sceneGeneration }],
                inputs === undefined ? [] : [inputs],
              );
            }
            const retainUnderwaterMaterialSource = (
              checkedHandle: AssetHandle,
              checkedInputs: typeof inputs,
              checkedPoints: typeof points,
            ) => {
              const source = captureMaterialSource(resources, checkedHandle);
              if (source === undefined)
                throw new Error('Accepted material source payload is unavailable');
              accepted = Object.freeze({
                contextKey,
                source,
                references: materialSourceReferences(source),
                views: previous?.views ?? new Set<string>(),
                shader: program.specializationKey,
                ...(checkedInputs === undefined || checkedPoints === undefined
                  ? {}
                  : {
                      waterProgramInputs: Object.freeze({
                        ...checkedInputs,
                        entryPoints: waterMaterialEntryPointReferences(checkedPoints),
                      }),
                    }),
              });
              materials.set(consumer, accepted);
            };
            retainUnderwaterMaterialSource(handle, inputs, points);
          } catch (cause) {
            context.reportError?.(
              failure(
                'an admissible underwater material replacement with complete source closure',
                {
                  cause,
                  guid: state.postProcess.materialGuid,
                },
              ),
            );
          }
        };
        admitUnderwaterMaterial(
          checkedState as WaterViewState & {
            readonly postProcess: NonNullable<WaterViewState['postProcess']>;
          },
        );
      }
    };
    refreshUnderwaterMaterial(
      state as WaterViewState & {
        readonly postProcess: NonNullable<WaterViewState['postProcess']>;
      },
    );
    if (accepted === undefined) continue;
    accepted.views.add(view.identity);
    const publishUnderwaterMaterialProjection = (
      accepted: AcceptedUnderwaterMaterial,
      checkedState: WaterViewState & {
        readonly postProcess: NonNullable<WaterViewState['postProcess']>;
      },
    ) => {
      try {
        for (const asset of accepted.source.assets) {
          if (asset.value === undefined)
            throw new Error('Accepted material source payload is unavailable');
          const referenced = captureFeatureSourceAssetVersion(context, asset.handle, {
            revision: asset.revision,
            value: asset.value,
          });
          if (referenced?.ok !== true)
            throw referenced?.error ?? new Error('Exact material source transport is unavailable');
        }
        let waterMaterial: UnderwaterMaterialFrame['waterMaterial'];
        if (accepted.waterProgramInputs !== undefined) {
          const body =
            checkedState.selectedBody === undefined
              ? undefined
              : water.snapshot(checkedState.selectedBody);
          if (body === undefined || body.sceneGeneration !== checkedState.selectedBodyGeneration) {
            context.reportError?.(
              failure('a selected current Body and cooked Water system resource reflection', {
                reason: 'selected-water-frame-source-unavailable',
                bodyGuid: checkedState.selectedBody,
                bodyGeneration: checkedState.selectedBodyGeneration,
              }),
            );
            return;
          }
          const zoneGeneration = body.binding.kind === 'bound' ? body.binding.zoneGeneration : 0;
          waterMaterial = {
            bodyKey: waterBodyOwnerKey(
              world.identity,
              body.guid,
              body.sceneGeneration,
              zoneGeneration,
            ),
            viewIdentity: view.identity,
            bodyGeneration: body.sceneGeneration,
            zoneGeneration,
            programInputs: accepted.waterProgramInputs,
          };
        }
        projection.material = {
          view: view.identity,
          world: worldIndex,
          handle: accepted.source.root,
          revision: accepted.source.revision,
          shader: accepted.shader,
          sourceAssets: accepted.references,
          selection: new Float32Array([
            positionY + checkedState.immersionDepthM,
            checkedState.immersionDepthM,
            checkedState.postProcess.blendWeight,
            timeSeconds,
          ]),
          state: checkedState,
          ...(waterMaterial === undefined ? {} : { waterMaterial }),
        };
      } catch (cause) {
        context.reportError?.(
          failure('the selected PostProcess specialization is cooked for this renderer', {
            cause,
            guid: checkedState.postProcess.materialGuid,
          }),
        );
      }
    };
    publishUnderwaterMaterialProjection(
      accepted,
      state as WaterViewState & {
        readonly postProcess: NonNullable<WaterViewState['postProcess']>;
      },
    );
  }
  const releaseUnusedUnderwaterViews = () => {
    for (const [water, previous] of retainedViews)
      for (const identity of previous)
        if (!currentViews.get(water)?.has(identity)) water.releaseViewState(identity);
    retainedViews.clear();
    for (const [water, identities] of currentViews) retainedViews.set(water, identities);
    for (const [water, materials] of retainedMaterials) {
      const active = currentViews.get(water);
      if (active === undefined) {
        retainedMaterials.delete(water);
        continue;
      }
      for (const [consumer, material] of materials) {
        for (const view of material.views) if (!active.has(view)) material.views.delete(view);
        if (
          material.views.size === 0 ||
          (consumer.startsWith('view:')
            ? !active.has(consumer.slice(5))
            : water.snapshot(consumer) === undefined)
        )
          materials.delete(consumer);
      }
    }
  };
  releaseUnusedUnderwaterViews();
  return ok(underwaterSourceFrame(context, views));
}

/** The selected ordinary cooked material owns transport; the feature owns only scene inputs. */
export function createWaterUnderwaterFeature(): RenderFeature<UnderwaterFeatureFrame> {
  const retainedViews = new Map<WaterSystem, ReadonlySet<string>>();
  const retainedMaterials: UnderwaterMaterials = new Map();
  return Object.freeze({
    identity: WATER_UNDERWATER_FEATURE_IDENTITY,
    inactiveSourceData: INACTIVE_UNDERWATER_FRAME,
    placement: 'after-tonemap' as const,
    requiredFullscreenPostProcesses: [{ identity: COPY_PROGRAM, source: COPY_SOURCE }],
    extract: (context: RenderFeatureExtractContext) =>
      extractUnderwater(context, retainedViews, retainedMaterials),
    requiresPreparation: (data: UnderwaterFeatureFrame) =>
      data.views.some(
        ({ waterView }) => waterView.kind === 'available' && waterView.state.visualPpActive,
      ),
    assetDependencies: (data: UnderwaterFeatureFrame) =>
      data.views.flatMap((view) => (view.material === undefined ? [] : [view.material.handle])),
    plan: (
      data: UnderwaterFeatureFrame,
      context: RenderFeaturePlanContext,
    ): Result<RenderFeaturePlan, RenderError> => {
      const work: RenderFeatureWork[] = [];
      for (const selected of data.views) {
        const material = selected.material;
        if (material === undefined) {
          if (selected.waterView.kind === 'available' && selected.waterView.state.visualPpActive)
            return err(
              failure(
                'the selected visual underwater PostProcess material is available',
                {
                  reason: 'selected-post-process-unavailable',
                  view: selected.view,
                  guid: selected.waterView.state.postProcess?.materialGuid,
                },
                'plan',
              ),
            );
          work.push({
            scope: { view: selected.view },
            waterView: selected.waterView,
            resources: [],
            passes: [],
          });
          continue;
        }
        const view = context.views.find((entry) => entry.identity === material.view);
        const color = view?.targets.find((target) => target.name === 'color');
        const depth = view?.targets.find((target) => target.kind === 'depth');
        const width = view?.frame.extent?.outputWidth ?? view?.frame.width;
        const height = view?.frame.extent?.outputHeight ?? view?.frame.height;
        if (
          color?.format !== 'rgba16float' ||
          color.sampleCount !== 1 ||
          depth?.sampleCount !== 1 ||
          width === undefined ||
          height === undefined
        )
          return err(
            failure(
              'single-sample after-tonemap color and real scene depth',
              {
                reason: 'post-process-targets-unavailable',
                view: material.view,
              },
              'plan',
            ),
          );
        const fullscreenDraw = (program: string, bindings: readonly string[]) => ({
          program,
          bindings,
          vertexData: [],
          vertexLayout: 'none' as const,
          draw: { kind: 'draw' as const, vertexCount: 3, instanceCount: 1 },
        });
        work.push({
          scope: { view: material.view },
          waterView: selected.waterView,
          resources: [
            {
              kind: 'graph-texture',
              name: 'underwater-scene',
              allocationKey: 'underwater-scene',
              descriptor: {
                format: color.format,
                size: { width, height, depthOrArrayLayers: 1 },
                sampleCount: 1,
              },
            },
            {
              kind: 'buffer',
              name: 'underwater-selection',
              size: 16,
              usage: ['uniform'],
              data: material.selection,
            },
            {
              kind: 'fullscreen-program',
              name: COPY_PROGRAM,
              source: COPY_SOURCE,
              reads: ['input'],
            },
            {
              kind: 'graphics-program',
              name: 'underwater-copy-pipeline',
              program: {
                shader: COPY_PROGRAM,
                preparePipelines: true,
                vertexLayout: 'none',
                colorFormats: [color.format],
                sampleCount: 1,
              },
            },
            {
              kind: 'graphics-bindings',
              name: 'underwater-copy-bindings',
              program: 'underwater-copy-pipeline',
              values: { group: 1, fullscreen: true, shader: COPY_PROGRAM, input: 'color' },
              logicalTargets: { input: 'color' },
            },
            {
              kind: 'graphics-program',
              name: 'underwater-material-pipeline',
              program: {
                shader: material.shader,
                preparePipelines: true,
                vertexLayout: 'none',
                colorFormats: [color.format],
                sampleCount: 1,
              },
            },
            {
              kind: 'graphics-bindings',
              name: 'underwater-view',
              program: 'underwater-material-pipeline',
              values: {
                group: 0,
                postProcess: true,
                sceneColor: 'underwater-scene',
                sceneDepth: depth.name,
                passInputBuffer: 'underwater-selection',
                uniformBuffers: ['underwater-selection'],
              },
              logicalTargets: { sceneColor: 'underwater-scene', sceneDepth: depth.name },
            },
            {
              kind: 'graphics-bindings',
              name: 'underwater-parameters',
              program: 'underwater-material-pipeline',
              values: {
                group: 1,
                material: {
                  world: material.world,
                  handle: material.handle,
                  revision: material.revision,
                  sourceAssets: material.sourceAssets,
                },
              },
            },
            ...(material.waterMaterial === undefined
              ? []
              : [
                  {
                    kind: 'graphics-bindings' as const,
                    name: 'underwater-water-frame',
                    program: 'underwater-material-pipeline',
                    values: { group: 2, waterMaterial: material.waterMaterial },
                  },
                ]),
          ],
          passes: [
            {
              kind: 'raster',
              name: 'underwater-scene-copy',
              colorAttachments: [{ target: 'underwater-scene', loadOp: 'clear', storeOp: 'store' }],
              sampledTargets: ['color'],
              draws: [fullscreenDraw('underwater-copy-pipeline', ['underwater-copy-bindings'])],
            },
            {
              kind: 'raster',
              name: 'underwater-cooked-post-process',
              colorAttachments: [{ target: 'color', loadOp: 'load', storeOp: 'store' }],
              sampledTargets: ['underwater-scene', depth.name],
              sceneDepth: 'before-pass',
              draws: [
                fullscreenDraw('underwater-material-pipeline', [
                  'underwater-view',
                  'underwater-parameters',
                  ...(material.waterMaterial === undefined ? [] : ['underwater-water-frame']),
                ]),
              ],
            },
          ],
        });
      }
      return ok({ work });
    },
  });
}

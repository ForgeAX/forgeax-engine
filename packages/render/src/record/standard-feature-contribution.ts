import type { GraphAccess, RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { TextureFormat } from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-types';
import { atmosphereAccesses } from '../environment/luts';
import { type RenderError, RenderFeatureStageFailedError } from '../errors/render';
import {
  type FeatureGraphConformanceEvent,
  recordFeatureGraphConformanceEvent,
} from '../features/feature-graph-conformance-trace';
import type { RenderFeaturePlanExecution } from '../features/host';
import type { createRenderFeatureProjectionState } from '../features/render-graph-contribution';
import { isRenderFeatureTargetHandle, POST_PROCESS_OUTPUT_DEPTH } from '../features/targets';
import { projectTransientViewPlans } from '../features/transient-view-graph';
import type { PostProcessShaderEntry } from '../fullscreen-post-process-pass';
import type {
  RenderPipelineBuildContext,
  RenderPipelineFrame,
  RenderPipelineTarget,
} from '../render-pipeline';
import { recordContext } from '../world/view-record-context';
import type { RenderFrameState } from './frame-snapshot';
import type { RenderSystemInternals } from './render-context';
import {
  projectSceneDataSampledViews,
  resolveTargetBindings,
  targetResolver,
} from './typed-frame-graph-bindings';

type ContributionRequest = Parameters<
  NonNullable<RenderPipelineBuildContext<RenderPipelineFrame>['contributeFeatures']>
>[0];
type Contribution = NonNullable<
  RenderPipelineBuildContext<RenderPipelineFrame>['contributeFeatures']
>;
type FeatureSceneInputs = NonNullable<
  ReturnType<NonNullable<RenderSystemInternals['featureSceneInputs']>['import']>
>;
type ProjectionState = ReturnType<typeof createRenderFeatureProjectionState>;

interface StandardFeatureContributionContext {
  readonly internals: RenderSystemInternals;
  readonly frameState: RenderFrameState;
  readonly builder: RenderGraphBuilder<RenderPipelineFrame>;
  readonly projectedFeaturePlans: readonly RenderFeaturePlanExecution[];
  readonly featurePostProcessEntries: ReadonlyMap<string, PostProcessShaderEntry>;
  readonly fullscreenFeatureIds: ReadonlySet<string>;
  readonly featureProjection: ProjectionState;
  readonly sceneDataDepthViews: Map<RenderPipelineTarget['texture'], RenderPipelineTarget['view']>;
  readonly transientViews: ReadonlySet<string>;
  readonly transientSlots: Map<string, { complete: boolean; names: Set<string> }>;
  readonly sceneInputs: FeatureSceneInputs | undefined;
  readonly surfaceSize: { readonly width: number; readonly height: number };
  readonly reportError: (error: RenderError) => void;
}

interface FeatureSelection {
  readonly executions: readonly RenderFeaturePlanExecution[];
  readonly traceExecution: RenderFeaturePlanExecution | undefined;
  readonly reason: string;
  readonly selectedPassNames: readonly string[];
}

function selectionReason(
  context: StandardFeatureContributionContext,
  request: ContributionRequest,
  execution: RenderFeaturePlanExecution,
  selected: boolean,
  selectedPassNames: readonly string[],
): string {
  const fullscreenDeferred =
    Object.keys(request.namedTargets ?? {}).length === 0 &&
    context.fullscreenFeatureIds.has(execution.featureIdentity);
  if (fullscreenDeferred) return 'fullscreen-deferred';
  if ((execution.placement ?? 'post') !== (request.placement ?? 'post')) return 'placement-filter';
  if (request.include !== undefined && !request.include.includes(execution.featureIdentity))
    return 'include-filter';
  if (request.exclude?.includes(execution.featureIdentity)) return 'exclude-filter';
  if (!selected) return 'not-selected';
  if (selectedPassNames.length === 0) return 'pass-name-filter';
  return 'selected';
}

function selectedPassNames(
  execution: RenderFeaturePlanExecution,
  allowed: readonly string[],
): readonly string[] {
  return execution.passes
    .filter((pass) => allowed.length === 0 || allowed.includes(pass.name))
    .map((pass) => pass.name);
}

function selectFeatureExecutions(
  context: StandardFeatureContributionContext,
  request: ContributionRequest,
): FeatureSelection {
  const namedTargets = request.namedTargets ?? {};
  const trace = context.internals.featureGraphConformanceTrace;
  const traceExecution =
    trace === undefined
      ? undefined
      : context.projectedFeaturePlans.find((row) => row.featureIdentity === trace.featureIdentity);
  const executions = (
    Object.keys(namedTargets).length === 0
      ? context.projectedFeaturePlans.filter(
          (row) => !context.fullscreenFeatureIds.has(row.featureIdentity),
        )
      : context.projectedFeaturePlans
  )
    .filter((row) => (row.placement ?? 'post') === (request.placement ?? 'post'))
    .filter((row) => request.include === undefined || request.include.includes(row.featureIdentity))
    .filter((row) => !request.exclude?.includes(row.featureIdentity));
  const passNames =
    traceExecution === undefined ? [] : selectedPassNames(traceExecution, request.passNames ?? []);
  return {
    executions,
    traceExecution,
    reason:
      traceExecution === undefined
        ? 'target-execution-absent'
        : selectionReason(
            context,
            request,
            traceExecution,
            executions.includes(traceExecution),
            passNames,
          ),
    selectedPassNames: passNames,
  };
}

function recordFeatureSelection(
  context: StandardFeatureContributionContext,
  request: ContributionRequest,
  selection: FeatureSelection,
): void {
  const trace = context.internals.featureGraphConformanceTrace;
  if (trace === undefined) return;
  const traceExecution = selection.traceExecution;
  const details: FeatureGraphConformanceEvent['details'] = {
    targetExecutionPresent: traceExecution !== undefined,
    requestedPlacement: request.placement ?? 'post',
    namedTargetCount: Object.keys(request.namedTargets ?? {}).length,
    selected: traceExecution !== undefined && selection.executions.includes(traceExecution),
    reason: selection.reason,
    sourcePassNames: traceExecution?.passes.map((pass) => pass.name) ?? [],
    selectedPassNames: selection.selectedPassNames,
    allowedPassNames: request.passNames ?? [],
    ...(traceExecution === undefined
      ? {}
      : { executionPlacement: traceExecution.placement ?? 'post' }),
  };
  recordFeatureGraphConformanceEvent(trace, {
    recordFrameNumber: context.frameState.frameNumber,
    featureIdentity: trace.featureIdentity,
    stage: 'standard-scene-selection',
    details,
  });
}

type FeatureTargetResolution =
  | {
      readonly ok: true;
      readonly resolveTarget: ReturnType<typeof targetResolver>;
      readonly viewAccesses: readonly GraphAccess[];
    }
  | {
      readonly ok: false;
      readonly error: import('@forgeax/engine-render-graph').RenderGraphError | RenderError;
    };

function resolveFeatureTargets(
  context: StandardFeatureContributionContext,
  request: ContributionRequest,
): FeatureTargetResolution {
  const projected = projectSceneDataSampledViews(
    context.builder,
    request.semanticTargets ?? [],
    context.sceneDataDepthViews,
  );
  if (!projected.ok) return { ok: false, error: projected.error };
  const resolveDisplayTarget = targetResolver(
    request.targets,
    projected.value,
    request.namedTargets ?? {},
  );
  const resolveTarget: ReturnType<typeof targetResolver> = (target) =>
    (typeof target === 'object'
      ? context.sceneInputs?.get(target as import('../features/targets').RenderFeatureTargetHandle)
      : undefined) ?? resolveDisplayTarget(target);
  const viewAccesses: GraphAccess[] =
    request.atmosphere === undefined ? [] : atmosphereAccesses(request.atmosphere);
  for (const target of request.waterInfoTargets?.values() ?? [])
    viewAccesses.push({ resource: target.view, usage: 'sampled-read' });
  return { ok: true, resolveTarget, viewAccesses };
}

function projectSelectedExecutions(
  context: StandardFeatureContributionContext,
  request: ContributionRequest,
  executions: readonly RenderFeaturePlanExecution[],
): ReturnType<Contribution> {
  const targets = resolveFeatureTargets(context, request);
  if (!targets.ok) return err(targets.error);
  const standardSurfaceAccesses = request.standardSurfaceAccesses ?? [];
  const projected = projectTransientViewPlans(
    context.builder,
    executions,
    context.transientViews,
    {
      state: context.featureProjection,
      resolveTarget: targets.resolveTarget,
      placement: request.placement ?? 'post',
      ...(request.passNames === undefined || request.passNames.length === 0
        ? {}
        : { passNames: new Set(request.passNames) }),
      standardSurfaceAccesses,
      viewAccesses: targets.viewAccesses,
      resolveBindings: (input) =>
        resolveTargetBindings(
          {
            ...input,
            resolveCloudBlueNoise: recordContext(context.internals).featureSceneInputs
              ?.cloudBlueNoise,
          },
          context.featurePostProcessEntries,
          request.atmosphere,
          request.waterInfoTargets,
          request.unjitteredDepth,
        ),
      reportError: context.reportError,
    },
    {
      owner: context.internals,
      device: context.internals.device,
      surfaceSize: context.surfaceSize,
      slots: context.transientSlots,
      ports: [
        ...standardSurfaceAccesses,
        ...targets.viewAccesses,
        ...request.targets.flatMap((target) => [
          {
            resource: target.view,
            usage:
              target.kind === 'scene-depth'
                ? ('depth-stencil-write' as const)
                : ('color-attachment' as const),
          },
          ...(target.kind === 'scene-depth'
            ? [{ resource: target.view, usage: 'sampled-read' as const }]
            : []),
          ...(target.resolveTarget === undefined
            ? []
            : [{ resource: target.resolveTarget, usage: 'color-attachment' as const }]),
        ]),
      ],
    },
  );
  if (!projected.ok) return projected;
  return ok(undefined);
}

function isCurrentColor(resource: unknown): boolean {
  return (
    resource === 'color' ||
    (isRenderFeatureTargetHandle(resource) &&
      resource.kind === 'scene-color' &&
      (resource.name === undefined || resource.name === 'color'))
  );
}

function isOutputDepth(resource: unknown): boolean {
  return (
    resource === POST_PROCESS_OUTPUT_DEPTH ||
    (isRenderFeatureTargetHandle(resource) &&
      resource.kind === 'scene-depth' &&
      resource.name === POST_PROCESS_OUTPUT_DEPTH)
  );
}

/** Analyze the physical attachment and read roles of the same plans we project. */
export function standardAfterTonemapOutput(
  executions: readonly RenderFeaturePlanExecution[],
  fullscreenFeatureIds: ReadonlySet<string>,
  endpointFormat: TextureFormat,
): Exclude<RenderPipelineBuildContext<RenderPipelineFrame>['afterTonemapOutput'], undefined> {
  let needsIntermediate = false;
  let needsOutputDepth = false;
  let hasWork = false;
  const endpointFeatures: string[] = [];
  for (const execution of executions) {
    if (
      execution.placement !== 'after-tonemap' ||
      execution.passes.length === 0 ||
      fullscreenFeatureIds.has(execution.featureIdentity)
    )
      continue;
    hasWork = true;
    let writesEndpoint = false;
    for (const pass of execution.passes) {
      needsOutputDepth ||=
        pass.graphics?.sampledTargets?.some(isOutputDepth) === true ||
        pass.resolvedGpuCompute?.sampledTargets?.some(isOutputDepth) === true;
      for (const { resource, format } of pass.graphics?.attachments.colors ?? []) {
        if (resource === 'swapchain') writesEndpoint = true;
        if (isCurrentColor(resource) && format !== endpointFormat) needsIntermediate = true;
      }
      if (
        pass.graphics?.sampledTargets?.some(isCurrentColor) ||
        pass.resolvedGpuCompute?.sampledTargets?.some(isCurrentColor) ||
        pass.resolvedGpuCompute?.storageTargets?.some(isCurrentColor) ||
        pass.textureReadbacks?.some(({ target }) => isCurrentColor(target))
      )
        needsIntermediate = true;
    }
    if (writesEndpoint) endpointFeatures.push(execution.featureIdentity);
  }
  return hasWork ? { needsIntermediate, endpointFeatures, needsOutputDepth } : null;
}

export function standardFeatureContribution(
  context: StandardFeatureContributionContext,
): Contribution {
  return (request) => {
    const selection = selectFeatureExecutions(context, request);
    recordFeatureSelection(context, request, selection);
    if (selection.executions.length === 0) return ok(undefined);
    if (
      request.placement === 'after-tonemap' &&
      request.targets.some(({ name }) => name === 'swapchain')
    ) {
      const mixed = selection.executions.find((execution) =>
        execution.passes.some(
          (pass) =>
            pass.graphics?.attachments.colors.some(({ resource }) => isCurrentColor(resource)) ||
            pass.resolvedGpuCompute?.storageTargets?.some(isCurrentColor),
        ),
      );
      if (mixed !== undefined)
        return err(
          new RenderFeatureStageFailedError(
            mixed.featureIdentity,
            mixed.order,
            'plan',
            'next-frame',
            {
              kind: 'after-tonemap-output',
              expected:
                'terminal overlay work writes swapchain and uses current color only as input',
            },
          ),
        );
    }
    return projectSelectedExecutions(context, request, selection.executions);
  };
}

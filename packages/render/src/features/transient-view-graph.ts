import {
  type GraphAccess,
  type RenderGraphBuilder,
  RenderGraphError,
  type RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import { type RenderError, RenderFeatureStageFailedError } from '../errors/render';
import type { RenderFeatureExecutionFrame } from './frame-execution';
import {
  type RenderFeaturePlanExecution,
  renderFeaturePlanRequiresPreparedResourceKey,
} from './host';
import type { RenderFeaturePlannedFrame } from './plan';
import { encodeRenderFeatureGpuComputePass } from './prepared-gpu-work';
import { throwFeatureRecordingFailure } from './recording-failure';
import { visitRenderFeatureComputeSequence } from './render-graph-compute';
import { projectRenderFeaturePlans } from './render-graph-contribution';
import { RenderFeatureRasterGraphProjection } from './render-graph-raster';
import { isRenderFeatureTargetHandle } from './targets';

export interface TransientViewGraphInspection {
  readonly selectedPlans: number;
  readonly childBuilds: number;
  readonly childBuildCpuMs: number;
  readonly childCompiles: number;
  readonly childCompileCpuMs: number;
  readonly childFailures: number;
  readonly commandFrames: number;
  readonly commandPasses: number;
}

const inspections = new WeakMap<
  object,
  {
    selectedPlans: number;
    childBuilds: number;
    childBuildCpuMs: number;
    childCompiles: number;
    childCompileCpuMs: number;
    childFailures: number;
    commandFrames: number;
    commandPasses: number;
  }
>();

function inspection(owner: object) {
  let value = inspections.get(owner);
  if (value === undefined) {
    value = {
      selectedPlans: 0,
      childBuilds: 0,
      childBuildCpuMs: 0,
      childCompiles: 0,
      childCompileCpuMs: 0,
      childFailures: 0,
      commandFrames: 0,
      commandPasses: 0,
    };
    inspections.set(owner, value);
  }
  return value;
}

export function inspectTransientViewGraphs(owner: object): TransientViewGraphInspection {
  return Object.freeze({ ...inspection(owner) });
}

function standardTarget(target: unknown): boolean {
  if (typeof target === 'string') return ['color', 'linear-hdr', 'depth'].includes(target);
  return (
    isRenderFeatureTargetHandle(target) &&
    (target.kind === 'scene-depth'
      ? target.name === undefined || target.name === 'depth'
      : target.name === undefined || target.name === 'color' || target.name === 'linear-hdr')
  );
}

/** Reject cross-stage work; the ordinary exact plan remains the fallback. */
export function transientViewExecutionEligible(execution: RenderFeaturePlanExecution): boolean {
  if (!execution.scope?.startsWith('view:') || (execution.placement ?? 'post') !== 'post')
    return false;
  return execution.passes.every((pass) => {
    if (pass.shadowCaster) return false;
    if (pass.resolvedGpuCopies !== undefined) return true;
    if (pass.resolvedGpuCompute !== undefined)
      return (
        (pass.resolvedGpuCompute.sampledTargets?.length ?? 0) === 0 &&
        (pass.resolvedGpuCompute.storageTargets?.length ?? 0) === 0
      );
    const graphics = pass.graphics;
    return (
      graphics !== undefined &&
      pass.resolvedGraphics !== undefined &&
      graphics.sceneDepth !== 'before-pass' &&
      graphics.attachments.colors.every(
        (color) =>
          color.loadOp === 'load' && color.storeOp === 'store' && standardTarget(color.resource),
      ) &&
      (graphics.attachments.depthStencil === undefined ||
        (standardTarget(graphics.attachments.depthStencil.resource) &&
          graphics.attachments.depthStencil.depthLoadOp === 'load' &&
          graphics.attachments.depthStencil.depthStoreOp === 'store')) &&
      (graphics.sampledTargets ?? []).every(
        (target) =>
          standardTarget(target) &&
          (typeof target === 'string' ? target === 'depth' : target.kind === 'scene-depth'),
      )
    );
  });
}

interface TransientViewSelection {
  readonly identities: ReadonlySet<string>;
  readonly topologySignature: string | undefined;
  readonly ownsPhysicalChanges: boolean;
}

const transientResourceKinds = new Set([
  'buffer',
  'compute-program',
  'compute-bindings',
  'graphics-program',
  'graphics-bindings',
  'vertex-data',
  'index-data',
]);

interface ParentPlanEntry {
  readonly identity: string;
  readonly scope: string;
  readonly generation: number;
  readonly order: number | undefined;
  readonly placement: string;
  readonly signature: string;
}
const parentRevisions = new WeakMap<
  object,
  { revision: number; entries: readonly ParentPlanEntry[] }
>();

function parentPlanSignature(
  owner: object,
  plans: readonly RenderFeaturePlannedFrame[],
  executions: readonly RenderFeaturePlanExecution[],
  isolated: ReadonlySet<string>,
): string {
  const previous = parentRevisions.get(owner);
  const scope = (plan: RenderFeaturePlannedFrame) =>
    typeof plan.scope === 'string' ? plan.scope : `view:${plan.scope.view}`;
  const signature = (plan: RenderFeaturePlannedFrame) =>
    isolated.has(plan.featureIdentity) ? 'transient-view' : plan.signature;
  if (
    previous !== undefined &&
    previous.entries.length === plans.length &&
    plans.every((plan, i) => {
      const row = previous.entries[i];
      return (
        row !== undefined &&
        row.identity === plan.featureIdentity &&
        row.scope === scope(plan) &&
        row.generation === plan.generation &&
        row.order === executions[i]?.order &&
        row.placement === (plan.placement ?? 'post') &&
        row.signature === signature(plan)
      );
    })
  )
    return `transient-view-${previous.revision}`;
  const next = {
    revision: (previous?.revision ?? 0) + 1,
    entries: plans.map((plan, i) => ({
      identity: plan.featureIdentity,
      scope: scope(plan),
      generation: plan.generation,
      order: executions[i]?.order,
      placement: plan.placement ?? 'post',
      signature: signature(plan),
    })),
  };
  parentRevisions.set(owner, next);
  return `transient-view-${next.revision}`;
}

/** Keep Host signatures intact; partition only the Standard graph dependency. */
export function selectTransientViewPlans(
  owner: object,
  plans: readonly RenderFeaturePlannedFrame[],
  executions: readonly RenderFeaturePlanExecution[],
  enabled: boolean,
  scopeOwner: object = owner,
): TransientViewSelection {
  const identities = new Set<string>();
  const unsupported = new Set<string>();
  // Shadow hoisting can cross feature boundaries. Keep its complete old path.
  if (enabled && !executions.some((row) => row.passes.some((pass) => pass.shadowCaster)))
    for (let i = 0; i < plans.length; i++) {
      const planned = plans[i];
      const execution = executions[i];
      if (
        planned?.viewGraph === 'transient' &&
        typeof planned.scope !== 'string' &&
        planned.plan.resources.every((resource) => transientResourceKinds.has(resource.kind)) &&
        execution !== undefined &&
        execution.scope === `view:${planned.scope.view}` &&
        transientViewExecutionEligible(execution)
      )
        identities.add(planned.featureIdentity);
      else if (planned?.viewGraph === 'transient' && typeof planned.scope !== 'string')
        unsupported.add(planned.featureIdentity);
    }
  for (const identity of unsupported) identities.delete(identity);
  if (identities.size === 0)
    return { identities, topologySignature: undefined, ownsPhysicalChanges: false };
  inspection(owner).selectedPlans += identities.size;
  return {
    identities,
    topologySignature: parentPlanSignature(scopeOwner, plans, executions, identities),
    ownsPhysicalChanges: plans.every(
      (planned) =>
        identities.has(planned.featureIdentity) ||
        !renderFeaturePlanRequiresPreparedResourceKey(planned),
    ),
  };
}

type ProjectionOptions<F extends RenderGraphFrame> = Parameters<
  typeof projectRenderFeaturePlans<F>
>[2];

function portFailure(): RenderGraphError {
  return new RenderGraphError({
    code: 'resource-descriptor-invalid',
    expected: 'a transient view borrows declared parent resources with exact physical descriptors',
    hint: 'use the monolithic path for unsupported external resource contracts',
    detail: {
      resourceLabel: 'transient-view',
      field: 'subgraph-port',
      expected: 'declared parent view or buffer',
      actual: 'unavailable',
    },
  });
}

/** Preserve each feature's ordered insertion, including empty-to-active transitions. */
export function projectTransientViewPlans<F extends RenderGraphFrame>(
  builder: RenderGraphBuilder<F>,
  executions: readonly RenderFeaturePlanExecution[],
  selected: ReadonlySet<string>,
  options: ProjectionOptions<F>,
  context: {
    readonly owner: object;
    readonly device: RhiDevice;
    readonly surfaceSize: { readonly width: number; readonly height: number };
    readonly ports: readonly GraphAccess[];
    readonly slots: Map<string, { complete: boolean; names: Set<string> }>;
  },
): Result<void, RenderGraphError | RenderError> {
  if (selected.size === 0) return projectRenderFeaturePlans(builder, executions, options);
  let ordinary: RenderFeaturePlanExecution[] = [];
  const flush = (): Result<void, RenderGraphError | RenderError> => {
    if (ordinary.length === 0) return ok(undefined);
    const result = projectRenderFeaturePlans(builder, ordinary, options);
    ordinary = [];
    return result;
  };
  for (const execution of executions) {
    if (!selected.has(execution.featureIdentity)) {
      ordinary.push(execution);
      continue;
    }
    const projectedOrdinary = flush();
    if (!projectedOrdinary.ok) return projectedOrdinary;
    const key = `${execution.featureIdentity}:${execution.scope}`;
    const slot = context.slots.get(key);
    if (slot?.complete) continue;
    const excluded = new Set(slot?.names);
    for (const pass of execution.passes)
      if (options.state?.projected.has(pass)) excluded.add(pass.name);
    const names =
      options.passNames === undefined
        ? undefined
        : new Set([...options.passNames].filter((name) => !excluded.has(name)));
    if (names?.size === 0) continue;
    const selectedPass = (pass: import('./host').RenderFeaturePlanExecutionPass) =>
      !excluded.has(pass.name) && (names === undefined || names.has(pass.name));
    const added = builder.addSubgraphPass(
      `feature-view:${key}:${names === undefined ? 'rest' : `part-${excluded.size}`}`,
      {
        accesses: context.ports,
        commands: ({ frame, resources, execute: run }) => {
          const current = (frame as RenderFeatureExecutionFrame).featureExecutions?.find(
            (row) =>
              row.featureIdentity === execution.featureIdentity &&
              row.scope === execution.scope &&
              row.order === execution.order,
          );
          if (current === undefined || !transientViewExecutionEligible(current))
            throw new RenderFeatureStageFailedError(
              execution.featureIdentity,
              execution.order,
              'plan',
              'next-frame',
            );
          const raster = new RenderFeatureRasterGraphProjection(
            builder,
            (reference) => {
              const target = options.resolveTarget(reference);
              if (
                target !== undefined &&
                !context.ports.some((port) => port.resource === target.view)
              )
                throw portFailure();
              return target;
            },
            options.resolveBindings,
            undefined,
            options.reportError,
            options.resolveStandardLighting,
            options.standardSurfaceAccesses,
            options.viewAccesses,
          );
          const metrics = inspection(context.owner);
          metrics.commandFrames += 1;
          const execute = (pass: import('@forgeax/engine-render-graph').RenderGraphNativePass) => {
            metrics.commandPasses += 1;
            run(pass);
          };
          const passes = current.passes;
          for (let index = 0; index < passes.length; ) {
            const work = passes[index];
            if (work === undefined || !selectedPass(work)) {
              index++;
              continue;
            }
            if (work.graphics !== undefined) {
              if (work.enabled !== false)
                execute(raster.nativePass(work, frame, resources, current.scope));
              index++;
              continue;
            }
            let end = index + 1;
            while (end < passes.length) {
              const next = passes[end];
              if (next === undefined || next.graphics !== undefined || !selectedPass(next)) break;
              end++;
            }
            const visited = visitRenderFeatureComputeSequence(passes.slice(index, end), {
              copy: (pass) => {
                if (pass.enabled !== false)
                  execute({
                    kind: 'copy',
                    name: pass.name,
                    encode: (encoder) => {
                      for (const copy of pass.resolvedGpuCopies ?? []) {
                        if (copy.enabled === false) continue;
                        encoder.copyBufferToBuffer(
                          copy.source.buffer,
                          copy.sourceOffset,
                          copy.destination.buffer,
                          copy.destinationOffset,
                          copy.size,
                        );
                      }
                    },
                  });
                return ok(undefined);
              },
              compute: (passes) => {
                const first = passes[0];
                if (first !== undefined && passes.some((pass) => pass.enabled !== false))
                  execute({
                    kind: 'compute',
                    name: first.name,
                    encode: (encoder) => {
                      for (const pass of passes) {
                        if (pass.enabled === false) continue;
                        try {
                          if (pass.resolvedGpuCompute === undefined)
                            throw new RenderFeatureStageFailedError(
                              pass.featureIdentity,
                              pass.order,
                              'record',
                              'renderer-recover',
                            );
                          encodeRenderFeatureGpuComputePass(encoder, pass.resolvedGpuCompute);
                        } catch (failure) {
                          throwFeatureRecordingFailure(
                            failure,
                            pass.featureIdentity,
                            pass.order,
                            pass.name,
                            'bindings',
                            options.reportError,
                          );
                        }
                      }
                    },
                  });
                return ok(undefined);
              },
            });
            if (!visited.ok) throw visited.error;
            index = end;
          }
        },
      },
    );
    if (!added.ok) return added;
    context.slots.set(key, {
      complete: names === undefined,
      names: names === undefined ? excluded : new Set([...excluded, ...names]),
    });
    for (const pass of execution.passes) if (selectedPass(pass)) options.state?.projected.add(pass);
  }
  return flush();
}

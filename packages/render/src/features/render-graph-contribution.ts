import type {
  GraphAccess,
  GraphBufferAccess,
  RenderGraphBuilder,
  RenderGraphError,
  RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import type { Buffer } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { type RenderError, RenderFeatureStageFailedError } from '../errors/render';
import {
  createRenderFeatureGraphTextureTargets,
  graphTextureTargetResolver,
  prepareRenderFeatureGraphTextureTargets,
} from './graph-texture-targets';
import type { RenderFeaturePlanExecution, RenderFeaturePlanExecutionPass } from './host';
import { RenderFeatureComputeGraphProjection } from './render-graph-compute';
import { projectRenderFeatureCopies } from './render-graph-copy';
import {
  type RenderFeatureGraphBindingsResolver,
  type RenderFeatureGraphTargetResolver,
  type RenderFeatureLightingResolver,
  RenderFeatureRasterGraphProjection,
  type RenderFeatureShadowDraws,
  resolveRenderFeatureDrawBuffers,
} from './render-graph-raster';
import { createRenderFeatureGraphBufferState } from './render-graph-resources';
import { compareRenderFeatureTemporalStage } from './temporal-stage';
import type { RenderFeaturePlacement } from './types';

export function createRenderFeatureProjectionState() {
  return {
    buffers: createRenderFeatureGraphBufferState(),
    graphTextures: createRenderFeatureGraphTextureTargets(),
    projected: new Set<RenderFeaturePlanExecutionPass>(),
  };
}

function writesBuffer(access: GraphBufferAccess): boolean {
  switch (access) {
    case 'storage-write':
    case 'storage-read-write':
    case 'copy-dst':
      return true;
    case 'uniform-read':
    case 'storage-read':
    case 'indirect-read':
    case 'vertex-read':
    case 'index-read':
    case 'copy-src':
      return false;
  }
}

function canHoistCopyPass(
  pass: RenderFeaturePlanExecutionPass,
  deferredWrites: ReadonlySet<Buffer>,
  deferredAccesses: ReadonlySet<Buffer>,
): boolean {
  return (
    (pass.textureReadbacks?.length ?? 0) === 0 &&
    pass.resolvedGpuCopies?.every(
      ({ source, destination }) =>
        !deferredWrites.has(source.buffer) && !deferredAccesses.has(destination.buffer),
    ) === true
  );
}

function collectShadowGraphicsAccesses(
  execution: RenderFeaturePlanExecution,
  pass: RenderFeaturePlanExecutionPass,
  deferredAccesses: Set<Buffer>,
): Result<void, RenderError> {
  if (pass.graphics !== undefined && pass.resolvedGraphics !== undefined) {
    const inputs = resolveRenderFeatureDrawBuffers(
      execution.featureIdentity,
      execution.order,
      pass.graphics,
      pass.resolvedGraphics,
    );
    if (!inputs.ok) return inputs;
    for (const group of Object.values(inputs.value)) {
      for (const resource of group.values()) deferredAccesses.add(resource.buffer);
    }
  }
  return ok(undefined);
}

function matchesFeaturePlacement(
  execution: RenderFeaturePlanExecution,
  placement: RenderFeaturePlacement | undefined,
): boolean {
  return placement === undefined || (execution.placement ?? 'post') === placement;
}

export function projectRenderFeatureShadows<FrameCtx extends RenderGraphFrame>(
  builder: RenderGraphBuilder<FrameCtx>,
  executions: readonly RenderFeaturePlanExecution[],
  state: ReturnType<typeof createRenderFeatureProjectionState>,
): Result<RenderFeatureShadowDraws<FrameCtx> | undefined, RenderGraphError | RenderError> {
  if (!executions.some((execution) => execution.passes.some((pass) => pass.shadowCaster)))
    return ok(undefined);
  const projectShadowTemporalWork = () => {
    if (
      executions.some((execution) => execution.passes.some((pass) => pass.temporal !== undefined))
    ) {
      const temporal = projectRenderFeaturePlans(builder, executions, {
        resolveTarget: () => undefined,
        placement: 'scene',
        passNames: new Set(),
        state,
      });
      if (!temporal.ok) return temporal;
    }

    return undefined;
  };
  const temporalFailure = projectShadowTemporalWork();
  if (temporalFailure !== undefined) return temporalFailure;
  const compute = new RenderFeatureComputeGraphProjection(builder, state.buffers);
  const raster = new RenderFeatureRasterGraphProjection(
    builder,
    () => undefined,
    undefined,
    state.buffers,
  );
  const draws: RenderFeatureShadowDraws<FrameCtx>[] = [];
  // Hoist only work that can cross earlier deferred work without changing its
  // buffer observations. Physical identity catches aliases across features too.
  const deferredAccesses = new Set<Buffer>();
  const deferredWrites = new Set<Buffer>();
  for (const execution of executions) {
    for (let index = 0; index < execution.passes.length; index++) {
      const pass = pendingProjectionPass(execution.passes[index], state.projected);
      if (pass === undefined) continue;
      const accessed = collectShadowGraphicsAccesses(execution, pass, deferredAccesses);
      if (!accessed.ok) return accessed;
      if (pass.shadowCaster) {
        if (
          pass.graphics === undefined ||
          pass.graphicsState === undefined ||
          pass.resolvedGraphics === undefined
        )
          return err(
            new RenderFeatureStageFailedError(
              execution.featureIdentity,
              execution.order,
              'plan',
              'next-frame',
            ),
          );
        const prepared = raster.prepareShadowDraws(
          pass.name,
          execution.featureIdentity,
          execution.order,
          pass.graphics,
          pass.graphicsState,
          pass.resolvedGraphics,
          execution.scope,
        );
        if (!prepared.ok) return prepared;
        draws.push(prepared.value);
        state.projected.add(pass);
        continue;
      }
      if (pass.resolvedGpuCopies !== undefined) {
        const canRunEarly = canHoistCopyPass(pass, deferredWrites, deferredAccesses);
        if (canRunEarly) {
          const added = projectRenderFeatureCopies(builder, state.buffers, pass, execution.scope);
          if (!added.ok) return added;
          state.projected.add(pass);
        } else {
          for (const { source, destination } of pass.resolvedGpuCopies) {
            deferredAccesses.add(source.buffer);
            deferredAccesses.add(destination.buffer);
            deferredWrites.add(destination.buffer);
          }
        }
        continue;
      }
      const work = pass.resolvedGpuCompute;
      if (work === undefined) continue;
      const canRunEarly = (candidate: RenderFeaturePlanExecutionPass): boolean => {
        if (candidate.resolvedGpuCopies !== undefined)
          return canHoistCopyPass(candidate, deferredWrites, deferredAccesses);
        return (
          candidate.resolvedGpuCompute !== undefined &&
          (candidate.resolvedGpuCompute.sampledTargets?.length ?? 0) === 0 &&
          (candidate.resolvedGpuCompute.storageTargets?.length ?? 0) === 0 &&
          candidate.resolvedGpuCompute.buffers.every(
            ({ buffer, access }) =>
              !deferredWrites.has(buffer) &&
              (!writesBuffer(access) || !deferredAccesses.has(buffer)),
          )
        );
      };
      if (canRunEarly(pass)) {
        let end = index + 1;
        while (execution.submission !== 'atomic' && end < execution.passes.length) {
          const next = execution.passes[end];
          if (
            next === undefined ||
            next.shadowCaster ||
            next.graphics !== undefined ||
            !canRunEarly(next)
          )
            break;
          end++;
        }
        const group = execution.passes.slice(index, end);
        const added = compute.addPasses(group, execution.scope);
        if (!added.ok) return added;
        for (const logical of group) state.projected.add(logical);
        index = end - 1;
      } else {
        for (const { buffer, access } of work.buffers) {
          deferredAccesses.add(buffer);
          if (writesBuffer(access)) deferredWrites.add(buffer);
        }
      }
    }
  }
  return ok({
    accesses: draws.flatMap((draw) => [...draw.accesses]),
    encode: (pass, frame, resources, view) => {
      for (const draw of draws) draw.encode(pass, frame, resources, view);
    },
  });
}

/** Project the host-owned plan execution directly into the one typed graph. */
export function projectRenderFeaturePlans<FrameCtx extends RenderGraphFrame>(
  builder: RenderGraphBuilder<FrameCtx>,
  executions: readonly RenderFeaturePlanExecution[],
  options: {
    readonly resolveTarget: RenderFeatureGraphTargetResolver;
    readonly resolveBindings?: RenderFeatureGraphBindingsResolver<FrameCtx> | undefined;
    readonly reportError?: ((error: RenderError) => void) | undefined;
    readonly resolveStandardLighting?: RenderFeatureLightingResolver<FrameCtx> | undefined;
    readonly standardSurfaceAccesses?: readonly GraphAccess[] | undefined;
    readonly viewAccesses?: readonly GraphAccess[] | undefined;
    /** Restrict projection to one Standard graph placement. */
    readonly placement?: RenderFeaturePlacement | undefined;
    /** Restrict projection to the named passes for a multi-stage feature. */
    readonly passNames?: ReadonlySet<string> | undefined;
    /** Physical graph labels may qualify logical passes when several views share one graph. */
    readonly passNamePrefix?: string | undefined;
    readonly state?: ReturnType<typeof createRenderFeatureProjectionState>;
  },
): Result<void, RenderGraphError | RenderError> {
  const state = options.state ?? createRenderFeatureProjectionState();
  const textureTargets = prepareRenderFeatureGraphTextureTargets(
    builder,
    state.graphTextures,
    executions,
  );
  if (!textureTargets.ok) return textureTargets;
  const resolveTarget = graphTextureTargetResolver(state.graphTextures, options.resolveTarget);
  const buffers = state.buffers;
  const compute = new RenderFeatureComputeGraphProjection(
    builder,
    buffers,
    options.reportError,
    resolveTarget,
    options.passNamePrefix,
  );
  const raster = new RenderFeatureRasterGraphProjection(
    builder,
    resolveTarget,
    options.resolveBindings,
    buffers,
    options.reportError,
    options.resolveStandardLighting,
    options.standardSurfaceAccesses,
    options.viewAccesses,
  );
  // Temporal work from all registered features is admitted together before
  // constructing SSA versions, so a reused water texture represents tick N
  // until its consumer has executed, then advances to tick N+1.
  const projectTemporalWork = () => {
    if (options.placement === undefined || options.placement === 'scene') {
      const temporal = executions.flatMap((execution) =>
        execution.passes.flatMap((pass) =>
          pass.temporal === undefined || state.projected.has(pass)
            ? []
            : [{ execution, pass, stage: pass.temporal }],
        ),
      );
      temporal.sort((a, b) => compareRenderFeatureTemporalStage(a.stage, b.stage));
      const produced = new Set<string>();
      for (const { execution, pass, stage } of temporal) {
        const key = JSON.stringify([stage.timeline, stage.epoch, stage.tick]);
        if (stage.phase === 'consumer' && !produced.has(key))
          return err(
            new RenderFeatureStageFailedError(
              execution.featureIdentity,
              execution.order,
              'plan',
              'next-frame',
              new Error('Temporal consumer has no matching producer tick'),
            ),
          );
        if (stage.phase === 'producer') produced.add(key);
        if (pass.resolvedGpuCopies !== undefined) {
          const added = projectRenderFeatureCopies(builder, buffers, pass, execution.scope);
          if (!added.ok) return added;
        } else if (pass.resolvedGpuCompute !== undefined) {
          const added = compute.addPasses([pass], execution.scope);
          if (!added.ok) return added;
        } else
          return err(
            new RenderFeatureStageFailedError(
              execution.featureIdentity,
              execution.order,
              'plan',
              'next-frame',
              new Error('Temporal stages require native compute/copy work'),
            ),
          );
        state.projected.add(pass);
      }
    }

    return undefined;
  };
  const temporalFailure = projectTemporalWork();
  if (temporalFailure !== undefined) return temporalFailure;

  for (const execution of executions) {
    if (!matchesFeaturePlacement(execution, options.placement)) continue;
    for (let index = 0; index < execution.passes.length; index++) {
      const pass = execution.passes[index];
      if (pass === undefined) continue;
      if (state.projected.has(pass)) continue;
      if (!selectedProjectionPass(pass, options.passNames)) continue;
      if (pass.shadowCaster)
        return err(
          new RenderFeatureStageFailedError(
            execution.featureIdentity,
            execution.order,
            'plan',
            'next-frame',
          ),
        );
      if (pass.resolvedGpuCopies !== undefined) {
        const added = projectRenderFeatureCopies(
          builder,
          buffers,
          pass,
          execution.scope,
          (options.passNamePrefix ?? '') + pass.name,
          resolveTarget,
        );
        if (!added.ok) return added;
        state.projected.add(pass);
        continue;
      }
      if (pass.resolvedGpuCompute !== undefined) {
        const resolveComputePassGroupEnd = () => {
          let end = index + 1;
          while (execution.submission !== 'atomic' && end < execution.passes.length) {
            const next = execution.passes[end];
            if (
              next === undefined ||
              next.shadowCaster ||
              next.graphics !== undefined ||
              (next.resolvedGpuCompute === undefined && next.resolvedGpuCopies === undefined) ||
              state.projected.has(next) ||
              (options.passNames !== undefined && !options.passNames.has(next.name))
            )
              break;
            end++;
          }
          return end;
        };
        const end = resolveComputePassGroupEnd();
        const group = execution.passes.slice(index, end);
        const added = compute.addPasses(group, execution.scope);
        if (!added.ok) return added;
        for (const logical of group) state.projected.add(logical);
        index = end - 1;
        continue;
      }
      if (
        pass.graphics !== undefined &&
        pass.graphicsState !== undefined &&
        pass.resolvedGraphics !== undefined
      ) {
        const added = raster.addPass(
          pass.name,
          execution.featureIdentity,
          execution.order,
          pass.graphics,
          pass.graphicsState,
          pass.resolvedGraphics,
          pass.enabled,
          execution.scope,
          (options.passNamePrefix ?? '') + pass.name,
        );
        if (!added.ok) return added;
        state.projected.add(pass);
        continue;
      }
      return err(
        new RenderFeatureStageFailedError(
          execution.featureIdentity,
          execution.order,
          'plan',
          'next-frame',
        ),
      );
    }
  }
  return ok(undefined);
}

function selectedProjectionPass(
  pass: RenderFeaturePlanExecutionPass,
  names: ReadonlySet<string> | undefined,
): boolean {
  return names === undefined || names.has(pass.name);
}

function pendingProjectionPass(
  pass: RenderFeaturePlanExecutionPass | undefined,
  projected: ReadonlySet<RenderFeaturePlanExecutionPass>,
): RenderFeaturePlanExecutionPass | undefined {
  return pass === undefined || projected.has(pass) ? undefined : pass;
}

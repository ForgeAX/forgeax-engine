import type {
  GraphBuffer,
  GraphBufferAccess,
  RenderGraphBuilder,
  RenderGraphError,
  RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import type { Buffer } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { type RenderError, RenderFeatureStageFailedError } from '../errors/render';
import { currentRenderFeaturePass } from './frame-execution';
import type { RenderFeaturePlanExecutionPass } from './host';
import type { RenderFeatureComputeTarget } from './prepared-gpu-work';
import {
  encodeRenderFeatureGpuComputePass,
  type RenderFeatureResolvedGpuComputePass,
} from './prepared-gpu-work';
import { throwFeatureRecordingFailure } from './recording-failure';
import { projectRenderFeatureCopies } from './render-graph-copy';
import type { RenderFeatureGraphTargetResolver } from './render-graph-raster';
import {
  createRenderFeatureGraphBufferState,
  importRenderFeatureGraphBuffer,
  type RenderFeatureGraphBufferState,
} from './render-graph-resources';

/** Preserve physical usage scopes and copy barriers for graph and native command consumers. */
export function visitRenderFeatureComputeSequence(
  passes: readonly RenderFeaturePlanExecutionPass[],
  actions: {
    copy: (pass: RenderFeaturePlanExecutionPass) => Result<void, RenderGraphError | RenderError>;
    compute: (
      passes: readonly RenderFeaturePlanExecutionPass[],
    ) => Result<void, RenderGraphError | RenderError>;
  },
): Result<void, RenderGraphError | RenderError> {
  const bufferOnly = (pass: RenderFeaturePlanExecutionPass): boolean =>
    pass.gpuCompute !== undefined &&
    pass.resolvedGpuCompute !== undefined &&
    (pass.resolvedGpuCompute.sampledTargets?.length ?? 0) === 0 &&
    (pass.resolvedGpuCompute.storageTargets?.length ?? 0) === 0;
  for (let start = 0; start < passes.length; ) {
    const first = passes[start];
    if (first === undefined) {
      start++;
      continue;
    }
    if (first.resolvedGpuCopies !== undefined) {
      const added = actions.copy(first);
      if (!added.ok) return added;
      start++;
      continue;
    }
    if (first.resolvedGpuCompute === undefined)
      return err(
        new RenderFeatureStageFailedError(first.featureIdentity, first.order, 'plan', 'next-frame'),
      );
    let end = start + 1;
    const logicalPasses = [first];
    const earlyCopies: RenderFeaturePlanExecutionPass[] = [];
    const program = first.gpuCompute?.program;
    if (program !== undefined && bufferOnly(first)) {
      const uses = new Map<Buffer, Set<GraphBufferAccess>>();
      const remember = (work: RenderFeatureResolvedGpuComputePass): void => {
        for (const resource of work.buffers) {
          let accesses = uses.get(resource.buffer);
          if (accesses === undefined) {
            accesses = new Set();
            uses.set(resource.buffer, accesses);
          }
          accesses.add(resource.access);
        }
      };
      remember(first.resolvedGpuCompute);
      while (end < passes.length) {
        const next = passes[end];
        const nextWork = next?.resolvedGpuCompute;
        if (
          next === undefined ||
          next.featureIdentity !== first.featureIdentity ||
          next.order !== first.order
        )
          break;
        if (next.resolvedGpuCopies !== undefined) {
          // Copies may cross prior dispatches only with disjoint physical
          // buffers. Names, byte ranges and the current enabled bit are not proof.
          if (
            next.resolvedGpuCopies.some(
              (copy) => uses.has(copy.source.buffer) || uses.has(copy.destination.buffer),
            )
          )
            break;
          earlyCopies.push(next);
          end++;
          continue;
        }
        if (
          nextWork === undefined ||
          !bufferOnly(next) ||
          nextWork.buffers.some((resource) => {
            const accesses = uses.get(resource.buffer);
            return accesses !== undefined && !accesses.has(resource.access);
          })
        )
          break;
        remember(nextWork);
        logicalPasses.push(next);
        end++;
      }
    }
    for (const copy of earlyCopies) {
      const added = actions.copy(copy);
      if (!added.ok) return added;
    }
    const added = actions.compute(logicalPasses);
    if (!added.ok) return added;
    start = end;
  }
  return ok(undefined);
}

export class RenderFeatureComputeGraphProjection<FrameCtx extends RenderGraphFrame> {
  private readonly resources: RenderFeatureGraphBufferState;

  constructor(
    private readonly builder: RenderGraphBuilder<FrameCtx>,
    resources?: RenderFeatureGraphBufferState,
    private readonly reportError?: (error: RenderError) => void,
    private readonly resolveTarget?: RenderFeatureGraphTargetResolver,
  ) {
    this.resources = resources ?? createRenderFeatureGraphBufferState();
  }

  /** Adjacent logical compute work shares a native pass only within its resource contract. */
  addPasses(
    passes: readonly RenderFeaturePlanExecutionPass[],
    scope?: string,
  ): Result<void, RenderGraphError | RenderError> {
    return visitRenderFeatureComputeSequence(passes, {
      copy: (pass) => projectRenderFeatureCopies(this.builder, this.resources, pass, scope),
      compute: (group) => this.addPass(group, scope),
    });
  }

  private addPass(
    logicalPasses: readonly RenderFeaturePlanExecutionPass[],
    scope?: string,
  ): Result<void, RenderGraphError | RenderError> {
    const first = logicalPasses[0];
    if (first === undefined) return ok(undefined);
    const { name, featureIdentity, order } = first;
    const work = first.resolvedGpuCompute;
    if (work === undefined)
      return err(new RenderFeatureStageFailedError(featureIdentity, order, 'plan', 'next-frame'));
    const accesses = [];
    const targets = new Map<
      RenderFeatureComputeTarget,
      NonNullable<ReturnType<RenderFeatureGraphTargetResolver>>
    >();
    const sampledTargets = new Set(work.sampledTargets ?? []);
    const storageTargets = new Set(work.storageTargets ?? []);
    for (const handle of [...sampledTargets, ...storageTargets]) {
      let target = this.resolveTarget?.(handle);
      if (target === undefined)
        return err(
          new RenderFeatureStageFailedError(featureIdentity, order, 'record', 'renderer-recover'),
        );
      if (typeof handle !== 'string' && handle.kind === 'scene-depth') {
        const view = this.builder.view(target.texture, { aspect: 'depth-only' });
        if (!view.ok) return view;
        target = { ...target, view: view.value };
      }
      targets.set(handle, target);
      if (sampledTargets.has(handle) && storageTargets.has(handle)) {
        accesses.push({ resource: target.view, usage: 'sampled-storage-read-write' as const });
      } else if (storageTargets.has(handle)) {
        accesses.push({ resource: target.view, usage: 'storage-write' as const });
      } else {
        accesses.push({ resource: target.view, usage: 'sampled-read' as const });
      }
    }
    const bufferAccesses = new Map<GraphBuffer, Set<GraphBufferAccess>>();
    for (const logical of logicalPasses) {
      const logicalWork = logical.resolvedGpuCompute;
      if (logicalWork === undefined)
        return err(
          new RenderFeatureStageFailedError(
            logical.featureIdentity,
            logical.order,
            'plan',
            'next-frame',
          ),
        );
      for (const resource of logicalWork.buffers) {
        const imported = importRenderFeatureGraphBuffer(
          this.builder,
          this.resources,
          `${logical.name}.${resource.name}`,
          resource,
        );
        if (!imported.ok) return imported;
        let usages = bufferAccesses.get(imported.value);
        if (usages === undefined) {
          usages = new Set();
          bufferAccesses.set(imported.value, usages);
        }
        if (usages.has(resource.access)) continue;
        usages.add(resource.access);
        accesses.push({ resource: imported.value, usage: resource.access } as const);
      }
    }
    const enabled = (frame: FrameCtx, logical: RenderFeaturePlanExecutionPass): boolean =>
      currentRenderFeaturePass(frame, logical.featureIdentity, logical.name, scope)?.enabled ??
      logical.enabled ??
      true;
    return this.builder.addComputePass(name, {
      accesses,
      executeIf: (frame) => logicalPasses.some((logical) => enabled(frame, logical)),
      encode: ({ pass, frame, resources }) => {
        for (const logical of logicalPasses) {
          if (!enabled(frame, logical)) continue;
          const { featureIdentity, order, name } = logical;
          try {
            const current = currentRenderFeaturePass(frame, featureIdentity, name, scope);
            const currentWork = current?.resolvedGpuCompute ?? logical.resolvedGpuCompute;
            if (currentWork === undefined)
              throw new RenderFeatureStageFailedError(
                featureIdentity,
                order,
                'record',
                'renderer-recover',
              );
            encodeRenderFeatureGpuComputePass(pass, currentWork, (name) => {
              const target = targets.get(name);
              if (target === undefined) throw new Error(`Missing sampled graph target: ${name}`);
              const view = resources.textureView(target.view);
              if (!view.ok) throw view.error;
              return view.value;
            });
          } catch (failure) {
            throwFeatureRecordingFailure(
              failure,
              featureIdentity,
              order,
              name,
              'bindings',
              this.reportError,
            );
          }
        }
      },
    });
  }
}

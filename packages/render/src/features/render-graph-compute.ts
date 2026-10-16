import type {
  GraphBuffer,
  GraphBufferAccess,
  RenderGraphBuilder,
  RenderGraphError,
  RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import type { Buffer } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import {
  type RenderError,
  RenderFeatureDrawRecordingFailedError,
  RenderFeatureStageFailedError,
} from '../errors/render';
import { currentRenderFeaturePass } from './frame-execution';
import type { RenderFeaturePlanExecutionPass } from './host';
import type { RenderFeatureComputeTarget } from './prepared-gpu-work';
import {
  encodeRenderFeatureGpuComputePass,
  type RenderFeatureResolvedGpuComputePass,
} from './prepared-gpu-work';
import type { RenderFeatureGraphTargetResolver } from './render-graph-raster';
import {
  createRenderFeatureGraphBufferState,
  importRenderFeatureGraphBuffer,
  type RenderFeatureGraphBufferState,
} from './render-graph-resources';

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
      if (first.resolvedGpuCompute === undefined)
        return err(
          new RenderFeatureStageFailedError(
            first.featureIdentity,
            first.order,
            'plan',
            'next-frame',
          ),
        );
      let end = start + 1;
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
            nextWork === undefined ||
            !bufferOnly(next) ||
            next.featureIdentity !== first.featureIdentity ||
            next.order !== first.order ||
            next.gpuCompute?.program !== program ||
            nextWork.buffers.some((resource) => {
              const accesses = uses.get(resource.buffer);
              return accesses !== undefined && !accesses.has(resource.access);
            })
          )
            break;
          remember(nextWork);
          end++;
        }
      }
      const added = this.addPass(passes.slice(start, end), scope);
      if (!added.ok) return added;
      start = end;
    }
    return ok(undefined);
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
            const error =
              failure instanceof Error && typeof (failure as Partial<RenderError>).code === 'string'
                ? (failure as RenderError)
                : new RenderFeatureDrawRecordingFailedError(
                    featureIdentity,
                    order,
                    name,
                    'bindings',
                    'backend-recording-failed',
                    failure instanceof Error ? failure.message : String(failure),
                    'renderer-recover',
                  );
            this.reportError?.(error);
            // A partially encoded intent is not a submitted transaction.
            throw error;
          }
        }
      },
    });
  }
}

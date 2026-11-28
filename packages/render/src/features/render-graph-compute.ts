import type {
  GraphBuffer,
  GraphBufferAccess,
  GraphTexture,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
  RenderGraphFrame,
  RenderGraphNativePass,
} from '@forgeax/engine-render-graph';
import type { Buffer, Texture } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { type RenderError, RenderFeatureStageFailedError } from '../errors/render';
import { currentRenderFeaturePass } from './frame-execution';
import type { RenderFeaturePlanExecutionPass } from './host';
import {
  motionBlurFeatureEntry,
  recordMotionBlurFeatureDispatch,
} from './motion-blur/motion-blur-execution';
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
import { isRenderFeatureTextureReference } from './texture-source';

class RenderFeatureGraphTargetUnavailableError extends Error {
  readonly detail: Readonly<{
    readonly consumerFeatureIdentity: string;
    readonly passName: string;
    readonly scope?: string;
    readonly target: Readonly<Record<string, string | number>>;
  }>;

  constructor(
    featureIdentity: string,
    passName: string,
    scope: string | undefined,
    target: RenderFeatureComputeTarget,
  ) {
    const identity: Readonly<Record<string, string | number>> = isRenderFeatureTextureReference(
      target,
    )
      ? {
          kind: target.kind,
          featureIdentity: target.featureIdentity,
          name: target.name,
          viewIdentity: target.viewIdentity,
          format: target.format,
        }
      : typeof target === 'string'
        ? { kind: 'named-target', name: target }
        : {
            kind: target.kind,
            ...('name' in target && typeof target.name === 'string' ? { name: target.name } : {}),
            ...('producerIdentity' in target && typeof target.producerIdentity === 'string'
              ? { producerIdentity: target.producerIdentity }
              : {}),
            ...('allocationScope' in target && typeof target.allocationScope === 'string'
              ? { allocationScope: target.allocationScope }
              : {}),
            ...('allocationKey' in target && typeof target.allocationKey === 'string'
              ? { allocationKey: target.allocationKey }
              : {}),
            ...('format' in target && typeof target.format === 'string'
              ? { format: target.format }
              : {}),
          };
    const scopeDescription =
      scope === undefined ? 'an unspecified graph scope' : `scope '${scope}'`;
    super(
      `graph target '${identity.name ?? identity.kind}' for feature '${featureIdentity}' pass '${passName}' is unavailable in ${scopeDescription}`,
    );
    this.name = 'RenderFeatureGraphTargetUnavailableError';
    this.detail = {
      consumerFeatureIdentity: featureIdentity,
      passName,
      ...(scope === undefined ? {} : { scope }),
      target: identity,
    };
  }
}

const computeAccessBit: Readonly<Record<GraphBufferAccess, number>> = {
  'uniform-read': 1,
  'storage-read': 2,
  'storage-write': 4,
  'storage-read-write': 8,
  'indirect-read': 16,
  'vertex-read': 32,
  'index-read': 64,
  'copy-src': 128,
  'copy-dst': 256,
};

function bufferOnlyDispatch(pass: RenderFeaturePlanExecutionPass): boolean {
  const work = pass.resolvedGpuCompute;
  return (
    pass.gpuCompute !== undefined &&
    work !== undefined &&
    (work.textures?.length ?? 0) === 0 &&
    (work.sampledTargets?.length ?? 0) === 0 &&
    (work.storageTargets?.length ?? 0) === 0
  );
}

function rememberBufferAccesses(
  uses: Map<Buffer, number>,
  work: RenderFeatureResolvedGpuComputePass,
): void {
  for (const resource of work.buffers) {
    uses.set(resource.buffer, (uses.get(resource.buffer) ?? 0) | computeAccessBit[resource.access]);
  }
}

/** Visit native usage scopes in the supplied range. Independent copies are issued before
 * their compute scope; consumers read dispatches directly from the original range. */
export function visitRenderFeatureComputeSequence(
  passes: readonly RenderFeaturePlanExecutionPass[],
  actions: {
    copy: (pass: RenderFeaturePlanExecutionPass) => Result<void, RenderGraphError | RenderError>;
    compute: (
      passes: readonly RenderFeaturePlanExecutionPass[],
      start: number,
      end: number,
    ) => Result<void, RenderGraphError | RenderError>;
  },
  start = 0,
  limit = passes.length,
): Result<void, RenderGraphError | RenderError> {
  let uses: Map<Buffer, number> | undefined;
  while (start < limit) {
    const first = passes[start];
    if (first === undefined) {
      start++;
      continue;
    }
    if (first.resolvedGpuCopies !== undefined) {
      const result = actions.copy(first);
      if (!result.ok) return result;
      start++;
      continue;
    }
    const firstWork = first.resolvedGpuCompute;
    if (firstWork === undefined)
      return err(
        new RenderFeatureStageFailedError(first.featureIdentity, first.order, 'plan', 'next-frame'),
      );
    let end = start + 1;
    let hasCopies = false;
    if (end < limit && first.gpuCompute?.program !== undefined && bufferOnlyDispatch(first)) {
      uses ??= new Map();
      uses.clear();
      rememberBufferAccesses(uses, firstWork);
      for (; end < limit; end++) {
        const next = passes[end];
        if (
          next === undefined ||
          next.featureIdentity !== first.featureIdentity ||
          next.order !== first.order
        )
          break;
        if (next.resolvedGpuCopies !== undefined) {
          if ((next.textureReadbacks?.length ?? 0) > 0) break;
          let dependent = false;
          for (const copy of next.resolvedGpuCopies) {
            if (uses.has(copy.source.buffer) || uses.has(copy.destination.buffer)) {
              dependent = true;
              break;
            }
          }
          if (dependent) break;
          hasCopies = true;
          continue;
        }
        const work = next.resolvedGpuCompute;
        if (work === undefined || !bufferOnlyDispatch(next)) break;
        let conflict = false;
        for (const resource of work.buffers) {
          const previous = uses.get(resource.buffer);
          if (previous !== undefined && (previous & computeAccessBit[resource.access]) === 0) {
            conflict = true;
            break;
          }
        }
        if (conflict) break;
        rememberBufferAccesses(uses, work);
      }
    }
    if (hasCopies)
      for (let i = start + 1; i < end; i++) {
        const pass = passes[i];
        if (pass?.resolvedGpuCopies === undefined) continue;
        const result = actions.copy(pass);
        if (!result.ok) return result;
      }
    const result = actions.compute(passes, start, end);
    if (!result.ok) return result;
    start = end;
  }
  return ok(undefined);
}

/**
 * Issue a contiguous run of actual Feature commands. Its graphics boundary and
 * visibility filter are selected by the caller; the physical hazard rules are
 * shared with graph-authored passes. The borrowed range ends when this returns.
 */
export function issueFeatureComputeCommands(
  passes: readonly RenderFeaturePlanExecutionPass[],
  start: number,
  end: number,
  execute: (work: RenderGraphNativePass) => void,
  reportError: ((error: RenderError) => void) | undefined,
): void {
  const visited = visitRenderFeatureComputeSequence(
    passes,
    {
      copy(pass) {
        if (pass.enabled !== false)
          execute({
            kind: 'copy',
            name: pass.name,
            encode(encoder) {
              for (const copy of pass.resolvedGpuCopies ?? []) {
                if (copy.enabled !== false)
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
      compute(source, from, to) {
        let firstActive = from;
        while (firstActive < to) {
          const pass = source[firstActive];
          if (pass?.resolvedGpuCompute !== undefined && pass.enabled !== false) break;
          firstActive++;
        }
        const first = source[from];
        if (first === undefined || firstActive === to) return ok(undefined);
        execute({
          kind: 'compute',
          name: first.name,
          encode(encoder) {
            for (let i = firstActive; i < to; i++) {
              const pass = source[i];
              if (pass?.resolvedGpuCompute === undefined || pass.enabled === false) continue;
              try {
                encodeRenderFeatureGpuComputePass(encoder, pass.resolvedGpuCompute);
              } catch (cause) {
                throwFeatureRecordingFailure(
                  cause,
                  pass.featureIdentity,
                  pass.order,
                  pass.name,
                  'bindings',
                  reportError,
                );
              }
            }
          },
        });
        return ok(undefined);
      },
    },
    start,
    end,
  );
  if (!visited.ok) throw visited.error;
}

/** One physical identity table per frame graph, shared across producer and consumer projections. */
const featureGraphTextures = new WeakMap<
  object,
  Map<Texture, { texture: GraphTexture; view: GraphTextureView }>
>();
export class RenderFeatureComputeGraphProjection<FrameCtx extends RenderGraphFrame> {
  private readonly ownedTextures: Map<Texture, { texture: GraphTexture; view: GraphTextureView }>;
  private readonly resources: RenderFeatureGraphBufferState;

  constructor(
    private readonly builder: RenderGraphBuilder<FrameCtx>,
    resources?: RenderFeatureGraphBufferState,
    private readonly reportError?: (error: RenderError) => void,
    private readonly resolveTarget?: RenderFeatureGraphTargetResolver,
    private readonly passNamePrefix = '',
  ) {
    let textures = featureGraphTextures.get(builder);
    if (!textures) {
      textures = new Map();
      featureGraphTextures.set(builder, textures);
    }
    this.ownedTextures = textures;
    this.resources = resources ?? createRenderFeatureGraphBufferState();
  }

  /** Adjacent logical compute work shares a native pass only within its resource contract. */
  addPasses(
    passes: readonly RenderFeaturePlanExecutionPass[],
    scope?: string,
  ): Result<void, RenderGraphError | RenderError> {
    return visitRenderFeatureComputeSequence(passes, {
      copy: (pass) =>
        projectRenderFeatureCopies(
          this.builder,
          this.resources,
          pass,
          scope,
          this.passNamePrefix + pass.name,
          this.resolveTarget,
        ),
      compute: (source, start, end) => {
        // A compiled graph owns its declaration beyond this call. Native issuers
        // consume the original range synchronously and need no detached array.
        const group: RenderFeaturePlanExecutionPass[] = [];
        for (let i = start; i < end; i++) {
          const pass = source[i];
          if (pass !== undefined && pass.resolvedGpuCopies === undefined) group.push(pass);
        }
        return this.addPass(group, scope);
      },
    });
  }

  private addPass(
    logicalPasses: readonly RenderFeaturePlanExecutionPass[],
    scope?: string,
  ): Result<void, RenderGraphError | RenderError> {
    const first = logicalPasses[0];
    if (first === undefined) return ok(undefined);
    const { name, featureIdentity, order } = first;
    const motionBlurEntry = motionBlurFeatureEntry(featureIdentity, name);
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
    const importOwnedTextureAccesses = () => {
      for (const logical of logicalPasses)
        for (const resource of logical.resolvedGpuCompute?.textures ?? []) {
          let target = this.ownedTextures.get(resource.owned.texture);
          if (!target) {
            const texture = this.builder.importTexture(
              `feature-texture.${this.ownedTextures.size}.${resource.name}`,
              resource.owned.graph,
              () => resource.owned.texture,
            );
            if (!texture.ok) return texture;
            const view = this.builder.view(texture.value, {
              dimension: resource.owned.source.dimension ?? '2d',
            });
            if (!view.ok) return view;
            target = { texture: texture.value, view: view.value };
            this.ownedTextures.set(resource.owned.texture, target);
          }
          accesses.push({ resource: target.view, usage: resource.access });
          if (resource.owned.source.consumer === 'material') {
            const published = this.builder.publishConsumerRead(
              'render-feature.scene',
              target.view,
              'sampled-read',
            );
            if (!published.ok) return published;
          }
        }

      return undefined;
    };
    const textureFailure = importOwnedTextureAccesses();
    if (textureFailure !== undefined) return textureFailure;
    for (const handle of [...sampledTargets, ...storageTargets]) {
      let target = this.resolveTarget?.(handle);
      if (target === undefined)
        return err(
          new RenderFeatureStageFailedError(
            featureIdentity,
            order,
            'record',
            'renderer-recover',
            new RenderFeatureGraphTargetUnavailableError(featureIdentity, name, scope, handle),
          ),
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
    return this.builder.addComputePass(this.passNamePrefix + name, {
      accesses,
      executeIf: (frame) => logicalPasses.some((logical) => enabled(frame, logical)),
      encodeDirect: (pass, frame, resources) => {
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
            if (motionBlurEntry !== undefined)
              recordMotionBlurFeatureDispatch(frame, motionBlurEntry, currentWork);
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

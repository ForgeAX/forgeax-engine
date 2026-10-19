import type {
  GraphAccess,
  GraphBuffer,
  GraphResourceResolver,
  GraphTexture,
  GraphTextureView,
  RasterDepthStencilAttachment,
  RenderGraphBuilder,
  RenderGraphFrame,
  RenderGraphNativePass,
} from '@forgeax/engine-render-graph';
import { RenderGraphError } from '@forgeax/engine-render-graph';
import type { BindGroup, RenderPipeline, RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { type RenderError, RenderFeatureStageFailedError } from '../errors/render';
import type {
  PreparedGraphicsResolvedResource,
  PreparedGraphicsResolvedSnapshot,
} from '../prepare/prepared-graphics-resolver';
import type { SceneDataTarget } from '../temporal/scene-data';
import { currentRenderFeaturePass } from './frame-execution';
import type { RenderFeatureResolvedGpuBuffer } from './prepared-gpu-work';
import type {
  RenderFeatureGraphicsPassDescriptor,
  RenderFeaturePreparedGraphicsState,
  RenderFeaturePreparedRef,
} from './prepared-graphics';
import { validateOwnedRenderFeatureGraphicsPass } from './prepared-graphics';
import { throwFeatureRecordingFailure } from './recording-failure';
import {
  createRenderFeatureGraphBufferState,
  importRenderFeatureGraphBuffer,
  type RenderFeatureGraphBufferState,
} from './render-graph-resources';
import type { RenderFeatureTargetHandle } from './targets';

export interface RenderFeatureGraphTarget {
  readonly texture: GraphTexture;
  readonly view: GraphTextureView;
  readonly resolveTarget?: GraphTextureView | undefined;
}

export type RenderFeatureGraphTargetResolver = (
  resource: string | RenderFeatureTargetHandle | SceneDataTarget,
) => RenderFeatureGraphTarget | undefined;

export type RenderFeatureGraphBindingsResolution =
  | BindGroup
  | {
      readonly handle: BindGroup;
      readonly dynamicOffsets?: readonly number[];
    };

export type RenderFeatureGraphBindingsResolver<FrameCtx extends RenderGraphFrame> = (input: {
  readonly frame: FrameCtx;
  readonly binding: Extract<PreparedGraphicsResolvedResource, { readonly kind: 'bindings' }>;
  readonly resources: GraphResourceResolver;
  readonly resolveTarget: RenderFeatureGraphTargetResolver;
  readonly resolveGpuResource?: (name: string) => RenderFeatureResolvedGpuBuffer | undefined;
}) => RenderFeatureGraphBindingsResolution | undefined;

export type RenderFeatureLightingResolver<FrameCtx extends RenderGraphFrame> = (
  frame: FrameCtx,
  pipeline: RenderPipeline,
) => BindGroup | undefined;

/** Prepared draws embedded by the owning pipeline into its light-view passes. */
export interface RenderFeatureShadowDraws<FrameCtx extends RenderGraphFrame> {
  readonly accesses: readonly GraphAccess[];
  encode(
    pass: RhiRenderPassEncoder,
    frame: FrameCtx,
    resources: GraphResourceResolver,
    view: BindGroup,
  ): void;
}

interface ResolvedDrawBuffers {
  readonly vertex: ReadonlyMap<object, GraphBuffer>;
  readonly index: ReadonlyMap<object, GraphBuffer>;
  readonly indirect: ReadonlyMap<object, GraphBuffer>;
}

function missing(featureIdentity: string, order: number): RenderFeatureStageFailedError {
  return new RenderFeatureStageFailedError(featureIdentity, order, 'record', 'renderer-recover');
}

function resolved(
  snapshot: PreparedGraphicsResolvedSnapshot,
  reference: RenderFeaturePreparedRef,
): PreparedGraphicsResolvedResource | undefined {
  return snapshot.resolve(reference);
}

type DrawGpuBuffer = RenderFeatureResolvedGpuBuffer & {
  readonly byteOffset?: number;
  readonly byteLength?: number;
};

/** Physical draw inputs shared by readiness ordering and graph imports. */
export function resolveRenderFeatureDrawBuffers(
  featureIdentity: string,
  order: number,
  descriptor: RenderFeatureGraphicsPassDescriptor,
  snapshot: PreparedGraphicsResolvedSnapshot,
): Result<
  {
    vertex: Map<object, DrawGpuBuffer>;
    index: Map<object, DrawGpuBuffer>;
    indirect: Map<object, RenderFeatureResolvedGpuBuffer>;
  },
  RenderError
> {
  const vertex = new Map<object, DrawGpuBuffer>();
  const index = new Map<object, DrawGpuBuffer>();
  const indirect = new Map<object, RenderFeatureResolvedGpuBuffer>();
  for (const draw of descriptor.draws) {
    for (const binding of draw.vertexData) {
      const resource = resolved(snapshot, binding.resource);
      if (resource?.kind !== 'vertex-data') return err(missing(featureIdentity, order));
      vertex.set(binding.resource, {
        buffer: resource.handle,
        size: resource.size,
        physicalUsage: resource.physicalUsage,
        ...(resource.byteOffset === undefined ? {} : { byteOffset: resource.byteOffset }),
        ...(resource.byteLength === undefined ? {} : { byteLength: resource.byteLength }),
      });
    }
    if (draw.indexData !== undefined) {
      const resource = resolved(snapshot, draw.indexData.resource);
      if (resource?.kind !== 'index-data') return err(missing(featureIdentity, order));
      index.set(draw.indexData.resource, {
        buffer: resource.handle,
        size: resource.size,
        physicalUsage: resource.physicalUsage,
        ...(resource.byteOffset === undefined ? {} : { byteOffset: resource.byteOffset }),
        ...(resource.byteLength === undefined ? {} : { byteLength: resource.byteLength }),
      });
    }
    if (draw.kind === 'draw-indirect' || draw.kind === 'draw-indexed-indirect') {
      const resource = snapshot.resolveGpuBuffer?.(draw.command.buffer);
      if (resource === undefined) return err(missing(featureIdentity, order));
      indirect.set(draw.command.buffer, resource);
    }
  }
  return ok({ vertex, index, indirect });
}

export class RenderFeatureRasterGraphProjection<FrameCtx extends RenderGraphFrame> {
  private readonly buffers: RenderFeatureGraphBufferState;

  constructor(
    private readonly builder: RenderGraphBuilder<FrameCtx>,
    private readonly resolveTarget: RenderFeatureGraphTargetResolver,
    private readonly resolveBindings?: RenderFeatureGraphBindingsResolver<FrameCtx>,
    buffers?: RenderFeatureGraphBufferState,
    private readonly reportError?: (error: RenderError) => void,
    private readonly resolveStandardLighting?: RenderFeatureLightingResolver<FrameCtx>,
    private readonly standardSurfaceAccesses: readonly GraphAccess[] = [],
    private readonly viewAccesses: readonly GraphAccess[] = [],
  ) {
    this.buffers = buffers ?? createRenderFeatureGraphBufferState();
  }

  prepareShadowDraws(
    name: string,
    featureIdentity: string,
    order: number,
    descriptor: RenderFeatureGraphicsPassDescriptor,
    state: RenderFeaturePreparedGraphicsState,
    snapshot: PreparedGraphicsResolvedSnapshot,
    scope?: string,
  ): Result<RenderFeatureShadowDraws<FrameCtx>, RenderGraphError | RenderError> {
    const validated = validateOwnedRenderFeatureGraphicsPass(featureIdentity, descriptor, state);
    if (!validated.ok) return validated;
    const imported = this.importDrawBuffers(name, featureIdentity, order, descriptor, snapshot);
    if (!imported.ok) return imported;
    const accesses: GraphAccess[] = [
      ...[...imported.value.vertex.values()].map((resource) => ({
        resource,
        usage: 'vertex-read' as const,
      })),
      ...[...imported.value.index.values()].map((resource) => ({
        resource,
        usage: 'index-read' as const,
      })),
      ...[...imported.value.indirect.values()].map((resource) => ({
        resource,
        usage: 'indirect-read' as const,
      })),
    ];
    return ok({
      accesses,
      encode: (pass, frame, resources, view) =>
        this.encode(
          name,
          featureIdentity,
          order,
          descriptor,
          snapshot,
          imported.value,
          pass,
          frame,
          resources,
          view,
          scope,
        ),
    });
  }

  addPass(
    name: string,
    featureIdentity: string,
    order: number,
    descriptor: RenderFeatureGraphicsPassDescriptor,
    state: RenderFeaturePreparedGraphicsState,
    snapshot: PreparedGraphicsResolvedSnapshot,
    enabled = true,
    scope?: string,
  ): Result<void, RenderGraphError | RenderError> {
    const validated = validateOwnedRenderFeatureGraphicsPass(featureIdentity, descriptor, state);
    if (!validated.ok) return validated;

    const accesses = [...this.viewAccesses];
    if (
      descriptor.draws.some((draw) => {
        const pipeline = resolved(snapshot, draw.pipeline);
        return pipeline?.kind === 'pipeline' && pipeline.standardLighting === true;
      })
    )
      accesses.push(...this.standardSurfaceAccesses);
    const colors = [];
    for (const attachment of descriptor.attachments.colors) {
      const target = this.resolveTarget(attachment.resource);
      if (target === undefined) return err(missing(featureIdentity, order));
      accesses.push({ resource: target.view, usage: 'color-attachment' } as const);
      if (target.resolveTarget !== undefined) {
        accesses.push({ resource: target.resolveTarget, usage: 'color-attachment' } as const);
      }
      colors.push({
        view: target.view,
        ...(target.resolveTarget === undefined ? {} : { resolveTarget: target.resolveTarget }),
        loadOp: attachment.loadOp,
        storeOp: attachment.storeOp,
      });
    }

    let depthStencilAttachment: RasterDepthStencilAttachment | undefined;
    let sampledDepth: RenderFeatureGraphTarget | undefined;
    let originalDepth: RenderFeatureGraphTarget | undefined;
    const depth = descriptor.attachments.depthStencil;
    if (depth !== undefined) {
      const target = this.resolveTarget(depth.resource);
      if (target === undefined) return err(missing(featureIdentity, order));
      const sampledTarget = (descriptor.sampledTargets ?? []).find(
        (candidate) => this.resolveTarget(candidate)?.texture === target.texture,
      );
      const sampled = sampledTarget !== undefined;
      const writesDepth = descriptor.draws.some((draw) => {
        const pipeline = resolved(snapshot, draw.pipeline);
        return pipeline?.kind === 'pipeline' && pipeline.writesDepth === true;
      });
      if (sampled && writesDepth) {
        if (descriptor.sceneDepth !== 'before-pass')
          return err(
            new RenderGraphError({
              code: 'resource-descriptor-invalid',
              expected: 'an explicit before-pass depth snapshot for a sampled depth writer',
              hint: 'declare sceneDepth: before-pass or disable depth writes in the authored material',
              detail: {
                resourceLabel: name,
                field: 'sceneDepth',
                expected: 'before-pass',
                actual: descriptor.sceneDepth ?? 'undeclared',
              },
            }),
          );
        if (sampledTarget.sampleCount !== 1)
          return err(
            new RenderGraphError({
              code: 'resource-descriptor-invalid',
              expected: 'a single-sample depth snapshot for sampled depth-writing materials',
              hint: 'use a single-sample scene target; multisampled depth needs an independent snapshot producer',
              detail: {
                resourceLabel: name,
                field: 'sampleCount',
                expected: '1',
                actual: String(sampledTarget.sampleCount),
              },
            }),
          );
        // A material may sample existing scene depth and still write its own
        // depth. Keep both author facts without a same-pass texture feedback loop.
        const texture = this.builder.createTextureLike(`${name}.sampled-depth`, target.texture);
        if (!texture.ok) return texture;
        const view = this.builder.view(texture.value);
        if (!view.ok) return view;
        sampledDepth = { texture: texture.value, view: view.value };
        originalDepth = target;
        const copied = this.builder.addCopyPass(`${name}.sampled-depth-copy`, {
          accesses: [
            { resource: target.view, usage: 'copy-src' },
            { resource: view.value, usage: 'copy-dst' },
          ],
          executeIf: (frame) =>
            currentRenderFeaturePass(frame, featureIdentity, name)?.enabled ?? enabled,
          encode: ({ encoder, resources }) => {
            const source = resources.texture(target.texture).unwrap();
            const destination = resources.texture(texture.value).unwrap();
            const extent = resources.textureViewExtent(target.view).unwrap();
            encoder.copyTextureToTexture(
              { texture: source, aspect: 'all' },
              { texture: destination, aspect: 'all' },
              { ...extent, depthOrArrayLayers: 1 },
            );
          },
        });
        if (!copied.ok) return copied;
      }
      const readOnly = sampled && !writesDepth;
      accesses.push({
        resource: target.view,
        usage: readOnly ? ('depth-stencil-read' as const) : ('depth-stencil-write' as const),
      });
      depthStencilAttachment = readOnly
        ? { view: target.view, depthReadOnly: true, stencilReadOnly: true }
        : {
            view: target.view,
            depthLoadOp: depth.depthLoadOp,
            depthStoreOp: depth.depthStoreOp,
            stencilLoadOp: depth.depthLoadOp,
            stencilStoreOp: depth.depthStoreOp,
          };
    }

    for (const sampled of descriptor.sampledTargets ?? []) {
      const source = this.resolveTarget(sampled);
      const target = source?.texture === originalDepth?.texture ? sampledDepth : source;
      if (target === undefined) return err(missing(featureIdentity, order));
      accesses.push({ resource: target.view, usage: 'sampled-read' } as const);
    }

    const drawBuffers = this.importDrawBuffers(name, featureIdentity, order, descriptor, snapshot);
    if (!drawBuffers.ok) return drawBuffers;
    for (const handle of drawBuffers.value.vertex.values()) {
      accesses.push({ resource: handle, usage: 'vertex-read' } as const);
    }
    for (const handle of drawBuffers.value.index.values()) {
      accesses.push({ resource: handle, usage: 'index-read' } as const);
    }
    for (const handle of drawBuffers.value.indirect.values()) {
      accesses.push({ resource: handle, usage: 'indirect-read' } as const);
    }

    // Feature-owned fullscreen/material bind groups may carry a read-only
    // storage buffer (for example the bounded procedural cloud cache). Import
    // it into the same graph so the compute producer is ordered before the
    // raster consumer and the buffer lease follows queue retirement.
    for (const draw of descriptor.draws) {
      for (const reference of draw.bindings) {
        const binding = resolved(snapshot, reference);
        const names =
          binding?.kind === 'bindings' ? binding.descriptor?.values.storageBuffers : undefined;
        if (!Array.isArray(names)) continue;
        for (const name of names) {
          if (typeof name !== 'string') continue;
          const physical = snapshot.resolveGpuResource?.(name);
          if (physical === undefined) continue;
          const imported = importRenderFeatureGraphBuffer(
            this.builder,
            this.buffers,
            `${name}.${featureIdentity}.${order}`,
            physical,
          );
          if (!imported.ok) return imported;
          accesses.push({ resource: imported.value, usage: 'storage-read' } as const);
        }
      }
    }

    return this.builder.addRasterPass(name, {
      accesses,
      executeIf: (frame) =>
        currentRenderFeaturePass(frame, featureIdentity, name, scope)?.enabled ?? enabled,
      colorAttachments: colors,
      ...(depthStencilAttachment === undefined ? {} : { depthStencilAttachment }),
      encode: ({ pass, frame, resources }) => {
        try {
          this.encode(
            name,
            featureIdentity,
            order,
            descriptor,
            snapshot,
            drawBuffers.value,
            pass,
            frame,
            resources,
            undefined,
            scope,
            sampledDepth === undefined || originalDepth === undefined
              ? this.resolveTarget
              : (resource) => {
                  const target = this.resolveTarget(resource);
                  return target?.texture === originalDepth.texture ? sampledDepth : target;
                },
          );
        } catch (failure) {
          throwFeatureRecordingFailure(
            failure,
            featureIdentity,
            order,
            name,
            'pipeline',
            this.reportError,
          );
        }
      },
    });
  }

  /** Current admitted work needs no graph buffer imports inside a private command segment. */
  nativePass(
    work: import('./host').RenderFeaturePlanExecutionPass,
    frame: FrameCtx,
    resources: GraphResourceResolver,
    scope?: string,
  ): RenderGraphNativePass {
    const descriptor = work.graphics;
    const snapshot = work.resolvedGraphics;
    if (descriptor === undefined || snapshot === undefined)
      throw missing(work.featureIdentity, work.order);
    const colorAttachments = descriptor.attachments.colors.map((attachment) => {
      const target = this.resolveTarget(attachment.resource);
      if (target === undefined) throw missing(work.featureIdentity, work.order);
      return {
        view: resources.textureView(target.view).unwrap(),
        ...(target.resolveTarget === undefined
          ? {}
          : { resolveTarget: resources.textureView(target.resolveTarget).unwrap() }),
        loadOp: attachment.loadOp,
        storeOp: attachment.storeOp,
      };
    });
    const depth = descriptor.attachments.depthStencil;
    let depthStencilAttachment:
      | import('@forgeax/engine-rhi').RenderPassDepthStencilAttachment
      | undefined;
    if (depth !== undefined) {
      const target = this.resolveTarget(depth.resource);
      if (target === undefined) throw missing(work.featureIdentity, work.order);
      const sampled = (descriptor.sampledTargets ?? []).some(
        (sampled) => this.resolveTarget(sampled)?.texture === target.texture,
      );
      const writes = descriptor.draws.some((draw) => {
        const pipeline = snapshot.resolve(draw.pipeline);
        return pipeline?.kind === 'pipeline' && pipeline.writesDepth === true;
      });
      if (sampled && writes) throw missing(work.featureIdentity, work.order);
      depthStencilAttachment = sampled
        ? {
            view: resources.textureView(target.view).unwrap(),
            depthReadOnly: true,
            stencilReadOnly: true,
          }
        : {
            view: resources.textureView(target.view).unwrap(),
            depthLoadOp: depth.depthLoadOp,
            depthStoreOp: depth.depthStoreOp,
            stencilLoadOp: depth.depthLoadOp,
            stencilStoreOp: depth.depthStoreOp,
          };
    }
    return {
      name: work.name,
      kind: 'raster',
      descriptor: {
        label: work.name,
        colorAttachments,
        ...(depthStencilAttachment === undefined ? {} : { depthStencilAttachment }),
      },
      encode: (pass) => {
        try {
          this.encode(
            work.name,
            work.featureIdentity,
            work.order,
            descriptor,
            snapshot,
            undefined,
            pass,
            frame,
            resources,
            undefined,
            scope,
          );
        } catch (failure) {
          throwFeatureRecordingFailure(
            failure,
            work.featureIdentity,
            work.order,
            work.name,
            'pipeline',
            this.reportError,
          );
        }
      },
    };
  }

  private importDrawBuffers(
    name: string,
    featureIdentity: string,
    order: number,
    descriptor: RenderFeatureGraphicsPassDescriptor,
    snapshot: PreparedGraphicsResolvedSnapshot,
  ): Result<ResolvedDrawBuffers, RenderGraphError | RenderError> {
    const vertex = new Map<object, GraphBuffer>();
    const index = new Map<object, GraphBuffer>();
    const indirect = new Map<object, GraphBuffer>();
    const add = (
      destination: Map<object, GraphBuffer>,
      key: object,
      resource: RenderFeatureResolvedGpuBuffer,
    ): Result<void, RenderGraphError> => {
      if (destination.has(key)) return ok(undefined);
      const imported = importRenderFeatureGraphBuffer(this.builder, this.buffers, name, resource);
      if (!imported.ok) return imported;
      destination.set(key, imported.value);
      return ok(undefined);
    };

    const inputs = resolveRenderFeatureDrawBuffers(featureIdentity, order, descriptor, snapshot);
    if (!inputs.ok) return inputs;
    for (const [source, destination] of [
      [inputs.value.vertex, vertex],
      [inputs.value.index, index],
      [inputs.value.indirect, indirect],
    ] as const) {
      for (const [key, resource] of source) {
        const added = add(destination, key, resource);
        if (!added.ok) return added;
      }
    }
    return ok({ vertex, index, indirect });
  }

  private encode(
    name: string,
    featureIdentity: string,
    order: number,
    descriptor: RenderFeatureGraphicsPassDescriptor,
    snapshot: PreparedGraphicsResolvedSnapshot,
    buffers: ResolvedDrawBuffers | undefined,
    pass: RhiRenderPassEncoder,
    frame: FrameCtx,
    resources: GraphResourceResolver,
    shadowView?: BindGroup,
    scope?: string,
    resolveTarget: RenderFeatureGraphTargetResolver = this.resolveTarget,
  ): void {
    const current = currentRenderFeaturePass(frame, featureIdentity, name, scope);
    if (current?.enabled === false) return;
    const activeSnapshot = current?.resolvedGraphics ?? snapshot;
    for (const [drawIndex, draw] of descriptor.draws.entries()) {
      const activeDraw = current?.graphics?.draws[drawIndex] ?? draw;
      if (activeDraw.enabled === false) continue;
      const pipeline = resolved(activeSnapshot, activeDraw.pipeline);
      if (pipeline?.kind !== 'pipeline') throw missing(featureIdentity, order);
      pass.setPipeline(pipeline.handle);
      if (pipeline.standardLighting === true) {
        const lighting = this.resolveStandardLighting?.(frame, pipeline.handle);
        if (lighting === undefined) throw missing(featureIdentity, order);
        pass.setBindGroup(2, lighting);
      }
      for (const [group, reference] of activeDraw.bindings.entries()) {
        const binding = resolved(activeSnapshot, reference);
        if (binding?.kind !== 'bindings') throw missing(featureIdentity, order);
        const targetGroup = binding.descriptor?.values.group ?? group;
        if (shadowView !== undefined && targetGroup === 0) {
          pass.setBindGroup(0, shadowView, [0, 0]);
          continue;
        }
        // Fullscreen feature bindings contain graph-owned texture views and a
        // per-frame params UBO. Resolve them at execution time so a retained
        // graph still follows the current post-process input and authored
        // parameters; material/view bindings remain safely cached.
        const resolvedBindings = (() => {
          const resolve = () =>
            this.resolveBindings?.({
              frame,
              binding,
              resources,
              resolveTarget,
              ...(activeSnapshot.resolveGpuResource === undefined
                ? {}
                : { resolveGpuResource: activeSnapshot.resolveGpuResource }),
            });
          if (
            binding.descriptor?.values.fullscreen === true ||
            (resolveTarget !== this.resolveTarget &&
              binding.descriptor?.values.sceneDepth !== undefined)
          )
            return resolve();
          return binding.handle ?? resolve();
        })();
        const handle =
          resolvedBindings !== undefined &&
          typeof resolvedBindings === 'object' &&
          'handle' in resolvedBindings
            ? resolvedBindings.handle
            : resolvedBindings;
        if (handle === undefined) throw missing(featureIdentity, order);
        const dynamicOffsets =
          resolvedBindings !== undefined &&
          typeof resolvedBindings === 'object' &&
          'handle' in resolvedBindings
            ? resolvedBindings.dynamicOffsets
            : binding.dynamicOffsets;
        pass.setBindGroup(targetGroup, handle, dynamicOffsets);
      }
      for (const vertex of activeDraw.vertexData) {
        const original = draw.vertexData.find((binding) => binding.slot === vertex.slot);
        const currentVertex = resolved(activeSnapshot, vertex.resource);
        if (currentVertex?.kind !== 'vertex-data') throw missing(featureIdentity, order);
        const handle = original === undefined ? undefined : buffers?.vertex.get(original.resource);
        const physical =
          buffers === undefined
            ? ok(currentVertex.handle)
            : handle === undefined
              ? undefined
              : resources.buffer(handle);
        if (physical === undefined) throw missing(featureIdentity, order);
        if (!physical.ok) throw physical.error;
        if (currentVertex.handle !== physical.value) throw missing(featureIdentity, order);
        // Graph imports describe the complete physical dependency. The current
        // prepared reference owns the range, including on a retained graph.
        if (currentVertex.byteOffset === undefined && currentVertex.byteLength === undefined)
          pass.setVertexBuffer(vertex.slot, physical.value);
        else
          pass.setVertexBuffer(
            vertex.slot,
            physical.value,
            currentVertex.byteOffset ?? 0,
            currentVertex.byteLength,
          );
      }
      if (activeDraw.indexData !== undefined) {
        const currentIndex = resolved(activeSnapshot, activeDraw.indexData.resource);
        if (currentIndex?.kind !== 'index-data') throw missing(featureIdentity, order);
        const handle =
          draw.indexData === undefined ? undefined : buffers?.index.get(draw.indexData.resource);
        const physical =
          buffers === undefined
            ? ok(currentIndex.handle)
            : handle === undefined
              ? undefined
              : resources.buffer(handle);
        if (physical === undefined) throw missing(featureIdentity, order);
        if (!physical.ok) throw physical.error;
        if (currentIndex.handle !== physical.value) throw missing(featureIdentity, order);
        if (currentIndex.byteOffset === undefined && currentIndex.byteLength === undefined)
          pass.setIndexBuffer(physical.value, activeDraw.indexData.format);
        else
          pass.setIndexBuffer(
            physical.value,
            activeDraw.indexData.format,
            currentIndex.byteOffset ?? 0,
            currentIndex.byteLength,
          );
      }
      switch (activeDraw.kind) {
        case 'draw':
          pass.draw(
            activeDraw.command.vertexCount,
            activeDraw.command.instanceCount,
            activeDraw.command.firstVertex,
            activeDraw.command.firstInstance,
          );
          break;
        case 'draw-indexed':
          pass.drawIndexed(
            activeDraw.command.indexCount,
            activeDraw.command.instanceCount,
            activeDraw.command.firstIndex,
            activeDraw.command.baseVertex,
            activeDraw.command.firstInstance,
          );
          break;
        case 'draw-indirect':
        case 'draw-indexed-indirect': {
          const handle = buffers?.indirect.get(activeDraw.command.buffer as object);
          const currentBuffer = activeSnapshot.resolveGpuBuffer?.(activeDraw.command.buffer);
          const physical =
            buffers === undefined
              ? currentBuffer === undefined
                ? undefined
                : ok(currentBuffer.buffer)
              : handle === undefined
                ? undefined
                : resources.buffer(handle);
          if (physical === undefined) throw missing(featureIdentity, order);
          if (!physical.ok) throw physical.error;
          if (activeDraw.kind === 'draw-indirect') {
            pass.drawIndirect(physical.value, activeDraw.command.offset ?? 0);
          } else {
            pass.drawIndexedIndirect(physical.value, activeDraw.command.offset ?? 0);
          }
          break;
        }
      }
    }
  }
}

import type {
  Buffer,
  RenderPassColorAttachment,
  RenderPassDepthStencilAttachment,
  RhiComputePassEncoder,
  RhiDevice,
  Texture,
  TextureView,
  Tlas,
} from '@forgeax/engine-rhi';
import { err, ok, RenderGraphError, type Result } from './errors.js';
import type { ResolvedColorTargetDescriptor } from './graph.js';
import type {
  CompiledPass,
  CompiledResource,
  CompiledView,
  GraphTextureAllocation,
  ResourceHandleData,
  TextureViewRecord,
} from './kernel-internal.js';
import { handleData, releaseGraphTexture } from './kernel-internal.js';
import type {
  CompiledRenderGraph,
  CompiledRenderGraphInfo,
  GraphAccelerationStructure,
  GraphBuffer,
  GraphResourceResolver,
  GraphTexture,
  GraphTextureView,
  RenderGraphFrame,
  RenderGraphPassInstrumentation,
  RenderGraphPassRunner,
  RenderGraphResourceAllocationInspection,
} from './types.js';

/** Acceleration structures derive no RHI usage bits; a declared access keeps them live. */
function isResolved<FrameCtx>(compiled: CompiledResource<FrameCtx>): boolean {
  return compiled.record.kind === 'acceleration-structure'
    ? compiled.firstUse !== null
    : compiled.usage !== 0;
}

interface FrameResources {
  readonly buffers: ReadonlyMap<number, Buffer>;
  readonly textures: ReadonlyMap<number, Texture>;
  readonly views: ReadonlyMap<number, TextureView>;
  readonly accelerationStructures: ReadonlyMap<number, Tlas>;
}

interface AllocationEntry {
  readonly handle: unknown;
  readonly bytes: number | undefined;
  readonly newlyAllocated: boolean;
}

/**
 * Compiled-graph owner ledger. It counts only graph-created physical handles;
 * imported handles are references owned by the caller and remain byte-unknown.
 */
class RenderGraphAllocationLedger {
  private readonly allocations = new Map<
    unknown,
    { bytes: number | undefined; state: 'live' | 'pending-retirement' }
  >();
  private inspection: RenderGraphResourceAllocationInspection | undefined;
  private liveBytes = 0;
  private pendingBytes = 0;
  private peakBytes = 0;
  private successfulAllocationCount = 0;
  private successfulAllocationBytes = 0;
  private retiredBytes = 0;
  private unknownByteSizeCount = 0;
  private readonly importedResourceCount: number;

  constructor(entries: readonly AllocationEntry[], importedResourceCount: number) {
    this.importedResourceCount = importedResourceCount;
    for (const entry of entries) this.allocate(entry.handle, entry.bytes, entry.newlyAllocated);
  }

  inspect(): RenderGraphResourceAllocationInspection {
    if (this.inspection !== undefined) return this.inspection;
    this.inspection = Object.freeze({
      unit: 'engine-allocation-bytes',
      physicalResidency: 'unknown',
      liveBytes: this.liveBytes,
      pendingRetirementBytes: this.pendingBytes,
      peakBytes: this.peakBytes,
      successfulAllocationCount: this.successfulAllocationCount,
      successfulAllocationBytes: this.successfulAllocationBytes,
      pendingRetirementCount: [...this.allocations.values()].filter(
        (entry) => entry.state === 'pending-retirement',
      ).length,
      retiredBytes: this.retiredBytes,
      failedAllocationRollbacks: 0,
      failedAllocationRollbackBytes: 0,
      unknownByteSizeCount: this.unknownByteSizeCount,
      importedResourceCount: this.importedResourceCount,
    });
    return this.inspection;
  }

  state(handle: unknown): 'live' | 'pending-retirement' | 'released' {
    return this.allocations.get(handle)?.state ?? 'released';
  }

  retireAll(): void {
    for (const entry of this.allocations.values()) {
      if (entry.state !== 'live') continue;
      this.inspection = undefined;
      entry.state = 'pending-retirement';
      if (entry.bytes !== undefined) {
        this.liveBytes -= entry.bytes;
        this.pendingBytes += entry.bytes;
      }
    }
  }

  release(handle: unknown): void {
    const entry = this.allocations.get(handle);
    if (entry === undefined) return;
    this.inspection = undefined;
    this.allocations.delete(handle);
    if (entry.bytes === undefined) this.unknownByteSizeCount -= 1;
    else {
      if (entry.state === 'live') this.liveBytes -= entry.bytes;
      else this.pendingBytes -= entry.bytes;
      this.retiredBytes += entry.bytes;
    }
  }

  private allocate(handle: unknown, bytes: number | undefined, newlyAllocated: boolean): void {
    if (this.allocations.has(handle)) return;
    this.inspection = undefined;
    this.allocations.set(handle, { bytes, state: 'live' });
    if (newlyAllocated) this.successfulAllocationCount += 1;
    if (bytes === undefined) this.unknownByteSizeCount += 1;
    else {
      this.liveBytes += bytes;
      if (newlyAllocated) this.successfulAllocationBytes += bytes;
    }
    this.updatePeak();
  }

  private updatePeak(): void {
    this.peakBytes = Math.max(this.peakBytes, this.liveBytes + this.pendingBytes);
  }
}

function resolutionError(label: string, cause?: unknown): RenderGraphError {
  return new RenderGraphError({
    code: 'resource-resolution-failed',
    expected: `resource '${label}' resolves to a live RHI handle for this frame`,
    hint: `repair the imported owner for '${label}' before executing the graph`,
    detail: { resourceLabel: label, ...(cause === undefined ? {} : { accesses: [String(cause)] }) },
  });
}

export class CompiledRenderGraphImpl<FrameCtx extends RenderGraphFrame>
  implements CompiledRenderGraph<FrameCtx>
{
  private retired = false;
  private retireResult: Promise<Result<void, RenderGraphError>> | undefined;
  private readonly allocationLedger: RenderGraphAllocationLedger;
  private inspection: CompiledRenderGraphInfo | undefined;

  constructor(
    private readonly generation: number,
    private readonly owner: object,
    private readonly device: RhiDevice,
    private readonly resources: ReadonlyMap<number, CompiledResource<FrameCtx>>,
    private readonly views: ReadonlyMap<number, CompiledView<FrameCtx>>,
    private readonly passes: readonly CompiledPass<FrameCtx>[],
    private readonly info: CompiledRenderGraphInfo,
    private readonly colorTargetDescriptors: ReadonlyMap<string, ResolvedColorTargetDescriptor>,
  ) {
    const infoByLabel = new Map(info.resources.map((resource) => [resource.label, resource]));
    const entries: AllocationEntry[] = [];
    let importedResourceCount = 0;
    for (const compiled of resources.values()) {
      if (!isResolved(compiled)) continue;
      const handle = compiled.texture ?? compiled.buffer;
      if (compiled.record.origin === 'imported') {
        importedResourceCount += 1;
        continue;
      }
      if (handle === undefined) continue;
      entries.push({
        handle,
        bytes: infoByLabel.get(compiled.record.label)?.byteSize,
        newlyAllocated:
          compiled.textureAllocation === undefined || compiled.textureAllocation.references === 1,
      });
    }
    this.allocationLedger = new RenderGraphAllocationLedger(entries, importedResourceCount);
  }

  inspect(): CompiledRenderGraphInfo {
    const allocation = this.allocationLedger.inspect();
    if (this.inspection?.resourceAllocation === allocation) return this.inspection;
    const states = new Map<string, 'live' | 'pending-retirement' | 'released'>();
    for (const resource of this.resources.values()) {
      states.set(
        resource.record.label,
        this.allocationLedger.state(resource.texture ?? resource.buffer),
      );
    }
    const resources = this.info.resources.map((resource) => {
      if (resource.origin !== 'created' || resource.physicalAllocationKey === undefined)
        return resource;
      return Object.freeze({ ...resource, allocationState: states.get(resource.label) });
    });
    this.inspection = Object.freeze({
      ...this.info,
      resources: Object.freeze(resources),
      resourceAllocation: allocation,
    });
    return this.inspection;
  }

  retainTexture(
    device: RhiDevice,
    label: string,
    signature: string,
  ): GraphTextureAllocation | undefined {
    if (this.retired || this.device !== device) return undefined;
    for (const resource of this.resources.values()) {
      const allocation = resource.textureAllocation;
      if (resource.record.label !== label || allocation?.signature !== signature) continue;
      allocation.references += 1;
      return allocation;
    }
    return undefined;
  }

  reuseTextureView(
    device: RhiDevice,
    texture: Texture,
    record: TextureViewRecord<FrameCtx>,
  ): TextureView | undefined {
    if (this.retired || this.device !== device) return undefined;
    const descriptor = record.descriptor;
    const matches = (compiled: CompiledView<FrameCtx> | undefined): boolean => {
      if (
        compiled?.view === undefined ||
        this.resources.get(compiled.record.textureId)?.texture !== texture
      )
        return false;
      const previous = compiled.record.descriptor;
      return (
        previous.format === descriptor.format &&
        previous.dimension === descriptor.dimension &&
        previous.aspect === descriptor.aspect &&
        previous.baseMipLevel === descriptor.baseMipLevel &&
        previous.mipLevelCount === descriptor.mipLevelCount &&
        previous.baseArrayLayer === descriptor.baseArrayLayer &&
        previous.arrayLayerCount === descriptor.arrayLayerCount
      );
    };
    // Ordinals are only a probe; physical texture and complete view fields
    // remain authoritative when feature declarations change their order.
    const previous = this.views.get(record.id);
    if (matches(previous)) return previous?.view;
    for (const compiled of this.views.values()) {
      if (compiled !== previous && matches(compiled)) return compiled.view;
    }
    return undefined;
  }

  getColorTargetView(name: string): TextureView | undefined {
    for (const view of this.views.values()) {
      const resource = this.resources.get(view.record.textureId);
      if (resource?.record.label === name) return view.view;
    }
    return undefined;
  }

  getColorTargetTexture(name: string): Texture | undefined {
    for (const resource of this.resources.values()) {
      if (resource.record.label === name) return resource.texture;
    }
    return undefined;
  }

  getColorTargetDescriptor(name: string): ResolvedColorTargetDescriptor | undefined {
    return this.colorTargetDescriptors.get(name);
  }

  execute(
    frame: FrameCtx,
    runPass?: RenderGraphPassRunner,
    instrumentation?: RenderGraphPassInstrumentation<FrameCtx>,
  ): Result<void, RenderGraphError> {
    if (this.retired) {
      return err(
        new RenderGraphError({
          code: 'compiled-graph-retired',
          expected: 'a compiled graph executes only before retire()',
          hint: 'publish and execute the replacement compiled graph',
          detail: { generation: this.generation },
        }),
      );
    }

    const resolved = this.resolveFrameResources(frame);
    if (!resolved.ok) return resolved;

    for (const [executionIndex, pass] of this.passes.entries()) {
      const resolver = this.createPassResolver(pass, resolved.value);
      try {
        if (pass.pass.descriptor.executeIf?.(frame) === false) continue;
        const execution = { name: pass.name, kind: pass.pass.kind, executionIndex };
        let encodeResult: Result<void, RenderGraphError> = ok(undefined);
        const encode = () => {
          // Resolve instrumentation only when the runner actually enters the
          // pass. A runner may inspect or skip a pass without calling encode;
          // such a pass must not reserve timestamp queries that it never
          // writes.
          const scope = instrumentation?.begin(execution, frame);
          switch (pass.pass.kind) {
            case 'raster': {
              const descriptor = pass.pass.descriptor;
              const colorAttachments: RenderPassColorAttachment[] = [];
              for (const attachment of descriptor.colorAttachments) {
                const view = resolver.textureView(attachment.view);
                if (!view.ok) {
                  encodeResult = view;
                  return;
                }
                const resolveTarget =
                  attachment.resolveTarget === undefined
                    ? undefined
                    : resolver.textureView(attachment.resolveTarget);
                if (resolveTarget !== undefined && !resolveTarget.ok) {
                  encodeResult = resolveTarget;
                  return;
                }
                const clearValue =
                  typeof attachment.clearValue === 'function'
                    ? attachment.clearValue(frame)
                    : attachment.clearValue;
                colorAttachments.push({
                  view: view.value,
                  ...(resolveTarget === undefined ? {} : { resolveTarget: resolveTarget.value }),
                  ...(clearValue === undefined ? {} : { clearValue }),
                  loadOp: attachment.loadOp,
                  storeOp: attachment.storeOp,
                  ...(attachment.depthSlice === undefined
                    ? {}
                    : { depthSlice: attachment.depthSlice }),
                });
              }
              let depthStencilAttachment: RenderPassDepthStencilAttachment | undefined;
              if (descriptor.depthStencilAttachment !== undefined) {
                const attachment = descriptor.depthStencilAttachment;
                const view = resolver.textureView(attachment.view);
                if (!view.ok) {
                  encodeResult = view;
                  return;
                }
                depthStencilAttachment = {
                  view: view.value,
                  ...(attachment.depthClearValue === undefined
                    ? {}
                    : { depthClearValue: attachment.depthClearValue }),
                  ...(attachment.depthLoadOp === undefined
                    ? {}
                    : { depthLoadOp: attachment.depthLoadOp }),
                  ...(attachment.depthStoreOp === undefined
                    ? {}
                    : { depthStoreOp: attachment.depthStoreOp }),
                  ...(attachment.depthReadOnly === undefined
                    ? {}
                    : { depthReadOnly: attachment.depthReadOnly }),
                  ...(attachment.stencilClearValue === undefined
                    ? {}
                    : { stencilClearValue: attachment.stencilClearValue }),
                  ...(attachment.stencilLoadOp === undefined
                    ? {}
                    : { stencilLoadOp: attachment.stencilLoadOp }),
                  ...(attachment.stencilStoreOp === undefined
                    ? {}
                    : { stencilStoreOp: attachment.stencilStoreOp }),
                  ...(attachment.stencilReadOnly === undefined
                    ? {}
                    : { stencilReadOnly: attachment.stencilReadOnly }),
                };
              }
              const querySet =
                typeof descriptor.occlusionQuerySet === 'function'
                  ? descriptor.occlusionQuerySet(frame)
                  : descriptor.occlusionQuerySet;
              const baseDescriptor = {
                label: pass.name,
                colorAttachments,
                ...(depthStencilAttachment === undefined ? {} : { depthStencilAttachment }),
                ...(querySet === undefined ? {} : { occlusionQuerySet: querySet }),
              };
              const instrumentedDescriptor =
                scope?.renderPassDescriptor?.(baseDescriptor) ?? baseDescriptor;
              const encoder = frame.encoder.beginRenderPass(instrumentedDescriptor);
              try {
                descriptor.encode({ pass: encoder, frame, resources: resolver });
              } finally {
                encoder.end();
              }
              break;
            }
            case 'compute': {
              const begin = pass.pass.descriptor.begin?.(frame);
              const instrumentedBegin = scope?.computePassDescriptor?.(begin ?? {}) ?? begin;
              let encoder: RhiComputePassEncoder;
              try {
                encoder = frame.encoder.beginComputePass({
                  ...(instrumentedBegin ?? {}),
                  label: pass.name,
                });
              } catch (cause) {
                pass.pass.descriptor.onBeginError?.(frame, cause);
                throw cause;
              }
              try {
                pass.pass.descriptor.encode({ pass: encoder, frame, resources: resolver });
              } finally {
                encoder.end();
              }
              pass.pass.descriptor.after?.(frame);
              break;
            }
            case 'copy':
              scope?.beforeCopy?.(frame.encoder);
              try {
                pass.pass.descriptor.encode({ encoder: frame.encoder, frame, resources: resolver });
              } finally {
                scope?.afterCopy?.(frame.encoder);
              }
              break;
          }
        };
        if (runPass === undefined) {
          encode();
        } else {
          runPass(execution, encode);
        }
        if (!encodeResult.ok) return encodeResult;
      } catch (cause) {
        return err(
          new RenderGraphError({
            code: 'pass-encode-failed',
            expected: `pass '${pass.name}' encodes without throwing`,
            hint: 'inspect detail.cause and repair the pass-owned RHI command',
            detail: { passName: pass.name, passKind: pass.pass.kind, cause },
          }),
        );
      }
    }
    return ok(undefined);
  }

  retire(): Promise<Result<void, RenderGraphError>> {
    if (this.retireResult !== undefined) return this.retireResult;
    this.retired = true;
    this.retireResult = this.finishRetire();
    return this.retireResult;
  }

  private async finishRetire(): Promise<Result<void, RenderGraphError>> {
    this.allocationLedger.retireAll();
    try {
      await this.device.queue.onSubmittedWorkDone();
    } catch (cause) {
      return err(
        new RenderGraphError({
          code: 'resource-retire-failed',
          expected: 'the GPU submission fence resolves before graph resources retire',
          hint: 'recover the device before retiring the replacement generation',
          detail: { generation: this.generation, cause },
        }),
      );
    }

    let firstFailure: RenderGraphError | undefined;
    for (const compiled of this.resources.values()) {
      if (compiled.record.origin === 'imported') continue;
      if (compiled.texture === undefined && compiled.buffer === undefined) continue;
      let destroyedSuccessfully = false;
      try {
        const destroyed =
          compiled.textureAllocation !== undefined
            ? releaseGraphTexture(this.device, compiled.textureAllocation)
            : compiled.record.kind === 'texture'
              ? this.device.destroyTexture(compiled.texture as Texture)
              : this.device.destroyBuffer(compiled.buffer as Buffer);
        destroyedSuccessfully = destroyed.ok;
        if (!destroyed.ok && firstFailure === undefined) {
          firstFailure = new RenderGraphError({
            code: 'resource-retire-failed',
            expected: `graph-created resource '${compiled.record.label}' retires exactly once`,
            hint: 'inspect detail.cause for the RHI destroy refusal',
            detail: {
              generation: this.generation,
              resourceLabel: compiled.record.label,
              cause: destroyed.error,
            },
          });
        }
      } catch (cause) {
        firstFailure ??= new RenderGraphError({
          code: 'resource-retire-failed',
          expected: `graph-created resource '${compiled.record.label}' retires exactly once`,
          hint: 'inspect detail.cause for the RHI destroy failure',
          detail: { generation: this.generation, resourceLabel: compiled.record.label, cause },
        });
      } finally {
        // A failed or throwing destroy leaves the handle owned by this
        // graph. Keep its token pending so inspection reflects the
        // retirement failure instead of claiming bytes were released.
        if (destroyedSuccessfully)
          this.allocationLedger.release(compiled.texture ?? compiled.buffer);
      }
    }
    return firstFailure === undefined ? ok(undefined) : err(firstFailure);
  }

  private resolveFrameResources(frame: FrameCtx): Result<FrameResources, RenderGraphError> {
    const buffers = new Map<number, Buffer>();
    const textures = new Map<number, Texture>();
    const views = new Map<number, TextureView>();
    const accelerationStructures = new Map<number, Tlas>();

    for (const compiled of this.resources.values()) {
      if (!isResolved(compiled)) continue;
      try {
        if (compiled.record.kind === 'texture') {
          const texture =
            compiled.record.origin === 'created'
              ? compiled.texture
              : compiled.record.resolve(frame);
          if (texture === undefined) return err(resolutionError(compiled.record.label));
          textures.set(compiled.record.id, texture);
        } else if (compiled.record.kind === 'acceleration-structure') {
          accelerationStructures.set(compiled.record.id, compiled.record.resolve(frame));
        } else {
          const buffer =
            compiled.record.origin === 'created' ? compiled.buffer : compiled.record.resolve(frame);
          if (buffer === undefined) return err(resolutionError(compiled.record.label));
          buffers.set(compiled.record.id, buffer);
        }
      } catch (cause) {
        return err(resolutionError(compiled.record.label, cause));
      }
    }

    for (const compiledView of this.views.values()) {
      if (this.resources.get(compiledView.record.textureId)?.usage === 0) continue;
      if (compiledView.record.resolve !== undefined) {
        try {
          views.set(compiledView.record.id, compiledView.record.resolve(frame));
        } catch (cause) {
          return err(resolutionError(compiledView.record.label, cause));
        }
        continue;
      }
      if (compiledView.view !== undefined) {
        views.set(compiledView.record.id, compiledView.view);
        continue;
      }
      const texture = textures.get(compiledView.record.textureId);
      if (texture === undefined) return err(resolutionError(compiledView.record.label));
      const created = this.device.createTextureView(texture, compiledView.record.descriptor);
      if (!created.ok) return err(resolutionError(compiledView.record.label, created.error));
      views.set(compiledView.record.id, created.value);
    }
    return ok({ buffers, textures, views, accelerationStructures });
  }

  private createPassResolver(
    pass: CompiledPass<FrameCtx>,
    frameResources: FrameResources,
  ): GraphResourceResolver {
    const lookup = (
      resource: GraphBuffer | GraphTexture | GraphTextureView | GraphAccelerationStructure,
      expectedKind: ResourceHandleData['kind'],
    ): Result<ResourceHandleData, RenderGraphError> => {
      const data = handleData(resource);
      const resourceId = data?.kind === 'texture-view' ? data.textureId : data?.id;
      if (data === undefined || data.owner !== this.owner || data.kind !== expectedKind) {
        return err(
          new RenderGraphError({
            code: 'foreign-resource-handle',
            expected: `pass '${pass.name}' resolves a handle owned by this compiled graph`,
            hint: 'use only handles created by the builder that declared this pass',
            detail: { passName: pass.name },
          }),
        );
      }
      if (resourceId === undefined || !pass.resourceIds.has(resourceId)) {
        const label = this.resources.get(resourceId ?? -1)?.record.label;
        return err(
          new RenderGraphError({
            code: 'resource-not-declared-by-pass',
            expected: `pass '${pass.name}' resolves only resources present in its accesses`,
            hint: 'add the resource access to this pass before resolving it',
            detail: { passName: pass.name, resourceLabel: label },
          }),
        );
      }
      if (data.kind === 'texture-view' && !pass.viewIds.has(data.id)) {
        const label = this.views.get(data.id)?.record.label;
        return err(
          new RenderGraphError({
            code: 'resource-not-declared-by-pass',
            expected: `pass '${pass.name}' resolves only texture views present in its accesses`,
            hint: 'add this exact texture view to the pass accesses',
            detail: { passName: pass.name, resourceLabel: label },
          }),
        );
      }
      return ok(data);
    };

    return {
      buffer: (resource) => {
        const data = lookup(resource, 'buffer');
        if (!data.ok) return data;
        const buffer = frameResources.buffers.get(data.value.id);
        return buffer === undefined
          ? err(resolutionError(this.resources.get(data.value.id)?.record.label ?? 'buffer'))
          : ok(buffer);
      },
      texture: (resource) => {
        const data = lookup(resource, 'texture');
        if (!data.ok) return data;
        const texture = frameResources.textures.get(data.value.id);
        return texture === undefined
          ? err(resolutionError(this.resources.get(data.value.id)?.record.label ?? 'texture'))
          : ok(texture);
      },
      textureView: (resource) => {
        const data = lookup(resource, 'texture-view');
        if (!data.ok) return data;
        const view = frameResources.views.get(data.value.id);
        return view === undefined
          ? err(resolutionError(this.views.get(data.value.id)?.record.label ?? 'texture view'))
          : ok(view);
      },
      textureViewExtent: (resource) => {
        const data = lookup(resource, 'texture-view');
        if (!data.ok) return data;
        const view = this.views.get(data.value.id)?.record;
        const texture = this.resources.get(view?.textureId ?? -1);
        const extent = texture?.textureDescriptor?.size;
        if (view === undefined || extent === undefined) {
          return err(resolutionError(texture?.record.label ?? 'texture view'));
        }
        const divisor = 2 ** (view.descriptor.baseMipLevel ?? 0);
        return ok({
          width: Math.max(1, Math.floor(extent.width / divisor)),
          height: Math.max(1, Math.floor(extent.height / divisor)),
        });
      },
      accelerationStructure: (resource) => {
        const data = lookup(resource, 'acceleration-structure');
        if (!data.ok) return data;
        const tlas = frameResources.accelerationStructures.get(data.value.id);
        return tlas === undefined
          ? err(
              resolutionError(
                this.resources.get(data.value.id)?.record.label ?? 'acceleration structure',
              ),
            )
          : ok(tlas);
      },
    };
  }
}

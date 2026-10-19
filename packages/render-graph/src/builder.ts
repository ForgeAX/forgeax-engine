import type { Buffer, RhiCaps, Texture, TextureView, Tlas } from '@forgeax/engine-rhi';
import { textureFormatBlock } from '@forgeax/engine-types';
import { CompiledRenderGraphImpl } from './compiled-graph.js';
import { err, ok, RenderGraphError, type Result } from './errors.js';
import type { ResolvedColorTargetDescriptor } from './graph.js';
import {
  accelerationStructureHandle,
  accessResourceId,
  bufferHandle,
  type CompiledPass,
  type CompiledResource,
  type CompiledView,
  type GraphTextureAllocation,
  handleData,
  type PassRecord,
  physicalAllocationKey,
  type ResourceRecord,
  releaseGraphTexture,
  snapshotPass,
  snapshotTextureDescriptor,
  type TextureViewRecord,
  textureHandle,
  textureViewHandle,
} from './kernel-internal.js';
import { isTextureViewDimensionCompatible } from './resource-registry.js';
import type {
  CompiledRenderGraph,
  CompiledRenderGraphInfo,
  ComputeGraphPass,
  CopyGraphPass,
  GraphAccelerationStructure,
  GraphAccess,
  GraphAccessUsage,
  GraphBuffer,
  GraphBufferAccess,
  GraphBufferDescriptor,
  GraphExtent,
  GraphPass,
  GraphTexture,
  GraphTextureAccess,
  GraphTextureDescriptor,
  GraphTextureView,
  GraphTextureViewDescriptor,
  ImportedAccelerationStructureDescriptor,
  ImportedBufferDescriptor,
  ImportedTextureDescriptor,
  ImportedTextureViewResolver,
  RasterGraphPass,
  RenderGraphCompileOptions,
  RenderGraphFrame,
  SubgraphPass,
} from './types.js';

const BUFFER_USAGE = {
  copySrc: 0x0004,
  copyDst: 0x0008,
  index: 0x0010,
  vertex: 0x0020,
  uniform: 0x0040,
  storage: 0x0080,
  indirect: 0x0100,
} as const;

const TEXTURE_USAGE = {
  copySrc: 0x01,
  copyDst: 0x02,
  textureBinding: 0x04,
  storageBinding: 0x08,
  renderAttachment: 0x10,
} as const;

let nextGeneration = 1;

// Inspection retains its admitted format set; implementation-dependent depth and
// unmodeled compressed allocations still report an unknown byte size.
const KNOWN_TEXTURE_BYTE_FORMATS = new Set<GPUTextureFormat>([
  'r8unorm',
  'r8snorm',
  'r8uint',
  'r8sint',
  'rg8unorm',
  'rg8snorm',
  'rg8uint',
  'rg8sint',
  'r16unorm',
  'r16snorm',
  'r16uint',
  'r16sint',
  'r16float',
  'rgba8unorm',
  'rgba8unorm-srgb',
  'rgba8snorm',
  'rgba8uint',
  'rgba8sint',
  'r32float',
  'r32uint',
  'r32sint',
  'depth32float',
  'rg16float',
  'rg16uint',
  'rg16sint',
  'rg16snorm',
  'rg16unorm',
  'rgba16float',
  'rgba16uint',
  'rgba16sint',
  'rgba16snorm',
  'rgba16unorm',
  'rg32float',
  'rg32uint',
  'rg32sint',
  'rgba32float',
  'rgba32uint',
  'rgba32sint',
]);

function textureByteSize(
  format: GPUTextureFormat,
  dimension: GPUTextureDimension,
  extent: { readonly width: number; readonly height: number; readonly depthOrArrayLayers: number },
  mipLevelCount: number,
  sampleCount: number,
): number | undefined {
  if (!KNOWN_TEXTURE_BYTE_FORMATS.has(format)) return undefined;
  const bytesPerTexel = textureFormatBlock(format).bytesPerBlock;
  let bytes = 0;
  let width = extent.width;
  let height = extent.height;
  let depth = extent.depthOrArrayLayers;
  for (let level = 0; level < mipLevelCount; level += 1) {
    bytes += width * height * depth * bytesPerTexel * sampleCount;
    width = Math.max(1, Math.floor(width / 2));
    height = Math.max(1, Math.floor(height / 2));
    // Array layers are independent images and retain their layer count at
    // every mip. Only a true 3D allocation reduces its depth axis.
    if (dimension === '3d') depth = Math.max(1, Math.floor(depth / 2));
  }
  return bytes;
}

type ResourceAnalysis = {
  -readonly [Key in 'usage' | 'firstUse' | 'lastUse']: CompiledResource<unknown>[Key];
};

interface NormalizedRange {
  readonly mipStart: number;
  readonly mipEnd: number;
  readonly layerStart: number;
  readonly layerEnd: number;
  readonly aspect: GPUTextureAspect;
}

interface NormalizedAccess {
  readonly passIndex: number;
  readonly resourceId: number;
  readonly viewId?: number | undefined;
  readonly usage: GraphAccessUsage;
  readonly read: boolean;
  readonly write: boolean;
  readonly range?: NormalizedRange | undefined;
}

function bufferUsage(access: GraphBufferAccess): number {
  switch (access) {
    case 'uniform-read':
      return BUFFER_USAGE.uniform;
    case 'storage-read':
    case 'storage-write':
    case 'storage-read-write':
      return BUFFER_USAGE.storage;
    case 'indirect-read':
      return BUFFER_USAGE.indirect;
    case 'vertex-read':
      return BUFFER_USAGE.vertex;
    case 'index-read':
      return BUFFER_USAGE.index;
    case 'copy-src':
      return BUFFER_USAGE.copySrc;
    case 'copy-dst':
      return BUFFER_USAGE.copyDst;
  }
}

function textureUsage(access: GraphTextureAccess): number {
  switch (access) {
    case 'sampled-read':
      return TEXTURE_USAGE.textureBinding;
    case 'storage-read':
    case 'storage-write':
    case 'storage-read-write':
      return TEXTURE_USAGE.storageBinding;
    case 'sampled-storage-read-write':
    case 'sampled-storage-write':
      return TEXTURE_USAGE.storageBinding | TEXTURE_USAGE.textureBinding;
    case 'color-attachment':
    case 'depth-stencil-read':
    case 'depth-stencil-write':
      return TEXTURE_USAGE.renderAttachment;
    case 'copy-src':
      return TEXTURE_USAGE.copySrc;
    case 'copy-dst':
      return TEXTURE_USAGE.copyDst;
  }
}

const READ_ACCESS_MODE = Object.freeze({ read: true, write: false });
const WRITE_ACCESS_MODE = Object.freeze({ read: false, write: true });
const READ_WRITE_ACCESS_MODE = Object.freeze({ read: true, write: true });

function accessMode(access: GraphAccessUsage): {
  readonly read: boolean;
  readonly write: boolean;
} {
  switch (access) {
    case 'storage-read-write':
    case 'sampled-storage-read-write':
      return READ_WRITE_ACCESS_MODE;
    case 'storage-write':
    case 'sampled-storage-write':
    case 'color-attachment':
    case 'depth-stencil-write':
    case 'copy-dst':
    case 'acceleration-structure-build':
      return WRITE_ACCESS_MODE;
    default:
      return READ_ACCESS_MODE;
  }
}

function rangesOverlap(
  left: NormalizedRange | undefined,
  right: NormalizedRange | undefined,
): boolean {
  if (left === undefined || right === undefined) return true;
  const aspectOverlap =
    left.aspect === 'all' || right.aspect === 'all' || left.aspect === right.aspect;
  return (
    aspectOverlap &&
    left.mipStart < right.mipEnd &&
    right.mipStart < left.mipEnd &&
    left.layerStart < right.layerEnd &&
    right.layerStart < left.layerEnd
  );
}

export class RenderGraphBuilder<FrameCtx extends RenderGraphFrame> {
  private readonly owner = Object.freeze({});
  private readonly labels = new Set<string>();
  private readonly resources = new Map<number, ResourceRecord<FrameCtx>>();
  private readonly views = new Map<number, TextureViewRecord<FrameCtx>>();
  private readonly passes: PassRecord<FrameCtx>[] = [];
  private readonly passNames = new Set<string>();
  private nextId = 1;
  private sealed = false;

  createTexture(
    label: string,
    descriptor: GraphTextureDescriptor,
  ): Result<GraphTexture, RenderGraphError> {
    if (this.sealed) return err(this.sealedError());
    const unique = this.reserveLabel(label);
    if (unique !== undefined) return err(unique);
    const id = this.nextId++;
    this.resources.set(id, {
      id,
      label,
      kind: 'texture',
      origin: 'created',
      descriptor: snapshotTextureDescriptor(descriptor),
    });
    return ok(textureHandle(this.owner, id));
  }

  importTexture(
    label: string,
    descriptor: ImportedTextureDescriptor,
    resolve: (frame: FrameCtx) => Texture,
  ): Result<GraphTexture, RenderGraphError> {
    if (this.sealed) return err(this.sealedError());
    const unique = this.reserveLabel(label);
    if (unique !== undefined) return err(unique);
    const id = this.nextId++;
    this.resources.set(id, {
      id,
      label,
      kind: 'texture',
      origin: 'imported',
      descriptor: snapshotTextureDescriptor(descriptor),
      resolve,
    });
    return ok(textureHandle(this.owner, id));
  }

  /** Independent graph storage with the source's exact allocation descriptor. */
  createTextureLike(label: string, source: GraphTexture): Result<GraphTexture, RenderGraphError> {
    const data = handleData(source);
    if (data?.kind !== 'texture' || data.owner !== this.owner)
      return err(this.foreignHandleError());
    const record = this.resources.get(data.id);
    if (record?.kind !== 'texture') return err(this.foreignHandleError());
    return this.createTexture(label, record.descriptor);
  }

  createBuffer(
    label: string,
    descriptor: GraphBufferDescriptor,
  ): Result<GraphBuffer, RenderGraphError> {
    if (this.sealed) return err(this.sealedError());
    const unique = this.reserveLabel(label);
    if (unique !== undefined) return err(unique);
    const id = this.nextId++;
    this.resources.set(id, {
      id,
      label,
      kind: 'buffer',
      origin: 'created',
      descriptor: Object.freeze({ ...descriptor }),
    });
    return ok(bufferHandle(this.owner, id));
  }

  importBuffer(
    label: string,
    descriptor: ImportedBufferDescriptor,
    resolve: (frame: FrameCtx) => Buffer,
  ): Result<GraphBuffer, RenderGraphError> {
    if (this.sealed) return err(this.sealedError());
    const unique = this.reserveLabel(label);
    if (unique !== undefined) return err(unique);
    const id = this.nextId++;
    this.resources.set(id, {
      id,
      label,
      kind: 'buffer',
      origin: 'imported',
      descriptor: Object.freeze({ ...descriptor }),
      resolve,
    });
    return ok(bufferHandle(this.owner, id));
  }

  importAccelerationStructure(
    label: string,
    descriptor: ImportedAccelerationStructureDescriptor,
    resolve: (frame: FrameCtx) => Tlas,
  ): Result<GraphAccelerationStructure, RenderGraphError> {
    if (this.sealed) return err(this.sealedError());
    const unique = this.reserveLabel(label);
    if (unique !== undefined) return err(unique);
    const id = this.nextId++;
    this.resources.set(id, {
      id,
      label,
      kind: 'acceleration-structure',
      origin: 'imported',
      descriptor: Object.freeze({ ...descriptor }),
      resolve,
    });
    return ok(accelerationStructureHandle(this.owner, id));
  }

  view(
    texture: GraphTexture,
    descriptor: GraphTextureViewDescriptor = {},
  ): Result<GraphTextureView, RenderGraphError> {
    if (this.sealed) return err(this.sealedError());
    const data = handleData(texture);
    if (data?.kind !== 'texture' || data.owner !== this.owner) {
      return err(this.foreignHandleError());
    }
    const textureRecord = this.resources.get(data.id);
    if (textureRecord?.kind !== 'texture') return err(this.foreignHandleError());
    const label = descriptor.label ?? `${textureRecord.label}.view.${this.nextId}`;
    const unique = this.reserveLabel(label);
    if (unique !== undefined) return err(unique);
    const id = this.nextId++;
    this.views.set(id, {
      id,
      label,
      textureId: data.id,
      descriptor: Object.freeze({ ...descriptor }),
    });
    return ok(textureViewHandle(this.owner, id, data.id));
  }

  importView(
    texture: GraphTexture,
    descriptor: GraphTextureViewDescriptor,
    resolve: ImportedTextureViewResolver<FrameCtx>,
  ): Result<GraphTextureView, RenderGraphError> {
    if (this.sealed) return err(this.sealedError());
    const data = handleData(texture);
    if (data?.kind !== 'texture' || data.owner !== this.owner) {
      return err(this.foreignHandleError());
    }
    const textureRecord = this.resources.get(data.id);
    if (textureRecord?.kind !== 'texture' || textureRecord.origin !== 'imported') {
      return err(
        new RenderGraphError({
          code: 'resource-descriptor-invalid',
          expected: 'an imported view belongs to an imported texture',
          hint: 'use view() for graph-created textures and importView() for host-owned views',
          detail: {
            resourceLabel: textureRecord?.label ?? 'foreign',
            field: 'origin',
            expected: 'imported',
            actual: textureRecord?.origin ?? 'foreign',
          },
        }),
      );
    }
    const label = descriptor.label ?? `${textureRecord.label}.view.${this.nextId}`;
    const unique = this.reserveLabel(label);
    if (unique !== undefined) return err(unique);
    const id = this.nextId++;
    this.views.set(id, {
      id,
      label,
      textureId: data.id,
      descriptor: Object.freeze({ ...descriptor }),
      resolve,
    });
    return ok(textureViewHandle(this.owner, id, data.id));
  }

  addRasterPass(
    name: string,
    descriptor: RasterGraphPass<FrameCtx>,
  ): Result<void, RenderGraphError> {
    return this.addPass(name, { kind: 'raster', descriptor });
  }

  addComputePass(
    name: string,
    descriptor: ComputeGraphPass<FrameCtx>,
  ): Result<void, RenderGraphError> {
    return this.addPass(name, { kind: 'compute', descriptor });
  }

  addCopyPass(name: string, descriptor: CopyGraphPass<FrameCtx>): Result<void, RenderGraphError> {
    return this.addPass(name, { kind: 'copy', descriptor });
  }

  addSubgraphPass(
    name: string,
    descriptor: SubgraphPass<FrameCtx>,
  ): Result<void, RenderGraphError> {
    return this.addPass(name, { kind: 'subgraph', descriptor });
  }

  compile(
    options: RenderGraphCompileOptions,
  ): Result<CompiledRenderGraph<FrameCtx>, RenderGraphError> {
    if (this.sealed) return err(this.sealedError());
    this.sealed = true;

    const descriptors = this.validateDescriptors(options.surfaceSize);
    if (!descriptors.ok) return descriptors;
    const analyzed = this.analyze(options.device.caps);
    if (!analyzed.ok) return analyzed;

    const allocated = this.allocate(options, analyzed.value.resources);
    if (!allocated.ok) return allocated;

    const generation = nextGeneration;
    const physicalKey = (resource: CompiledResource<FrameCtx>): string | undefined => {
      const handle = resource.texture ?? resource.buffer;
      return handle === undefined ? undefined : physicalAllocationKey(handle);
    };
    const info: CompiledRenderGraphInfo = Object.freeze({
      generation,
      passes: Object.freeze(
        analyzed.value.passes.map((pass, executionIndex) =>
          Object.freeze({
            name: pass.name,
            kind: pass.pass.kind,
            executionIndex,
            accesses: Object.freeze(
              pass.pass.descriptor.accesses.map((access) => {
                const id = accessResourceId(access);
                return Object.freeze({
                  resource: this.resources.get(id ?? -1)?.label ?? 'foreign',
                  usage: access.usage,
                });
              }),
            ),
            dependencies: Object.freeze(
              pass.dependencies.map(
                (dependency) => analyzed.value.passes[dependency]?.name ?? 'unknown',
              ),
            ),
          }),
        ),
      ),
      resources: Object.freeze(
        Array.from(allocated.value.resources.values(), (resource) => {
          const texture =
            resource.record.kind === 'texture'
              ? (resource.record.descriptor as GraphTextureDescriptor)
              : undefined;
          const accelerationStructure =
            resource.record.kind === 'acceleration-structure'
              ? resource.record.descriptor
              : undefined;
          const buffer =
            resource.record.kind === 'buffer'
              ? (resource.record.descriptor as GraphBufferDescriptor)
              : undefined;
          const allocationKey = physicalKey(resource);
          const extent = resource.textureDescriptor?.size;
          const knownByteSize =
            resource.record.origin === 'imported' || resource.usage === 0
              ? undefined
              : texture === undefined || extent === undefined
                ? buffer?.size
                : textureByteSize(
                    texture.format,
                    texture.dimension ?? '2d',
                    extent,
                    texture.mipLevelCount ?? 1,
                    texture.sampleCount ?? 1,
                  );
          const byteSizeUnknownReason =
            resource.record.origin === 'imported'
              ? ('imported-owner' as const)
              : resource.usage === 0
                ? ('not-allocated' as const)
                : knownByteSize === undefined
                  ? ('format-or-layout-unknown' as const)
                  : undefined;
          return Object.freeze({
            label: resource.record.label,
            kind: resource.record.kind,
            origin: resource.record.origin,
            descriptor: Object.freeze(
              accelerationStructure !== undefined
                ? {
                    kind: 'acceleration-structure' as const,
                    maxInstances: accelerationStructure.maxInstances,
                  }
                : texture === undefined
                  ? {
                      kind: 'buffer' as const,
                      size: buffer?.size ?? 0,
                    }
                  : {
                      kind: 'texture' as const,
                      format: texture.format,
                      ...(texture.domain === undefined ? {} : { domain: texture.domain }),
                      size:
                        typeof texture.size === 'string'
                          ? texture.size
                          : Object.freeze({ ...texture.size }),
                      width: extent?.width ?? 1,
                      height: extent?.height ?? 1,
                      depthOrArrayLayers: extent?.depthOrArrayLayers ?? 1,
                      mipLevelCount: texture.mipLevelCount ?? 1,
                      sampleCount: texture.sampleCount ?? 1,
                    },
            ),
            firstUse: resource.firstUse,
            lastUse: resource.lastUse,
            derivedUsage: resource.usage,
            ...(allocationKey === undefined ? {} : { physicalAllocationKey: allocationKey }),
            ...(texture === undefined ? {} : { format: texture.format }),
            ...(knownByteSize === undefined ? {} : { byteSize: knownByteSize }),
            ...(byteSizeUnknownReason === undefined ? {} : { byteSizeUnknownReason }),
            ...(texture === undefined
              ? {}
              : {
                  dimension: texture.dimension ?? '2d',
                  extent,
                }),
          });
        }),
      ),
    });

    const colorTargetDescriptors = new Map<string, ResolvedColorTargetDescriptor>();
    for (const resource of allocated.value.resources.values()) {
      if (resource.record.kind !== 'texture' || resource.texture === undefined) continue;
      const extent = resource.textureDescriptor?.size;
      if (extent === undefined) continue;
      colorTargetDescriptors.set(resource.record.label, {
        texture: resource.texture,
        format: resource.record.descriptor.format,
        size: { width: extent.width, height: extent.height },
        usage: resource.usage,
        sample: resource.record.descriptor.sampleCount ?? 1,
      });
    }

    return ok(
      new CompiledRenderGraphImpl(
        nextGeneration++,
        this.owner,
        options.device,
        allocated.value.resources,
        allocated.value.views,
        Object.freeze(analyzed.value.passes),
        info,
        colorTargetDescriptors,
      ),
    );
  }

  private addPass(name: string, pass: GraphPass<FrameCtx>): Result<void, RenderGraphError> {
    if (this.sealed) return err(this.sealedError());
    if (this.passNames.has(name)) {
      return err(
        new RenderGraphError({
          code: 'duplicate-pass-name',
          expected: `pass name '${name}' is unique within one builder`,
          hint: `rename the second '${name}' pass; names are diagnostics, not identity`,
          detail: { passName: name },
        }),
      );
    }
    for (const access of pass.descriptor.accesses) {
      const valid = this.validateAccessHandle(name, access);
      if (valid !== undefined) return err(valid);
    }
    this.passNames.add(name);
    this.passes.push({ id: this.passes.length, name, pass: snapshotPass(pass) });
    return ok(undefined);
  }

  private validateAccessHandle(
    passName: string,
    access: GraphAccess,
  ): RenderGraphError | undefined {
    const data = handleData(access.resource);
    if (data === undefined || data.owner !== this.owner) {
      return this.foreignHandleError(passName);
    }
    if (data.kind === 'texture-view') {
      if (!this.views.has(data.id)) return this.foreignHandleError(passName);
      return undefined;
    }
    if (
      (data.kind !== 'buffer' && data.kind !== 'acceleration-structure') ||
      !this.resources.has(data.id)
    ) {
      return this.foreignHandleError(passName);
    }
    return undefined;
  }

  private analyze(caps: RhiCaps): Result<
    {
      readonly passes: readonly CompiledPass<FrameCtx>[];
      readonly resources: ReadonlyMap<number, ResourceAnalysis>;
    },
    RenderGraphError
  > {
    const resources = new Map<number, ResourceAnalysis>();
    const compiledPasses: CompiledPass<FrameCtx>[] = [];
    const historyByResource = new Map<number, NormalizedAccess[]>();
    const writesByResource = new Map<number, NormalizedAccess[]>();
    const noHistory: readonly NormalizedAccess[] = [];

    for (const resource of this.resources.values()) {
      if (resource.kind !== 'texture' || resource.origin !== 'created') continue;
      const usage = resource.descriptor.usage ?? 0;
      if (usage !== 0) resources.set(resource.id, { usage, firstUse: null, lastUse: null });
    }

    for (let passIndex = 0; passIndex < this.passes.length; passIndex++) {
      const pass = this.passes[passIndex];
      if (pass === undefined) continue;
      const capability = this.validateCapabilities(pass, caps);
      if (!capability.ok) return capability;
      const normalized: NormalizedAccess[] = [];
      const resourceIds = new Set<number>();
      const viewIds = new Set<number>();
      for (const access of pass.pass.descriptor.accesses) {
        const item = this.normalizeAccess(passIndex, pass, access);
        if (item instanceof RenderGraphError) return err(item);
        normalized.push(item);
        resourceIds.add(item.resourceId);
        if (item.viewId !== undefined) viewIds.add(item.viewId);
        const resource = this.resources.get(item.resourceId);
        const usage =
          resource?.kind === 'acceleration-structure'
            ? 0
            : (resource?.kind === 'texture' && resource.origin === 'created'
                ? (resource.descriptor.usage ?? 0)
                : 0) |
              (resource?.kind === 'buffer'
                ? bufferUsage(access.usage as GraphBufferAccess)
                : textureUsage(access.usage as GraphTextureAccess));
        const previous = resources.get(item.resourceId);
        if (previous === undefined) {
          resources.set(item.resourceId, { usage, firstUse: passIndex, lastUse: passIndex });
        } else {
          previous.usage |= usage;
          previous.firstUse ??= passIndex;
          previous.lastUse = passIndex;
        }
      }
      const conflict = this.validatePassAccesses(pass, normalized);
      if (!conflict.ok) return conflict;
      const attachments = this.validateAttachments(pass);
      if (!attachments.ok) return attachments;

      const dependencies = new Set<number>();
      for (const current of normalized) {
        if (current.read) {
          const priorWrite = this.findPriorWrite(
            writesByResource.get(current.resourceId) ?? noHistory,
            current,
          );
          if (priorWrite !== undefined) {
            dependencies.add(priorWrite.passIndex);
          } else if (this.resources.get(current.resourceId)?.origin === 'created') {
            const label = this.resources.get(current.resourceId)?.label;
            return err(
              new RenderGraphError({
                code: 'uninitialized-read',
                expected: `graph-created resource '${label}' is written before pass '${pass.name}' reads it`,
                hint: 'add a clear/write/copy-dst pass before the first read, or import initialized data',
                detail: { passName: pass.name, resourceLabel: label, usage: current.usage },
              }),
            );
          }
        }
        if (current.write) {
          this.findWriteDependencies(
            historyByResource.get(current.resourceId) ?? noHistory,
            current,
            dependencies,
          );
        }
      }
      // Publish only after the whole pass: accesses within one pass are not prior accesses.
      for (const access of normalized) {
        let history = historyByResource.get(access.resourceId);
        if (history === undefined) {
          history = [];
          historyByResource.set(access.resourceId, history);
        }
        history.push(access);
        if (access.write) {
          let writes = writesByResource.get(access.resourceId);
          if (writes === undefined) {
            writes = [];
            writesByResource.set(access.resourceId, writes);
          }
          writes.push(access);
        }
      }
      compiledPasses.push({
        ...pass,
        dependencies: Object.freeze([...dependencies].sort((left, right) => left - right)),
        resourceIds,
        viewIds,
      });
    }

    for (const [resourceId, { usage }] of resources) {
      const resource = this.resources.get(resourceId);
      if (resource?.origin !== 'imported' || resource.kind === 'acceleration-structure') continue;
      if ((resource.descriptor.usage & usage) !== usage) {
        return err(
          new RenderGraphError({
            code: 'import-usage-mismatch',
            expected: `imported resource '${resource.label}' physical usage contains derived graph usage ${usage}`,
            hint: 'recreate the imported resource with every usage declared by graph accesses',
            detail: {
              resourceLabel: resource.label,
              field: 'usage',
              expected: String(usage),
              actual: resource.descriptor.usage,
            },
          }),
        );
      }
    }

    return ok({ passes: compiledPasses, resources });
  }

  private normalizeAccess(
    passIndex: number,
    pass: PassRecord<FrameCtx>,
    access: GraphAccess,
  ): NormalizedAccess | RenderGraphError {
    const passName = pass.name;
    const data = handleData(access.resource);
    if (data === undefined || data.owner !== this.owner) {
      return this.foreignHandleError(passName);
    }
    const mode = this.accessModeForPass(pass, access);
    if (data.kind === 'buffer' || data.kind === 'acceleration-structure') {
      return {
        passIndex,
        resourceId: data.id,
        usage: access.usage,
        read: mode.read,
        write: mode.write,
      };
    }
    if (data.kind !== 'texture-view') return this.foreignHandleError(passName);
    const view = this.views.get(data.id);
    const texture = this.resources.get(data.textureId);
    if (view === undefined || texture?.kind !== 'texture') {
      return this.foreignHandleError(passName);
    }
    const mipLevels = texture.descriptor.mipLevelCount ?? 1;
    const layers =
      typeof texture.descriptor.size === 'object'
        ? (texture.descriptor.size.depthOrArrayLayers ?? 1)
        : 1;
    const mipStart = view.descriptor.baseMipLevel ?? 0;
    const layerStart = view.descriptor.baseArrayLayer ?? 0;
    return {
      passIndex,
      resourceId: data.textureId,
      viewId: data.id,
      usage: access.usage,
      read: mode.read,
      write: mode.write,
      range: {
        mipStart,
        mipEnd: mipStart + (view.descriptor.mipLevelCount ?? mipLevels - mipStart),
        layerStart,
        layerEnd: layerStart + (view.descriptor.arrayLayerCount ?? layers - layerStart),
        aspect: view.descriptor.aspect ?? 'all',
      },
    };
  }

  private accessModeForPass(
    pass: PassRecord<FrameCtx>,
    access: GraphAccess,
  ): { readonly read: boolean; readonly write: boolean } {
    const base = accessMode(access.usage);
    if (
      pass.pass.kind === 'subgraph' &&
      (access.usage === 'color-attachment' || access.usage === 'depth-stencil-write')
    )
      return READ_WRITE_ACCESS_MODE;
    if (pass.pass.kind !== 'raster' || handleData(access.resource)?.kind !== 'texture-view') {
      return base;
    }
    if (access.usage === 'color-attachment') {
      const attachment = pass.pass.descriptor.colorAttachments.find(
        (candidate) => candidate.view === access.resource,
      );
      return attachment?.loadOp === 'load' ? READ_WRITE_ACCESS_MODE : base;
    }
    if (access.usage === 'depth-stencil-write') {
      const attachment = pass.pass.descriptor.depthStencilAttachment;
      if (
        attachment?.view === access.resource &&
        (attachment.depthLoadOp === 'load' || attachment.stencilLoadOp === 'load')
      ) {
        return READ_WRITE_ACCESS_MODE;
      }
    }
    return base;
  }

  private validateCapabilities(
    pass: PassRecord<FrameCtx>,
    caps: RhiCaps,
  ): Result<void, RenderGraphError> {
    if (
      pass.pass.kind === 'raster' &&
      pass.pass.descriptor.colorAttachments.length > caps.maxColorAttachments
    ) {
      return this.capabilityError(pass.name, 'color-attachments');
    }
    if (pass.pass.kind === 'compute' && !caps.compute) {
      return this.capabilityError(pass.name, 'compute');
    }
    for (const access of pass.pass.descriptor.accesses) {
      if (
        (access.usage === 'storage-read' ||
          access.usage === 'storage-write' ||
          access.usage === 'storage-read-write') &&
        handleData(access.resource)?.kind === 'buffer' &&
        !caps.storageBuffer
      ) {
        return this.capabilityError(pass.name, 'storage-buffer', access);
      }
      if (
        (access.usage === 'storage-read' ||
          access.usage === 'storage-write' ||
          access.usage === 'storage-read-write' ||
          access.usage === 'sampled-storage-read-write' ||
          access.usage === 'sampled-storage-write') &&
        handleData(access.resource)?.kind === 'texture-view' &&
        !caps.storageTexture
      ) {
        return this.capabilityError(pass.name, 'storage-texture', access);
      }
      if (access.usage === 'indirect-read' && !caps.indirectDrawing) {
        return this.capabilityError(pass.name, 'indirect', access);
      }
      if (
        (access.usage === 'acceleration-structure-build' ||
          access.usage === 'acceleration-structure-read') &&
        !caps.rayQuery.supported
      ) {
        return this.capabilityError(pass.name, 'ray-query', access);
      }
    }
    return ok(undefined);
  }

  private capabilityError(
    passName: string,
    capability:
      | 'compute'
      | 'storage-buffer'
      | 'storage-texture'
      | 'indirect'
      | 'color-attachments'
      | 'ray-query',
    access?: GraphAccess,
  ): Result<never, RenderGraphError> {
    const resourceId = access === undefined ? undefined : accessResourceId(access);
    return err(
      new RenderGraphError({
        code: 'capability-missing',
        expected: `pass '${passName}' is built only when capability '${capability}' is available`,
        hint: 'select the fallback algorithm before adding this pass to the builder',
        detail: {
          passName,
          capability,
          ...(resourceId === undefined
            ? {}
            : { resourceLabel: this.resources.get(resourceId)?.label, usage: access?.usage }),
        },
      }),
    );
  }

  private validatePassAccesses(
    pass: PassRecord<FrameCtx>,
    accesses: readonly NormalizedAccess[],
  ): Result<void, RenderGraphError> {
    // A child has separately validated, ordered scopes rather than one GPU pass.
    if (pass.pass.kind === 'subgraph') return ok(undefined);
    // Link equal-resource indices in the original ascending order, including sparse inputs.
    const nextAccessByResource: (number | undefined)[] = [];
    const nextResourceAccess = new Map<number, number>();
    for (let index = accesses.length - 1; index >= 0; index--) {
      const access = accesses[index];
      if (access === undefined) continue;
      nextAccessByResource[index] = nextResourceAccess.get(access.resourceId);
      nextResourceAccess.set(access.resourceId, index);
    }
    for (let leftIndex = 0; leftIndex < accesses.length; leftIndex++) {
      const left = accesses[leftIndex];
      if (left === undefined) continue;
      for (
        let rightIndex = nextAccessByResource[leftIndex];
        rightIndex !== undefined;
        rightIndex = nextAccessByResource[rightIndex]
      ) {
        const right = accesses[rightIndex];
        if (
          right === undefined ||
          left.resourceId !== right.resourceId ||
          !rangesOverlap(left.range, right.range)
        ) {
          continue;
        }
        if (!left.write && !right.write) continue;
        if (
          left.usage === right.usage &&
          (left.usage === 'storage-read-write' || left.usage === 'sampled-storage-read-write')
        )
          continue;
        const label = this.resources.get(left.resourceId)?.label;
        return err(
          new RenderGraphError({
            code: 'access-conflict',
            expected: `pass '${pass.name}' uses resource '${label}' in one compatible WebGPU usage scope`,
            hint: 'split conflicting read/write roles into ordered passes or use storage-read-write once',
            detail: {
              passName: pass.name,
              resourceLabel: label,
              accesses: [left.usage, right.usage],
            },
          }),
        );
      }
    }
    if (pass.pass.kind !== 'compute') {
      const invalid = accesses.find((access) => access.usage === 'sampled-storage-write');
      if (invalid !== undefined) {
        return err(
          new RenderGraphError({
            code: 'access-conflict',
            expected: `pass '${pass.name}' uses ordered compute dispatches for sampled-storage-write`,
            hint: 'move the write-then-sample chain into a compute pass',
            detail: { passName: pass.name, usage: invalid.usage },
          }),
        );
      }
    }
    if (pass.pass.kind !== 'copy') {
      const invalid = accesses.find((access) => access.usage === 'acceleration-structure-build');
      if (invalid !== undefined) {
        return err(
          new RenderGraphError({
            code: 'access-conflict',
            expected: `pass '${pass.name}' builds acceleration structures only from a copy pass`,
            hint: 'record acceleration-structure-build in a copy pass ordered before its readers',
            detail: { passName: pass.name, usage: invalid.usage },
          }),
        );
      }
    }
    if (pass.pass.kind === 'copy') {
      const invalid = accesses.find(
        (access) =>
          access.usage !== 'copy-src' &&
          access.usage !== 'copy-dst' &&
          access.usage !== 'acceleration-structure-build',
      );
      if (invalid !== undefined) {
        return err(
          new RenderGraphError({
            code: 'access-conflict',
            expected: `copy pass '${pass.name}' declares only copy-src/copy-dst/acceleration-structure-build accesses`,
            hint: 'move shader or attachment work into raster/compute passes',
            detail: { passName: pass.name, usage: invalid.usage },
          }),
        );
      }
    }
    return ok(undefined);
  }

  private validateAttachments(pass: PassRecord<FrameCtx>): Result<void, RenderGraphError> {
    if (pass.pass.kind !== 'raster') return ok(undefined);
    const accesses = pass.pass.descriptor.accesses;
    const has = (view: GraphTextureView, usage: GraphTextureAccess): boolean =>
      accesses.some((access) => access.resource === view && access.usage === usage);
    for (const attachment of pass.pass.descriptor.colorAttachments) {
      if (!has(attachment.view, 'color-attachment')) {
        return this.missingAttachmentAccess(pass.name, attachment.view, 'color-attachment');
      }
      if (
        attachment.resolveTarget !== undefined &&
        !has(attachment.resolveTarget, 'color-attachment')
      ) {
        return this.missingAttachmentAccess(
          pass.name,
          attachment.resolveTarget,
          'color-attachment',
        );
      }
    }
    const depth = pass.pass.descriptor.depthStencilAttachment;
    if (depth !== undefined) {
      const usage = depth.depthReadOnly === true ? 'depth-stencil-read' : 'depth-stencil-write';
      if (!has(depth.view, usage))
        return this.missingAttachmentAccess(pass.name, depth.view, usage);
    }
    return ok(undefined);
  }

  private missingAttachmentAccess(
    passName: string,
    view: GraphTextureView,
    usage: GraphTextureAccess,
  ): Result<never, RenderGraphError> {
    const data = handleData(view);
    const label = data?.kind === 'texture-view' ? this.views.get(data.id)?.label : undefined;
    return err(
      new RenderGraphError({
        code: 'resource-not-declared-by-pass',
        expected: `raster pass '${passName}' attachment '${label}' declares '${usage}' access`,
        hint: 'add the attachment view and matching usage to accesses',
        detail: { passName, resourceLabel: label, usage },
      }),
    );
  }

  private findPriorWrite(
    history: readonly NormalizedAccess[],
    current: NormalizedAccess,
  ): NormalizedAccess | undefined {
    for (let index = history.length - 1; index >= 0; index--) {
      const prior = history[index];
      if (
        prior !== undefined &&
        prior.resourceId === current.resourceId &&
        prior.write &&
        rangesOverlap(prior.range, current.range)
      ) {
        return prior;
      }
    }
    return undefined;
  }

  private findWriteDependencies(
    history: readonly NormalizedAccess[],
    current: NormalizedAccess,
    dependencies: Set<number>,
  ): void {
    for (let index = history.length - 1; index >= 0; index--) {
      const prior = history[index];
      if (
        prior === undefined ||
        prior.resourceId !== current.resourceId ||
        !rangesOverlap(prior.range, current.range)
      ) {
        continue;
      }
      if (prior.read) dependencies.add(prior.passIndex);
      if (prior.write) {
        dependencies.add(prior.passIndex);
        break;
      }
    }
  }

  private validateDescriptors(
    surfaceSize: RenderGraphCompileOptions['surfaceSize'],
  ): Result<void, RenderGraphError> {
    if (surfaceSize.width <= 0 || surfaceSize.height <= 0) {
      return err(
        new RenderGraphError({
          code: 'resource-descriptor-invalid',
          expected: 'surfaceSize width and height are positive integers',
          hint: 'compile after the render surface has a non-zero physical extent',
          detail: {
            resourceLabel: 'surface',
            field: 'surfaceSize',
            expected: 'width > 0 and height > 0',
            actual: `${surfaceSize.width}x${surfaceSize.height}`,
          },
        }),
      );
    }
    for (const resource of this.resources.values()) {
      if (resource.kind === 'buffer' && resource.descriptor.size <= 0) {
        return err(
          new RenderGraphError({
            code: 'resource-descriptor-invalid',
            expected: `buffer '${resource.label}' size is greater than zero`,
            hint: 'derive a positive byte size before creating/importing the buffer',
            detail: {
              resourceLabel: resource.label,
              field: 'size',
              expected: 'size > 0',
              actual: resource.descriptor.size,
            },
          }),
        );
      }
      if (resource.kind === 'texture') {
        const extent = this.resolveExtent(resource.descriptor.size, surfaceSize);
        if (extent.width <= 0 || extent.height <= 0 || extent.depthOrArrayLayers <= 0) {
          return err(
            new RenderGraphError({
              code: 'resource-descriptor-invalid',
              expected: `texture '${resource.label}' extent is positive`,
              hint: 'repair the authored extent or compile surface size',
              detail: {
                resourceLabel: resource.label,
                field: 'size',
                expected: 'all extent axes > 0',
                actual: `${extent.width}x${extent.height}x${extent.depthOrArrayLayers}`,
              },
            }),
          );
        }
      }
    }
    for (const view of this.views.values()) {
      const texture = this.resources.get(view.textureId);
      if (texture?.kind !== 'texture') continue;
      const allocationDimension = texture.descriptor.dimension ?? '2d';
      const viewDimension = view.descriptor.dimension;
      if (!isTextureViewDimensionCompatible(allocationDimension, viewDimension)) {
        return err(
          new RenderGraphError({
            code: 'resource-descriptor-invalid',
            expected: `texture '${texture.label}' view dimension matches allocation dimension`,
            hint: 'use a 3d view only for a 3d allocation and preserve array views on 2d allocations',
            detail: {
              resourceLabel: texture.label,
              field: 'dimension',
              expected: allocationDimension,
              actual: viewDimension ?? '2d',
            },
          }),
        );
      }
    }
    return ok(undefined);
  }

  private allocate(
    options: RenderGraphCompileOptions,
    analyzedResources: ReadonlyMap<number, ResourceAnalysis>,
  ): Result<
    {
      readonly resources: ReadonlyMap<number, CompiledResource<FrameCtx>>;
      readonly views: ReadonlyMap<number, CompiledView<FrameCtx>>;
    },
    RenderGraphError
  > {
    const compiledResources = new Map<number, CompiledResource<FrameCtx>>();
    const compiledViews = new Map<number, CompiledView<FrameCtx>>();
    const createdTextures: GraphTextureAllocation[] = [];
    const createdBuffers: Buffer[] = [];
    const discard = (): void => {
      for (const texture of createdTextures) releaseGraphTexture(options.device, texture);
      for (const buffer of createdBuffers) options.device.destroyBuffer(buffer);
    };

    for (const resource of this.resources.values()) {
      const analysis = analyzedResources.get(resource.id) ?? {
        usage: 0,
        firstUse: null,
        lastUse: null,
      };
      const { usage } = analysis;
      let texture: Texture | undefined;
      let textureAllocation: GraphTextureAllocation | undefined;
      let buffer: Buffer | undefined;
      const textureDescriptor: CompiledResource<FrameCtx>['textureDescriptor'] =
        resource.kind === 'texture'
          ? {
              label: resource.label,
              size: this.resolveExtent(resource.descriptor.size, options.surfaceSize),
              mipLevelCount: resource.descriptor.mipLevelCount ?? 1,
              sampleCount: resource.descriptor.sampleCount ?? 1,
              dimension: resource.descriptor.dimension ?? '2d',
              format: resource.descriptor.format,
              usage: resource.origin === 'imported' ? resource.descriptor.usage : usage,
              viewFormats: [...(resource.descriptor.viewFormats ?? [])],
            }
          : undefined;
      if (resource.origin === 'created' && usage !== 0) {
        if (textureDescriptor !== undefined) {
          const descriptor = textureDescriptor;
          const signature = JSON.stringify(descriptor);
          textureAllocation =
            options.reuseResourcesFrom instanceof CompiledRenderGraphImpl
              ? options.reuseResourcesFrom.retainTexture(options.device, resource.label, signature)
              : undefined;
          const created =
            textureAllocation === undefined
              ? options.device.createTexture(descriptor)
              : ok(textureAllocation.texture);
          if (!created.ok) {
            discard();
            return err(
              new RenderGraphError({
                code: 'resource-allocation-failed',
                expected: `RHI creates graph texture '${resource.label}'`,
                hint: 'inspect detail.rhiCode and repair the descriptor/capability route',
                detail: { resourceKey: resource.label, rhiCode: created.error.code },
              }),
            );
          }
          texture = created.value;
          textureAllocation ??= { texture, signature, references: 1 };
          createdTextures.push(textureAllocation);
        } else if (resource.kind === 'buffer') {
          const created = options.device.createBuffer({
            label: resource.label,
            size: resource.descriptor.size,
            usage,
            mappedAtCreation: resource.descriptor.mappedAtCreation ?? false,
          });
          if (!created.ok) {
            discard();
            return err(
              new RenderGraphError({
                code: 'resource-allocation-failed',
                expected: `RHI creates graph buffer '${resource.label}'`,
                hint: 'inspect detail.rhiCode and repair the descriptor/capability route',
                detail: { resourceKey: resource.label, rhiCode: created.error.code },
              }),
            );
          }
          buffer = created.value;
          createdBuffers.push(buffer);
        }
      }
      compiledResources.set(resource.id, {
        record: resource,
        ...analysis,
        ...(textureDescriptor === undefined ? {} : { textureDescriptor }),
        ...(texture === undefined ? {} : { texture, textureAllocation }),
        ...(buffer === undefined ? {} : { buffer }),
      });
    }

    for (const view of this.views.values()) {
      const resource = compiledResources.get(view.textureId);
      let physicalView: TextureView | undefined;
      if (resource?.record.origin === 'created' && resource.texture !== undefined) {
        const retained =
          options.reuseResourcesFrom instanceof CompiledRenderGraphImpl
            ? options.reuseResourcesFrom.reuseTextureView(options.device, resource.texture, view)
            : undefined;
        const created =
          retained === undefined
            ? options.device.createTextureView(resource.texture, view.descriptor)
            : ok(retained);
        if (!created.ok) {
          discard();
          return err(
            new RenderGraphError({
              code: 'resource-allocation-failed',
              expected: `RHI creates graph texture view '${view.label}'`,
              hint: 'inspect detail.rhiCode and repair the view descriptor',
              detail: { resourceKey: view.label, rhiCode: created.error.code },
            }),
          );
        }
        physicalView = created.value;
      }
      compiledViews.set(view.id, {
        record: view,
        ...(physicalView === undefined ? {} : { view: physicalView }),
      });
    }
    return ok({ resources: compiledResources, views: compiledViews });
  }

  private resolveExtent(
    extent: GraphExtent,
    surface: RenderGraphCompileOptions['surfaceSize'],
  ): { readonly width: number; readonly height: number; readonly depthOrArrayLayers: number } {
    if (extent === 'surface') return { ...surface, depthOrArrayLayers: 1 };
    if (extent === 'half-surface') {
      return {
        width: Math.ceil(surface.width / 2),
        height: Math.ceil(surface.height / 2),
        depthOrArrayLayers: 1,
      };
    }
    return {
      width: extent.width,
      height: extent.height,
      depthOrArrayLayers: extent.depthOrArrayLayers ?? 1,
    };
  }

  private sealedError(): RenderGraphError {
    return new RenderGraphError({
      code: 'builder-sealed',
      expected: 'a RenderGraphBuilder accepts declarations only before compile()',
      hint: 'create a new builder for a changed topology',
      detail: {},
    });
  }

  private reserveLabel(label: string): RenderGraphError | undefined {
    const size = this.labels.size;
    this.labels.add(label);
    if (this.labels.size === size) {
      return new RenderGraphError({
        code: 'duplicate-resource-label',
        expected: `resource label '${label}' is unique within one builder`,
        hint: `rename the second '${label}' declaration`,
        detail: { resourceLabel: label },
      });
    }
    return undefined;
  }

  private foreignHandleError(passName?: string): RenderGraphError {
    return new RenderGraphError({
      code: 'foreign-resource-handle',
      expected: 'every graph resource handle belongs to this builder',
      hint: 'create/import/view the resource on the same builder that declares the pass',
      detail: { ...(passName === undefined ? {} : { passName }) },
    });
  }
}

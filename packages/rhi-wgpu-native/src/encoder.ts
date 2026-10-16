// Command recording. Encoders record a JSON command list (the addon's `desc::Command`
// shape) and the addon replays it into one wgpu encoder at `finish()`; pass encoders
// append to their parent's list. Recorded objects stay referenced until `finish()` so a
// garbage collection cannot release a native object a pending recording names.

import {
  color,
  extent,
  hideReference,
  idOf,
  type NativeAccelerationStructure,
  type NativeGPUDevice,
  NativeGPUObject,
  type NativeGPUTexture,
  NativeGPUTextureView,
  origin,
} from './gpu';

type Command = Record<string, unknown> & { readonly op: string };

function attachmentOf(view: GPUTextureView | GPUTexture): {
  readonly format: GPUTextureFormat;
  readonly sampleCount: number;
} {
  if (view instanceof NativeGPUTextureView) {
    return { format: view.format, sampleCount: view.texture.sampleCount };
  }
  return view as unknown as NativeGPUTexture;
}

function dynamicOffsets(
  offsets: Iterable<number> | Uint32Array | undefined,
  start?: number,
  length?: number,
): number[] {
  if (offsets === undefined) return [];
  const all = Array.from(offsets);
  return start === undefined ? all : all.slice(start, start + (length ?? all.length - start));
}

class Recorder {
  readonly commands: Command[] = [];
  readonly refs: unknown[] = [];
  finished = false;

  declare readonly device: NativeGPUDevice;
  constructor(device: NativeGPUDevice) {
    hideReference(this, 'device', device);
  }

  push(command: Command, ...refs: unknown[]): void {
    if (this.finished) {
      this.device.native.reportValidationError(`'${command.op}' recorded on a finished encoder`);
      this.device.touch();
      return;
    }
    this.commands.push(command);
    for (const ref of refs) if (ref !== null && ref !== undefined) this.refs.push(ref);
  }
}

/** Commands shared by render passes and render bundles. */
class RenderCommands {
  label = '';
  constructor(protected readonly recorder: Recorder) {}

  setPipeline(pipeline: GPURenderPipeline): void {
    this.recorder.push({ op: 'setPipeline', id: idOf(pipeline) }, pipeline);
  }

  setBindGroup(
    index: number,
    bindGroup: GPUBindGroup | null,
    offsets?: Iterable<number> | Uint32Array,
    start?: number,
    length?: number,
  ): void {
    this.recorder.push(
      {
        op: 'setBindGroup',
        index,
        id: bindGroup === null ? null : idOf(bindGroup),
        offsets: dynamicOffsets(offsets, start, length),
      },
      bindGroup,
    );
  }

  setVertexBuffer(slot: number, buffer: GPUBuffer | null, offset = 0, size?: number): void {
    this.recorder.push(
      { op: 'setVertexBuffer', slot, id: buffer === null ? null : idOf(buffer), offset, size },
      buffer,
    );
  }

  setIndexBuffer(buffer: GPUBuffer, format: GPUIndexFormat, offset = 0, size?: number): void {
    this.recorder.push({ op: 'setIndexBuffer', id: idOf(buffer), format, offset, size }, buffer);
  }

  draw(vertexCount: number, instanceCount = 1, firstVertex = 0, firstInstance = 0): void {
    this.recorder.push({ op: 'draw', vertexCount, instanceCount, firstVertex, firstInstance });
  }

  drawIndexed(
    indexCount: number,
    instanceCount = 1,
    firstIndex = 0,
    baseVertex = 0,
    firstInstance = 0,
  ): void {
    this.recorder.push({
      op: 'drawIndexed',
      indexCount,
      instanceCount,
      firstIndex,
      baseVertex,
      firstInstance,
    });
  }

  drawIndirect(buffer: GPUBuffer, offset: number): void {
    this.recorder.push({ op: 'drawIndirect', id: idOf(buffer), offset }, buffer);
  }

  drawIndexedIndirect(buffer: GPUBuffer, offset: number): void {
    this.recorder.push({ op: 'drawIndexedIndirect', id: idOf(buffer), offset }, buffer);
  }

  pushDebugGroup(label: string): void {
    this.recorder.push({ op: 'pushDebugGroup', label });
  }

  popDebugGroup(): void {
    this.recorder.push({ op: 'popDebugGroup' });
  }

  insertDebugMarker(label: string): void {
    this.recorder.push({ op: 'insertDebugMarker', label });
  }
}

export class NativeRenderPassEncoder extends RenderCommands {
  constructor(
    recorder: Recorder,
    private readonly layout: GPURenderBundleEncoderDescriptor,
  ) {
    super(recorder);
  }

  setViewport(x: number, y: number, w: number, h: number, min: number, max: number): void {
    this.recorder.push({ op: 'setViewport', x, y, w, h, min, max });
  }

  setScissorRect(x: number, y: number, w: number, h: number): void {
    this.recorder.push({ op: 'setScissorRect', x, y, w, h });
  }

  setBlendConstant(value: GPUColor): void {
    this.recorder.push({ op: 'setBlendConstant', color: color(value) });
  }

  setStencilReference(reference: number): void {
    this.recorder.push({ op: 'setStencilReference', reference });
  }

  beginOcclusionQuery(index: number): void {
    this.recorder.push({ op: 'beginOcclusionQuery', index });
  }

  endOcclusionQuery(): void {
    this.recorder.push({ op: 'endOcclusionQuery' });
  }

  executeBundles(bundles: Iterable<GPURenderBundle>): void {
    const list: GPURenderBundle[] = Array.from(bundles);
    // WebGPU resets pass state even for an empty list; wgpu resets it per executed
    // bundle, so an empty list executes one empty bundle of the pass layout.
    if (list.length === 0) {
      list.push(
        new NativeRenderBundleEncoder(
          this.recorder.device,
          this.layout,
        ).finish() as unknown as GPURenderBundle,
      );
    }
    this.recorder.push({ op: 'executeBundles', ids: list.map(idOf) }, ...list);
  }

  end(): void {
    this.recorder.push({ op: 'end' });
  }
}

export class NativeComputePassEncoder {
  label = '';
  constructor(private readonly recorder: Recorder) {}

  setPipeline(pipeline: GPUComputePipeline): void {
    this.recorder.push({ op: 'setPipeline', id: idOf(pipeline) }, pipeline);
  }

  setBindGroup(
    index: number,
    bindGroup: GPUBindGroup | null,
    offsets?: Iterable<number> | Uint32Array,
    start?: number,
    length?: number,
  ): void {
    this.recorder.push(
      {
        op: 'setBindGroup',
        index,
        id: bindGroup === null ? null : idOf(bindGroup),
        offsets: dynamicOffsets(offsets, start, length),
      },
      bindGroup,
    );
  }

  dispatchWorkgroups(x: number, y = 1, z = 1): void {
    this.recorder.push({ op: 'dispatch', x, y, z });
  }

  dispatchWorkgroupsIndirect(buffer: GPUBuffer, offset: number): void {
    this.recorder.push({ op: 'dispatchIndirect', id: idOf(buffer), offset }, buffer);
  }

  pushDebugGroup(label: string): void {
    this.recorder.push({ op: 'pushDebugGroup', label });
  }

  popDebugGroup(): void {
    this.recorder.push({ op: 'popDebugGroup' });
  }

  insertDebugMarker(label: string): void {
    this.recorder.push({ op: 'insertDebugMarker', label });
  }

  end(): void {
    this.recorder.push({ op: 'end' });
  }
}

function timestampWrites(writes: GPURenderPassTimestampWrites | undefined) {
  return writes === undefined
    ? undefined
    : {
        querySet: idOf(writes.querySet),
        beginningOfPassWriteIndex: writes.beginningOfPassWriteIndex,
        endOfPassWriteIndex: writes.endOfPassWriteIndex,
      };
}

function texelCopyTexture(info: GPUTexelCopyTextureInfo) {
  return {
    texture: idOf(info.texture),
    mipLevel: info.mipLevel ?? 0,
    origin: origin(info.origin),
    aspect: info.aspect,
  };
}

function texelCopyBuffer(info: GPUTexelCopyBufferInfo) {
  return {
    buffer: idOf(info.buffer),
    offset: info.offset ?? 0,
    bytesPerRow: info.bytesPerRow,
    rowsPerImage: info.rowsPerImage,
  };
}

/** Raw build entries of the Ray Query extension (see rhi-webgpu `RawBlasBuildEntry`). */
interface BlasBuild {
  readonly blas: NativeAccelerationStructure;
  readonly geometries: readonly {
    readonly vertexBuffer: GPUBuffer;
    readonly firstVertex?: number | undefined;
    readonly vertexStride: number;
    readonly index?:
      | { readonly buffer: GPUBuffer; readonly firstIndex?: number | undefined }
      | undefined;
  }[];
}

interface TlasBuild {
  readonly tlas: NativeAccelerationStructure;
  readonly instances: readonly {
    readonly blas: NativeAccelerationStructure;
    readonly transform: ArrayLike<number>;
    readonly customIndex: number;
    readonly mask: number;
  }[];
}

export class NativeCommandEncoder {
  label: string;
  private readonly recorder: Recorder;

  constructor(device: NativeGPUDevice, label: string | undefined) {
    this.label = label ?? '';
    this.recorder = new Recorder(device);
  }

  beginRenderPass(descriptor: GPURenderPassDescriptor): NativeRenderPassEncoder {
    const attachments = Array.from(descriptor.colorAttachments);
    const depth = descriptor.depthStencilAttachment;
    this.recorder.push(
      {
        op: 'beginRenderPass',
        label: descriptor.label,
        colorAttachments: attachments.map((attachment) =>
          attachment === null || attachment === undefined
            ? null
            : {
                view: idOf(attachment.view),
                depthSlice: attachment.depthSlice,
                resolveTarget:
                  attachment.resolveTarget === undefined
                    ? undefined
                    : idOf(attachment.resolveTarget),
                clearValue:
                  attachment.clearValue === undefined ? undefined : color(attachment.clearValue),
                loadOp: attachment.loadOp,
                storeOp: attachment.storeOp,
              },
        ),
        depthStencilAttachment:
          depth === undefined || depth === null
            ? undefined
            : {
                view: idOf(depth.view),
                depthClearValue: depth.depthClearValue,
                depthLoadOp: depth.depthLoadOp,
                depthStoreOp: depth.depthStoreOp,
                depthReadOnly: depth.depthReadOnly ?? false,
                stencilClearValue: depth.stencilClearValue ?? 0,
                stencilLoadOp: depth.stencilLoadOp,
                stencilStoreOp: depth.stencilStoreOp,
                stencilReadOnly: depth.stencilReadOnly ?? false,
              },
        occlusionQuerySet:
          descriptor.occlusionQuerySet === undefined
            ? undefined
            : idOf(descriptor.occlusionQuerySet),
        timestampWrites: timestampWrites(descriptor.timestampWrites),
      },
      ...attachments.flatMap((a) => (a ? [a.view, a.resolveTarget] : [])),
      depth?.view,
      descriptor.occlusionQuerySet,
      descriptor.timestampWrites?.querySet,
    );
    const sample = attachments.find((a) => a !== null && a !== undefined)?.view ?? depth?.view;
    return new NativeRenderPassEncoder(this.recorder, {
      colorFormats: attachments.map((a) =>
        a === null || a === undefined ? null : attachmentOf(a.view).format,
      ),
      ...(depth === undefined || depth === null
        ? {}
        : { depthStencilFormat: attachmentOf(depth.view).format }),
      sampleCount: sample === undefined ? 1 : attachmentOf(sample).sampleCount,
      depthReadOnly: depth?.depthReadOnly ?? false,
      stencilReadOnly: depth?.stencilReadOnly ?? false,
    });
  }

  beginComputePass(descriptor: GPUComputePassDescriptor = {}): NativeComputePassEncoder {
    this.recorder.push(
      {
        op: 'beginComputePass',
        label: descriptor.label,
        timestampWrites: timestampWrites(descriptor.timestampWrites),
      },
      descriptor.timestampWrites?.querySet,
    );
    return new NativeComputePassEncoder(this.recorder);
  }

  copyBufferToBuffer(
    source: GPUBuffer,
    a: number | GPUBuffer,
    b?: GPUBuffer | number,
    c?: number,
    d?: number,
  ): void {
    // (src, srcOffset, dst, dstOffset, size?) or (src, dst, size?)
    const [sourceOffset, destination, destinationOffset, size] =
      typeof a === 'number' ? [a, b as GPUBuffer, c ?? 0, d] : [0, a, 0, b as number | undefined];
    this.recorder.push(
      {
        op: 'copyBufferToBuffer',
        source: idOf(source),
        sourceOffset,
        destination: idOf(destination),
        destinationOffset,
        size,
      },
      source,
      destination,
    );
  }

  copyBufferToTexture(
    source: GPUTexelCopyBufferInfo,
    destination: GPUTexelCopyTextureInfo,
    size: GPUExtent3D,
  ): void {
    this.recorder.push(
      {
        op: 'copyBufferToTexture',
        source: texelCopyBuffer(source),
        destination: texelCopyTexture(destination),
        size: extent(size),
      },
      source.buffer,
      destination.texture,
    );
  }

  copyTextureToBuffer(
    source: GPUTexelCopyTextureInfo,
    destination: GPUTexelCopyBufferInfo,
    size: GPUExtent3D,
  ): void {
    this.recorder.push(
      {
        op: 'copyTextureToBuffer',
        source: texelCopyTexture(source),
        destination: texelCopyBuffer(destination),
        size: extent(size),
      },
      source.texture,
      destination.buffer,
    );
  }

  copyTextureToTexture(
    source: GPUTexelCopyTextureInfo,
    destination: GPUTexelCopyTextureInfo,
    size: GPUExtent3D,
  ): void {
    this.recorder.push(
      {
        op: 'copyTextureToTexture',
        source: texelCopyTexture(source),
        destination: texelCopyTexture(destination),
        size: extent(size),
      },
      source.texture,
      destination.texture,
    );
  }

  clearBuffer(buffer: GPUBuffer, offset = 0, size?: number): void {
    this.recorder.push({ op: 'clearBuffer', id: idOf(buffer), offset, size }, buffer);
  }

  resolveQuerySet(
    querySet: GPUQuerySet,
    firstQuery: number,
    queryCount: number,
    destination: GPUBuffer,
    destinationOffset: number,
  ): void {
    this.recorder.push(
      {
        op: 'resolveQuerySet',
        querySet: idOf(querySet),
        firstQuery,
        queryCount,
        destination: idOf(destination),
        destinationOffset,
      },
      querySet,
      destination,
    );
  }

  pushDebugGroup(label: string): void {
    this.recorder.push({ op: 'pushDebugGroup', label });
  }

  popDebugGroup(): void {
    this.recorder.push({ op: 'popDebugGroup' });
  }

  insertDebugMarker(label: string): void {
    this.recorder.push({ op: 'insertDebugMarker', label });
  }

  /** Ray Query extension: BLAS builds precede TLAS builds within one call. */
  buildAccelerationStructures(blas: readonly BlasBuild[], tlas: readonly TlasBuild[]): void {
    this.recorder.push(
      {
        op: 'buildAccelerationStructures',
        blas: blas.map((entry) => ({
          blas: entry.blas.nativeId,
          geometries: entry.geometries.map((geometry) => ({
            vertexBuffer: idOf(geometry.vertexBuffer),
            firstVertex: geometry.firstVertex ?? 0,
            vertexStride: geometry.vertexStride,
            indexBuffer: geometry.index === undefined ? undefined : idOf(geometry.index.buffer),
            firstIndex: geometry.index?.firstIndex,
          })),
        })),
        tlas: tlas.map((entry) => ({
          tlas: entry.tlas.nativeId,
          instances: entry.instances.map((instance) => ({
            blas: instance.blas.nativeId,
            transform: Array.from(instance.transform),
            customIndex: instance.customIndex,
            mask: instance.mask,
          })),
        })),
      },
      blas,
      tlas,
    );
  }

  finish(descriptor: GPUCommandBufferDescriptor = {}): NativeGPUObject {
    const { device } = this.recorder;
    if (this.recorder.finished) {
      device.native.reportValidationError('GPUCommandEncoder.finish() called twice');
      device.touch();
      return new NativeGPUObject(device, 0, descriptor.label);
    }
    this.recorder.finished = true;
    const id = device.native.finishEncoder(
      JSON.stringify({ label: descriptor.label ?? this.label, commands: this.recorder.commands }),
    );
    device.touch();
    return new NativeGPUObject(device, id, descriptor.label, this.recorder.refs);
  }
}

export class NativeRenderBundleEncoder extends RenderCommands {
  constructor(
    device: NativeGPUDevice,
    private readonly descriptor: GPURenderBundleEncoderDescriptor,
  ) {
    super(new Recorder(device));
    this.label = descriptor.label ?? '';
  }

  finish(descriptor: GPURenderBundleDescriptor = {}): NativeGPUObject {
    const { device } = this.recorder;
    this.recorder.finished = true;
    const id = device.native.finishBundle(
      JSON.stringify({
        label: this.descriptor.label,
        colorFormats: Array.from(this.descriptor.colorFormats),
        depthStencilFormat: this.descriptor.depthStencilFormat,
        sampleCount: this.descriptor.sampleCount ?? 1,
        depthReadOnly: this.descriptor.depthReadOnly ?? false,
        stencilReadOnly: this.descriptor.stencilReadOnly ?? false,
      }),
      JSON.stringify({ label: descriptor.label, commands: this.recorder.commands }),
    );
    device.touch();
    return new NativeGPUObject(device, id, descriptor.label, this.recorder.refs);
  }
}

// Immutable compiled KernelRenderGraph: lowers declared passes directly into FrameRecorder
// bytecode with zero per-frame graph recompilation and executes identically across WebGPU,
// Dawn, Browser WebGL2 (WasmWgpuRenderKernel), and Desktop Native (NativeRenderKernel).

import {
  type BindingSetBuilder,
  type FrameRecorder,
  type KernelColorAttachmentDesc,
  type KernelDepthAttachmentDesc,
  type KernelDrawRenderersDesc,
  packTextureBindingSubresource,
} from '../command-stream.js';
import type { FrameSubmitReceipt, RenderKernelExecutionTarget } from '../contract.js';
import { gpuTextureFormatToCode } from '../dynamic-texture.js';
import type { KernelError, Result } from '../errors.js';
import type {
  BindingSetId,
  BufferId,
  MaterialId,
  MeshId,
  PipelineId,
  ShaderProgramId,
  TempTextureId,
  TextureOrTempId,
} from '../handles.js';
import { SURFACE_SWAPCHAIN_HANDLE } from '../pso-key.js';
import type {
  CompiledKernelGraphInfo,
  KernelGraphBufferHandle,
  KernelGraphColorAttachment,
  KernelGraphComputeEncoder,
  KernelGraphComputePassDesc,
  KernelGraphCopyBufferPassDesc,
  KernelGraphCopyTexturePassDesc,
  KernelGraphDepthAttachment,
  KernelGraphFrameResources,
  KernelGraphRasterEncoder,
  KernelGraphRasterPassDesc,
  KernelGraphReadbackPassDesc,
  KernelGraphResourceInfo,
  KernelGraphTextureHandle,
  KernelGraphTextureRef,
} from './types.js';

export const SURFACE_SWAPCHAIN_TARGET = SURFACE_SWAPCHAIN_HANDLE as TextureOrTempId;

/** @internal */
export interface CompiledTextureSlot<Frame> {
  readonly id: number;
  readonly name: string;
  readonly origin: 'transient' | 'imported' | 'surface';
  readonly format: GPUTextureFormat;
  readonly formatCode: number;
  readonly width: number;
  readonly height: number;
  readonly sampleCount: 1 | 4;
  readonly mipLevelCount: number;
  readonly arrayLayerCount: number;
  readonly colorDomain: number;
  readonly derivedUsage: number;
  readonly resolve?: (frame: Frame) => TextureOrTempId;
}

/** @internal */
export interface CompiledBufferSlot<Frame> {
  readonly id: number;
  readonly name: string;
  readonly resolve: (frame: Frame) => BufferId;
}

/** @internal */
export type CompiledGraphPassEntry<Frame> =
  | {
      readonly kind: 'raster';
      readonly name: string;
      readonly labelId: number;
      readonly desc: KernelGraphRasterPassDesc<Frame>;
      readonly resolvedStoreOps: readonly ('store' | 'discard')[];
    }
  | {
      readonly kind: 'compute';
      readonly name: string;
      readonly labelId: number;
      readonly desc: KernelGraphComputePassDesc<Frame>;
    }
  | {
      readonly kind: 'copy-texture';
      readonly name: string;
      readonly desc: KernelGraphCopyTexturePassDesc<Frame>;
    }
  | {
      readonly kind: 'copy-buffer';
      readonly name: string;
      readonly desc: KernelGraphCopyBufferPassDesc<Frame>;
    }
  | {
      readonly kind: 'mipgen';
      readonly name: string;
      readonly target: KernelGraphTextureHandle;
      readonly when?: (frame: Frame) => boolean;
    }
  | {
      readonly kind: 'readback';
      readonly name: string;
      readonly desc: KernelGraphReadbackPassDesc<Frame>;
    };

export function unwrapTextureHandle(ref: KernelGraphTextureRef): KernelGraphTextureHandle {
  return ref.kind === 'graph-texture' ? ref : ref.texture;
}

class ReusableRasterEncoder implements KernelGraphRasterEncoder {
  recorder!: FrameRecorder;

  drawRenderers(desc: KernelDrawRenderersDesc): void {
    this.recorder.drawRenderers(desc);
  }
  drawFullscreen(
    shader: ShaderProgramId,
    bindings: BindingSetId | 0 = 0,
    uniformOffset = 0,
    uniformLength = 0,
  ): void {
    this.recorder.drawFullscreen(shader, bindings, uniformOffset, uniformLength);
  }
  drawMesh(
    mesh: MeshId,
    material: MaterialId,
    transformUniformOffset: number,
    passTag = 0,
    passAttachmentId = 1,
  ): void {
    this.recorder.drawMesh(mesh, material, transformUniformOffset, passTag, passAttachmentId);
  }
  setShaderPipeline(
    shader: ShaderProgramId,
    renderStateBits = 0,
    passAttachmentId = 1,
    vertexLayoutId = 0,
  ): void {
    this.recorder.setShaderPipeline(shader, renderStateBits, passAttachmentId, vertexLayoutId);
  }
  setPipeline(pso: PipelineId): void {
    this.recorder.rhiSetPipeline(pso);
  }
  setBindGroup(slot: number, bindingSet: BindingSetId, dynamicOffsets?: Uint32Array): void {
    this.recorder.rhiSetBindGroup(slot, bindingSet, dynamicOffsets);
  }
  setVertexBuffer(slot: number, bufferOrMesh: BufferId | MeshId, offsetBytes = 0): void {
    this.recorder.rhiSetVertexBuffer(slot, bufferOrMesh as unknown as BufferId, offsetBytes);
  }
  setIndexBuffer(bufferOrMesh: BufferId | MeshId, isUint32 = false, offsetBytes = 0): void {
    this.recorder.rhiSetIndexBuffer(bufferOrMesh as unknown as BufferId, isUint32, offsetBytes);
  }
  draw(vertexCount: number, instanceCount = 1, firstVertex = 0, firstInstance = 0): void {
    this.recorder.rhiDraw(vertexCount, instanceCount, firstVertex, firstInstance);
  }
  drawIndexed(
    indexCount: number,
    instanceCount = 1,
    firstIndex = 0,
    baseVertex = 0,
    firstInstance = 0,
  ): void {
    this.recorder.rhiDrawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance);
  }
  drawIndirect(indirectBuffer: BufferId, offsetBytes = 0): void {
    this.recorder.rhiDrawIndirect(indirectBuffer, offsetBytes);
  }
  setViewport(x: number, y: number, w: number, h: number, minD = 0, maxD = 1): void {
    this.recorder.setViewport(x, y, w, h, minD, maxD);
  }
  setScissor(x: number, y: number, w: number, h: number): void {
    this.recorder.setScissor(x, y, w, h);
  }
}

class ReusableComputeEncoder implements KernelGraphComputeEncoder {
  recorder!: FrameRecorder;

  dispatch(
    shader: ShaderProgramId,
    bindings: BindingSetId | 0,
    uniformOffset: number,
    uniformLength: number,
    x: number,
    y = 1,
    z = 1,
  ): void {
    this.recorder.dispatch(shader, bindings, uniformOffset, uniformLength, x, y, z);
  }
  dispatchIndirect(
    shader: ShaderProgramId,
    bindings: BindingSetId | 0,
    indirectBuffer: BufferId,
    offsetBytes = 0,
  ): void {
    this.recorder.dispatchIndirect(shader, bindings, indirectBuffer, offsetBytes);
  }
}

export interface KernelGraphExecuteOptions<Frame> {
  readonly frameId?: number;
  /** Optional hook executed after `beginFrame` and before passes (e.g., for `kernel.cull`). */
  readonly beforePasses?: (frame: Frame, resources: KernelGraphFrameResources) => void;
}

export class CompiledKernelGraph<Frame> {
  private readonly texHandles: Uint32Array;
  private readonly bufHandles: Uint32Array;
  private readonly rasterEncoder = new ReusableRasterEncoder();
  private readonly computeEncoder = new ReusableComputeEncoder();
  private readonly colorDescScratch: KernelColorAttachmentDesc[] = [];
  private nextFrameId = 1;

  /** @internal */
  constructor(
    readonly surfaceSize: { readonly width: number; readonly height: number },
    private readonly textures: readonly CompiledTextureSlot<Frame>[],
    private readonly buffers: readonly CompiledBufferSlot<Frame>[],
    private readonly passes: readonly CompiledGraphPassEntry<Frame>[],
    private readonly graphInfo: CompiledKernelGraphInfo,
  ) {
    this.texHandles = new Uint32Array(textures.length);
    this.bufHandles = new Uint32Array(buffers.length);
  }

  inspect(): CompiledKernelGraphInfo {
    return this.graphInfo;
  }

  /**
   * Records every compiled pass directly onto an already-begun `FrameRecorder`.
   * Enables lock-free async pipelined submission (e.g. `NativeRenderKernel.preparePipelinedRecorder`)
   * to share the exact same `CompiledKernelGraph` as synchronous `execute()`.
   */
  record(
    recorder: FrameRecorder,
    frame: Frame,
    options?: Pick<KernelGraphExecuteOptions<Frame>, 'beforePasses'>,
  ): void {
    this.bindFrameResources(recorder, frame);
    const resources = this.createFrameResourceView(recorder);
    options?.beforePasses?.(frame, resources);

    this.rasterEncoder.recorder = recorder;
    this.computeEncoder.recorder = recorder;
    for (const pass of this.passes) {
      this.emitPass(pass, recorder, frame, resources);
    }
  }

  /**
   * Executes this immutable compiled graph on any `RenderKernelExecutionTarget`
   * (WebGPU, Dawn, WebGL2 WASM closure, or Desktop Native) in one `submitFrame` crossing.
   */
  execute(
    kernel: RenderKernelExecutionTarget,
    frame: Frame,
    options?: KernelGraphExecuteOptions<Frame>,
  ): Result<FrameSubmitReceipt, KernelError> {
    const frameId = options?.frameId ?? this.nextFrameId++;
    const recRes = kernel.beginFrame(frameId, this.surfaceSize.width, this.surfaceSize.height);
    if (!recRes.ok) return recRes;
    this.record(recRes.value, frame, options);
    return kernel.submitFrame(recRes.value);
  }

  private bindFrameResources(recorder: FrameRecorder, frame: Frame): void {
    for (let i = 0; i < this.textures.length; i++) {
      const slot = this.textures[i];
      if (slot === undefined) continue;
      if (slot.origin === 'transient') {
        const tempId: TempTextureId = recorder.acquireTempTexture(
          slot.formatCode,
          slot.width,
          slot.height,
          slot.sampleCount,
          slot.arrayLayerCount,
          slot.mipLevelCount,
          slot.derivedUsage,
          slot.colorDomain,
        );
        this.texHandles[i] = tempId >>> 0;
      } else if (slot.resolve !== undefined) {
        this.texHandles[i] = slot.resolve(frame) >>> 0;
      } else {
        this.texHandles[i] = SURFACE_SWAPCHAIN_TARGET >>> 0;
      }
    }
    for (let i = 0; i < this.buffers.length; i++) {
      const bufSlot = this.buffers[i];
      if (bufSlot !== undefined) {
        this.bufHandles[i] = bufSlot.resolve(frame) >>> 0;
      }
    }
  }

  private createFrameResourceView(recorder: FrameRecorder): KernelGraphFrameResources {
    const texHandles = this.texHandles;
    const bufHandles = this.bufHandles;
    return {
      texture(ref: KernelGraphTextureRef): TextureOrTempId {
        const handle = unwrapTextureHandle(ref);
        return texHandles[handle.id] as number as TextureOrTempId;
      },
      buffer(handle: KernelGraphBufferHandle): BufferId {
        return bufHandles[handle.id] as number as BufferId;
      },
      writeUniform(data: ArrayBufferView) {
        const slice = recorder.writeUniform(data);
        return { offset: slice.offset, length: slice.length };
      },
      beginBindingSet() {
        return recorder.beginBindingSet();
      },
      bindTexture(builder: BindingSetBuilder, slot: number, ref: KernelGraphTextureRef): void {
        const handle = unwrapTextureHandle(ref);
        const texId = texHandles[handle.id] as number as TextureOrTempId;
        if (ref.kind === 'graph-texture-view') {
          builder.bindTexture(
            slot,
            texId,
            packTextureBindingSubresource({
              baseMipLevel: ref.baseMipLevel,
              ...(ref.mipLevelCount === undefined ? {} : { mipLevelCount: ref.mipLevelCount }),
              baseArrayLayer: ref.baseArrayLayer,
              aspect: ref.aspect,
            }),
          );
        } else {
          builder.bindTexture(slot, texId, 0);
        }
      },
    };
  }

  private emitPass(
    entry: CompiledGraphPassEntry<Frame>,
    recorder: FrameRecorder,
    frame: Frame,
    resources: KernelGraphFrameResources,
  ): void {
    switch (entry.kind) {
      case 'raster':
        this.emitRasterPass(entry, recorder, frame, resources);
        break;
      case 'compute':
        this.emitComputePass(entry, recorder, frame, resources);
        break;
      case 'copy-texture':
        this.emitCopyTexturePass(entry.desc, recorder, frame);
        break;
      case 'copy-buffer':
        this.emitCopyBufferPass(entry.desc, recorder, frame);
        break;
      case 'mipgen':
        if (entry.when === undefined || entry.when(frame)) {
          recorder.generateMips(this.texHandles[entry.target.id] as TextureOrTempId);
        }
        break;
      case 'readback':
        this.emitReadbackPass(entry.desc, recorder, frame);
        break;
    }
  }

  private emitRasterPass(
    entry: Extract<CompiledGraphPassEntry<Frame>, { kind: 'raster' }>,
    recorder: FrameRecorder,
    frame: Frame,
    resources: KernelGraphFrameResources,
  ): void {
    if (entry.desc.when !== undefined && !entry.desc.when(frame)) return;
    entry.desc.prepare?.(frame, resources);
    const colors = this.resolveColorAttachments(
      entry.desc.colorAttachments,
      entry.resolvedStoreOps,
      frame,
    );
    const depth = this.resolveDepthAttachment(entry.desc.depthAttachment, frame);
    recorder.beginRenderPass({
      labelId: entry.labelId,
      colorAttachments: colors,
      ...(depth === undefined ? {} : { depthAttachment: depth }),
    });
    entry.desc.encode(this.rasterEncoder, frame, resources);
    recorder.endRenderPass();
  }

  private resolveColorAttachments(
    attachments: readonly KernelGraphColorAttachment<Frame>[],
    storeOps: readonly ('store' | 'discard')[],
    frame: Frame,
  ): readonly KernelColorAttachmentDesc[] {
    this.colorDescScratch.length = 0;
    for (let i = 0; i < attachments.length; i++) {
      const a = attachments[i];
      if (a === undefined) continue;
      const texHandle = unwrapTextureHandle(a.target);
      const texSlot = this.textures[texHandle.id];
      const loadOp = typeof a.loadOp === 'function' ? a.loadOp(frame) : a.loadOp;
      const clearColor = typeof a.clearColor === 'function' ? a.clearColor(frame) : a.clearColor;
      const resolveHandle =
        a.resolveTarget === undefined ? undefined : unwrapTextureHandle(a.resolveTarget);
      const mipLevel = a.target.kind === 'graph-texture-view' ? a.target.baseMipLevel : 0;
      const arrayLayer = a.target.kind === 'graph-texture-view' ? a.target.baseArrayLayer : 0;
      this.colorDescScratch.push({
        texture: this.texHandles[texHandle.id] as TextureOrTempId,
        ...(resolveHandle === undefined
          ? {}
          : { resolveTarget: this.texHandles[resolveHandle.id] as TextureOrTempId }),
        mipLevel,
        arrayLayer,
        loadOp,
        storeOp: storeOps[i] ?? 'store',
        isSurface: texSlot?.origin === 'surface',
        ...(clearColor === undefined ? {} : { clearColor }),
      });
    }
    return this.colorDescScratch;
  }

  private resolveDepthAttachment(
    d: KernelGraphDepthAttachment<Frame> | undefined,
    frame: Frame,
  ): KernelDepthAttachmentDesc | undefined {
    if (d === undefined) return undefined;
    const handle = unwrapTextureHandle(d.target);
    const loadOp =
      d.loadOp === undefined
        ? 'clear'
        : typeof d.loadOp === 'function'
          ? d.loadOp(frame)
          : d.loadOp;
    return {
      texture: this.texHandles[handle.id] as TextureOrTempId,
      mipLevel: d.target.kind === 'graph-texture-view' ? d.target.baseMipLevel : 0,
      arrayLayer: d.target.kind === 'graph-texture-view' ? d.target.baseArrayLayer : 0,
      loadOp,
      storeOp: d.storeOp ?? 'store',
      readOnly: d.readOnly === true,
      ...(d.clearDepth === undefined ? {} : { clearDepth: d.clearDepth }),
    };
  }

  private emitComputePass(
    entry: Extract<CompiledGraphPassEntry<Frame>, { kind: 'compute' }>,
    recorder: FrameRecorder,
    frame: Frame,
    resources: KernelGraphFrameResources,
  ): void {
    if (entry.desc.when !== undefined && !entry.desc.when(frame)) return;
    entry.desc.prepare?.(frame, resources);
    recorder.beginComputePass(entry.labelId);
    entry.desc.encode(this.computeEncoder, frame, resources);
    recorder.endComputePass();
  }

  private emitCopyTexturePass(
    desc: KernelGraphCopyTexturePassDesc<Frame>,
    recorder: FrameRecorder,
    frame: Frame,
  ): void {
    if (desc.when !== undefined && !desc.when(frame)) return;
    const srcH = unwrapTextureHandle(desc.source);
    const dstH = unwrapTextureHandle(desc.destination);
    const srcSlot = this.textures[srcH.id];
    const srcMip = desc.source.kind === 'graph-texture-view' ? desc.source.baseMipLevel : 0;
    const srcLayer = desc.source.kind === 'graph-texture-view' ? desc.source.baseArrayLayer : 0;
    const dstMip =
      desc.destination.kind === 'graph-texture-view' ? desc.destination.baseMipLevel : 0;
    const dstLayer =
      desc.destination.kind === 'graph-texture-view' ? desc.destination.baseArrayLayer : 0;
    recorder.copyTexture(
      this.texHandles[srcH.id] as TextureOrTempId,
      this.texHandles[dstH.id] as TextureOrTempId,
      desc.width ?? Math.max(1, (srcSlot?.width ?? 1) >>> srcMip),
      desc.height ?? Math.max(1, (srcSlot?.height ?? 1) >>> srcMip),
      desc.depth ?? 1,
      srcMip,
      srcLayer,
      dstMip,
      dstLayer,
    );
  }

  private emitCopyBufferPass(
    desc: KernelGraphCopyBufferPassDesc<Frame>,
    recorder: FrameRecorder,
    frame: Frame,
  ): void {
    if (desc.when !== undefined && !desc.when(frame)) return;
    recorder.copyBuffer(
      this.bufHandles[desc.source.id] as BufferId,
      desc.sourceOffset ?? 0,
      this.bufHandles[desc.destination.id] as BufferId,
      desc.destinationOffset ?? 0,
      desc.byteLength,
    );
  }

  private emitReadbackPass(
    desc: KernelGraphReadbackPassDesc<Frame>,
    recorder: FrameRecorder,
    frame: Frame,
  ): void {
    if (desc.when !== undefined && !desc.when(frame)) return;
    const handle = unwrapTextureHandle(desc.source);
    const ticketId = typeof desc.ticketId === 'function' ? desc.ticketId(frame) : desc.ticketId;
    const mip = desc.source.kind === 'graph-texture-view' ? desc.source.baseMipLevel : 0;
    const layer = desc.source.kind === 'graph-texture-view' ? desc.source.baseArrayLayer : 0;
    recorder.requestReadback(this.texHandles[handle.id] as TextureOrTempId, ticketId, mip, layer);
  }
}

export function buildCompiledTextureSlot<Frame>(
  id: number,
  info: KernelGraphResourceInfo,
  colorDomain: number,
  resolve?: (frame: Frame) => TextureOrTempId,
): CompiledTextureSlot<Frame> {
  return {
    id,
    name: info.name,
    origin: info.origin,
    format: info.format,
    formatCode: gpuTextureFormatToCode(info.format),
    width: info.width,
    height: info.height,
    sampleCount: info.sampleCount,
    mipLevelCount: info.mipLevelCount,
    arrayLayerCount: info.arrayLayerCount,
    colorDomain,
    derivedUsage: info.derivedUsage,
    ...(resolve === undefined ? {} : { resolve }),
  };
}

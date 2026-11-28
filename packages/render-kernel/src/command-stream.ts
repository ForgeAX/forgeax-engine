// Zero-allocation imperative FrameRecorder writing compact Uint32Array command bytecode
// and a contiguous Uint8Array uniform ring buffer (bit-identical with Rust kernel-core::planner).

import {
  type BindingSetId,
  type BufferId,
  type CullId,
  INVALID_HANDLE,
  type MaterialId,
  type MeshId,
  makeTempTextureHandle,
  type PipelineId,
  type ShaderProgramId,
  type SurfaceId,
  type TempTextureId,
  type TextureOrTempId,
  type UniformSliceHandle,
} from './handles.js';

// Input FrameRecorder opcodes (exact match with Rust planner.rs)
export const CMD_ACQUIRE_TEMP_TEX = 0x01;
export const CMD_DEF_BINDING_SET = 0x02;
export const CMD_BEGIN_RENDER_PASS = 0x10;
export const CMD_DRAW_RENDERERS = 0x11;
export const CMD_DRAW_FULLSCREEN = 0x12;
export const CMD_DRAW_MESH = 0x13;
export const CMD_END_RENDER_PASS = 0x14;
export const CMD_SET_VIEWPORT = 0x15;
export const CMD_SET_SCISSOR = 0x16;
export const CMD_BEGIN_COMPUTE_PASS = 0x20;
export const CMD_DISPATCH = 0x21;
export const CMD_DISPATCH_INDIRECT = 0x22;
export const CMD_END_COMPUTE_PASS = 0x23;
export const CMD_COPY_TEXTURE = 0x30;
export const CMD_COPY_BUFFER = 0x31;
export const CMD_GENERATE_MIPS = 0x32;
export const CMD_REQUEST_READBACK = 0x33;
export const CMD_RHI_SET_PIPELINE = 0x40;
export const CMD_RHI_SET_BIND_GROUP = 0x41;
export const CMD_RHI_SET_VB = 0x42;
export const CMD_RHI_SET_IB = 0x43;
export const CMD_RHI_DRAW = 0x44;
export const CMD_RHI_DRAW_INDEXED = 0x45;
export const CMD_RHI_DRAW_INDIRECT = 0x46;
export const CMD_SET_SHADER_PIPELINE = 0x47;

// Resolved Physical Replay Stream opcodes
export const PHYS_ENSURE_POOL_TEX = 0x81;
export const PHYS_RETIRE_POOL_TEX = 0x82;
export const PHYS_BEGIN_RENDER_PASS = 0x83;
export const PHYS_SET_PSO = 0x84;
export const PHYS_SET_BIND_GROUP = 0x85;
export const PHYS_SET_VB = 0x86;
export const PHYS_SET_IB = 0x87;
export const PHYS_DRAW = 0x88;
export const PHYS_DRAW_INDEXED = 0x89;
export const PHYS_DRAW_INDIRECT = 0x8a;
export const PHYS_END_RENDER_PASS = 0x8b;
export const PHYS_BEGIN_COMPUTE_PASS = 0x8c;
export const PHYS_DISPATCH = 0x8d;
export const PHYS_DISPATCH_INDIRECT = 0x8e;
export const PHYS_END_COMPUTE_PASS = 0x8f;
export const PHYS_COPY_TEXTURE = 0x90;
export const PHYS_COPY_BUFFER = 0x91;
export const PHYS_GENERATE_MIPS = 0x92;
export const PHYS_REQUEST_READBACK = 0x93;
export const PHYS_UPLOAD_GPU_SCENE = 0x94;
export const PHYS_DRAW_FULLSCREEN = 0x95;
export const PHYS_DEF_BINDING_SET = 0x96;
export const PHYS_SET_VIEWPORT = 0x97;
export const PHYS_SET_SCISSOR = 0x98;

export const SORT_NONE = 0;
export const SORT_FRONT_TO_BACK = 1;
export const SORT_BACK_TO_FRONT = 2;
export const SORT_MATERIAL_PSO = 3;

export const DRAW_FLAG_INSTANCING = 1 << 0;
export const DRAW_FLAG_GPU_DRIVEN = 1 << 1;
export const DRAW_FLAG_SHADOW_CASTER_ONLY = 1 << 2;

export const BINDING_KIND_TEXTURE = 0;
export const BINDING_KIND_DYNAMIC_TEXTURE = 1;
export const BINDING_KIND_TEMP_TEXTURE = 2;
export const BINDING_KIND_BUFFER = 3;
export const BINDING_KIND_SAMPLER = 4;
export const BINDING_KIND_UNIFORM_SLICE = 5;

export const BINDING_TEX_ASPECT_ALL = 0;
export const BINDING_TEX_ASPECT_DEPTH_ONLY = 1;
export const BINDING_TEX_ASPECT_STENCIL_ONLY = 2;
export const BINDING_TEX_SUBRESOURCE_FLAG = 1 << 30;

export interface KernelTextureViewSubresource {
  readonly baseMipLevel?: number;
  readonly mipLevelCount?: number;
  readonly baseArrayLayer?: number;
  readonly aspect?: 'all' | 'depth-only' | 'stencil-only';
}

export function packTextureBindingSubresource(view?: KernelTextureViewSubresource): number {
  if (view === undefined) return 0;
  const baseMip = (view.baseMipLevel ?? 0) & 0xff;
  const mipCount = (view.mipLevelCount ?? 0) & 0xff;
  const baseLayer = (view.baseArrayLayer ?? 0) & 0xfff;
  const aspectCode =
    view.aspect === 'depth-only'
      ? BINDING_TEX_ASPECT_DEPTH_ONLY
      : view.aspect === 'stencil-only'
        ? BINDING_TEX_ASPECT_STENCIL_ONLY
        : BINDING_TEX_ASPECT_ALL;
  if (baseMip === 0 && mipCount === 0 && baseLayer === 0 && aspectCode === 0) return 0;
  return (
    (BINDING_TEX_SUBRESOURCE_FLAG |
      ((aspectCode & 0x3) << 28) |
      (baseLayer << 16) |
      (mipCount << 8) |
      baseMip) >>>
    0
  );
}

export const COLOR_DOMAIN_LINEAR_HDR = 0;
export const COLOR_DOMAIN_LINEAR_LDR = 1;
export const COLOR_DOMAIN_DISPLAY_ENCODED = 2;

export const LOAD_OP_CLEAR = 0;
export const LOAD_OP_LOAD = 1;
export const STORE_OP_STORE = 0;
export const STORE_OP_DISCARD = 1;

export function cmdHeader(opcode: number, wordLen: number): number {
  return (((wordLen & 0xffff) << 16) | (opcode & 0xffff)) >>> 0;
}

const F32_SCRATCH = new Float32Array(1);
const U32_SCRATCH = new Uint32Array(F32_SCRATCH.buffer);

export function f32ToBits(v: number): number {
  F32_SCRATCH[0] = v;
  return (U32_SCRATCH[0] as number) >>> 0;
}

export function bitsToF32(bits: number): number {
  U32_SCRATCH[0] = bits >>> 0;
  return F32_SCRATCH[0] as number;
}

export interface KernelColorAttachmentDesc {
  readonly texture: TextureOrTempId;
  readonly resolveTarget?: TextureOrTempId;
  readonly mipLevel?: number;
  readonly arrayLayer?: number;
  readonly loadOp?: 'clear' | 'load';
  readonly storeOp?: 'store' | 'discard';
  readonly isSurface?: boolean;
  readonly clearColor?: readonly [number, number, number, number];
}

export interface KernelDepthAttachmentDesc {
  readonly texture: TextureOrTempId;
  readonly mipLevel?: number;
  readonly arrayLayer?: number;
  readonly loadOp?: 'clear' | 'load';
  readonly storeOp?: 'store' | 'discard';
  readonly readOnly?: boolean;
  readonly clearDepth?: number;
}

export interface KernelRenderPassDesc {
  readonly labelId?: number;
  readonly colorAttachments: readonly KernelColorAttachmentDesc[];
  readonly depthAttachment?: KernelDepthAttachmentDesc;
}

export interface KernelDrawRenderersDesc {
  readonly cullId: CullId;
  readonly passTag: number;
  readonly queueMin: number;
  readonly queueMax: number;
  readonly layerMask?: number;
  readonly sortMode?: 0 | 1 | 2 | 3;
  readonly drawFlags?: number;
  readonly viewUniformOffset?: number;
  readonly viewUniformLength?: number;
  readonly extraBindings?: BindingSetId | 0;
  readonly overrideShader?: ShaderProgramId | 0;
  readonly viewSlotMode?: number;
  readonly passAttachmentId?: number;
}

export class BindingSetBuilder {
  private readonly words = new Uint32Array(128);
  private entryCount = 0;
  private recorder!: FrameRecorder;
  private setId = 0;

  /** @internal */
  _begin(recorder: FrameRecorder, setId: number): this {
    this.recorder = recorder;
    this.setId = setId;
    this.entryCount = 0;
    return this;
  }

  private push(slot: number, kind: number, handle: number, offsetOrSize: number): this {
    const base = this.entryCount * 3;
    this.words[base] = (((kind & 0xffff) << 16) | (slot & 0xffff)) >>> 0;
    this.words[base + 1] = handle >>> 0;
    this.words[base + 2] = offsetOrSize >>> 0;
    this.entryCount += 1;
    return this;
  }

  bindTexture(slot: number, tex: TextureOrTempId, mipOrLayer = 0): this {
    return this.push(slot, BINDING_KIND_TEXTURE, tex, mipOrLayer);
  }

  bindTextureView(
    slot: number,
    tex: TextureOrTempId,
    subresource?: KernelTextureViewSubresource,
  ): this {
    return this.push(slot, BINDING_KIND_TEXTURE, tex, packTextureBindingSubresource(subresource));
  }

  bindDynamicTexture(slot: number, tex: number): this {
    return this.push(slot, BINDING_KIND_DYNAMIC_TEXTURE, tex, 0);
  }

  bindBuffer(slot: number, buffer: BufferId, offsetBytes = 0): this {
    return this.push(slot, BINDING_KIND_BUFFER, buffer, offsetBytes);
  }

  /** Binds a slice of this frame's uniform staging ring buffer (`writeUniform()`). */
  bindUniformSlice(slot: number, offsetBytes: number, byteLength: number): this {
    return this.push(slot, BINDING_KIND_UNIFORM_SLICE, offsetBytes, byteLength);
  }

  bindSampler(slot: number, sampler: number): this {
    return this.push(slot, BINDING_KIND_SAMPLER, sampler, 0);
  }

  finish(): BindingSetId {
    this.recorder._emitBindingSet(this.setId, this.words, this.entryCount);
    return this.setId as BindingSetId;
  }
}

/**
 * Reusable zero-allocation imperative frame command recorder.
 * Writes directly to a preallocated Uint32Array command buffer and contiguous uniform staging buffer.
 */
export class FrameRecorder {
  private cmds: Uint32Array;
  private wordCursor = 0;
  private uniformBytes: Uint8Array;
  private uniformCursor = 0;
  private nextTempId = 1;
  private nextBindingSetId = 1;
  private readonly bindingBuilder = new BindingSetBuilder();
  private externalCmdResize?: (minWords: number) => Uint32Array;

  constructor(initialCmdWords = 8192, initialUniformBytes = 64 * 1024) {
    this.cmds = new Uint32Array(initialCmdWords);
    this.uniformBytes = new Uint8Array(initialUniformBytes);
  }

  /** Rebinds command output directly onto WASM linear memory (zero copy). */
  bindExternalCmds(view: Uint32Array, resize: (minWords: number) => Uint32Array): void {
    this.cmds = view;
    this.externalCmdResize = resize;
  }

  reset(): void {
    this.wordCursor = 0;
    this.uniformCursor = 0;
    this.nextTempId = 1;
    this.nextBindingSetId = 1;
  }

  get commandWordLength(): number {
    return this.wordCursor;
  }

  get commandSlice(): Uint32Array {
    return this.cmds.subarray(0, this.wordCursor);
  }

  get uniformDataSlice(): Uint8Array {
    return this.uniformBytes.subarray(0, this.uniformCursor);
  }

  private ensureWords(extra: number): void {
    const needed = this.wordCursor + extra;
    if (needed <= this.cmds.length) return;
    if (this.externalCmdResize !== undefined) {
      this.cmds = this.externalCmdResize(needed);
      return;
    }
    let cap = this.cmds.length || 1024;
    while (cap < needed) cap *= 2;
    const next = new Uint32Array(cap);
    next.set(this.cmds.subarray(0, this.wordCursor));
    this.cmds = next;
  }

  private ensureUniformBytes(extra: number): void {
    const aligned = (this.uniformCursor + 255) & ~255;
    const needed = aligned + extra;
    if (needed <= this.uniformBytes.byteLength) return;
    let cap = this.uniformBytes.byteLength || 4096;
    while (cap < needed) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.uniformBytes.subarray(0, this.uniformCursor));
    this.uniformBytes = next;
  }

  /** Writes uniform bytes with 256-byte alignment (WebGPU minUniformBufferOffsetAlignment). */
  writeUniform(data: ArrayBufferView): {
    readonly offset: number;
    readonly length: number;
    readonly handle: UniformSliceHandle;
  } {
    this.ensureUniformBytes(data.byteLength);
    const offset = (this.uniformCursor + 255) & ~255;
    const src = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.uniformBytes.set(src, offset);
    this.uniformCursor = offset + data.byteLength;
    return {
      offset,
      length: data.byteLength,
      handle: offset as UniformSliceHandle,
    };
  }

  acquireTempTexture(
    formatCode: number,
    width: number,
    height: number,
    sampleCount: 1 | 4 = 1,
    arrayLayers = 1,
    mipLevels = 1,
    usageFlags = 0x10,
    colorDomain = COLOR_DOMAIN_LINEAR_HDR,
  ): TempTextureId {
    const tempId = makeTempTextureHandle(this.nextTempId++);
    this.ensureWords(7);
    const c = this.cmds;
    let p = this.wordCursor;
    c[p++] = cmdHeader(CMD_ACQUIRE_TEMP_TEX, 7);
    c[p++] = tempId >>> 0;
    c[p++] =
      ((formatCode & 0xff) | ((sampleCount & 0xff) << 8) | ((colorDomain & 0xff) << 16)) >>> 0;
    c[p++] = width >>> 0;
    c[p++] = height >>> 0;
    c[p++] = ((arrayLayers & 0xffff) | ((mipLevels & 0xffff) << 16)) >>> 0;
    c[p++] = usageFlags >>> 0;
    this.wordCursor = p;
    return tempId;
  }

  beginBindingSet(): BindingSetBuilder {
    return this.bindingBuilder._begin(this, this.nextBindingSetId++);
  }

  /** @internal */
  _emitBindingSet(setId: number, entries: Uint32Array, count: number): void {
    const wordLen = 3 + count * 3;
    this.ensureWords(wordLen);
    const c = this.cmds;
    let p = this.wordCursor;
    c[p++] = cmdHeader(CMD_DEF_BINDING_SET, wordLen);
    c[p++] = setId >>> 0;
    c[p++] = count >>> 0;
    for (let i = 0; i < count * 3; i++) {
      c[p++] = (entries[i] as number) >>> 0;
    }
    this.wordCursor = p;
  }

  beginRenderPass(desc: KernelRenderPassDesc): void {
    const colorCount = desc.colorAttachments.length;
    const hasDepth = desc.depthAttachment !== undefined ? 1 : 0;
    const wordLen = 3 + colorCount * 8 + hasDepth * 4;
    this.ensureWords(wordLen);
    const c = this.cmds;
    let p = this.wordCursor;
    c[p++] = cmdHeader(CMD_BEGIN_RENDER_PASS, wordLen);
    c[p++] = (desc.labelId ?? 0) >>> 0;
    c[p++] = ((colorCount & 0xff) | (hasDepth << 8)) >>> 0;
    for (let i = 0; i < colorCount; i++) {
      const a = desc.colorAttachments[i] as KernelColorAttachmentDesc;
      const clear = a.clearColor ?? [0, 0, 0, 1];
      c[p++] = a.texture >>> 0;
      c[p++] = (a.resolveTarget ?? INVALID_HANDLE) >>> 0;
      c[p++] = (((a.arrayLayer ?? 0) << 16) | ((a.mipLevel ?? 0) & 0xffff)) >>> 0;
      c[p++] =
        ((a.loadOp === 'load' ? LOAD_OP_LOAD : LOAD_OP_CLEAR) |
          ((a.storeOp === 'discard' ? STORE_OP_DISCARD : STORE_OP_STORE) << 8) |
          ((a.isSurface ? 1 : 0) << 16)) >>>
        0;
      c[p++] = f32ToBits(clear[0]);
      c[p++] = f32ToBits(clear[1]);
      c[p++] = f32ToBits(clear[2]);
      c[p++] = f32ToBits(clear[3]);
    }
    if (desc.depthAttachment !== undefined) {
      const d = desc.depthAttachment;
      c[p++] = d.texture >>> 0;
      c[p++] = (((d.arrayLayer ?? 0) << 16) | ((d.mipLevel ?? 0) & 0xffff)) >>> 0;
      c[p++] =
        ((d.loadOp === 'load' ? LOAD_OP_LOAD : LOAD_OP_CLEAR) |
          ((d.storeOp === 'discard' ? STORE_OP_DISCARD : STORE_OP_STORE) << 8) |
          ((d.readOnly ? 1 : 0) << 16)) >>>
        0;
      c[p++] = f32ToBits(d.clearDepth ?? 0.0);
    }
    this.wordCursor = p;
  }

  drawRenderers(desc: KernelDrawRenderersDesc): void {
    this.ensureWords(11);
    const c = this.cmds;
    let p = this.wordCursor;
    c[p++] = cmdHeader(CMD_DRAW_RENDERERS, 11);
    c[p++] = desc.cullId >>> 0;
    c[p++] =
      ((desc.passTag & 0xff) |
        (((desc.sortMode ?? SORT_MATERIAL_PSO) & 0xff) << 8) |
        (((desc.drawFlags ?? DRAW_FLAG_INSTANCING) & 0xffff) << 16)) >>>
      0;
    c[p++] = ((desc.queueMin & 0xffff) | ((desc.queueMax & 0xffff) << 16)) >>> 0;
    c[p++] = (desc.layerMask ?? 0xffff_ffff) >>> 0;
    c[p++] = (desc.viewUniformOffset ?? 0) >>> 0;
    c[p++] = (desc.viewUniformLength ?? 0) >>> 0;
    c[p++] = (desc.extraBindings ?? 0) >>> 0;
    c[p++] = (desc.overrideShader ?? 0) >>> 0;
    c[p++] = (desc.viewSlotMode ?? 0) >>> 0;
    c[p++] = (desc.passAttachmentId ?? 1) >>> 0;
    this.wordCursor = p;
  }

  drawFullscreen(
    shader: ShaderProgramId,
    bindings: BindingSetId | 0 = 0,
    uniformOffset = 0,
    uniformLength = 0,
  ): void {
    this.ensureWords(5);
    const c = this.cmds;
    let p = this.wordCursor;
    c[p++] = cmdHeader(CMD_DRAW_FULLSCREEN, 5);
    c[p++] = shader >>> 0;
    c[p++] = bindings >>> 0;
    c[p++] = uniformOffset >>> 0;
    c[p++] = uniformLength >>> 0;
    this.wordCursor = p;
  }

  drawMesh(
    mesh: MeshId,
    material: MaterialId,
    transformUniformOffset: number,
    passTag = 0,
    passAttachmentId = 1,
  ): void {
    this.ensureWords(6);
    const c = this.cmds;
    let p = this.wordCursor;
    c[p++] = cmdHeader(CMD_DRAW_MESH, 6);
    c[p++] = mesh >>> 0;
    c[p++] = material >>> 0;
    c[p++] = transformUniformOffset >>> 0;
    c[p++] = passTag >>> 0;
    c[p++] = passAttachmentId >>> 0;
    this.wordCursor = p;
  }

  endRenderPass(): void {
    this.ensureWords(1);
    this.cmds[this.wordCursor++] = cmdHeader(CMD_END_RENDER_PASS, 1);
  }

  setViewport(
    x: number,
    y: number,
    width: number,
    height: number,
    minDepth = 0,
    maxDepth = 1,
  ): void {
    this.ensureWords(7);
    const c = this.cmds;
    let p = this.wordCursor;
    c[p++] = cmdHeader(CMD_SET_VIEWPORT, 7);
    c[p++] = f32ToBits(x);
    c[p++] = f32ToBits(y);
    c[p++] = f32ToBits(width);
    c[p++] = f32ToBits(height);
    c[p++] = f32ToBits(minDepth);
    c[p++] = f32ToBits(maxDepth);
    this.wordCursor = p;
  }

  setScissor(x: number, y: number, width: number, height: number): void {
    this.ensureWords(5);
    const c = this.cmds;
    let p = this.wordCursor;
    c[p++] = cmdHeader(CMD_SET_SCISSOR, 5);
    c[p++] = x >>> 0;
    c[p++] = y >>> 0;
    c[p++] = width >>> 0;
    c[p++] = height >>> 0;
    this.wordCursor = p;
  }

  beginComputePass(labelId = 0): void {
    this.ensureWords(2);
    this.cmds[this.wordCursor++] = cmdHeader(CMD_BEGIN_COMPUTE_PASS, 2);
    this.cmds[this.wordCursor++] = labelId >>> 0;
  }

  dispatch(
    shader: ShaderProgramId,
    bindings: BindingSetId | 0,
    uniformOffset: number,
    uniformLength: number,
    x: number,
    y = 1,
    z = 1,
  ): void {
    this.ensureWords(8);
    const c = this.cmds;
    let p = this.wordCursor;
    c[p++] = cmdHeader(CMD_DISPATCH, 8);
    c[p++] = shader >>> 0;
    c[p++] = bindings >>> 0;
    c[p++] = uniformOffset >>> 0;
    c[p++] = uniformLength >>> 0;
    c[p++] = x >>> 0;
    c[p++] = y >>> 0;
    c[p++] = z >>> 0;
    this.wordCursor = p;
  }

  dispatchIndirect(
    shader: ShaderProgramId,
    bindings: BindingSetId | 0,
    indirectBuffer: BufferId,
    offsetBytes = 0,
  ): void {
    this.ensureWords(5);
    const c = this.cmds;
    let p = this.wordCursor;
    c[p++] = cmdHeader(CMD_DISPATCH_INDIRECT, 5);
    c[p++] = shader >>> 0;
    c[p++] = bindings >>> 0;
    c[p++] = indirectBuffer >>> 0;
    c[p++] = offsetBytes >>> 0;
    this.wordCursor = p;
  }

  endComputePass(): void {
    this.ensureWords(1);
    this.cmds[this.wordCursor++] = cmdHeader(CMD_END_COMPUTE_PASS, 1);
  }

  copyTexture(
    src: TextureOrTempId,
    dst: TextureOrTempId,
    width: number,
    height: number,
    depth = 1,
    srcMip = 0,
    srcLayer = 0,
    dstMip = 0,
    dstLayer = 0,
  ): void {
    this.ensureWords(8);
    const c = this.cmds;
    let p = this.wordCursor;
    c[p++] = cmdHeader(CMD_COPY_TEXTURE, 8);
    c[p++] = src >>> 0;
    c[p++] = ((srcLayer << 16) | (srcMip & 0xffff)) >>> 0;
    c[p++] = dst >>> 0;
    c[p++] = ((dstLayer << 16) | (dstMip & 0xffff)) >>> 0;
    c[p++] = width >>> 0;
    c[p++] = height >>> 0;
    c[p++] = depth >>> 0;
    this.wordCursor = p;
  }

  copyBuffer(
    src: BufferId,
    srcOffset: number,
    dst: BufferId,
    dstOffset: number,
    byteLength: number,
  ): void {
    this.ensureWords(6);
    const c = this.cmds;
    let p = this.wordCursor;
    c[p++] = cmdHeader(CMD_COPY_BUFFER, 6);
    c[p++] = src >>> 0;
    c[p++] = srcOffset >>> 0;
    c[p++] = dst >>> 0;
    c[p++] = dstOffset >>> 0;
    c[p++] = byteLength >>> 0;
    this.wordCursor = p;
  }

  generateMips(tex: TextureOrTempId): void {
    this.ensureWords(2);
    this.cmds[this.wordCursor++] = cmdHeader(CMD_GENERATE_MIPS, 2);
    this.cmds[this.wordCursor++] = tex >>> 0;
  }

  requestReadback(tex: TextureOrTempId, ticketId: number, mip = 0, layer = 0): void {
    this.ensureWords(4);
    const c = this.cmds;
    let p = this.wordCursor;
    c[p++] = cmdHeader(CMD_REQUEST_READBACK, 4);
    c[p++] = tex >>> 0;
    c[p++] = ticketId >>> 0;
    c[p++] = ((layer << 16) | (mip & 0xffff)) >>> 0;
    this.wordCursor = p;
  }

  // --- Shared-handle RHI passthrough & custom shader pipeline primitives ---
  setShaderPipeline(
    shaderProgramId: ShaderProgramId,
    renderStateBits = 0,
    passAttachmentId = 1,
    vertexLayoutId = 0,
  ): void {
    this.ensureWords(5);
    const c = this.cmds;
    let p = this.wordCursor;
    c[p++] = cmdHeader(CMD_SET_SHADER_PIPELINE, 5);
    c[p++] = shaderProgramId >>> 0;
    c[p++] = renderStateBits >>> 0;
    c[p++] = passAttachmentId >>> 0;
    c[p++] = vertexLayoutId >>> 0;
    this.wordCursor = p;
  }

  rhiSetPipeline(pso: PipelineId): void {
    this.ensureWords(2);
    this.cmds[this.wordCursor++] = cmdHeader(CMD_RHI_SET_PIPELINE, 2);
    this.cmds[this.wordCursor++] = pso >>> 0;
  }

  rhiSetBindGroup(slot: number, bindingSet: BindingSetId, dynamicOffsets?: Uint32Array): void {
    const dynLen = dynamicOffsets?.length ?? 0;
    const wordLen = 4 + dynLen;
    this.ensureWords(wordLen);
    const c = this.cmds;
    let p = this.wordCursor;
    c[p++] = cmdHeader(CMD_RHI_SET_BIND_GROUP, wordLen);
    c[p++] = slot >>> 0;
    c[p++] = bindingSet >>> 0;
    c[p++] = dynLen >>> 0;
    for (let i = 0; i < dynLen; i++) {
      c[p++] = ((dynamicOffsets as Uint32Array)[i] as number) >>> 0;
    }
    this.wordCursor = p;
  }

  rhiSetVertexBuffer(slot: number, buffer: BufferId, offsetBytes = 0): void {
    this.ensureWords(4);
    const c = this.cmds;
    let p = this.wordCursor;
    c[p++] = cmdHeader(CMD_RHI_SET_VB, 4);
    c[p++] = slot >>> 0;
    c[p++] = buffer >>> 0;
    c[p++] = offsetBytes >>> 0;
    this.wordCursor = p;
  }

  rhiSetIndexBuffer(buffer: BufferId, isUint32 = false, offsetBytes = 0): void {
    this.ensureWords(4);
    const c = this.cmds;
    let p = this.wordCursor;
    c[p++] = cmdHeader(CMD_RHI_SET_IB, 4);
    c[p++] = buffer >>> 0;
    c[p++] = isUint32 ? 1 : 0;
    c[p++] = offsetBytes >>> 0;
    this.wordCursor = p;
  }

  rhiDraw(vertexCount: number, instanceCount = 1, firstVertex = 0, firstInstance = 0): void {
    this.ensureWords(5);
    const c = this.cmds;
    let p = this.wordCursor;
    c[p++] = cmdHeader(CMD_RHI_DRAW, 5);
    c[p++] = vertexCount >>> 0;
    c[p++] = instanceCount >>> 0;
    c[p++] = firstVertex >>> 0;
    c[p++] = firstInstance >>> 0;
    this.wordCursor = p;
  }

  rhiDrawIndexed(
    indexCount: number,
    instanceCount = 1,
    firstIndex = 0,
    baseVertex = 0,
    firstInstance = 0,
  ): void {
    this.ensureWords(6);
    const c = this.cmds;
    let p = this.wordCursor;
    c[p++] = cmdHeader(CMD_RHI_DRAW_INDEXED, 6);
    c[p++] = indexCount >>> 0;
    c[p++] = instanceCount >>> 0;
    c[p++] = firstIndex >>> 0;
    c[p++] = baseVertex | 0;
    c[p++] = firstInstance >>> 0;
    this.wordCursor = p;
  }

  rhiDrawIndirect(indirectBuffer: BufferId, offsetBytes = 0): void {
    this.ensureWords(3);
    const c = this.cmds;
    let p = this.wordCursor;
    c[p++] = cmdHeader(CMD_RHI_DRAW_INDIRECT, 3);
    c[p++] = indirectBuffer >>> 0;
    c[p++] = offsetBytes >>> 0;
    this.wordCursor = p;
  }

  /** Helper for writing a raw surface target id. */
  static surfaceTarget(surfaceId: SurfaceId): TextureOrTempId {
    return surfaceId;
  }
}

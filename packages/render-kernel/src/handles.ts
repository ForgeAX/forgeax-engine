// 32-bit generational handles (`generation:12 | slot:20`, 0 = invalid sentinel).

export const INVALID_HANDLE = 0 as const;
export const HANDLE_SLOT_BITS = 20;
export const HANDLE_SLOT_MASK = (1 << HANDLE_SLOT_BITS) - 1;
export const HANDLE_GEN_MASK = 0x0fff;
export const TEMP_TEXTURE_TAG_BIT = 0x8000_0000;

export type MeshId = number & { readonly __kernelBrand: 'MeshId' };
export type TextureId = number & { readonly __kernelBrand: 'TextureId' };
export type DynamicTextureId = number & { readonly __kernelBrand: 'DynamicTextureId' };
export type BufferId = number & { readonly __kernelBrand: 'BufferId' };
export type SamplerId = number & { readonly __kernelBrand: 'SamplerId' };
export type ShaderProgramId = number & { readonly __kernelBrand: 'ShaderProgramId' };
export type MaterialId = number & { readonly __kernelBrand: 'MaterialId' };
export type PipelineId = number & { readonly __kernelBrand: 'PipelineId' };
export type RenderObjectId = number & { readonly __kernelBrand: 'RenderObjectId' };
export type LightId = number & { readonly __kernelBrand: 'LightId' };
export type CullId = number & { readonly __kernelBrand: 'CullId' };
export type TempTextureId = number & { readonly __kernelBrand: 'TempTextureId' };
export type BindingSetId = number & { readonly __kernelBrand: 'BindingSetId' };
export type SurfaceId = number & { readonly __kernelBrand: 'SurfaceId' };
export type UniformSliceHandle = number & { readonly __kernelBrand: 'UniformSliceHandle' };

export type TextureOrTempId = TextureId | DynamicTextureId | TempTextureId | SurfaceId;

export function packKernelHandle(slot: number, generation: number): number {
  return (((generation & HANDLE_GEN_MASK) << HANDLE_SLOT_BITS) | (slot & HANDLE_SLOT_MASK)) >>> 0;
}

export function kernelHandleSlot(handle: number): number {
  return handle & HANDLE_SLOT_MASK;
}

export function kernelHandleGeneration(handle: number): number {
  return (handle >>> HANDLE_SLOT_BITS) & HANDLE_GEN_MASK;
}

export function nextKernelGeneration(generation: number): number {
  const next = (generation + 1) & HANDLE_GEN_MASK;
  return next === 0 ? 1 : next;
}

export function isTempTextureHandle(handle: number): boolean {
  return (handle & TEMP_TEXTURE_TAG_BIT) !== 0;
}

export function makeTempTextureHandle(localId: number): TempTextureId {
  return ((TEMP_TEXTURE_TAG_BIT | (localId & 0x7fff_ffff)) >>> 0) as TempTextureId;
}

export type SlotLookupError = 'invalid' | 'stale' | 'destroyed' | 'capacity';

export class GenerationalSlotTable<T> {
  private readonly values: (T | undefined)[] = [];
  private readonly generations: number[] = [];
  private readonly freeList: number[] = [];
  private liveCount = 0;

  get size(): number {
    return this.liveCount;
  }

  insert(value: T): number | null {
    if (this.freeList.length > 0) {
      const slot = this.freeList.pop() as number;
      this.values[slot] = value;
      this.liveCount += 1;
      return packKernelHandle(slot, this.generations[slot] as number);
    }
    if (this.values.length > HANDLE_SLOT_MASK) {
      return null;
    }
    const slot = this.values.length;
    this.values.push(value);
    this.generations.push(1);
    this.liveCount += 1;
    return packKernelHandle(slot, 1);
  }

  get(handle: number): T | undefined {
    if (handle === INVALID_HANDLE) return undefined;
    const slot = kernelHandleSlot(handle);
    if (slot >= this.values.length) return undefined;
    if (this.generations[slot] !== kernelHandleGeneration(handle)) return undefined;
    return this.values[slot];
  }

  check(handle: number): SlotLookupError | undefined {
    if (handle === INVALID_HANDLE) return 'invalid';
    const slot = kernelHandleSlot(handle);
    if (slot >= this.values.length) return 'invalid';
    if (this.generations[slot] !== kernelHandleGeneration(handle)) return 'stale';
    if (this.values[slot] === undefined) return 'destroyed';
    return undefined;
  }

  remove(
    handle: number,
  ):
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly reason: SlotLookupError } {
    const fault = this.check(handle);
    if (fault !== undefined) return { ok: false, reason: fault };
    const slot = kernelHandleSlot(handle);
    const value = this.values[slot] as T;
    this.values[slot] = undefined;
    this.generations[slot] = nextKernelGeneration(this.generations[slot] as number);
    this.freeList.push(slot);
    this.liveCount -= 1;
    return { ok: true, value };
  }

  clear(): void {
    this.values.length = 0;
    this.generations.length = 0;
    this.freeList.length = 0;
    this.liveCount = 0;
  }
}

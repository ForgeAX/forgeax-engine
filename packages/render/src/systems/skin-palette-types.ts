import type { Mat4 } from '@forgeax/engine-math';
import type { Buffer } from '@forgeax/engine-rhi';

/**
 * Per-draw palette slice metadata shared by the extract producer and the
 * palette allocator. The slice carries the buffer identity so storage and
 * uniform fallback paths converge at the record binding owner.
 */
export interface SkinPaletteSlice {
  readonly jointCount: number;
  /** Byte offset into buffer; uniform fallback slices always use zero. */
  readonly byteOffset: number;
  /** GPU buffer containing the slice's joint matrices. */
  readonly buffer: Buffer;
}

export interface SkinPaletteDirtyRange {
  readonly startJoint: number;
  readonly jointCount: number;
}

export interface SkinPaletteReceipt extends SkinPaletteSlice {
  readonly identity: string;
  readonly generation: number;
  readonly fence: number;
  readonly customDataStart: number;
  readonly storageOrUniform: 'storage' | 'uniform';
  readonly bounds?: Float32Array;
  readonly dirtyRanges: readonly SkinPaletteDirtyRange[];
  readonly uploadBytes: number;
  readonly retiredByteOffset?: number;
}

/** Frozen source facts; GPU addresses are assigned only by the consuming Renderer. */
export interface SkinPose {
  readonly identity: string;
  readonly generation: number;
  readonly jointCount: number;
  readonly bounds?: Float32Array;
  readonly inverseBindMatrices: readonly Float32Array[];
  readonly jointWorlds: readonly Mat4[];
}

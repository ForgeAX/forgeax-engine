import { getModelingKernelWasm } from '@forgeax/modeling-kernel-wasm';

export interface GpuBakeBvhInput {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  readonly slots: Int32Array;
  readonly floater: Uint8Array;
  readonly stray: Uint8Array;
  readonly groupTris: Uint32Array;
  readonly groupRanges: Uint32Array;
}

export interface GpuBakeBvhBuffers {
  readonly nodesU32: Uint32Array;
  readonly trisU32: Uint32Array;
  readonly triNormalsF32: Float32Array;
  readonly groupRootsI32: Int32Array;
  readonly release: () => void;
}

/**
 * Build binned-SAH stackless preorder GPU BVHs for all bake groups in one Rust WASM call.
 * Returns zero-copy views directly into WASM linear memory; call `release()` once copied
 * into WebGPU mapped buffers. Returns `undefined` if WASM is not initialized.
 */
export function buildGpuBakeBvhGroups(input: GpuBakeBvhInput): GpuBakeBvhBuffers | undefined {
  const wasm = getModelingKernelWasm();
  if (wasm === undefined) return undefined;

  const posBytes = input.positions.byteLength;
  const normBytes = input.normals.byteLength;
  const idxBytes = input.indices.byteLength;
  const slotsBytes = input.slots.byteLength;
  const floaterBytes = input.floater.byteLength;
  const strayBytes = input.stray.byteLength;
  const groupTrisBytes = input.groupTris.byteLength;
  const groupRangesBytes = input.groupRanges.byteLength;

  const align4 = (n: number) => (n + 3) & ~3;
  let offset = 0;
  const posOff = offset;
  offset += align4(posBytes);
  const normOff = offset;
  offset += align4(normBytes);
  const idxOff = offset;
  offset += align4(idxBytes);
  const slotsOff = offset;
  offset += align4(slotsBytes);
  const groupTrisOff = offset;
  offset += align4(groupTrisBytes);
  const groupRangesOff = offset;
  offset += align4(groupRangesBytes);
  const floaterOff = offset;
  offset += align4(floaterBytes);
  const strayOff = offset;
  offset += align4(strayBytes);

  const base = wasm.mk_scratch_ensure(Math.max(32, offset));
  const mem = wasm.memory.buffer;
  new Float32Array(mem, base + posOff, input.positions.length).set(input.positions);
  new Float32Array(mem, base + normOff, input.normals.length).set(input.normals);
  new Uint32Array(mem, base + idxOff, input.indices.length).set(input.indices);
  new Int32Array(mem, base + slotsOff, input.slots.length).set(input.slots);
  new Uint32Array(mem, base + groupTrisOff, input.groupTris.length).set(input.groupTris);
  new Uint32Array(mem, base + groupRangesOff, input.groupRanges.length).set(input.groupRanges);
  new Uint8Array(mem, base + floaterOff, input.floater.length).set(input.floater);
  new Uint8Array(mem, base + strayOff, input.stray.length).set(input.stray);

  const rc = wasm.mk_bake_build_bvh_groups(
    base + posOff,
    input.positions.length,
    base + normOff,
    input.normals.length,
    base + idxOff,
    input.indices.length,
    base + slotsOff,
    input.slots.length,
    base + floaterOff,
    input.floater.length,
    base + strayOff,
    input.stray.length,
    base + groupTrisOff,
    input.groupTris.length,
    base + groupRangesOff,
    input.groupRanges.length,
  );
  if (rc !== 0) return undefined;

  const metaPtr = wasm.mk_scratch_ensure(32);
  if (wasm.mk_bake_bvh_meta(metaPtr) !== 0) {
    wasm.mk_bake_bvh_clear();
    return undefined;
  }
  const freshMem = wasm.memory.buffer;
  const meta = new Uint32Array(freshMem, metaPtr, 8);
  const nodesPtr = meta[0] ?? 0;
  const nodesLen = meta[1] ?? 0;
  const trisPtr = meta[2] ?? 0;
  const trisLen = meta[3] ?? 0;
  const triNormPtr = meta[4] ?? 0;
  const triNormLen = meta[5] ?? 0;
  const rootsPtr = meta[6] ?? 0;
  const rootsLen = meta[7] ?? 0;

  return {
    nodesU32: new Uint32Array(freshMem, nodesPtr, nodesLen),
    trisU32: new Uint32Array(freshMem, trisPtr, trisLen),
    triNormalsF32: new Float32Array(freshMem, triNormPtr, triNormLen),
    groupRootsI32: new Int32Array(freshMem, rootsPtr, rootsLen),
    release: () => {
      wasm.mk_bake_bvh_clear();
    },
  };
}

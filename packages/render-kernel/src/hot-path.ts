// Switchable ('ts' | 'wasm') zero-GC bulk numerical hot-path accelerator
// directly consumable by `@forgeax/engine-render` (world AABB + frustum cull + transparent sort).

import type { KernelBackendMode } from './contract.js';

export type { KernelBackendMode };

import {
  loadRenderKernelWasm,
  type RawWasmHotPathAccel,
  type WasmKernelModule,
} from './wasm-kernel.js';

export interface HotPathCullBuffers {
  readonly localAabbs: Float32Array;
  readonly worldMatrices: Float32Array;
  readonly flags: Uint32Array;
  readonly layerMasks: Uint32Array;
  readonly cameraVp: Float32Array;
}

export interface HotPathSortBuffers {
  readonly positions: Float32Array;
  readonly layers: Int32Array;
  readonly ties: Uint32Array;
}

export interface HotPathWorldAabbCullBuffers {
  readonly worldAabbs: Float32Array;
  readonly frustumPlanes: Float32Array;
}

export interface RenderKernelHotPath {
  readonly mode: KernelBackendMode;
  ensureCapacity(count: number): void;
  borrowCullBuffers(count: number): HotPathCullBuffers;
  runTransformAndCull(
    count: number,
    cameraLayerMask: number,
    shadowCasterOnly: boolean,
    writeWorldAabbs: boolean,
  ): Uint32Array;
  getComputedWorldAabbs(count: number): Float32Array;
  borrowWorldAabbCullBuffers(count: number, cameraCount: number): HotPathWorldAabbCullBuffers;
  /** Runs multi-camera frustum culling and returns the packed visibility bitmask (1 bit/row) and visible count. */
  runCullWorldAabbs(
    count: number,
    cameraCount: number,
  ): { readonly bits: Uint32Array; readonly visibleCount: number };
  borrowSortBuffers(count: number): HotPathSortBuffers;
  runSortTransparent(count: number, eyeX: number, eyeY: number, eyeZ: number): Uint32Array;
  dispose(): void;
}

const F32_S = new Float32Array(1);
const U32_S = new Uint32Array(F32_S.buffer);

export class TsHotPathAccel implements RenderKernelHotPath {
  readonly mode = 'ts' as const;
  private cap: number;
  private cameraCap = 8;
  private localAabbs: Float32Array;
  private worldMatrices: Float32Array;
  private flags: Uint32Array;
  private layerMasks: Uint32Array;
  private readonly cameraVp = new Float32Array(16);
  private readonly planes = new Float32Array(24);
  private outVisible: Uint32Array;
  private outWorldAabbs: Float32Array;
  private worldAabbs: Float32Array;
  private frustumPlanes: Float32Array;
  private outVisBits: Uint32Array;
  private sortPositions: Float32Array;
  private sortLayers: Int32Array;
  private sortTies: Uint32Array;
  private sortDistBits: Uint32Array;
  private outSortOrder: Uint32Array;
  private cullBuffersView: HotPathCullBuffers;
  private worldAabbCullView: HotPathWorldAabbCullBuffers;
  private sortBuffersView: HotPathSortBuffers;
  private readonly worldAabbResult: { bits: Uint32Array; visibleCount: number } = {
    bits: new Uint32Array(0),
    visibleCount: 0,
  };

  constructor(initialCapacity = 512) {
    this.cap = Math.max(256, initialCapacity);
    this.localAabbs = new Float32Array(this.cap * 6);
    this.worldMatrices = new Float32Array(this.cap * 16);
    this.flags = new Uint32Array(this.cap);
    this.layerMasks = new Uint32Array(this.cap);
    this.outVisible = new Uint32Array(this.cap);
    this.outWorldAabbs = new Float32Array(this.cap * 6);
    this.worldAabbs = new Float32Array(this.cap * 6);
    this.frustumPlanes = new Float32Array(this.cameraCap * 24);
    this.outVisBits = new Uint32Array(Math.ceil(this.cap / 32));
    this.sortPositions = new Float32Array(this.cap * 3);
    this.sortLayers = new Int32Array(this.cap);
    this.sortTies = new Uint32Array(this.cap);
    this.sortDistBits = new Uint32Array(this.cap);
    this.outSortOrder = new Uint32Array(this.cap);
    this.cullBuffersView = {
      localAabbs: this.localAabbs,
      worldMatrices: this.worldMatrices,
      flags: this.flags,
      layerMasks: this.layerMasks,
      cameraVp: this.cameraVp,
    };
    this.worldAabbCullView = {
      worldAabbs: this.worldAabbs,
      frustumPlanes: this.frustumPlanes,
    };
    this.sortBuffersView = {
      positions: this.sortPositions,
      layers: this.sortLayers,
      ties: this.sortTies,
    };
  }

  ensureCapacity(count: number): void {
    if (count <= this.cap) return;
    let next = this.cap;
    while (next < count) next *= 2;
    this.cap = next;
    this.localAabbs = new Float32Array(next * 6);
    this.worldMatrices = new Float32Array(next * 16);
    this.flags = new Uint32Array(next);
    this.layerMasks = new Uint32Array(next);
    this.outVisible = new Uint32Array(next);
    this.outWorldAabbs = new Float32Array(next * 6);
    this.worldAabbs = new Float32Array(next * 6);
    this.outVisBits = new Uint32Array(Math.ceil(next / 32));
    this.sortPositions = new Float32Array(next * 3);
    this.sortLayers = new Int32Array(next);
    this.sortTies = new Uint32Array(next);
    this.sortDistBits = new Uint32Array(next);
    this.outSortOrder = new Uint32Array(next);
    this.cullBuffersView = {
      localAabbs: this.localAabbs,
      worldMatrices: this.worldMatrices,
      flags: this.flags,
      layerMasks: this.layerMasks,
      cameraVp: this.cameraVp,
    };
    this.worldAabbCullView = {
      worldAabbs: this.worldAabbs,
      frustumPlanes: this.frustumPlanes,
    };
    this.sortBuffersView = {
      positions: this.sortPositions,
      layers: this.sortLayers,
      ties: this.sortTies,
    };
  }

  private ensureCameras(cameraCount: number): void {
    if (cameraCount <= this.cameraCap) return;
    let next = this.cameraCap;
    while (next < cameraCount) next *= 2;
    this.cameraCap = next;
    this.frustumPlanes = new Float32Array(next * 24);
    this.worldAabbCullView = {
      worldAabbs: this.worldAabbs,
      frustumPlanes: this.frustumPlanes,
    };
  }

  borrowCullBuffers(count: number): HotPathCullBuffers {
    this.ensureCapacity(count);
    return this.cullBuffersView;
  }

  borrowWorldAabbCullBuffers(count: number, cameraCount: number): HotPathWorldAabbCullBuffers {
    this.ensureCapacity(count);
    this.ensureCameras(cameraCount);
    return this.worldAabbCullView;
  }

  runCullWorldAabbs(
    count: number,
    cameraCount: number,
  ): { readonly bits: Uint32Array; readonly visibleCount: number } {
    this.ensureCapacity(count);
    this.ensureCameras(cameraCount);
    const words = Math.ceil(count / 32);
    const bits = this.outVisBits;
    bits.fill(0, 0, words);
    if (count === 0) {
      this.worldAabbResult.bits = bits;
      this.worldAabbResult.visibleCount = 0;
      return this.worldAabbResult;
    }
    if (cameraCount === 0) {
      for (let i = 0; i < count; i++) (bits[i >>> 5] as number) |= 1 << (i & 31);
      this.worldAabbResult.bits = bits;
      this.worldAabbResult.visibleCount = count;
      return this.worldAabbResult;
    }
    const aabbs = this.worldAabbs;
    const planes = this.frustumPlanes;
    let visibleCount = 0;
    for (let i = 0; i < count; i++) {
      const ab = i * 6;
      const bx = aabbs[ab] as number;
      const by = aabbs[ab + 1] as number;
      const bz = aabbs[ab + 2] as number;
      const bX = aabbs[ab + 3] as number;
      const bY = aabbs[ab + 4] as number;
      const bZ = aabbs[ab + 5] as number;
      let visible = false;
      for (let cam = 0; cam < cameraCount; cam++) {
        const base = cam * 24;
        let inside = true;
        for (let p = 0; p < 6; p++) {
          const off = base + p * 4;
          const nx = planes[off] as number;
          const ny = planes[off + 1] as number;
          const nz = planes[off + 2] as number;
          const d = planes[off + 3] as number;
          const px = nx >= 0 ? bX : bx;
          const py = ny >= 0 ? bY : by;
          const pz = nz >= 0 ? bZ : bz;
          if (nx * px + ny * py + nz * pz + d < 0) {
            inside = false;
            break;
          }
        }
        if (inside) {
          visible = true;
          break;
        }
      }
      if (visible) {
        (bits[i >>> 5] as number) |= 1 << (i & 31);
        visibleCount += 1;
      }
    }
    this.worldAabbResult.bits = bits;
    this.worldAabbResult.visibleCount = visibleCount;
    return this.worldAabbResult;
  }

  runTransformAndCull(
    count: number,
    cameraLayerMask: number,
    shadowCasterOnly: boolean,
    writeWorldAabbs: boolean,
  ): Uint32Array {
    const m = this.cameraVp;
    const p = this.planes;
    const setPlane = (i: number, x: number, y: number, z: number, w: number) => {
      const len = Math.hypot(x, y, z);
      const inv = len > 1e-12 ? 1 / len : 1;
      const b = i * 4;
      p[b] = x * inv;
      p[b + 1] = y * inv;
      p[b + 2] = z * inv;
      p[b + 3] = w * inv;
    };
    const r0x = m[0] as number,
      r0y = m[4] as number,
      r0z = m[8] as number,
      r0w = m[12] as number;
    const r1x = m[1] as number,
      r1y = m[5] as number,
      r1z = m[9] as number,
      r1w = m[13] as number;
    const r2x = m[2] as number,
      r2y = m[6] as number,
      r2z = m[10] as number,
      r2w = m[14] as number;
    const r3x = m[3] as number,
      r3y = m[7] as number,
      r3z = m[11] as number,
      r3w = m[15] as number;
    setPlane(0, r3x + r0x, r3y + r0y, r3z + r0z, r3w + r0w);
    setPlane(1, r3x - r0x, r3y - r0y, r3z - r0z, r3w - r0w);
    setPlane(2, r3x + r1x, r3y + r1y, r3z + r1z, r3w + r1w);
    setPlane(3, r3x - r1x, r3y - r1y, r3z - r1z, r3w - r1w);
    setPlane(4, r2x, r2y, r2z, r2w);
    setPlane(5, r3x - r2x, r3y - r2y, r3z - r2z, r3w - r2w);

    let outCount = 0;
    const la = this.localAabbs;
    const wm = this.worldMatrices;
    const oa = this.outWorldAabbs;
    for (let i = 0; i < count; i++) {
      const f = this.flags[i] as number;
      if ((f & 1) === 0) continue;
      if (((this.layerMasks[i] as number) & cameraLayerMask) === 0) continue;
      if (shadowCasterOnly && (f & 4) === 0) continue;
      const ab = i * 6;
      const mb = i * 16;
      const cx = ((la[ab] as number) + (la[ab + 3] as number)) * 0.5;
      const cy = ((la[ab + 1] as number) + (la[ab + 4] as number)) * 0.5;
      const cz = ((la[ab + 2] as number) + (la[ab + 5] as number)) * 0.5;
      const ex = ((la[ab + 3] as number) - (la[ab] as number)) * 0.5;
      const ey = ((la[ab + 4] as number) - (la[ab + 1] as number)) * 0.5;
      const ez = ((la[ab + 5] as number) - (la[ab + 2] as number)) * 0.5;
      const m0 = wm[mb] as number,
        m1 = wm[mb + 1] as number,
        m2 = wm[mb + 2] as number;
      const m4 = wm[mb + 4] as number,
        m5 = wm[mb + 5] as number,
        m6 = wm[mb + 6] as number;
      const m8 = wm[mb + 8] as number,
        m9 = wm[mb + 9] as number,
        m10 = wm[mb + 10] as number;
      const wcx = m0 * cx + m4 * cy + m8 * cz + (wm[mb + 12] as number);
      const wcy = m1 * cx + m5 * cy + m9 * cz + (wm[mb + 13] as number);
      const wcz = m2 * cx + m6 * cy + m10 * cz + (wm[mb + 14] as number);
      const wex = Math.abs(m0) * ex + Math.abs(m4) * ey + Math.abs(m8) * ez;
      const wey = Math.abs(m1) * ex + Math.abs(m5) * ey + Math.abs(m9) * ez;
      const wez = Math.abs(m2) * ex + Math.abs(m6) * ey + Math.abs(m10) * ez;
      const minX = wcx - wex,
        minY = wcy - wey,
        minZ = wcz - wez;
      const maxX = wcx + wex,
        maxY = wcy + wey,
        maxZ = wcz + wez;
      if (writeWorldAabbs) {
        oa[ab] = minX;
        oa[ab + 1] = minY;
        oa[ab + 2] = minZ;
        oa[ab + 3] = maxX;
        oa[ab + 4] = maxY;
        oa[ab + 5] = maxZ;
      }
      if ((f & 2) !== 0) {
        let vis = true;
        for (let k = 0; k < 6; k++) {
          const b = k * 4;
          const nx = p[b] as number,
            ny = p[b + 1] as number,
            nz = p[b + 2] as number,
            nw = p[b + 3] as number;
          if (
            nx * (nx >= 0 ? maxX : minX) +
              ny * (ny >= 0 ? maxY : minY) +
              nz * (nz >= 0 ? maxZ : minZ) +
              nw <
            0
          ) {
            vis = false;
            break;
          }
        }
        if (!vis) continue;
      }
      this.outVisible[outCount++] = i;
    }
    return this.outVisible.subarray(0, outCount);
  }

  getComputedWorldAabbs(count: number): Float32Array {
    return this.outWorldAabbs.subarray(0, count * 6);
  }

  borrowSortBuffers(count: number): HotPathSortBuffers {
    this.ensureCapacity(count);
    return this.sortBuffersView;
  }

  runSortTransparent(count: number, eyeX: number, eyeY: number, eyeZ: number): Uint32Array {
    for (let i = 0; i < count; i++) {
      const b = i * 3;
      const dx = (this.sortPositions[b] as number) - eyeX;
      const dy = (this.sortPositions[b + 1] as number) - eyeY;
      const dz = (this.sortPositions[b + 2] as number) - eyeZ;
      F32_S[0] = dx * dx + dy * dy + dz * dz;
      this.sortDistBits[i] = ~(U32_S[0] as number) >>> 0;
      this.outSortOrder[i] = i;
    }
    // Zero-allocation insertion/quicksort over index array matching Rust (layer, invDistBits, tie, index)
    const slice = this.outSortOrder.subarray(0, count);
    const layers = this.sortLayers;
    const dists = this.sortDistBits;
    const ties = this.sortTies;
    slice.sort((a, b) => {
      const dl = (layers[a] as number) - (layers[b] as number);
      if (dl !== 0) return dl;
      const dd = (dists[a] as number) - (dists[b] as number);
      if (dd !== 0) return dd;
      const dt = (ties[a] as number) - (ties[b] as number);
      if (dt !== 0) return dt;
      return a - b;
    });
    return slice;
  }

  dispose(): void {}
}

export class WasmHotPathAccel implements RenderKernelHotPath {
  readonly mode = 'wasm' as const;
  private readonly mod: WasmKernelModule;
  private readonly raw: RawWasmHotPathAccel;
  private cachedBuf: ArrayBuffer | undefined;
  private cachedCap = 0;
  private cachedCameraCap = 0;
  private cullView: HotPathCullBuffers | undefined;
  private worldAabbView: HotPathWorldAabbCullBuffers | undefined;
  private sortView: HotPathSortBuffers | undefined;
  private outVisibleView = new Uint32Array(0);
  private outWorldAabbsView = new Float32Array(0);
  private outVisBitsView = new Uint32Array(0);
  private outSortOrderView = new Uint32Array(0);
  private readonly worldAabbResult: { bits: Uint32Array; visibleCount: number } = {
    bits: new Uint32Array(0),
    visibleCount: 0,
  };

  constructor(mod: WasmKernelModule, initialCapacity = 512) {
    this.mod = mod;
    this.raw = new mod.WasmHotPathAccel(initialCapacity);
    this.cachedCap = Math.max(256, initialCapacity);
    this.cachedCameraCap = 8;
  }

  private mem(): ArrayBuffer {
    return this.mod.wasm_memory().buffer;
  }

  private syncViews(minCount: number, minCameras = 0): void {
    let grown = false;
    if (minCount > this.cachedCap) {
      this.raw.ensure_capacity(minCount);
      let next = this.cachedCap;
      while (next < minCount) next *= 2;
      this.cachedCap = next;
      grown = true;
    }
    if (minCameras > this.cachedCameraCap) {
      this.raw.ensure_frustum_cameras(minCameras);
      let next = this.cachedCameraCap;
      while (next < minCameras) next *= 2;
      this.cachedCameraCap = next;
      grown = true;
    }
    const buf = this.mem();
    if (!grown && this.cachedBuf === buf && this.cullView !== undefined) return;
    this.cachedBuf = buf;
    const cap = this.cachedCap;
    const camCap = this.cachedCameraCap;
    this.cullView = {
      localAabbs: new Float32Array(buf, this.raw.local_aabbs_ptr(), cap * 6),
      worldMatrices: new Float32Array(buf, this.raw.world_matrices_ptr(), cap * 16),
      flags: new Uint32Array(buf, this.raw.flags_ptr(), cap),
      layerMasks: new Uint32Array(buf, this.raw.layer_masks_ptr(), cap),
      cameraVp: new Float32Array(buf, this.raw.camera_vp_ptr(), 16),
    };
    this.worldAabbView = {
      worldAabbs: new Float32Array(buf, this.raw.world_aabbs_ptr(), cap * 6),
      frustumPlanes: new Float32Array(buf, this.raw.frustum_planes_ptr(), camCap * 24),
    };
    this.sortView = {
      positions: new Float32Array(buf, this.raw.sort_positions_ptr(), cap * 3),
      layers: new Int32Array(buf, this.raw.sort_layers_ptr(), cap),
      ties: new Uint32Array(buf, this.raw.sort_ties_ptr(), cap),
    };
    this.outVisibleView = new Uint32Array(buf, this.raw.out_visible_ptr(), cap);
    this.outWorldAabbsView = new Float32Array(buf, this.raw.out_world_aabbs_ptr(), cap * 6);
    this.outVisBitsView = new Uint32Array(buf, this.raw.out_vis_bits_ptr(), Math.ceil(cap / 32));
    this.outSortOrderView = new Uint32Array(buf, this.raw.out_sort_order_ptr(), cap);
  }

  ensureCapacity(count: number): void {
    this.syncViews(count);
  }

  borrowCullBuffers(count: number): HotPathCullBuffers {
    this.syncViews(count);
    return this.cullView as HotPathCullBuffers;
  }

  borrowWorldAabbCullBuffers(count: number, cameraCount: number): HotPathWorldAabbCullBuffers {
    this.syncViews(count, cameraCount);
    return this.worldAabbView as HotPathWorldAabbCullBuffers;
  }

  runCullWorldAabbs(
    count: number,
    cameraCount: number,
  ): { readonly bits: Uint32Array; readonly visibleCount: number } {
    this.syncViews(count, cameraCount);
    const visibleCount = this.raw.run_cull_world_aabbs(count, cameraCount);
    if (this.cachedBuf !== this.mem()) this.syncViews(count, cameraCount);
    this.worldAabbResult.bits = this.outVisBitsView;
    this.worldAabbResult.visibleCount = visibleCount;
    return this.worldAabbResult;
  }

  runTransformAndCull(
    count: number,
    cameraLayerMask: number,
    shadowCasterOnly: boolean,
    writeWorldAabbs: boolean,
  ): Uint32Array {
    this.syncViews(count);
    const outCount = this.raw.run_transform_and_cull(
      count,
      cameraLayerMask >>> 0,
      shadowCasterOnly,
      writeWorldAabbs,
    );
    if (this.cachedBuf !== this.mem()) this.syncViews(count);
    return this.outVisibleView.subarray(0, outCount);
  }

  getComputedWorldAabbs(count: number): Float32Array {
    if (this.cachedBuf !== this.mem()) this.syncViews(count);
    return this.outWorldAabbsView.subarray(0, count * 6);
  }

  borrowSortBuffers(count: number): HotPathSortBuffers {
    this.syncViews(count);
    return this.sortView as HotPathSortBuffers;
  }

  runSortTransparent(count: number, eyeX: number, eyeY: number, eyeZ: number): Uint32Array {
    this.syncViews(count);
    this.raw.run_sort_transparent(count, eyeX, eyeY, eyeZ);
    if (this.cachedBuf !== this.mem()) this.syncViews(count);
    return this.outSortOrderView.subarray(0, count);
  }

  dispose(): void {
    this.cachedBuf = undefined;
    this.cullView = undefined;
    this.worldAabbView = undefined;
    this.sortView = undefined;
    this.raw.free();
  }
}

export async function createRenderKernelHotPath(
  mode: KernelBackendMode | 'auto' = 'auto',
  initialCapacity = 512,
): Promise<RenderKernelHotPath> {
  if (mode === 'ts') return new TsHotPathAccel(initialCapacity);
  const wasm = await loadRenderKernelWasm();
  if (wasm.ok) return new WasmHotPathAccel(wasm.value, initialCapacity);
  return new TsHotPathAccel(initialCapacity);
}

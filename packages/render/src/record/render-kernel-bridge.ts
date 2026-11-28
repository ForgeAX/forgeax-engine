// Renderer-owned switchable TS / Rust-WASM RenderKernel bridge for `@forgeax/engine-render`.
//
// Owns the switchable `RenderKernelHotPath` (`'auto' | 'ts' | 'wasm'`) for bulk numerical
// hot paths (batch multi-camera AABB frustum culling and transparent draw sorting) with
// bounded scratch storage and clean disposal on `Renderer.dispose()`.

import {
  createRenderKernelHotPath,
  type KernelBackendMode,
  type RenderKernelHotPath,
  TsHotPathAccel,
} from '@forgeax/engine-render-kernel/hot-path';

export type RenderKernelSelection = 'auto' | KernelBackendMode;

export interface RenderKernelBridgeInspection {
  readonly requestedMode: RenderKernelSelection;
  readonly activeMode: KernelBackendMode;
  readonly wasmReady: boolean;
  readonly batchCullCalls: number;
  readonly batchCullCandidates: number;
  readonly sortCalls: number;
  readonly disposed: boolean;
}

export class RenderKernelBridge {
  readonly requestedMode: RenderKernelSelection;
  private activeHotPath: RenderKernelHotPath;
  private wasmHotPath: RenderKernelHotPath | undefined;
  private disposed = false;
  private batchCullCalls = 0;
  private batchCullCandidates = 0;
  private sortCalls = 0;

  private wasmUpgradeStarted = false;
  private readonly initialCapacity: number;

  constructor(requestedMode: RenderKernelSelection = 'auto', initialCapacity = 1024) {
    this.requestedMode = requestedMode;
    this.initialCapacity = initialCapacity;
    this.activeHotPath = new TsHotPathAccel(initialCapacity);
    if (requestedMode === 'wasm') {
      this.ensureWasmUpgrade();
    }
  }

  private ensureWasmUpgrade(): void {
    if (this.wasmUpgradeStarted || this.disposed || this.requestedMode === 'ts') return;
    this.wasmUpgradeStarted = true;
    void this.tryUpgradeToWasm(this.initialCapacity);
  }

  private async tryUpgradeToWasm(initialCapacity: number): Promise<void> {
    try {
      const accel = await createRenderKernelHotPath('wasm', initialCapacity);
      if (this.disposed) {
        accel.dispose();
        return;
      }
      if (accel.mode !== 'wasm') {
        accel.dispose();
        return;
      }
      this.activeHotPath.dispose();
      this.wasmHotPath = accel;
      this.activeHotPath = accel;
    } catch {
      // Keep the pure-TS accelerator when WASM is unavailable in this environment.
    }
  }

  get hotPath(): RenderKernelHotPath {
    return this.activeHotPath;
  }

  get activeMode(): KernelBackendMode {
    return this.activeHotPath.mode;
  }

  get wasmReady(): boolean {
    return this.wasmHotPath !== undefined;
  }

  /**
   * Batch-culls `count` pre-computed world AABBs against `cameraPlanes` (each 24 floats =
   * 6 planes x 4 floats) using the active TS or Rust-WASM hot-path accelerator.
   */
  cullWorldAabbs(
    count: number,
    cameraPlanes: readonly Float32Array[],
    fillWorldAabbs: (dstAabbs: Float32Array) => void,
  ): { readonly bits: Uint32Array; readonly visibleCount: number } {
    this.ensureWasmUpgrade();
    const camCount = cameraPlanes.length;
    const buffers = this.activeHotPath.borrowWorldAabbCullBuffers(count, camCount);
    const dstPlanes = buffers.frustumPlanes;
    for (let c = 0; c < camCount; c++) {
      const planes = cameraPlanes[c];
      if (planes !== undefined) {
        dstPlanes.set(planes, c * 24);
      }
    }
    fillWorldAabbs(buffers.worldAabbs);
    this.batchCullCalls += 1;
    this.batchCullCandidates += count;
    return this.activeHotPath.runCullWorldAabbs(count, camCount);
  }

  /** Batch-sorts transparent draw entries back-to-front by `(layer ASC, distSq DESC, tie ASC)`. */
  sortTransparentIndices(
    count: number,
    eyeX: number,
    eyeY: number,
    eyeZ: number,
    fill: (positions: Float32Array, layers: Int32Array, ties: Uint32Array) => void,
  ): Uint32Array {
    this.ensureWasmUpgrade();
    const buffers = this.activeHotPath.borrowSortBuffers(count);
    fill(buffers.positions, buffers.layers, buffers.ties);
    this.sortCalls += 1;
    return this.activeHotPath.runSortTransparent(count, eyeX, eyeY, eyeZ);
  }

  inspect(): RenderKernelBridgeInspection {
    return {
      requestedMode: this.requestedMode,
      activeMode: this.activeHotPath.mode,
      wasmReady: this.wasmHotPath !== undefined,
      batchCullCalls: this.batchCullCalls,
      batchCullCandidates: this.batchCullCandidates,
      sortCalls: this.sortCalls,
      disposed: this.disposed,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.activeHotPath.dispose();
    this.wasmHotPath = undefined;
  }
}

export function createRenderKernelBridge(
  requestedMode?: RenderKernelSelection,
  initialCapacity = 1024,
): RenderKernelBridge {
  return new RenderKernelBridge(requestedMode ?? 'auto', initialCapacity);
}

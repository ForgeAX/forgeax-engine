// @forgeax/engine-debug-draw -- CPU staging of immediate-mode line geometry.
//
// `DebugDrawSource` owns the shape API and the per-frame vertex batch with no GPU
// object. A Renderer calls `take()` once per frame and owns the upload; the
// low-path `DebugDraw` extends it with its own buffers.

import type { ColorLike, Mat4, Vec3 } from '@forgeax/engine-math';
import { INITIAL_VERTEX_CAPACITY, MAX_VERTEX_CAPACITY, VERTEX_STRIDE_BYTES } from './constants';
import { DEBUG_OVERLAY_SHADER } from './shader';
import { aabbVertices } from './shapes/aabb';
import { arrowVertices } from './shapes/arrow';
import { axesArrowSets } from './shapes/axes';
import { frustumVertices } from './shapes/frustum';
import { lineVertices } from './shapes/line';
import { sphereVertices } from './shapes/sphere';
import type { DebugDrawShapes } from './types';

/** Access Vec3/Mat4/ColorLike array element, narrow via `as number`. */
function at(a: { readonly [index: number]: number }, i: number): number {
  return a[i] as number;
}

export function normalizeCapacity(value: number, fallback: number): number {
  const finiteValue = Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(1, finiteValue);
}

/** One frame's staged vertices as the Renderer uploads them. */
export interface DebugOverlayBatch {
  /** `vertexCount` vertices of {@link VERTEX_STRIDE_BYTES}; valid until the next shape call. */
  readonly bytes: Uint8Array;
  readonly vertexCount: number;
  /** Vertices beyond the hard capacity were discarded this frame. */
  readonly truncated: boolean;
}

export interface DebugDrawSourceOptions {
  readonly initialVertexCapacity?: number | undefined;
  readonly maxVertexCapacity?: number | undefined;
}

export class DebugDrawSource implements DebugDrawShapes {
  /** The WGSL program and vertex layout a Renderer compiles for this batch format. */
  readonly shader = DEBUG_OVERLAY_SHADER;

  protected stagingArr: Float32Array;
  protected stagingLen = 0;
  protected capVal: number;
  protected maxCapVal: number;
  protected live = true;

  // Hard-cap diagnostics are per frame: take() clears this flag with staging.
  protected truncationWarned = false;

  private destroyedWarnedOnce = false;

  constructor(
    initialCapacity: number = INITIAL_VERTEX_CAPACITY,
    maxCapacity: number = MAX_VERTEX_CAPACITY,
  ) {
    this.maxCapVal = normalizeCapacity(maxCapacity, MAX_VERTEX_CAPACITY);
    this.capVal = Math.min(
      normalizeCapacity(initialCapacity, INITIAL_VERTEX_CAPACITY),
      this.maxCapVal,
    );
    this.stagingArr = new Float32Array(this.capVal * (VERTEX_STRIDE_BYTES / 4));
  }

  /** @internal CPU staging vertex count (exposed for unit tests). */
  get _stagingVertexCount(): number {
    return this.stagingLen;
  }

  /** @internal Current vertex capacity. */
  get _capacity(): number {
    return this.capVal;
  }

  /** @internal Whether destroy() has been called. */
  get _destroyed(): boolean {
    return !this.live;
  }

  /** @internal Read position of vertex at `index` in CPU staging (for unit tests). */
  _getVertexPosition(index: number): [number, number, number] {
    const idx = index * 4;
    return [
      this.stagingArr[idx + 0] as number,
      this.stagingArr[idx + 1] as number,
      this.stagingArr[idx + 2] as number,
    ];
  }

  /** @internal Read color of vertex at `index` as packed u32 (for unit tests). */
  _getVertexPackedColor(index: number): number {
    const byteOff = index * VERTEX_STRIDE_BYTES + 12;
    const bytes = new Uint8Array(this.stagingArr.buffer, byteOff, 4);
    return (
      ((bytes[3] as number) << 24) |
      ((bytes[2] as number) << 16) |
      ((bytes[1] as number) << 8) |
      (bytes[0] as number)
    );
  }

  /**
   * Hand this frame's staged vertices to the caller and start the next frame empty.
   * Returns null when nothing was staged.
   */
  take(): DebugOverlayBatch | null {
    if (!this.live || this.stagingLen === 0) return null;
    const vertexCount = Math.min(this.stagingLen, this.maxCapVal);
    const batch: DebugOverlayBatch = {
      bytes: new Uint8Array(this.stagingArr.buffer, 0, vertexCount * VERTEX_STRIDE_BYTES),
      vertexCount,
      truncated: this.truncationWarned,
    };
    this.stagingLen = 0;
    this.truncationWarned = false;
    return batch;
  }

  /**
   * Drop this frame's staged vertices. A frame that never reaches a Renderer
   * (update-only step) owns its geometry no longer than the frame itself.
   */
  discard(): void {
    this.stagingLen = 0;
    this.truncationWarned = false;
  }

  /** Release staging. Subsequent shape calls are no-ops. */
  destroy(): void {
    this.live = false;
    this.stagingArr = new Float32Array(0);
    this.stagingLen = 0;
  }

  /**
   * Make room for a larger vertex capacity in a subclass-owned resource. False
   * keeps the current capacity, so the draw stays bounded and truncated.
   */
  protected growResources(_newCapacity: number): boolean {
    return true;
  }

  private postDestroyWarnOnce(): void {
    if (!this.destroyedWarnedOnce) {
      this.destroyedWarnedOnce = true;
      console.warn(
        '[DebugDraw] Shape call after destroy() is a no-op. ' +
          'Create a new instance via createDebugDraw().',
      );
    }
  }

  private pushVertex(
    px: number,
    py: number,
    pz: number,
    rc: number,
    gc: number,
    bc: number,
    ac: number,
  ): void {
    // Truncation: silently drop vertices above max cap (warned once in ensureCapacity)
    if (this.stagingLen >= this.maxCapVal) return;

    const idx = this.stagingLen * 4; // 4 f32s per vertex (stride=16B)
    this.stagingArr[idx + 0] = px;
    this.stagingArr[idx + 1] = py;
    this.stagingArr[idx + 2] = pz;

    // Write RGBA as u8 bytes via Uint8Array view (Float32Array would
    // corrupt u32 bit-patterns via f32 conversion; the GPU reads raw bytes).
    const byteOff = this.stagingLen * VERTEX_STRIDE_BYTES + 12;
    const colorView = new Uint8Array(this.stagingArr.buffer, byteOff, 4);
    colorView[0] = Math.round(Math.max(0, Math.min(1, rc)) * 255);
    colorView[1] = Math.round(Math.max(0, Math.min(1, gc)) * 255);
    colorView[2] = Math.round(Math.max(0, Math.min(1, bc)) * 255);
    colorView[3] = Math.round(Math.max(0, Math.min(1, ac)) * 255);

    this.stagingLen++;
  }

  private warnTruncationOnce(): void {
    if (this.truncationWarned) return;
    this.truncationWarned = true;
    console.warn(
      `[DebugDraw] Vertex count would exceed MAX_VERTEX_CAPACITY=${this.maxCapVal}; ` +
        'vertices beyond the limit are discarded.',
    );
  }

  private ensureCapacity(needed: number): void {
    if (needed <= this.capVal) return;

    // Warn for hard-cap truncation once for this frame, before any vertex drops.
    if (needed > this.maxCapVal) this.warnTruncationOnce();

    // Double up to max cap
    let newCap = this.capVal;
    while (newCap < needed && newCap < this.maxCapVal) {
      newCap = Math.min(newCap * 2, this.maxCapVal);
    }
    if (newCap <= this.capVal || !this.growResources(newCap)) return;

    this.capVal = newCap;
    const newStaging = new Float32Array(newCap * (VERTEX_STRIDE_BYTES / 4));
    newStaging.set(this.stagingArr.subarray(0, this.stagingLen * 4));
    this.stagingArr = newStaging;
  }

  private colorToRGBA(color: ColorLike): [number, number, number, number] {
    if (Array.isArray(color)) {
      return [at(color, 0), at(color, 1), at(color, 2), (color as number[])[3] ?? 1];
    }
    // Float32Array (branded Color or plain)
    return [at(color, 0), at(color, 1), at(color, 2), color[3] ?? 1];
  }

  private stage(vertices: readonly (readonly [number, number, number])[], color: ColorLike): void {
    const [r, g, bc, alpha] = this.colorToRGBA(color);
    this.ensureCapacity(this.stagingLen + vertices.length);
    for (const [x, y, z] of vertices) this.pushVertex(x, y, z, r, g, bc, alpha);
  }

  // -- Public shape API --

  line(a: Vec3, b: Vec3, color: ColorLike): void {
    if (!this.live) {
      this.postDestroyWarnOnce();
      return;
    }
    this.stage(lineVertices(a, b), color);
  }

  aabb(min: Vec3, max: Vec3, color: ColorLike): void {
    if (!this.live) {
      this.postDestroyWarnOnce();
      return;
    }
    this.stage(aabbVertices(min, max), color);
  }

  sphere(center: Vec3, radius: number, color: ColorLike, segments = 16): void {
    if (!this.live) {
      this.postDestroyWarnOnce();
      return;
    }
    this.stage(sphereVertices(center, radius, segments), color);
  }

  frustum(viewProj: Mat4, color: ColorLike): void {
    if (!this.live) {
      this.postDestroyWarnOnce();
      return;
    }
    const verts = frustumVertices(viewProj);
    if (verts === null) {
      console.warn(
        '[DebugDraw] frustum() received a near-singular viewProj matrix; skipping this frame.',
      );
      return;
    }
    this.stage(verts, color);
  }

  arrow(start: Vec3, end: Vec3, color: ColorLike, tipLength?: number): void {
    if (!this.live) {
      this.postDestroyWarnOnce();
      return;
    }
    this.stage(arrowVertices(start, end, tipLength), color);
  }

  axes(worldMat: Mat4, length: number): void {
    if (!this.live) {
      this.postDestroyWarnOnce();
      return;
    }
    // Three arrows (X=red, Y=green, Z=blue) along the transform's local axes; each
    // carries its own color.
    for (const { vertices, color } of axesArrowSets(worldMat, length)) {
      this.stage(vertices, color as unknown as ColorLike);
    }
  }
}

/** Create a CPU-only debug-draw source for a Renderer to consume. */
export function createDebugDrawSource(options: DebugDrawSourceOptions = {}): DebugDrawSource {
  return new DebugDrawSource(options.initialVertexCapacity, options.maxVertexCapacity);
}

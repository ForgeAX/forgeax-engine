// @forgeax/engine-debug-draw -- public types + factory signature (M1 / w4)
//
// Decision anchors:
// - plan-strategy D-1: shape generation stays on rhi/math/types; the optional
//   RenderFeature adapter depends only on the declarative render contract.
// - plan-strategy D-2: depthMode single-instance single-PSO, no runtime switching
// - plan-strategy D-4 / D-9: vertex stride 16 B, capacities configurable
// - plan-strategy D-6: shape color = ColorLike (consumes engine-math existing type)
// - OOS-9: single-instance single-mode; two modes in one frame = two instances
//
// The DebugDraw interface is declared here as a type-only contract; its
// implementation lands in M2 (debug-draw.ts).

import type { ColorLike, Mat4, Vec3 } from '@forgeax/engine-math';
import type {
  RhiCommandEncoder,
  RhiDevice,
  RhiError,
  RhiQueue,
  RhiRenderPassEncoder,
  ShaderModule,
  TextureFormat,
  TextureView,
} from '@forgeax/engine-rhi';
import type { Result } from '@forgeax/engine-types';
import type { DebugDrawError } from './errors';

/**
 * Async shader-module factory matching `createShaderModule(device, desc)`.
 * Injected so the debug-draw package stays dependency-free of rhi-webgpu.
 */
export type CreateShaderModule = (
  device: RhiDevice,
  desc: { readonly label?: string | undefined; readonly code: string },
) => Promise<Result<ShaderModule, RhiError>>;

/** Depth comparison mode for the single-PSO line-list overlay. */
export type DepthMode = 'always' | 'less-equal';

/** Configuration passed to {@link createDebugDraw}. */
export interface DebugDrawOptions {
  /** RHI device for buffer + PSO creation. */
  readonly device: RhiDevice;
  /** RHI queue for `queue.writeBuffer` per-frame uploads. */
  readonly queue: RhiQueue;
  /**
   * Async WGSL shader-module factory.
   * Required; pass `createShaderModule` from `@forgeax/engine-rhi-webgpu`.
   * This callback lives in options (not a package dependency) to keep the
   * debug-draw package clean of concrete backend imports (plan-strategy D-1).
   */
  readonly createShaderModule: CreateShaderModule;
  /**
   * Swap-chain color target format.
   * Defaults to `'bgra8unorm'` when omitted.
   */
  readonly format?: TextureFormat | undefined;
  /**
   * Depth-stencil attachment format.
   * Required when `depthMode === 'less-equal'`.
   */
  readonly depthFormat?: TextureFormat | undefined;
  /**
   * Initial vertex buffer capacity in vertex count.
   * Defaults to {@link INITIAL_VERTEX_CAPACITY} (1024).
   */
  readonly initialVertexCapacity?: number | undefined;
  /**
   * Hard upper bound on vertex count per flush.
   * Defaults to {@link MAX_VERTEX_CAPACITY} (1_000_000). Excess vertices are
   * discarded with one bounded warning per frame; a successful flush resets the
   * diagnostic and staging for the next frame.
   */
  readonly maxVertexCapacity?: number | undefined;
  /**
   * Depth comparison mode for the overlay PSO.
   * `'always'` draws on top of everything; `'less-equal'` respects scene depth.
   * Defaults to `'always'`.
   */
  readonly depthMode?: DepthMode | undefined;
}

/**
 * Immediate-mode debug-draw instance.
 *
 * Shape calls (line / sphere / aabb / frustum) append vertices to a CPU staging
 * buffer. `flush(encoder, view, viewProj)` uploads staging to a GPU vertex buffer
 * and issues a single `draw` call with line-list topology.
 *
 * After `destroy()`, shape calls are no-ops (with a single console.warn) and
 * `flush()` returns `Result.err({ code: 'flushed-after-destroy' })`.
 */
export interface DebugDraw {
  /** Whether this frame has staged line vertices waiting to be encoded. */
  hasWork(): boolean;

  /** Push a line segment from `a` to `b` with the given color. */
  line(a: Vec3, b: Vec3, color: ColorLike): void;

  /** Push a wireframe axis-aligned bounding box (12 edges = 24 vertices). */
  aabb(min: Vec3, max: Vec3, color: ColorLike): void;

  /**
   * Push a wireframe sphere as 3 orthogonal great-circle rings.
   * `segments` defaults to 16, producing 96 vertices (3 * 2 * 16).
   */
  sphere(center: Vec3, radius: number, color: ColorLike, segments?: number): void;

  /**
   * Push a wireframe frustum (12 edges = 24 vertices) derived from
   * the given view-projection matrix.
   */
  frustum(viewProj: Mat4, color: ColorLike): void;

  /**
   * Push an arrow (body line + 4-line arrowhead = 10 vertices) from `start` to `end`.
   * `tipLength` defaults to `|end - start| / 10` (Bevy's default). A zero-length arrow
   * emits only the body segment. Maps Bevy `gizmos.arrow`.
   */
  arrow(start: Vec3, end: Vec3, color: ColorLike, tipLength?: number): void;

  /**
   * Push a transform's local coordinate frame as three colored arrows — X=red, Y=green,
   * Z=blue — originating at the transform's translation and pointing `length` along its
   * local X/Y/Z (the columns of the 16-float column-major `worldMat`, scale included).
   * Maps Bevy `gizmos.axes(transform, length)`.
   */
  axes(worldMat: Mat4, length: number): void;

  /**
   * Upload CPU staging to GPU vertex buffer, issue a single draw call,
   * and reset staging for the next frame.
   *
   * `viewProj` is required; omitting it returns
   * `Result.err({ code: 'viewProj-required' })`.
   */
  flush(
    encoder: RhiCommandEncoder,
    view: TextureView,
    viewProj: Mat4,
  ): Result<void, DebugDrawError>;

  /**
   * Encode into a render pass whose attachments and lifetime are owned by the caller.
   * `colorFormat` names that pass's color attachment; omitted means the creation `format`.
   */
  encode(
    pass: RhiRenderPassEncoder,
    viewProj: Mat4,
    colorFormat?: TextureFormat,
  ): Result<void, DebugDrawError>;

  /** Release GPU buffer + PSO. Subsequent shape calls are no-ops. */
  destroy(): void;
}

/**
 * Create an immediate-mode debug-draw instance.
 *
 * Async because GPU shader module compilation (createShaderModule)
 * must be awaited. Returns Promise<Result<DebugDraw, DebugDrawError>>.
 *
 * @example Low-path usage
 * ```ts
 * const r = await createDebugDraw({ device, queue });
 * if (!r.ok) { ... }
 * const dd = r.value;
 * dd.line(a, b, [1, 0, 0, 1]);
 * dd.flush(encoder, swapChainView, cameraViewProj);
 * ```
 *
 * @example With less-equal depth testing
 * ```ts
 * const dd = await createDebugDraw({
 *   device, queue,
 *   format: 'bgra8unorm',
 *   depthFormat: 'depth24plus',
 *   depthMode: 'less-equal',
 * });
 * ```
 */
export type CreateDebugDraw = (
  opts: DebugDrawOptions,
) => Promise<Result<DebugDraw, DebugDrawError>>;

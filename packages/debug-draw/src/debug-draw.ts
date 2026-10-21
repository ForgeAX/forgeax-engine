// @forgeax/engine-debug-draw -- DebugDraw class implementation (feat-20260615-debug-draw M2)
//
// This file is the single SSOT for DebugDraw class, GPU resource lifecycle,
// flush, and destroy semantics.
//
// Decision anchors:
// - plan-strategy D-2: depthMode single-instance single-PSO
// - plan-strategy D-3: inline WGSL, direct RHI (no ShaderRegistry)
// - plan-strategy D-4: queue.writeBuffer overwrite + double-resize + hard-cap truncate
// - plan-strategy D-9: vertex stride 16 B (12 B position + 4 B color)
// - plan-strategy D-11: destroy-after-shape = no-op + single warn

import type { ColorLike, Mat4, Vec3 } from '@forgeax/engine-math';
import type {
  BindGroup,
  Buffer,
  RenderPassDescriptor,
  RenderPipeline,
  RenderPipelineDescriptor,
  RhiCommandEncoder,
  RhiDevice,
  RhiRenderPassEncoder,
  TextureFormat,
  TextureView,
} from '@forgeax/engine-rhi';
import type { Result } from '@forgeax/engine-types';
import { ok } from '@forgeax/engine-types';
import { INITIAL_VERTEX_CAPACITY, MAX_VERTEX_CAPACITY, VERTEX_STRIDE_BYTES } from './constants';
import type { DebugDrawError } from './errors';
import {
  bufferAllocationFailed,
  flushedAfterDestroy,
  pipelineCreateFailed,
  viewProjRequired,
} from './errors';
import { aabbVertices } from './shapes/aabb';
import { arrowVertices } from './shapes/arrow';
import { axesArrowSets } from './shapes/axes';
import { frustumVertices } from './shapes/frustum';
import { lineVertices } from './shapes/line';
import { sphereVertices } from './shapes/sphere';
import type { DebugDraw as DebugDrawInterface, DebugDrawOptions } from './types';

// ==========================================================================
// Inline WGSL (plan-strategy D-3: no ShaderRegistry dependency)
// ==========================================================================

const VERTEX_SHADER = /* wgsl */ `
struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) color: vec4<f32>,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
}

struct Uniforms {
  viewProj: mat4x4<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  out.position = uniforms.viewProj * vec4<f32>(in.position, 1.0);
  out.color = in.color;
  return out;
}
`;

const FRAGMENT_SHADER = /* wgsl */ `
struct FragmentInput {
  @location(0) color: vec4<f32>,
}

@fragment
fn fs_main(in: FragmentInput) -> @location(0) vec4<f32> {
  return in.color;
}
`;

// ==========================================================================
// Internal helpers
// ==========================================================================

/** Access Vec3/Mat4/ColorLike array element, narrow via `as number`. */
function at(a: { readonly [index: number]: number }, i: number): number {
  return a[i] as number;
}

/** Creates the overlay PSO for one color-attachment format from the shared modules/layout. */
export interface DebugDrawPipelineSource {
  readonly format: TextureFormat;
  create(format: TextureFormat): Result<RenderPipeline, DebugDrawError>;
}

function normalizeCapacity(value: number, fallback: number): number {
  const finiteValue = Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(1, finiteValue);
}

// ==========================================================================
// DebugDraw (w12 / w13 / w14)
// ==========================================================================

interface DebugDrawResources {
  vbo: Buffer;
  readonly uniformBuffer: Buffer;
  readonly bindGroup: BindGroup;
  readonly pipeline: RenderPipeline;
}

export class DebugDraw implements DebugDrawInterface {
  private stagingArr: Float32Array;
  private stagingLen = 0;

  private lastFlushedVertexCount = 0;

  private capVal: number;

  private resources: DebugDrawResources | undefined;

  // Graph targets can differ from the creation format (e.g. rgba16float post input on
  // raw-only WebGL2 surfaces), so encode() resolves one PSO per attachment format.
  private readonly pipelineSource: DebugDrawPipelineSource | undefined;

  private readonly pipelinesByFormat = new Map<TextureFormat, RenderPipeline>();

  private maxCapVal: number;

  private readonly rhiDevice: RhiDevice;

  // Whether the destroy-after-shape warning has been emitted (plan-strategy D-11).
  // private (no underscore, no @internal) — purely class-internal state, not part of
  // package-internal API surface. Biome R-internal-A forbids `_x` on private fields;
  // lint:internal R-internal-C requires `_x` for `@internal`. Drop both markers since
  // there is no package-internal use for this field — accessing it from outside the
  // class is meaningless.
  private destroyedWarnedOnce = false;

  // Hard-cap diagnostics are per frame: flush() clears this flag with staging.
  private truncationWarned = false;

  /**
   * Depth texture view for less-equal depth mode.
   * Set via {@link _setDepthView} before flush() when depthMode is 'less-equal'.
   * The runtime auto-attach path receives depth from the render-graph context;
   * low-path callers (test harnesses, smoke runners) set this explicitly.
   */
  private depthView: TextureView | null = null;

  constructor(
    device: RhiDevice,
    pipeline: RenderPipeline,
    vbo: Buffer,
    uniformBuffer: Buffer,
    bindGroup: BindGroup,
    initialCapacity: number,
    maxCapacity: number,
    pipelineSource?: DebugDrawPipelineSource,
  ) {
    const boundedMaxCapacity = normalizeCapacity(maxCapacity, MAX_VERTEX_CAPACITY);
    const boundedInitialCapacity = Math.min(
      normalizeCapacity(initialCapacity, INITIAL_VERTEX_CAPACITY),
      boundedMaxCapacity,
    );
    this.rhiDevice = device;
    this.resources = { vbo, uniformBuffer, bindGroup, pipeline };
    this.pipelineSource = pipelineSource;
    if (pipelineSource !== undefined) this.pipelinesByFormat.set(pipelineSource.format, pipeline);
    this.capVal = boundedInitialCapacity;
    this.maxCapVal = boundedMaxCapacity;
    this.stagingArr = new Float32Array(boundedInitialCapacity * (VERTEX_STRIDE_BYTES / 4));
  }

  /** @internal CPU staging vertex count (exposed for unit tests). */
  get _stagingVertexCount(): number {
    return this.stagingLen;
  }

  /** @internal Vertex count passed to the most recent non-empty draw call. */
  get _lastFlushVertexCount(): number {
    return this.lastFlushedVertexCount;
  }

  /** @internal Current GPU vertex buffer capacity in vertex count. */
  get _capacity(): number {
    return this.capVal;
  }

  hasWork(): boolean {
    return this.resources !== undefined && this.stagingLen > 0;
  }

  /** @internal Whether destroy() has been called. */
  get _destroyed(): boolean {
    return this.resources === undefined;
  }

  /**
   * @internal Set the depth texture view for less-equal depth mode.
   * Required before flush() when depthMode is 'less-equal'.
   * Used by test harnesses and smoke runners that don't have a scene
   * depth buffer; the runtime auto-attach path receives depth from
   * the render-graph context.
   */
  _setDepthView(view: TextureView): void {
    this.depthView = view;
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
    if (this.resources === undefined) {
      this.postDestroyWarnOnce();
      return;
    }

    // Truncation: silently drop vertices above max cap (warned once in ensureCapacity)
    if (this.stagingLen >= this.maxCapVal) return;

    const idx = this.stagingLen * 4; // 4 f32s per vertex (stride=16B)
    this.stagingArr[idx + 0] = px;
    this.stagingArr[idx + 1] = py;
    this.stagingArr[idx + 2] = pz;

    // Write RGBA as u8 bytes via Uint8Array view (Float32Array would
    // corrupt u32 bit-patterns via f32 conversion; the GPU reads raw bytes).
    const u8r = Math.round(Math.max(0, Math.min(1, rc)) * 255);
    const u8g = Math.round(Math.max(0, Math.min(1, gc)) * 255);
    const u8bc = Math.round(Math.max(0, Math.min(1, bc)) * 255);
    const u8a = Math.round(Math.max(0, Math.min(1, ac)) * 255);
    const byteOff = this.stagingLen * VERTEX_STRIDE_BYTES + 12;
    const colorView = new Uint8Array(this.stagingArr.buffer, byteOff, 4);
    colorView[0] = u8r;
    colorView[1] = u8g;
    colorView[2] = u8bc;
    colorView[3] = u8a;

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
    const resources = this.resources;
    if (resources === undefined) return;
    if (needed <= this.capVal) return;

    // Warn for hard-cap truncation once for this frame, before any vertex drops.
    if (needed > this.maxCapVal) {
      this.warnTruncationOnce();
    }

    // Double up to max cap
    let newCap = this.capVal;
    while (newCap < needed && newCap < this.maxCapVal) {
      newCap = Math.min(newCap * 2, this.maxCapVal);
    }

    if (newCap > this.capVal) {
      // Bug B fix (feat-20260626 m6-4): the GPU vertex buffer must grow with the
      // CPU staging, or flush() binds a buffer too small for the staged vertex
      // count and the backend rejects the draw ("Vertex range requires a larger
      // buffer than the bound buffer size"). This was latent until the overlay
      // pass actually flushed -- before the glue merge the pass was a no-op stub,
      // so the GPU vbo was never bound past its initial size. Reallocate at the
      // new size + destroy the old; on alloc failure keep the old cap (the draw
      // stays bounded + correct, just truncated) rather than growing the staging
      // past the GPU buffer.
      const newVbo = this.rhiDevice.createBuffer({
        size: newCap * VERTEX_STRIDE_BYTES,
        usage: 8 | 32, // COPY_DST | VERTEX (mirrors createDebugDraw factory)
        label: 'debug-draw-vbo',
      });
      if (!newVbo.ok) {
        console.warn(
          `[DebugDraw] GPU vertex buffer grow to ${newCap} failed (${newVbo.error.code}); ` +
            `keeping ${this.capVal} -- excess vertices are truncated this frame.`,
        );
        return;
      }
      console.warn(`[DebugDraw] Resizing vertex buffer from ${this.capVal} to ${newCap} vertices.`);
      this.rhiDevice.destroyBuffer(resources.vbo);
      resources.vbo = newVbo.value;
      this.capVal = newCap;
      const newStaging = new Float32Array(newCap * (VERTEX_STRIDE_BYTES / 4));
      newStaging.set(this.stagingArr.subarray(0, this.stagingLen * 4));
      this.stagingArr = newStaging;
    }
  }

  private colorToRGBA(color: ColorLike): [number, number, number, number] {
    if (Array.isArray(color)) {
      return [at(color, 0), at(color, 1), at(color, 2), (color as number[])[3] ?? 1];
    }
    // Float32Array (branded Color or plain)
    return [at(color, 0), at(color, 1), at(color, 2), color[3] ?? 1];
  }

  // -- Public shape API --

  line(a: Vec3, b: Vec3, color: ColorLike): void {
    if (this.resources === undefined) {
      this.postDestroyWarnOnce();
      return;
    }
    const [r, g, bc, alpha] = this.colorToRGBA(color);
    this.ensureCapacity(this.stagingLen + 2);
    for (const [x, y, z] of lineVertices(a, b)) {
      this.pushVertex(x, y, z, r, g, bc, alpha);
    }
  }

  aabb(min: Vec3, max: Vec3, color: ColorLike): void {
    if (this.resources === undefined) {
      this.postDestroyWarnOnce();
      return;
    }
    const [r, g, bc, alpha] = this.colorToRGBA(color);
    const verts = aabbVertices(min, max);
    this.ensureCapacity(this.stagingLen + verts.length);
    for (const [x, y, z] of verts) {
      this.pushVertex(x, y, z, r, g, bc, alpha);
    }
  }

  sphere(center: Vec3, radius: number, color: ColorLike, segments = 16): void {
    if (this.resources === undefined) {
      this.postDestroyWarnOnce();
      return;
    }
    const [r, g, bc, alpha] = this.colorToRGBA(color);
    const verts = sphereVertices(center, radius, segments);
    this.ensureCapacity(this.stagingLen + verts.length);
    for (const [x, y, z] of verts) {
      this.pushVertex(x, y, z, r, g, bc, alpha);
    }
  }

  frustum(viewProj: Mat4, color: ColorLike): void {
    if (this.resources === undefined) {
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
    const [r, g, bc, alpha] = this.colorToRGBA(color);
    this.ensureCapacity(this.stagingLen + verts.length);
    for (const [x, y, z] of verts) {
      this.pushVertex(x, y, z, r, g, bc, alpha);
    }
  }

  arrow(start: Vec3, end: Vec3, color: ColorLike, tipLength?: number): void {
    if (this.resources === undefined) {
      this.postDestroyWarnOnce();
      return;
    }
    const [r, g, bc, alpha] = this.colorToRGBA(color);
    const verts = arrowVertices(start, end, tipLength);
    this.ensureCapacity(this.stagingLen + verts.length);
    for (const [x, y, z] of verts) {
      this.pushVertex(x, y, z, r, g, bc, alpha);
    }
  }

  axes(worldMat: Mat4, length: number): void {
    if (this.resources === undefined) {
      this.postDestroyWarnOnce();
      return;
    }
    // Three arrows (X=red, Y=green, Z=blue) along the transform's local axes; each
    // carries its own color, so they cannot share the single-color push path.
    for (const { vertices, color } of axesArrowSets(worldMat, length)) {
      const [r, g, bc, alpha] = this.colorToRGBA(color as unknown as ColorLike);
      this.ensureCapacity(this.stagingLen + vertices.length);
      for (const [x, y, z] of vertices) {
        this.pushVertex(x, y, z, r, g, bc, alpha);
      }
    }
  }

  // -- flush (w13) --

  flush(
    encoder: RhiCommandEncoder,
    view: TextureView,
    viewProj: Mat4,
  ): Result<void, DebugDrawError> {
    if (this.resources === undefined) return flushedAfterDestroy();
    if (viewProj === undefined || viewProj === null) return viewProjRequired();
    if (this.stagingLen === 0) {
      this.lastFlushedVertexCount = 0;
      return ok(undefined as void);
    }

    // Begin render pass with loadOp='load' to preserve scene content.
    // When depthMode is 'less-equal', a depthStencilAttachment is required
    // matching the PSO's depth format. The caller must provide depthView
    // for less-equal mode; without it, the render pass will fail validation.
    const passDesc: RenderPassDescriptor = {
      colorAttachments: [
        {
          view,
          loadOp: 'load',
          storeOp: 'store',
        },
      ],
    };
    if (this.depthView !== null) {
      passDesc.depthStencilAttachment = {
        view: this.depthView,
        depthLoadOp: 'load',
        depthStoreOp: 'store',
      };
    }
    const pass = encoder.beginRenderPass(passDesc);

    const encoded = this.encode(pass, viewProj);
    pass.end();
    return encoded;
  }

  encode(
    pass: RhiRenderPassEncoder,
    viewProj: Mat4,
    colorFormat?: TextureFormat,
  ): Result<void, DebugDrawError> {
    const resources = this.resources;
    if (resources === undefined) return flushedAfterDestroy();
    if (viewProj === undefined || viewProj === null) return viewProjRequired();
    if (this.stagingLen === 0) {
      this.lastFlushedVertexCount = 0;
      return ok(undefined as void);
    }
    const resolved = this.pipelineFor(resources.pipeline, colorFormat);
    if (!resolved.ok) return resolved;
    const pipeline = resolved.value;

    const vertexCount = Math.min(this.stagingLen, this.maxCapVal);
    const { vbo, uniformBuffer: uniformBuf, bindGroup } = resources;
    const byteCount = vertexCount * VERTEX_STRIDE_BYTES;
    this.rhiDevice.queue.writeBuffer(
      vbo,
      0,
      new Uint8Array(this.stagingArr.buffer, 0, byteCount),
      0,
      byteCount,
    );
    const uniformData = new Float32Array(16);
    for (let i = 0; i < 16; i++) uniformData[i] = viewProj[i] as number;
    this.rhiDevice.queue.writeBuffer(uniformBuf, 0, new Uint8Array(uniformData.buffer), 0, 64);

    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, vbo);
    pass.draw(vertexCount);
    this.lastFlushedVertexCount = vertexCount;

    // Reset staging for next frame
    this.stagingLen = 0;
    this.truncationWarned = false;

    return ok(undefined as void);
  }

  private pipelineFor(
    fallback: RenderPipeline,
    format: TextureFormat | undefined,
  ): Result<RenderPipeline, DebugDrawError> {
    const source = this.pipelineSource;
    if (format === undefined || source === undefined) return ok(fallback);
    const cached = this.pipelinesByFormat.get(format);
    if (cached !== undefined) return ok(cached);
    const created = source.create(format);
    if (created.ok) this.pipelinesByFormat.set(format, created.value);
    return created;
  }

  // -- destroy (w14) --

  destroy(): void {
    const resources = this.resources;
    if (resources === undefined) return;
    this.resources = undefined;
    this.rhiDevice.destroyBuffer(resources.vbo);
    this.rhiDevice.destroyBuffer(resources.uniformBuffer);
    this.pipelinesByFormat.clear();
    this.stagingArr = new Float32Array(0);
    this.stagingLen = 0;
    this.lastFlushedVertexCount = 0;
  }
}

// ==========================================================================
// createDebugDraw factory (w12)
// ==========================================================================

export async function createDebugDraw(
  opts: DebugDrawOptions,
): Promise<Result<DebugDraw, DebugDrawError>> {
  const device = opts.device;
  const fmt = opts.format ?? 'bgra8unorm';
  const depthFormat = opts.depthFormat;
  const depthMode = opts.depthMode ?? 'always';
  const maxCap = normalizeCapacity(
    opts.maxVertexCapacity ?? MAX_VERTEX_CAPACITY,
    MAX_VERTEX_CAPACITY,
  );
  const initialCap = Math.min(
    normalizeCapacity(
      opts.initialVertexCapacity ?? INITIAL_VERTEX_CAPACITY,
      INITIAL_VERTEX_CAPACITY,
    ),
    maxCap,
  );

  // Allocate GPU vertex buffer
  // GPUBufferUsage.COPY_DST=8, VERTEX=32
  const vboByteSize = initialCap * VERTEX_STRIDE_BYTES;
  const vboResult = device.createBuffer({
    size: vboByteSize,
    usage: 8 | 32, // COPY_DST | VERTEX
    label: 'debug-draw-vbo',
  });
  if (!vboResult.ok) {
    return bufferAllocationFailed(
      `createBuffer(COPY_DST|VERTEX, ${vboByteSize}B): ${vboResult.error.code}`,
    );
  }
  const vbo = vboResult.value;
  let uniformBuf: Buffer | undefined;
  let transferred = false;
  try {
    const uniformBufResult = device.createBuffer({
      size: 64,
      usage: 64 | 8,
      label: 'debug-draw-uniform',
    });
    if (!uniformBufResult.ok) {
      return bufferAllocationFailed(
        `createBuffer(UNIFORM|COPY_DST, 64B): ${uniformBufResult.error.code}`,
      );
    }
    uniformBuf = uniformBufResult.value;

    // Compile WGSL shader modules via injected factory
    const vsResult = await opts.createShaderModule(device, {
      label: 'debug-draw-vs',
      code: VERTEX_SHADER,
    });
    if (!vsResult.ok) {
      return pipelineCreateFailed(`createShaderModule(vertex): ${vsResult.error.code}`);
    }
    const vsModule = vsResult.value;

    const fsResult = await opts.createShaderModule(device, {
      label: 'debug-draw-fs',
      code: FRAGMENT_SHADER,
    });
    if (!fsResult.ok) {
      return pipelineCreateFailed(`createShaderModule(fragment): ${fsResult.error.code}`);
    }
    const fsModule = fsResult.value;

    const bglResult = device.createBindGroupLayout({
      label: 'debug-draw-bind-group-layout',
      entries: [
        {
          binding: 0,
          visibility: 1,
          buffer: { type: 'uniform', minBindingSize: 64 },
        },
      ],
    });
    if (!bglResult.ok) {
      return pipelineCreateFailed(`createBindGroupLayout: ${bglResult.error.code}`);
    }

    const pipelineLayoutResult = device.createPipelineLayout({
      label: 'debug-draw-pipeline-layout',
      bindGroupLayouts: [bglResult.value],
    });
    if (!pipelineLayoutResult.ok) {
      return pipelineCreateFailed(`createPipelineLayout: ${pipelineLayoutResult.error.code}`);
    }

    // Build render pipeline descriptor.
    // For 'always' mode: no depthStencil — the overlay draws on top regardless of depth.
    // For 'less-equal' mode: depthStencil included so the overlay respects scene depth.
    const depthStencil: RenderPipelineDescriptor['depthStencil'] =
      depthMode === 'less-equal'
        ? {
            format: depthFormat ?? 'depth24plus',
            depthWriteEnabled: false,
            depthCompare: 'greater-equal',
          }
        : undefined;

    const vertexBuffers: RenderPipelineDescriptor['vertex']['buffers'] = [
      {
        arrayStride: VERTEX_STRIDE_BYTES,
        stepMode: 'vertex',
        attributes: [
          {
            format: 'float32x3',
            offset: 0,
            shaderLocation: 0,
          },
          {
            format: 'unorm8x4',
            offset: 12,
            shaderLocation: 1,
          },
        ],
      },
    ];

    const pipelineDesc = (format: TextureFormat): RenderPipelineDescriptor => ({
      label: 'debug-draw-pso',
      layout: pipelineLayoutResult.value,
      vertex: {
        module: vsModule,
        entryPoint: 'vs_main',
        buffers: vertexBuffers,
      },
      primitive: {
        topology: 'line-list',
      },
      depthStencil,
      fragment: {
        module: fsModule,
        entryPoint: 'fs_main',
        targets: [{ format }],
      },
    });
    const pipelineSource: DebugDrawPipelineSource = {
      format: fmt,
      create: (format) => {
        const pso = device.createRenderPipeline(pipelineDesc(format));
        return pso.ok
          ? ok(pso.value)
          : pipelineCreateFailed(`createRenderPipeline(${format}): ${pso.error.code}`);
      },
    };

    const psoResult = pipelineSource.create(fmt);
    if (!psoResult.ok) {
      return psoResult;
    }
    const pipeline = psoResult.value;

    // Create the bind group from the same explicit RHI layout used by the pipeline.
    const bgResult = device.createBindGroup({
      layout: bglResult.value,
      entries: [
        {
          binding: 0,
          resource: {
            kind: 'buffer',
            value: { buffer: uniformBuf, offset: 0, size: 64 },
          },
        },
      ],
      label: 'debug-draw-bindgroup',
    });
    if (!bgResult.ok) {
      return pipelineCreateFailed(`createBindGroup: ${bgResult.error.code}`);
    }

    const draw = new DebugDraw(
      device,
      pipeline,
      vbo,
      uniformBuf,
      bgResult.value,
      initialCap,
      maxCap,
      pipelineSource,
    );
    transferred = true;
    return ok(draw);
  } finally {
    if (!transferred) {
      device.destroyBuffer(vbo);
      if (uniformBuf !== undefined) device.destroyBuffer(uniformBuf);
    }
  }
}

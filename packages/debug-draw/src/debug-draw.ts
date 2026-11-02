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

import type { Mat4 } from '@forgeax/engine-math';
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
import { DEBUG_OVERLAY_SHADER } from './shader';
import { DebugDrawSource, normalizeCapacity } from './source';
import type { DebugDraw as DebugDrawInterface, DebugDrawOptions } from './types';

// ==========================================================================
// Internal helpers
// ==========================================================================

/** Creates the overlay PSO for one color-attachment format from the shared modules/layout. */
export interface DebugDrawPipelineSource {
  readonly format: TextureFormat;
  create(format: TextureFormat): Result<RenderPipeline, DebugDrawError>;
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

/**
 * The low-path instance: {@link DebugDrawSource} staging plus its own GPU
 * buffers, uploaded by `flush`/`encode`. A Renderer does not use the GPU half.
 */
export class DebugDraw extends DebugDrawSource implements DebugDrawInterface {
  private lastFlushedVertexCount = 0;

  private resources: DebugDrawResources | undefined;

  // Graph targets can differ from the creation format (e.g. rgba16float post input on
  // raw-only WebGL2 surfaces), so encode() resolves one PSO per attachment format.
  private readonly pipelineSource: DebugDrawPipelineSource | undefined;

  private readonly pipelinesByFormat = new Map<TextureFormat, RenderPipeline>();

  private readonly rhiDevice: RhiDevice;

  /**
   * Depth texture view for less-equal depth mode.
   * Set via {@link _setDepthView} before flush() when depthMode is 'less-equal'.
   * Low-path callers (test harnesses, smoke runners) set this explicitly.
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
    super(initialCapacity, maxCapacity);
    this.rhiDevice = device;
    this.resources = { vbo, uniformBuffer, bindGroup, pipeline };
    this.pipelineSource = pipelineSource;
    if (pipelineSource !== undefined) this.pipelinesByFormat.set(pipelineSource.format, pipeline);
  }

  /** @internal Vertex count passed to the most recent non-empty draw call. */
  get _lastFlushVertexCount(): number {
    return this.lastFlushedVertexCount;
  }

  hasWork(): boolean {
    return this.resources !== undefined && this.stagingLen > 0;
  }

  /**
   * @internal Set the depth texture view for less-equal depth mode.
   * Required before flush() when depthMode is 'less-equal'.
   */
  _setDepthView(view: TextureView): void {
    this.depthView = view;
  }

  // The GPU vertex buffer must grow with the CPU staging, or flush() binds a
  // buffer too small for the staged vertex count. On alloc failure keep the old
  // cap (the draw stays bounded and correct, just truncated).
  protected override growResources(newCap: number): boolean {
    const resources = this.resources;
    if (resources === undefined) return false;
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
      return false;
    }
    console.warn(`[DebugDraw] Resizing vertex buffer from ${this.capVal} to ${newCap} vertices.`);
    this.rhiDevice.destroyBuffer(resources.vbo);
    resources.vbo = newVbo.value;
    return true;
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

    const batch = this.take();
    if (batch === null) return ok(undefined as void);
    const { vbo, uniformBuffer: uniformBuf, bindGroup } = resources;
    this.rhiDevice.queue.writeBuffer(vbo, 0, batch.bytes, 0, batch.bytes.byteLength);
    const uniformData = new Float32Array(16);
    for (let i = 0; i < 16; i++) uniformData[i] = viewProj[i] as number;
    this.rhiDevice.queue.writeBuffer(uniformBuf, 0, new Uint8Array(uniformData.buffer), 0, 64);

    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, vbo);
    pass.draw(batch.vertexCount);
    this.lastFlushedVertexCount = batch.vertexCount;
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

  override destroy(): void {
    const resources = this.resources;
    if (resources === undefined) return;
    this.resources = undefined;
    super.destroy();
    this.rhiDevice.destroyBuffer(resources.vbo);
    this.rhiDevice.destroyBuffer(resources.uniformBuffer);
    this.pipelinesByFormat.clear();
    this.lastFlushedVertexCount = 0;
  }
}

// ==========================================================================
// createDebugDraw factory (w12)
// ==========================================================================

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
      code: DEBUG_OVERLAY_SHADER.vertexWgsl,
    });
    if (!vsResult.ok) {
      return pipelineCreateFailed(`createShaderModule(vertex): ${vsResult.error.code}`);
    }
    const vsModule = vsResult.value;

    const fsResult = await opts.createShaderModule(device, {
      label: 'debug-draw-fs',
      code: DEBUG_OVERLAY_SHADER.fragmentWgsl,
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
        attributes: DEBUG_OVERLAY_SHADER.attributes.map((attribute) => ({ ...attribute })),
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

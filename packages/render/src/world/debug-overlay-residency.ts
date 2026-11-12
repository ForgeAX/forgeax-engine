import type {
  BindGroup,
  BindGroupLayout,
  Buffer,
  PipelineLayout,
  RenderPipeline,
  RhiDevice,
  ShaderModule,
  TextureFormat,
} from '@forgeax/engine-rhi';
import type { Result } from '@forgeax/engine-types';
import type { DeviceScope } from '../device/device-scope';
import { GpuBuffer } from '../gpu-resource';
import type {
  DebugOverlayBatch,
  DebugOverlayFailureCode,
  DebugOverlayShader,
} from '../render-contract';

/** COPY_DST | VERTEX. */
const VERTEX_BUFFER_USAGE = 8 | 32;
/** UNIFORM | COPY_DST. */
const UNIFORM_BUFFER_USAGE = 64 | 8;
/** The view-projection uniform of the overlay program. */
export const OVERLAY_UNIFORM_BYTES = 64;
const MIN_VERTEX_BUFFER_BYTES = 4096;

/** What the residency needs from its Renderer: the live device, its scope and a shader factory. */
export interface DebugOverlayHost {
  readonly device: RhiDevice;
  readonly scope: DeviceScope;
  readonly shaderModules:
    | {
        createShaderModule(input: {
          readonly code: string;
          readonly label?: string | undefined;
        }): Result<ShaderModule, unknown>;
      }
    | undefined;
}

interface Program {
  readonly bindGroupLayout: BindGroupLayout;
  readonly pipelineLayout: PipelineLayout;
  readonly vertex: ShaderModule;
  readonly fragment: ShaderModule;
  readonly pipelines: Map<TextureFormat, RenderPipeline>;
}

interface Bound {
  readonly device: RhiDevice;
  readonly scope: DeviceScope;
  vertexBuffer: GpuBuffer | undefined;
  vertexCapacity: number;
  program: Program | undefined;
}

/** A residency step: its value, or the closed overlay failure code with its cause. */
export type OverlayStep<T, C extends DebugOverlayFailureCode> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: C; readonly cause: unknown };

function fail<C extends DebugOverlayFailureCode>(code: C, cause: unknown): OverlayStep<never, C> {
  return { ok: false, code, cause };
}

/**
 * The Renderer's debug overlay GPU objects: one grow-only vertex buffer and the
 * overlay program with one pipeline per colour format. Device-bound: a different
 * device or scope than the one bound (device recovery) drops the old objects and
 * rebuilds lazily, so no recreation hook exists.
 */
export class DebugOverlayResidency {
  private bound: Bound | undefined;

  /** `recover(device)`: bind to the host's current device, retiring objects of a former one. */
  private bind(host: DebugOverlayHost): Bound {
    const current = this.bound;
    if (current?.device === host.device) return current;
    this.release();
    this.bound = {
      device: host.device,
      scope: host.scope,
      vertexBuffer: undefined,
      vertexCapacity: 0,
      program: undefined,
    };
    return this.bound;
  }

  /** Upload the batch into the vertex buffer, growing it when needed. */
  upload(
    host: DebugOverlayHost,
    batch: DebugOverlayBatch,
  ): OverlayStep<void, 'overlay-upload-failed'> {
    const bound = this.bind(host);
    const bytes = batch.bytes.byteLength;
    try {
      if (bound.vertexBuffer === undefined || bound.vertexCapacity < bytes) {
        const previous = bound.vertexBuffer;
        const size = Math.max(MIN_VERTEX_BUFFER_BYTES, bytes, bound.vertexCapacity * 2);
        const created = host.device.createBuffer({
          size,
          usage: VERTEX_BUFFER_USAGE,
          label: 'debug-overlay-vbo',
        });
        if (!created.ok) return fail('overlay-upload-failed', created.error);
        previous?.destroy();
        bound.vertexBuffer = new GpuBuffer(host.device, created.value, host.scope);
        bound.vertexCapacity = size;
      }
      const written = host.device.queue.writeBuffer(
        bound.vertexBuffer.handle,
        0,
        batch.bytes,
        0,
        bytes,
      );
      if (!written.ok) return fail('overlay-upload-failed', written.error);
      return { ok: true, value: undefined };
    } catch (cause) {
      return fail('overlay-upload-failed', cause);
    }
  }

  /** The vertex buffer the last upload filled. */
  get vertexBuffer(): Buffer | undefined {
    return this.bound?.vertexBuffer?.handle;
  }

  private program(
    host: DebugOverlayHost,
    shader: DebugOverlayShader,
  ): OverlayStep<Program, 'overlay-pipeline-failed'> {
    const bound = this.bind(host);
    if (bound.program !== undefined) return { ok: true, value: bound.program };
    const factory = host.shaderModules;
    if (factory === undefined)
      return fail(
        'overlay-pipeline-failed',
        new Error('the Renderer exposes no shader module factory'),
      );
    const vertex = factory.createShaderModule({
      code: shader.vertexWgsl,
      label: 'debug-overlay-vs',
    });
    if (!vertex.ok) return fail('overlay-pipeline-failed', vertex.error);
    const fragment = factory.createShaderModule({
      code: shader.fragmentWgsl,
      label: 'debug-overlay-fs',
    });
    if (!fragment.ok) return fail('overlay-pipeline-failed', fragment.error);
    const bgl = host.device.createBindGroupLayout({
      label: 'debug-overlay-bind-group-layout',
      entries: [
        {
          binding: 0,
          visibility: 1,
          buffer: { type: 'uniform', minBindingSize: OVERLAY_UNIFORM_BYTES },
        },
      ],
    });
    if (!bgl.ok) return fail('overlay-pipeline-failed', bgl.error);
    const layout = host.device.createPipelineLayout({
      label: 'debug-overlay-pipeline-layout',
      bindGroupLayouts: [bgl.value],
    });
    if (!layout.ok) return fail('overlay-pipeline-failed', layout.error);
    bound.program = {
      bindGroupLayout: bgl.value,
      pipelineLayout: layout.value,
      vertex: vertex.value,
      fragment: fragment.value,
      pipelines: new Map(),
    };
    return { ok: true, value: bound.program };
  }

  /** The overlay pipeline for one colour-attachment format, created once. */
  pipelineFor(
    host: DebugOverlayHost,
    shader: DebugOverlayShader,
    format: TextureFormat,
  ): OverlayStep<RenderPipeline, 'overlay-pipeline-failed'> {
    const program = this.program(host, shader);
    if (!program.ok) return program;
    const cached = program.value.pipelines.get(format);
    if (cached !== undefined) return { ok: true, value: cached };
    const created = host.device.createRenderPipeline({
      label: 'debug-overlay-pso',
      layout: program.value.pipelineLayout,
      vertex: {
        module: program.value.vertex,
        entryPoint: shader.vertexEntry,
        buffers: [
          {
            arrayStride: shader.vertexStrideBytes,
            stepMode: 'vertex',
            attributes: shader.attributes.map((attribute) => ({ ...attribute })),
          },
        ],
      },
      primitive: { topology: 'line-list' },
      fragment: {
        module: program.value.fragment,
        entryPoint: shader.fragmentEntry,
        targets: [{ format }],
      },
    });
    if (!created.ok) return fail('overlay-pipeline-failed', created.error);
    program.value.pipelines.set(format, created.value);
    return { ok: true, value: created.value };
  }

  /** A view's uniform buffer and bind group; the buffer is owned by the view's `scope`. */
  viewBinding(
    host: DebugOverlayHost,
    shader: DebugOverlayShader,
    scope: DeviceScope,
  ): OverlayStep<
    { readonly uniform: GpuBuffer; readonly bindGroup: BindGroup },
    'overlay-upload-failed' | 'overlay-pipeline-failed'
  > {
    const program = this.program(host, shader);
    if (!program.ok) return program;
    const created = host.device.createBuffer({
      size: OVERLAY_UNIFORM_BYTES,
      usage: UNIFORM_BUFFER_USAGE,
      label: 'debug-overlay-uniform',
    });
    if (!created.ok) return fail('overlay-upload-failed', created.error);
    const uniform = new GpuBuffer(host.device, created.value, scope);
    const group = host.device.createBindGroup({
      label: 'debug-overlay-bindgroup',
      layout: program.value.bindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: {
            kind: 'buffer',
            value: { buffer: created.value, offset: 0, size: OVERLAY_UNIFORM_BYTES },
          },
        },
      ],
    });
    if (!group.ok) {
      uniform.destroy();
      return fail('overlay-pipeline-failed', group.error);
    }
    return { ok: true, value: { uniform, bindGroup: group.value } };
  }

  private release(): void {
    const bound = this.bound;
    this.bound = undefined;
    if (bound === undefined) return;
    // A retired scope already destroyed its resources with the lost device.
    if (bound.scope.isAlive()) bound.vertexBuffer?.destroy();
  }

  /** Destroy the GPU objects; idempotent. */
  dispose(): void {
    this.release();
  }
}

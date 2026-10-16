import type {
  BindGroup,
  Buffer,
  ComputePipeline,
  RhiCommandEncoder,
  RhiDevice,
  RhiError,
  ShaderModule,
} from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import {
  packReferenceRays,
  RAY_HIT_STRIDE,
  type RayReferenceError,
  type RayReferenceScene,
  type ReferenceRay,
  rayReferenceFailure,
} from './scene';

export interface RayReferenceQuery {
  /** Named resources are captured by RHI Debug as normal storage buffers. */
  readonly buffers: {
    readonly triangles: Buffer;
    readonly nodes: Buffer;
    readonly rays: Buffer;
    readonly hits: Buffer;
  };
  readonly rayCount: number;
  /** The caller owns submission. Recording creates exactly one observable compute work. */
  record(encoder: RhiCommandEncoder): Result<void, RayReferenceError>;
  dispose(): void;
}

type CompileShader = (
  device: RhiDevice,
  desc: { code: string; label?: string | undefined },
) => Promise<Result<ShaderModule, RhiError>>;

/** One immutable scene/ray batch, one device owner. Rebuild to update; no hidden stale cache. */
export async function createRayReferenceQuery(
  device: RhiDevice,
  compile: CompileShader,
  kernel: string,
  scene: RayReferenceScene,
  rays: readonly ReferenceRay[],
): Promise<Result<RayReferenceQuery, RayReferenceError | RhiError>> {
  const packed = packReferenceRays(rays);
  if (!packed.ok) return packed;
  const owned: Buffer[] = [];
  const dispose = () => {
    for (const buffer of owned) device.destroyBuffer(buffer);
    owned.length = 0;
  };
  const make = (label: string, bytes: Uint8Array): Result<Buffer, RhiError> => {
    const buffer = device.createBuffer({
      label,
      size: bytes.byteLength,
      usage: 0x80 | 0x08 | 0x04,
    });
    if (!buffer.ok) return buffer;
    owned.push(buffer.value);
    const wrote = device.queue.writeBuffer(buffer.value, 0, bytes);
    return wrote.ok ? buffer : wrote;
  };
  const triangles = make('ray-reference.triangles', scene.triangles);
  if (!triangles.ok) {
    dispose();
    return triangles;
  }
  const nodes = make('ray-reference.nodes', scene.nodes);
  if (!nodes.ok) {
    dispose();
    return nodes;
  }
  const rayBuffer = make('ray-reference.rays', packed.value);
  if (!rayBuffer.ok) {
    dispose();
    return rayBuffer;
  }
  const hits = make('ray-reference.hits', new Uint8Array(rays.length * RAY_HIT_STRIDE));
  if (!hits.ok) {
    dispose();
    return hits;
  }
  const shader = await compile(device, { label: 'ray-reference', code: kernel });
  if (!shader.ok) {
    dispose();
    return shader;
  }
  const layout = device.createBindGroupLayout({
    entries: [0, 1, 2, 3].map((binding) => ({
      binding,
      visibility: 4,
      buffer: { type: binding === 3 ? ('storage' as const) : ('read-only-storage' as const) },
    })),
  });
  if (!layout.ok) {
    dispose();
    return layout;
  }
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout.value] });
  if (!pipelineLayout.ok) {
    dispose();
    return pipelineLayout;
  }
  const pipeline: Result<ComputePipeline, RhiError> = device.createComputePipeline({
    label: 'ray-reference',
    layout: pipelineLayout.value,
    compute: { module: shader.value, entryPoint: 'queryTriangles' },
  });
  if (!pipeline.ok) {
    dispose();
    return pipeline;
  }
  const bindings: Result<BindGroup, RhiError> = device.createBindGroup({
    label: 'ray-reference',
    layout: layout.value,
    entries: [triangles.value, nodes.value, rayBuffer.value, hits.value].map((buffer, binding) => ({
      binding,
      resource: { kind: 'buffer' as const, value: { buffer } },
    })),
  });
  if (!bindings.ok) {
    dispose();
    return bindings;
  }
  let disposed = false;
  return ok({
    buffers: {
      triangles: triangles.value,
      nodes: nodes.value,
      rays: rayBuffer.value,
      hits: hits.value,
    },
    rayCount: rays.length,
    record(encoder) {
      if (disposed) return rayReferenceFailure('query batch is disposed');
      const pass = encoder.beginComputePass({ label: 'ray-reference' });
      pass.setPipeline(pipeline.value);
      pass.setBindGroup(0, bindings.value);
      pass.dispatchWorkgroups(Math.ceil(rays.length / 64), 1, 1);
      pass.end();
      return ok(undefined);
    },
    dispose() {
      if (!disposed) {
        disposed = true;
        dispose();
      }
    },
  });
}

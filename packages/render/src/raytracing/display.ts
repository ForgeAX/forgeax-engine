import type {
  Buffer,
  RhiCommandEncoder,
  RhiDevice,
  RhiError,
  ShaderModule,
  TextureView,
} from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import { rayReferenceFailure } from './scene';

export type RayDisplayMode = 'direct' | 'gi' | 'indirect' | 'coverage' | 'path';
/** One shared output transform for raw GI or independent PT buffers. No relighting. */
export async function createRayDisplay(
  device: RhiDevice,
  compile: (
    device: RhiDevice,
    desc: { code: string; label?: string },
  ) => Promise<Result<ShaderModule, RhiError>>,
  request: {
    kernel: string;
    buffer: Buffer;
    resolution: number;
    mode: RayDisplayMode;
    exposure: number;
  },
) {
  const mode = ['direct', 'gi', 'indirect', 'coverage', 'path'].indexOf(request.mode);
  if (
    mode < 0 ||
    !Number.isInteger(request.resolution) ||
    request.resolution < 1 ||
    request.resolution > 512 ||
    !Number.isFinite(Math.fround(request.exposure)) ||
    request.exposure < 0
  )
    return rayReferenceFailure('display requires 1..512 pixels and finite nonnegative exposure');
  const shader = await compile(device, { code: request.kernel, label: 'ray.display' });
  if (!shader.ok) return shader;
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: 2, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: 2, buffer: { type: 'uniform' } },
    ],
  });
  if (!layout.ok) return layout;
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout.value] });
  if (!pipelineLayout.ok) return pipelineLayout;
  const pipeline = device.createRenderPipeline({
    label: `ray.display.${request.mode}`,
    layout: pipelineLayout.value,
    vertex: { module: shader.value, entryPoint: 'vs_display', buffers: [] },
    fragment: {
      module: shader.value,
      entryPoint: 'fs_display',
      targets: [{ format: 'rgba8unorm' }],
    },
    primitive: { topology: 'triangle-list' },
  });
  if (!pipeline.ok) return pipeline;
  const uniform = device.createBuffer({ size: 16, usage: 72, label: 'ray.display.settings' });
  if (!uniform.ok) return uniform;
  const data = new Uint8Array(16);
  new Uint32Array(data.buffer).set([request.resolution, mode]);
  new Float32Array(data.buffer)[2] = request.exposure;
  const written = device.queue.writeBuffer(uniform.value, 0, data);
  if (!written.ok) {
    device.destroyBuffer(uniform.value);
    return written;
  }
  const group = device.createBindGroup({
    layout: layout.value,
    entries: [request.buffer, uniform.value].map((buffer, binding) => ({
      binding,
      resource: { kind: 'buffer' as const, value: { buffer } },
    })),
  });
  if (!group.ok) {
    device.destroyBuffer(uniform.value);
    return group;
  }
  let disposed = false;
  return ok({
    record(encoder: RhiCommandEncoder, view: TextureView) {
      if (disposed) return rayReferenceFailure('ray display is disposed');
      const pass = encoder.beginRenderPass({
        label: `ray.display.${request.mode}`,
        colorAttachments: [
          { view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } },
        ],
      });
      pass.setPipeline(pipeline.value);
      pass.setBindGroup(0, group.value);
      pass.draw(3);
      pass.end();
      return ok(undefined);
    },
    dispose() {
      if (!disposed) {
        disposed = true;
        device.destroyBuffer(uniform.value);
      }
    },
  });
}

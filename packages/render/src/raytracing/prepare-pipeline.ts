import type {
  ComputePipelineDescriptor,
  RenderPipelineDescriptor,
  RhiDevice,
} from '@forgeax/engine-rhi';

/** An optional backend completion API is authoritative when advertised. */
export function prepareComputePipeline(device: RhiDevice, descriptor: ComputePipelineDescriptor) {
  const create = device.createComputePipelineAsync;
  return create === undefined
    ? device.createComputePipeline(descriptor)
    : create.call(device, descriptor);
}

export function prepareRenderPipeline(device: RhiDevice, descriptor: RenderPipelineDescriptor) {
  const create = device.createRenderPipelineAsync;
  return create === undefined
    ? device.createRenderPipeline(descriptor)
    : create.call(device, descriptor);
}

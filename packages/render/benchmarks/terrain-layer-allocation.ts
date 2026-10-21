import type { Buffer, RhiDevice, Texture } from '@forgeax/engine-rhi';

/** Opt-in benchmark instrumentation; counts actual live RHI descriptors and uploads. */
export function observeTerrainLayerAllocation(device: RhiDevice) {
  const textures = new Map<Texture, { label: string; bytes: number; bytesPerTexel: number }>();
  const buffers = new Map<Buffer, { label: string; bytes: number }>();
  const createTexture = device.createTexture.bind(device);
  const destroyTexture = device.destroyTexture.bind(device);
  const createBuffer = device.createBuffer.bind(device);
  const destroyBuffer = device.destroyBuffer.bind(device);
  const createCommandEncoder = device.createCommandEncoder.bind(device);
  let textureToTextureBytes = 0, textureToBufferBytes = 0, bufferToTextureBytes = 0;
  const writeBuffer = device.queue.writeBuffer.bind(device.queue);
  let uploadedBytes = 0;
  let peakBytes = 0;
  const currentBytes = () => [...textures.values(), ...buffers.values()].reduce((sum, item) => sum + item.bytes, 0);
  const admit = () => { peakBytes = Math.max(peakBytes, currentBytes()); };
  device.createTexture = (descriptor) => {
    const result = createTexture(descriptor);
    if (result.ok) {
      const size = descriptor.size;
      if (size === undefined) throw new Error('missing benchmark texture size');
      const dimensions = 'width' in size ? [size.width, size.height ?? 1, size.depthOrArrayLayers ?? 1] : Array.from(size);
      if (descriptor.format !== 'rgba16float' && descriptor.format !== 'rgba8unorm') throw new Error(`unaccounted Terrain benchmark format: ${descriptor.format}`);
      textures.set(result.value, { label: descriptor.label ?? '', bytes: (dimensions[0] ?? 1) * (dimensions[1] ?? 1) * (dimensions[2] ?? 1) * (descriptor.format === 'rgba8unorm' ? 4 : 8), bytesPerTexel: descriptor.format === 'rgba8unorm' ? 4 : 8 });
      admit();
    }
    return result;
  };
  device.destroyTexture = (texture) => { const result = destroyTexture(texture); if (result.ok) textures.delete(texture); return result; };
  device.createBuffer = (descriptor) => {
    const result = createBuffer(descriptor);
    if (result.ok) {
      if (descriptor.size === undefined) throw new Error('missing benchmark buffer size');
      buffers.set(result.value, { label: descriptor.label ?? '', bytes: descriptor.size }); admit();
    }
    return result;
  };
  device.destroyBuffer = (buffer) => { const result = destroyBuffer(buffer); if (result.ok) buffers.delete(buffer); return result; };
  device.queue.writeBuffer = (...args) => { uploadedBytes += args[4] ?? args[2].byteLength; return writeBuffer(...args); };
  const copyBytes = (texture: Texture | GPUTexture, size: GPUExtent3DStrict) => {
    const extent = 'width' in size ? [size.width, size.height ?? 1, size.depthOrArrayLayers ?? 1] : Array.from(size);
    return (textures.get(texture as unknown as Texture)?.bytesPerTexel ?? 0) * (extent[0] ?? 1) * (extent[1] ?? 1) * (extent[2] ?? 1);
  };
  device.createCommandEncoder = (...args) => {
    const result = createCommandEncoder(...args);
    if (!result.ok) return result;
    const encoder = result.value;
    const textureCopy = encoder.copyTextureToTexture.bind(encoder), read = encoder.copyTextureToBuffer.bind(encoder), write = encoder.copyBufferToTexture.bind(encoder);
    encoder.copyTextureToTexture = (...args) => { textureToTextureBytes += copyBytes(args[0].texture, args[2]); textureCopy(...args); };
    encoder.copyTextureToBuffer = (...args) => { textureToBufferBytes += copyBytes(args[0].texture, args[2]); read(...args); };
    encoder.copyBufferToTexture = (...args) => { bufferToTextureBytes += copyBytes(args[1].texture, args[2]); write(...args); };
    return result;
  };
  return {
    snapshot: () => ({ liveBytes: currentBytes(), peakBytes, uploadedBytes, textureToTextureBytes, textureToBufferBytes, bufferToTextureBytes, textures: [...textures.values()], buffers: [...buffers.values()] }),
    reset: () => { uploadedBytes = 0; textureToTextureBytes = textureToBufferBytes = bufferToTextureBytes = 0; peakBytes = currentBytes(); },
    dispose: () => {
      device.createTexture = createTexture;
      device.destroyTexture = destroyTexture;
      device.createBuffer = createBuffer;
      device.destroyBuffer = destroyBuffer;
      device.queue.writeBuffer = writeBuffer;
      device.createCommandEncoder = createCommandEncoder;
    },
  };
}

/** Opt-in native WebGPU counters. No engine owner or source payload is modified. */
export function gpuCounters() {
  if (globalThis.__managedAssetGpuCounters) return globalThis.__managedAssetGpuCounters;
  const live = { buffers: 0, textures: 0, bytes: 0 }, peak = { ...live };
  let counts = {}, unsupported = new Set();
  const hostFrames = new Map();
  const add = (key, value) => counts[key] = (counts[key] ?? 0) + value;
  const resources = new WeakMap();
  const formats = { r8unorm: 1, rg8unorm: 2, r16float: 2, rg16float: 4, rgba16float: 8, rgba32float: 16, rg32float: 8 };
  const bytesPerTexel = format => {
    if (format in formats) return formats[format];
    const plain=/^(r|rg|rgba)(8|16|32)/.exec(format);
    if(plain)return plain[1].length*Number(plain[2])/8;
    if(format==='depth16unorm')return 2;
    if(format==='stencil8')return 1;
    if (/^(rgba8|bgra8|r32|depth32|depth24|rgb10a2|rg11b10)/.test(format)) return 4;
    unsupported.add(format); return 0;
  };
  const textureBytes = descriptor => {
    const size = descriptor.size, width = size.width ?? size[0], height = size.height ?? size[1] ?? 1, depth = size.depthOrArrayLayers ?? size[2] ?? 1;
    let texels = 0;
    for (let mip = 0; mip < (descriptor.mipLevelCount ?? 1); mip++) texels += Math.max(1, width >> mip) * Math.max(1, height >> mip) * (descriptor.dimension === '3d' ? Math.max(1, depth >> mip) : depth);
    return texels * bytesPerTexel(descriptor.format) * (descriptor.sampleCount ?? 1);
  };
  const own = (resource, kind, bytes, format, label) => {
    resources.set(resource, { kind, bytes, format, label }); live[kind]++; live.bytes += bytes;
    for (const key of Object.keys(live)) peak[key] = Math.max(peak[key], live[key]);
    add('allocationBytes', bytes); add('allocations', 1);
    return resource;
  };
  const patch = (prototype, name, wrap) => { if (prototype?.[name]) { const original = prototype[name]; prototype[name] = wrap(original); } };
  patch(globalThis.GPUDevice?.prototype, 'createBuffer', original => function(descriptor) { return own(original.call(this, descriptor), 'buffers', descriptor.size, undefined, descriptor.label); });
  patch(globalThis.GPUDevice?.prototype, 'createTexture', original => function(descriptor) { return own(original.call(this, descriptor), 'textures', textureBytes(descriptor), descriptor.format, descriptor.label); });
  for (const type of [globalThis.GPUBuffer, globalThis.GPUTexture]) patch(type?.prototype, 'destroy', original => function() {
    const record = resources.get(this); if (record) { live[record.kind]--; live.bytes -= record.bytes; resources.delete(this); add('retiredBytes', record.bytes); }
    return original.call(this);
  });
  patch(globalThis.GPUQueue?.prototype, 'writeBuffer', original => function(buffer, offset, data, dataOffset = 0, size) {
    const unit = data.BYTES_PER_ELEMENT ?? 1,bytes=size === undefined ? data.byteLength - dataOffset * unit : size * unit;
    add('bufferUploadBytes',bytes);add('bufferUploadCalls',1);
    const label=resources.get(buffer)?.label??'';
    if(/^gpu-scene-.+-table$/.test(label))add(label+'UploadBytes',bytes);
    else if(/^mesh-.*-vbo$/.test(label))add('meshVertexUploadBytes',bytes);
    else if(/^mesh-.*-ibo$/.test(label))add('meshIndexUploadBytes',bytes);
    return original.apply(this, arguments);
  });
  patch(globalThis.GPUQueue?.prototype, 'writeTexture', original => function(destination, data, layout, size) {
    const info = resources.get(destination.texture), count = (size.width ?? size[0]) * (size.height ?? size[1] ?? 1) * (size.depthOrArrayLayers ?? size[2] ?? 1);
    const bytes=count*(info?bytesPerTexel(info.format):0);add('textureUploadBytes',bytes);add('textureUploadCalls',1);if(info?.label?.startsWith('texture-'))add('assetTextureUploadBytes',bytes);
    if (!info) unsupported.add('unobserved-upload-texture');
    return original.apply(this, arguments);
  });
  patch(globalThis.GPUQueue?.prototype, 'submit', original => function() { add('submissions', 1); return original.apply(this, arguments); });
  patch(globalThis.GPUCommandEncoder?.prototype, 'copyBufferToBuffer', original => function(source, offsetOrDestination, destinationOrSize, _destinationOffset, size) {
    const full = typeof offsetOrDestination === 'number';
    add('bufferCopyBytes', (full ? size : destinationOrSize) ?? (source.size - (full ? offsetOrDestination : 0)));
    return original.apply(this, arguments);
  });
  patch(globalThis.GPUCommandEncoder?.prototype, 'copyTextureToTexture', original => function(source, _destination, size) {
    const info = resources.get(source.texture); add('textureCopyBytes', (size.width ?? size[0]) * (size.height ?? size[1] ?? 1) * (size.depthOrArrayLayers ?? size[2] ?? 1) * (info ? bytesPerTexel(info.format) : 0));
    if (!info) unsupported.add('unobserved-copy-texture'); return original.apply(this, arguments);
  });
  for (const [prototype, label] of [[globalThis.Worker?.prototype, 'worker'], [globalThis.MessagePort?.prototype, 'port'], [typeof document === 'undefined' ? globalThis : undefined, 'scope']]) patch(prototype, 'postMessage', original => function(_message, transfers) {
    if (label === 'worker' && _message?.kind === 'frame' && Number.isSafeInteger(_message.frameId)) {
      hostFrames.set(_message.frameId, performance.now());
      while(hostFrames.size>1024)hostFrames.delete(hostFrames.keys().next().value);
    }
    const list=Array.isArray(transfers)?transfers:transfers?.transfer??[];
    let bytes=0;for(const value of list)if(value instanceof ArrayBuffer)bytes+=value.byteLength;
    add(`${label}Messages`,1);add(`${label}TransferredBytes`,bytes);
    const started=performance.now();try{return original.apply(this,arguments);}finally{add(`${label}PostCpuMs`,performance.now()-started);}
  });
  const api = { reset() { counts = {}; hostFrames.clear(); Object.assign(peak, live); }, frameStarted(frameId) { return hostFrames.get(frameId); }, snapshot() { return { ...counts, live: { ...live }, peak: { ...peak }, unsupported: [...unsupported] }; } };
  globalThis.__managedAssetGpuCounters = api; return api;
}

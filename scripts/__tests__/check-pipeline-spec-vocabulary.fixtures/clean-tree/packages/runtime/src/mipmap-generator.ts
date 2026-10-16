// Allowed Gate A + Gate B site: mipmap-generator owns its own pipeline cache
// (per-format mip downsamplers) and beginRenderPass per mip level.
export function buildMipPipeline(device) {
  return device.createRenderPipeline({});
}
export function recordMipPass(encoder) {
  return encoder.beginRenderPass({});
}

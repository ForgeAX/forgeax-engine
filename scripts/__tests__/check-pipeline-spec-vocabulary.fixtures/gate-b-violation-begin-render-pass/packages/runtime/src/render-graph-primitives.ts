// Gate B violation: raw beginRenderPass in render-graph-primitives.ts
// (must route through buildBeginRenderPassDescriptor in render-system-record.ts).
export function recordPass(encoder, descriptor) {
  return encoder.beginRenderPass(descriptor);
}

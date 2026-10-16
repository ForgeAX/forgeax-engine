// Gate A violation: raw createRenderPipeline call in createRenderer.ts
// (must route through getOrBuildPipeline / pipeline-spec).
export function createRenderer(device) {
  const pso = device.createRenderPipeline({});
  return pso;
}

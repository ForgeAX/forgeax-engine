// Clean: createRenderer.ts must NOT contain createRenderPipeline /
// beginRenderPass / materialShaderPipelineCacheKey -- all 3 vocab tokens
// belong elsewhere (pipeline-spec, render-system-record, deleted-via-cacheKeyOf).
export function createRenderer() {
  return { ready: Promise.resolve() };
}

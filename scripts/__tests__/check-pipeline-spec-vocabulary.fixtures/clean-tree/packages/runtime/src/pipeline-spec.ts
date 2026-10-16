// Allowed Gate A site: pipeline-spec.ts is the SSOT entrypoint.
export function getOrBuildPipeline(spec, deviceProvider, _cache) {
  const result = deviceProvider.createRenderPipeline(buildDescriptor(spec));
  return result;
}
function buildDescriptor(_spec) {
  return {};
}

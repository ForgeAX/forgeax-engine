// Gate C violation: residual materialShaderPipelineCacheKey reference
// (M2-T2 supersedes via cacheKeyOf(spec)).
export function materialShaderPipelineCacheKey(_id) {
  return 'legacy-key';
}

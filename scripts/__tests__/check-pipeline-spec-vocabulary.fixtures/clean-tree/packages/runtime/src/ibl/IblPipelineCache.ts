// Allowed Gate A site: IBL prefilter / brdf-LUT pipelines (resource baking
// allowlist; OOS-1 from feat-20260615 plan-strategy).
export function buildIblPipeline(device) {
  return device.createRenderPipeline({});
}

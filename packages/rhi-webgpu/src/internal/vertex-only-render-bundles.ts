/** Some WebGPU devices accept depth-only pipelines directly but reject them in bundles. */
export async function probeVertexOnlyRenderBundles(
  device: GPUDevice,
): Promise<boolean | undefined> {
  if (
    typeof device.createRenderBundleEncoder !== 'function' ||
    typeof device.pushErrorScope !== 'function' ||
    typeof device.popErrorScope !== 'function'
  )
    return undefined;

  device.pushErrorScope('validation');
  let recorded = false;
  try {
    const module = device.createShaderModule({
      label: 'forgeax-vertex-only-bundle-probe',
      code: '@vertex fn vs() -> @builtin(position) vec4f { return vec4f(0., 0., 0.5, 1.); }',
    });
    const format = 'depth32float';
    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      depthStencil: { format, depthCompare: 'always', depthWriteEnabled: true },
    });
    const bundle = device.createRenderBundleEncoder({
      colorFormats: [],
      depthStencilFormat: format,
    });
    bundle.setPipeline(pipeline);
    bundle.draw(3);
    bundle.finish();
    recorded = true;
  } catch {
    // A synchronous validation exception also rules out the native path.
  }
  return (await device.popErrorScope()) === null && recorded;
}

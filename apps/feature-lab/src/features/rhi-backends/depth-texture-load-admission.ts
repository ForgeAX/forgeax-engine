import { CheckList, defineFeature } from '../../lab/feature';
import { webgpuDevice } from './support/gpu';

export default defineFeature({
  title: 'Depth texture load admission',
  catalog: 'Depth texture load admission',
  kind: 'probe',
  summary:
    'Depth texture loads have an independent capability. Stock Renderer admission checks it before claiming the canvas; RHI Compatibility Mode can remain usable without it.',
  expect:
    'The renderer exposes a boolean depthTextureLoad. A default core WebGPU device admits the operation. Explicit compatibility requests qualify the actual native pipeline before publishing this capability.',
  setup({ app }) {
    return {
      async checks() {
        const checks = new CheckList();
        checks.ok(
          'Renderer publishes depthTextureLoad',
          typeof app.renderer.inspect().capabilities.depthTextureLoad === 'boolean',
        );
        const gpu = await webgpuDevice(checks);
        if (gpu !== undefined)
          checks.equal(
            'Core device admits depth texture loads',
            gpu.device.caps.depthTextureLoad,
            true,
          );
        return checks.items;
      },
    };
  },
});

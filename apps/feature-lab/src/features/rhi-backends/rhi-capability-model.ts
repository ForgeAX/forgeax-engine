import { rhi as nullRhi } from '@forgeax/engine/rhi-null';
import { CheckList, defineFeature } from '../../lab/feature';
import { webgpuDevice } from './support/gpu';

const BOOLEAN_CAPS = [
  'compute',
  'timestampQuery',
  'indirectDrawing',
  'storageBuffer',
  'storageTexture',
  'firstInstanceIndirect',
  'textureCompressionBc',
  'rgba16floatRenderable',
  'float32Filterable',
] as const;

export default defineFeature({
  title: 'RHI capability model',
  catalog: 'RHI capability model',
  kind: 'probe',
  summary:
    'Backend kind, features, limits, and optional operations are plain queryable data on the renderer and on every RhiDevice; different backends answer the same questions with different data.',
  expect:
    "All checks pass: renderer capabilities list backendKind plus boolean caps, adapter/device limits are numbers, caps.textureCompressionBc mirrors the device feature set, and a RhiNull device answers the same fields with backendKind 'null'.",
  setup({ app }) {
    return {
      async checks() {
        const checks = new CheckList();
        const caps = app.renderer.inspect().capabilities;
        checks.ok(
          'renderer backendKind reported',
          typeof caps.backendKind === 'string',
          caps.backendKind,
        );
        for (const key of BOOLEAN_CAPS)
          checks.ok(`caps.${key} is boolean`, typeof caps[key] === 'boolean', String(caps[key]));
        checks.ok(
          'caps.maxColorAttachments >= 4',
          caps.maxColorAttachments >= 4,
          String(caps.maxColorAttachments),
        );

        const gpu = await webgpuDevice(checks);
        if (gpu === undefined) return checks.items;
        const { device } = gpu;
        const limits = device.limits;
        checks.ok(
          'device limits are numbers',
          typeof limits.maxBindGroups === 'number' &&
            typeof limits.maxStorageBufferBindingSize === 'number',
          `maxBindGroups=${limits.maxBindGroups} maxStorageBufferBindingSize=${limits.maxStorageBufferBindingSize}`,
        );
        checks.equal(
          'caps.textureCompressionBc mirrors device.features',
          device.caps.textureCompressionBc,
          device.features.has('texture-compression-bc'),
        );
        checks.ok(
          'device without timestamp-query reports timestampQuery false',
          device.caps.timestampQuery === device.features.has('timestamp-query'),
          `caps=${device.caps.timestampQuery} feature=${device.features.has('timestamp-query')}`,
        );

        const nullAdapter = await nullRhi.requestAdapter();
        const nullDevice = nullAdapter.ok ? await nullAdapter.value.requestDevice() : undefined;
        checks.ok('RhiNull device created', nullDevice?.ok === true);
        if (nullDevice?.ok === true) {
          checks.equal('RhiNull backendKind', nullDevice.value.caps.backendKind, 'null');
          checks.equal(
            'same cap fields on both backends',
            Object.keys(nullDevice.value.caps).sort(),
            Object.keys(device.caps).sort(),
          );
        }
        return checks.items;
      },
    };
  },
});

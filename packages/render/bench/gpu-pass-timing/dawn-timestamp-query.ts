import { rhi } from '@forgeax/engine-rhi-webgpu';

export async function requestDawnTimestampQueryAdapter() {
  const adapter = await rhi.requestAdapter();
  if (!adapter.ok) {
    throw new Error(`${adapter.error.code}: ${adapter.error.hint}`);
  }
  return adapter.value.features.has('timestamp-query') ? adapter.value : undefined;
}

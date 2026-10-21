import { _internal_getRawDevice, rhi } from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { verifyMaterialVersions } from './managed-material-versions.gpu-fixture';

it('retains submitted material bytes and prior buffers across scalar and layout edits', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const native = _internal_getRawDevice(device);
  if (native === undefined) throw new Error('Native validation unavailable');
  native.pushErrorScope('validation');
  await verifyMaterialVersions(device);
  expect(await native.popErrorScope()).toBeNull();
});

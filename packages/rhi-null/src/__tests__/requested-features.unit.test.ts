import { expect, it } from 'vitest';
import { RhiNullAdapter } from '../adapter';

it('enables requested structural depth descriptors per device without claiming GPU timing', async () => {
  const adapter = new RhiNullAdapter();
  expect(adapter.features.has('depth32float-stencil8')).toBe(true);
  const defaults = (await adapter.requestDevice()).unwrap();
  const enabled = (
    await adapter.requestDevice({ requiredFeatures: ['depth32float-stencil8'] })
  ).unwrap();
  expect(defaults.features.has('depth32float-stencil8')).toBe(false);
  expect(enabled.features.has('depth32float-stencil8')).toBe(true);
  expect(enabled.caps.backendKind).toBe('null');
  expect(enabled.caps.timestampQuery).toBe(false);
  expect((await adapter.requestDevice({ requiredFeatures: ['timestamp-query'] })).ok).toBe(false);
});

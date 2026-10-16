import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isRhiOwnedRawHandle } from '../render-consumer-inventory.mjs';

test('raw-handle exclusion is path- and token-scoped', () => {
  assert.equal(isRhiOwnedRawHandle('packages/rhi-webgpu/src/device.ts', 'rawDevice'), true);
  assert.equal(isRhiOwnedRawHandle('apps/hello/debug-draw/src/main.ts', 'rawDevice'), true);
  assert.equal(isRhiOwnedRawHandle('apps/hello/cube/scripts/smoke-dawn.mjs', 'rawDevice'), true);
  assert.equal(
    isRhiOwnedRawHandle('apps/dual-impl-spike/scripts/texture-4x4.mjs', 'rawEncoder'),
    true,
  );
  assert.equal(isRhiOwnedRawHandle('apps/hello/debug-draw/src/main.ts', 'renderer.device'), false);
  assert.equal(isRhiOwnedRawHandle('apps/hello/triangle/src/main.ts', 'rawDevice'), false);
  assert.equal(isRhiOwnedRawHandle('apps/hello/debug-draw/src/main.ts', 'rawQueue'), true);
  assert.equal(
    isRhiOwnedRawHandle('apps/hello/m3-programmable-rendering/src/m10-browser.ts', 'host.device'),
    true,
  );
  assert.equal(isRhiOwnedRawHandle('packages/app/src/create-app.ts', 'host.device'), false);
});

import { afterAll, expect, it, vi } from 'vitest';
import { DAWN_CAPTURE_CASE } from '../original-frame-capture';

vi.stubEnv('FORGEAX_DAWN_CAPTURE_TEST', DAWN_CAPTURE_CASE);
await import('../vitest.setup-original-frame');
const originalHost = await vi.importActual<
  typeof import('@forgeax/engine-runtime/internal/renderer-host')
>('@forgeax/engine-runtime/internal/renderer-host');
const host = await import('@forgeax/engine-runtime/internal/renderer-host');
const originalReady = await vi.importActual<
  typeof import('../../scripts/test/ready-render-frame.mjs')
>('../../scripts/test/ready-render-frame.mjs');
const ready = await import('../../scripts/test/ready-render-frame.mjs');
afterAll(() => vi.unstubAllEnvs());

it('keeps the original public functions for every unselected test file', () => {
  expect(host.constructRuntimeRendererHost).toBe(originalHost.constructRuntimeRendererHost);
  expect(ready.drawReadyFrame).toBe(originalReady.drawReadyFrame);
});

import { expect, it } from 'vitest';
import { inspectRhiDeviceFacts } from '../device-facts.js';
import type { RhiCaps } from '../index.js';

it('does not infer array, depth or velocity usage from a backend or 2D float support', () => {
  const caps = { backendKind: 'webgpu', compute: true, rgba16floatRenderable: true } as RhiCaps;
  const facts = inspectRhiDeviceFacts(caps, {
    maxTextureDimension2D: 2048,
    maxTextureArrayLayers: 64,
  });
  expect(facts.formats.rgba16float.renderSample).toBe('supported');
  expect(facts.formats.rgba16float.arrayRenderSample).toBe('unvalidated');
  expect(facts.formats.depth32float.renderSample).toBe('unvalidated');
  expect(facts.limits.maxTextureArrayLayers).toBe(64);
});

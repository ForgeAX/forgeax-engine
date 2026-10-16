import { describe, expect, it } from 'vitest';
import { resolveDarkGradientBrowserBackend } from '../dark-gradient-fixture';

describe('dark-gradient browser backend identity contract', () => {
  it('accepts the normal browser WebGPU route only without a fallback hint', () => {
    expect(resolveDarkGradientBrowserBackend('webgpu', undefined)).toBe('browser-webgpu');
    expect(resolveDarkGradientBrowserBackend('webgpu', 'chromium-webgl2')).toBeUndefined();
  });

  it.each(['chromium-webgl2', 'webkit-webgl2'] as const)('accepts a real WebGL2 RHI with the %s provider hint', (hint) => {
    expect(resolveDarkGradientBrowserBackend('wgpu-webgl2', hint)).toBe(hint);
  });

  it.each([
    ['null', undefined],
    ['wgpu-native', undefined],
    ['wgpu-webgl2', undefined],
    ['wgpu-webgl2', 'browser-webgpu'],
  ] as const)('rejects actual backend=%s with hint=%s', (actual, hint) => {
    expect(resolveDarkGradientBrowserBackend(actual, hint)).toBeUndefined();
  });
});

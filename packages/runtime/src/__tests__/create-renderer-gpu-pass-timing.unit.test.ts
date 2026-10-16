import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { GpuPassTimingOptions, RendererOptions } from '@forgeax/engine-render';
import { describe, expect, it } from 'vitest';

describe('runtime GPU pass timing forwarding', () => {
  it('keeps one option object and projects the exact field to Render', () => {
    const gpuPassTiming = { maxPassesPerFrame: 8 } satisfies GpuPassTimingOptions;
    const options = { gpuPassTiming } satisfies RendererOptions;
    expect(options.gpuPassTiming).toBe(gpuPassTiming);
  });

  it('forwards without owning admission, sessions, handles, or CPU capture', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../createRenderer.ts', import.meta.url)),
      'utf8',
    );
    expect(source).toContain('constructRuntimeRendererHost(canvas, options, bundler)');
    expect(source).not.toContain('createGpuPassTimingSession');
    expect(source).not.toContain('ProfileCapture');
    expect(source).not.toContain('passCatalog');
  });
});

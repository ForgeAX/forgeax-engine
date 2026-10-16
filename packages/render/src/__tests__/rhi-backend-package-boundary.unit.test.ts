import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('render package backend identity boundary', () => {
  it('externalizes stateful RHI backends from the render bundle', async () => {
    const source = await readFile(new URL('../../tsup.config.ts', import.meta.url), 'utf8');

    expect(source).toContain("'@forgeax/engine-rhi-webgpu'");
    expect(source).toContain("'@forgeax/engine-rhi-wgpu'");
  });
});

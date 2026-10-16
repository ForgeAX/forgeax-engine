import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as rendererFactory from '../../../render/src/assembly/factory';

// This is a source/export contract. It creates no renderer, World, canvas, or
// device and must not retain the unrelated fixtures from the old merged suite.
describe('Renderer.draw(world) K-4 contract rewrite (D-S11)', () => {
  it('removes the RendererDrawTarget interface from the renderer source file', () => {
    const text = readFileSync(
      new URL('../../../render/src/assembly/webgpu-renderer.ts', import.meta.url),
      'utf8',
    );
    expect(text).not.toMatch(/interface RendererDrawTarget/);
    expect(text).not.toMatch(/RendererDrawTarget/);
    expect(rendererFactory).not.toHaveProperty('RendererDrawTarget');
  });
});

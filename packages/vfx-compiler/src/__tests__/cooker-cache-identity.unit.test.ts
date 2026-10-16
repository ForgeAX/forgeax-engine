import { describe, expect, it } from 'vitest';
import { createParticleCodeNativeCooker } from '../code-program.js';

describe('particle cooker DDC identity', () => {
  it('versions the compiler and canonical module inputs before cooking', async () => {
    const first = createParticleCodeNativeCooker({
      'a.wgsl': { entry: 'a', imports: { second: 'b', first: 'a' } },
      'b.wgsl': { entry: 'b' },
    });
    expect(first.cacheIdentity).toBeTypeOf('function');
    const identity = await first.cacheIdentity?.();
    expect(identity).toMatch(/^sha256:[a-f0-9]{64}$/);
    const reordered = createParticleCodeNativeCooker({
      'b.wgsl': { entry: 'b' },
      'a.wgsl': { entry: 'a', imports: { first: 'a', second: 'b' } },
    });
    expect(await reordered.cacheIdentity?.()).toBe(identity);
    const changed = createParticleCodeNativeCooker({
      'a.wgsl': { entry: 'a', imports: { second: 'changed', first: 'a' } },
      'b.wgsl': { entry: 'b' },
    });
    expect(await changed.cacheIdentity?.()).not.toBe(identity);
    const materialChanged = createParticleCodeNativeCooker(
      {
        'a.wgsl': { entry: 'a', imports: { second: 'b', first: 'a' } },
        'b.wgsl': { entry: 'b' },
      },
      { sparks: [{ name: 'tint', type: 'vec4<f32>', visibility: 'fragment', lane: 0 }] },
    );
    expect(await materialChanged.cacheIdentity?.()).not.toBe(identity);
  });
});

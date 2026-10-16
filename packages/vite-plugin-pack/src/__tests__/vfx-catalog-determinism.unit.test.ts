import { NativeCookerRegistry } from '@forgeax/engine-pack/native-cooker';
import { describe, expect, it } from 'vitest';

const input = { source: 'effect.vfx.wgsl', modules: ['b', 'a'] };

function createRegistry(): NativeCookerRegistry {
  const registry = new NativeCookerRegistry();
  registry.register({
    key: 'generated-effect',
    discover: (raw) => {
      if (typeof raw !== 'object' || raw === null || !('source' in raw)) {
        throw new Error('producer source is missing');
      }
      const value = raw as { source: string; modules?: string[] };
      return { source: value.source, modules: [...(value.modules ?? [])].sort() };
    },
    cook: (value: { readonly source: string; readonly modules: readonly string[] }) => ({
      guid: '019e9c00-0000-7000-8000-000000000020',
      payload: { source: value.source, modules: value.modules },
      refs: [],
      artifacts: {
        'generated-effect/program.json': {
          mediaType: 'application/json',
          bytes: new TextEncoder().encode(JSON.stringify(value)),
        },
      },
      inputFingerprint: `sha256:${value.source}`,
    }),
  });
  return registry;
}

describe('generated producer catalog determinism', () => {
  it('keeps candidate bytes and descriptor digests stable across cold runs', async () => {
    const first = await createRegistry().run('generated-effect', input);
    const second = await createRegistry().run('generated-effect', input);
    expect(first).toEqual(second);
    if (first.ok && second.ok) {
      expect(first.value.digest).toBe(second.value.digest);
      expect(first.value.receipt.outputDigest).toBe(second.value.receipt.outputDigest);
    }
  });

  it('fails closed when discovery input is missing', async () => {
    const result = await createRegistry().run('generated-effect', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('native-cook-failed');
  });
});

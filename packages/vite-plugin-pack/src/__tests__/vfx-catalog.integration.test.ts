import { NativeCookerRegistry } from '@forgeax/engine-pack/native-cooker';
import { describe, expect, it } from 'vitest';

describe('generated producer catalog integration', () => {
  it('publishes a typed candidate only after discovery and cook produce complete artifacts', async () => {
    const registry = new NativeCookerRegistry();
    registry.register({
      key: 'catalog-effect',
      discover: (raw) => ({
        sourceKey:
          typeof raw === 'object' && raw !== null && 'sourceKey' in raw
            ? String(raw.sourceKey)
            : '',
      }),
      cook: (input: { readonly sourceKey: string }) => ({
        guid: '019e9c00-0000-7000-8000-000000000030',
        payload: { kind: 'catalog-effect', sourceKey: input.sourceKey },
        refs: [],
        artifacts: {
          'catalog-effect/program.json': {
            mediaType: 'application/json',
            bytes: new TextEncoder().encode(JSON.stringify(input)),
          },
        },
        inputFingerprint: `sha256:${input.sourceKey}`,
      }),
    });

    const candidate = await registry.run('catalog-effect', { sourceKey: 'effect/main' });
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;
    expect(candidate.value.payload).toEqual({ kind: 'catalog-effect', sourceKey: 'effect/main' });
    expect(candidate.value.artifacts['catalog-effect/program.json']).toMatchObject({
      path: 'catalog-effect/program.json',
      mediaType: 'application/json',
    });
    expect(candidate.value.receipt.inputFingerprint).toBe('sha256:effect/main');
  });
});

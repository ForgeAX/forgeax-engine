import { describe, expect, it } from 'vitest';
import { NativeCookerRegistry } from '../native-cooker-registry.js';

describe('NativeCookerRegistry artifact boundary', () => {
  it('keeps native artifact bytes available before converting to CookProduct descriptors', async () => {
    const bytes = new TextEncoder().encode('{"program":true}');
    const registry = new NativeCookerRegistry();
    registry.register({
      key: 'test-effect',
      cook: () => ({
        guid: '019e9c00-0000-7000-8000-000000000000',
        payload: { kind: 'test-effect' },
        refs: ['019e9c00-0000-7000-8000-000000000001'],
        artifacts: {
          'test-effect/program.json': { mediaType: 'application/json', bytes },
        },
        inputFingerprint: 'sha256:test-input',
      }),
    });

    const draft = await registry.runDraft('test-effect', {});
    expect(draft.ok).toBe(true);
    if (!draft.ok) throw new Error(draft.error.hint);
    expect(draft.value.artifacts['test-effect/program.json']?.bytes).toEqual(bytes);

    const product = await registry.run('test-effect', {});
    expect(product.ok).toBe(true);
    if (!product.ok) throw new Error(product.error.hint);
    expect(product.value.artifacts['test-effect/program.json']).toMatchObject({
      path: 'test-effect/program.json',
      mediaType: 'application/json',
      byteLength: bytes.byteLength,
    });
  });

  it('discovers a typed producer input before cooking and preserves the typed output contract', async () => {
    const registry = new NativeCookerRegistry();
    registry.register({
      key: 'typed-effect',
      discover: (input) => {
        if (typeof input !== 'object' || input === null || !('source' in input)) {
          throw new Error('source is required');
        }
        return { source: String(input.source), revision: 3 };
      },
      cook: (input: { readonly source: string; readonly revision: number }) => ({
        guid: '019e9c00-0000-7000-8000-000000000010',
        payload: { source: input.source, revision: input.revision },
        refs: [],
        artifacts: {
          'typed-effect/program.json': {
            mediaType: 'application/json',
            bytes: new TextEncoder().encode(JSON.stringify(input)),
          },
        },
        inputFingerprint: `sha256:${input.source}`,
      }),
    });

    const result = await registry.runDraft('typed-effect', { source: 'module.wgsl' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.payload).toEqual({ source: 'module.wgsl', revision: 3 });
  });

  it('retains structured diagnostics when a producer throws a non-Error value', async () => {
    const registry = new NativeCookerRegistry();
    registry.register({
      key: 'structured-failure',
      cook: () => {
        throw { code: 'producer-schema-invalid', stage: 'cook', detail: 'missing field' };
      },
    });

    const result = await registry.runDraft('structured-failure', {});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected producer failure');
    expect(result.error.detail.producer).toContain('producer-schema-invalid');
    expect(result.error.detail.producer).not.toContain('[object Object]');
  });
});

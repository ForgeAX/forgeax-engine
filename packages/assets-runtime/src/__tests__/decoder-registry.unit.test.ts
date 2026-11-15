import { type AssetDecoder, type AssetDecoderInput, ok } from '@forgeax/engine-types';
import { createUiLoader, type UiAsset, uiAssetContribution } from '@forgeax/engine-ui';
import { describe, expect, it } from 'vitest';
import { defineAssetKind } from '../asset-kind';
import { DecoderRegistry } from '../internal/decoder-registry';

const kind = defineAssetKind<{ value: number }>('test-payload');
const input: AssetDecoderInput<{ value: number }> = {
  envelope: { guid: 'fixture', kind: kind.kind, payload: { value: 1 }, refs: [], artifacts: {} },
  artifacts: {
    read: async () => {
      throw new Error('unexpected artifact');
    },
  },
  signal: new AbortController().signal,
};
const decoder: AssetDecoder<{ value: number }> = {
  decode: async ({ envelope }) => ok(envelope.payload),
};

describe('one owner decoder per kind', () => {
  it('composes UI host and gameplay leases without replacing either owner', async () => {
    const registry = new DecoderRegistry();
    const { kind: uiKind, decoder: uiDecoder } = uiAssetContribution;
    const host = registry.install(uiKind, uiDecoder);
    const gameplay = registry.install(uiKind, uiDecoder);
    const uiInput: AssetDecoderInput<UiAsset> = {
      ...input,
      envelope: {
        ...input.envelope,
        kind: 'ui',
        payload: { guid: 'fixture', html: '<p>HUD</p>', css: 'p { color: red; }' },
      },
    };
    expect(() => registry.install(uiKind, createUiLoader())).toThrow(/duplicate decoder kind/);
    gameplay.dispose();
    expect((await registry.load(uiKind, uiInput)).unwrap()).toEqual(uiInput.envelope.payload);
    host.dispose();
    expect(await registry.load(uiKind, uiInput)).toMatchObject({
      ok: false,
      error: { code: 'asset-decoder-missing' },
    });
  });

  it('adopts the decoder output in place and freezes its plain nodes', async () => {
    const registry = new DecoderRegistry();
    const binary = defineAssetKind<{ bytes: Uint8Array; meta: { n: number } }>('binary');
    const handed = { bytes: new Uint8Array([1, 2]), meta: { n: 1 } };
    registry.install(binary, { decode: async () => ok(handed) });
    const result = (
      await registry.load(binary, {
        ...input,
        envelope: { ...input.envelope, kind: binary.kind, payload: handed },
      })
    ).unwrap();
    expect(result).toBe(handed);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.meta)).toBe(true);
    expect(result.bytes).toEqual(new Uint8Array([1, 2]));
  });
  it('retains repeated leases of the same owner and releases them independently', async () => {
    const registry = new DecoderRegistry();
    const a = registry.install(kind, decoder),
      b = registry.install(kind, decoder);
    a.dispose();
    a.dispose();
    expect((await registry.load(kind, input)).unwrap()).toEqual({ value: 1 });
    b.dispose();
    expect(await registry.load(kind, input)).toMatchObject({
      ok: false,
      error: { code: 'asset-decoder-missing' },
    });
  });
  it('rejects a competing owner and permits it only after the prior lease is released', async () => {
    const registry = new DecoderRegistry();
    const a = registry.install(kind, decoder);
    const replacement = { decode: async () => ok({ value: 2 }) };
    expect(() => registry.install(kind, replacement)).toThrow(/duplicate decoder kind/);
    expect((await registry.load(kind, input)).unwrap().value).toBe(1);
    a.dispose();
    registry.install(kind, replacement);
    expect((await registry.load(kind, input)).unwrap().value).toBe(2);
  });
  it('rejects malformed contributions at installation', () => {
    const registry = new DecoderRegistry();
    expect(() => registry.install(defineAssetKind(''), decoder)).toThrow(TypeError);
    expect(() =>
      registry.install(kind, { decode: 1 } as unknown as AssetDecoder<{ value: number }>),
    ).toThrow(TypeError);
  });
  it('rejects an in-flight result after its exact owner lease retires', async () => {
    const registry = new DecoderRegistry();
    let resume: (() => void) | undefined;
    const lease = registry.install(kind, {
      decode: async () => {
        await new Promise<void>((resolve) => {
          resume = resolve;
        });
        return ok({ value: 1 });
      },
    });
    const pending = registry.load(kind, input);
    lease.dispose();
    registry.install(kind, decoder);
    resume?.();
    expect(await pending).toMatchObject({ ok: false, error: { code: 'asset-superseded' } });
  });
  it('passes verified asset-local input and freezes accepted ordinary payloads', async () => {
    const registry = new DecoderRegistry();
    registry.install(kind, {
      decode: async (value) => {
        expect(value).toBe(input);
        expect(value).not.toHaveProperty('catalog');
        return ok(value.envelope.payload);
      },
    });
    const result = (await registry.load(kind, input)).unwrap();
    expect(Object.isFrozen(result)).toBe(true);
    expect(() => {
      result.value = 3;
    }).toThrow(TypeError);
    expect(result.value).toBe(1);
  });
});

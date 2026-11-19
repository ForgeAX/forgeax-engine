import { type AssetDecoderInput, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { defineAssetKind } from '../asset-kind';
import { adoptAssetData, copyAssetData } from '../internal/asset-data';
import { DecoderRegistry } from '../internal/decoder-registry';
import { freezeRuntimePayload } from '../internal/immutable-payload';

const kind = defineAssetKind<Record<string, unknown>>('frozen-capture');

function inputFor(payload: unknown): AssetDecoderInput<Record<string, unknown>> {
  return {
    envelope: {
      guid: 'fixture',
      kind: kind.kind,
      payload: payload as never,
      refs: [],
      artifacts: {},
    },
    artifacts: {
      read: async () => {
        throw new Error('unexpected artifact');
      },
    },
    signal: new AbortController().signal,
  };
}

/** A verified Pack document: owner-parsed JSON, deep-frozen before any decoder sees it. */
function packPayload(): { passes: object; parameters: object } {
  const pack = freezeRuntimePayload(
    JSON.parse(
      JSON.stringify({
        schemaVersion: '2.0.0',
        kind: 'internal-text-package',
        assets: [
          {
            guid: 'asset-0',
            kind: 'frozen-capture',
            payload: {
              kind: 'frozen-capture',
              passes: [{ name: 'forward', states: { cull: 'back', depth: [1, 2, 3] } }],
              parameters: [{ name: 'baseColor', type: 'vec4f', value: [1, 1, 1, 1] }],
            },
          },
        ],
      }),
    ),
  ) as { assets: { payload: { passes: object; parameters: object } }[] };
  const payload = pack.assets[0]?.payload;
  if (payload === undefined) throw new Error('missing payload');
  return payload;
}

/** One decode through the owner boundary. */
async function decode(value: () => Record<string, unknown>): Promise<Record<string, unknown>> {
  const registry = new DecoderRegistry();
  registry.install(kind, { decode: async () => ok(value()) });
  return (await registry.load(kind, inputFor({}))).unwrap();
}

describe('decoder boundary keeps immutable content by identity', () => {
  it('shares verified Pack JSON with the decoded payload instead of copying it', async () => {
    const payload = packPayload();
    const result = await decode(() => ({ kind: 'frozen-capture', ...payload, extra: { a: 1 } }));
    expect(result.passes).toBe(payload.passes);
    expect(result.parameters).toBe(payload.parameters);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.extra)).toBe(true);
  });

  it('adopts the decoder output in place, freezing plain nodes and keeping binary storage', async () => {
    const retained = {
      bytes: new Uint8Array([1, 2, 3]),
      open: { value: 1 },
      list: [{ n: 1 }],
    };
    const result = (await decode(() => retained)) as typeof retained;
    expect(result).toBe(retained);
    expect(result.bytes).toBe(retained.bytes);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.open)).toBe(true);
    expect(Object.isFrozen(result.list[0])).toBe(true);
  });

  it('holders share an adopted node and private copies stay independent', async () => {
    const payload = packPayload();
    const make = () => ({ ...payload, mesh: { vertices: new Float32Array([1, 2, 3]) } });
    const first = await decode(make);
    const second = await decode(make);
    expect(first.passes).toBe(second.passes);
    expect(() => {
      (first.passes as unknown[]).push({});
    }).toThrow(TypeError);
    const owned = copyAssetData(first) as typeof first & {
      passes: { name: string }[];
      mesh: { vertices: Float32Array };
    };
    expect(owned.passes).not.toBe(first.passes);
    owned.passes[0] = { name: 'mutated' };
    owned.mesh.vertices[0] = 9;
    structuredClone(owned.mesh.vertices, { transfer: [owned.mesh.vertices.buffer] });
    expect(owned.mesh.vertices.byteLength).toBe(0);
    expect((first.passes as { name: string }[])[0]?.name).toBe('forward');
    expect([...(first.mesh as { vertices: Float32Array }).vertices]).toEqual([1, 2, 3]);
  });

  it('keeps validating the content it adopts', () => {
    const getter = Object.defineProperty({}, 'value', { get: () => 1, enumerable: true });
    const symbol = { [Symbol('s')]: 1 };
    const fn = { run: () => 1 };
    for (const value of [getter, symbol, fn])
      expect(() => adoptAssetData({ value })).toThrow(TypeError);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => adoptAssetData(cyclic)).toThrow(/cycle/);
    const tree = packPayload();
    expect(adoptAssetData(tree)).toBe(tree);
    expect(adoptAssetData(tree)).toBe(tree);
  });
});

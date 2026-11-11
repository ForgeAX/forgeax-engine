import { type AssetDecoderInput, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { defineAssetKind } from '../asset-kind';
import { copyAssetData, freezeAssetData } from '../internal/asset-data';
import { DecoderRegistry } from '../internal/decoder-registry';
import { freezeRuntimePayload } from '../internal/immutable-payload';
import { freezePackValue } from '../internal/pack-reader';
import { parseRetainedPackJson } from '../internal/retained-pack-json';
import { shareVerifiedArtifactBytes } from '../internal/shared-immutable';

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
  const pack = freezePackValue(
    parseRetainedPackJson(
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

function describeTree(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  return {
    frozen: Object.isFrozen(value),
    prototype: Object.getPrototypeOf(value) === Array.prototype ? 'array' : 'object',
    length: Array.isArray(value) ? value.length : undefined,
    fields: Object.entries(Object.getOwnPropertyDescriptors(value))
      .filter(([key]) => !(Array.isArray(value) && key === 'length'))
      .map(([key, descriptor]) => [
        key,
        descriptor.writable,
        descriptor.configurable,
        describeTree(descriptor.value),
      ]),
  };
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

  it('copies every node the decoder could still change', async () => {
    const retained = {
      bytes: new Uint8Array([1, 2, 3]),
      open: { value: 1 },
      // Frozen, but holding a private binary view: the view is mutable storage.
      sealed: Object.freeze({ samples: new Float32Array([4, 5]) }),
      // Frozen, but holding a mutable child.
      shallow: Object.freeze({ child: { value: 2 } }),
    };
    const result = (await decode(() => retained)) as typeof retained;
    retained.bytes[0] = 9;
    retained.open.value = 9;
    retained.sealed.samples[0] = 9;
    retained.shallow.child.value = 9;
    expect([...result.bytes]).toEqual([1, 2, 3]);
    expect(result.open.value).toBe(1);
    expect([...result.sealed.samples]).toEqual([4, 5]);
    expect(result.shallow.child.value).toBe(2);
    expect(result.sealed).not.toBe(retained.sealed);
    expect(result.shallow).not.toBe(retained.shallow);
  });

  it('isolates holders that mutate or transfer their own copies', async () => {
    const payload = packPayload();
    const shared = shareVerifiedArtifactBytes('sha256:frozen-capture-a', new Uint8Array([7, 8]));
    const program = Object.freeze({ bytes: shared, entry: 'vs_main' });
    const make = () => ({
      ...payload,
      program,
      mesh: { vertices: new Float32Array([1, 2, 3]) },
    });
    const first = await decode(make);
    const second = await decode(make);
    expect(first.passes).toBe(second.passes);
    expect(first.program).toBe(program);
    expect(second.program).toBe(program);
    expect((first.mesh as { vertices: Float32Array }).vertices).not.toBe(
      (second.mesh as { vertices: Float32Array }).vertices,
    );
    // A shared node is immutable for every holder.
    expect(() => {
      (first.passes as unknown[]).push({});
    }).toThrow(TypeError);
    // Records adopt, and public reads return, private mutable copies.
    const owned = copyAssetData(first) as typeof first & {
      passes: { name: string }[];
      mesh: { vertices: Float32Array };
    };
    expect(owned.passes).not.toBe(first.passes);
    owned.passes[0] = { name: 'mutated' };
    owned.mesh.vertices[0] = 9;
    structuredClone(owned.mesh.vertices, { transfer: [owned.mesh.vertices.buffer] });
    expect(owned.mesh.vertices.byteLength).toBe(0);
    for (const holder of [first, second]) {
      expect((holder.passes as { name: string }[])[0]?.name).toBe('forward');
      expect([...(holder.mesh as { vertices: Float32Array }).vertices]).toEqual([1, 2, 3]);
    }
    expect(payload.passes).toEqual([
      { name: 'forward', states: { cull: 'back', depth: [1, 2, 3] } },
    ]);
  });

  it('produces the same tree as a frozen private copy', () => {
    const nullPrototype = Object.freeze(Object.assign(Object.create(null), { a: 1 }));
    const sparse = Object.freeze(Object.assign(new Array<number>(4), { 0: 1, 2: 3 }));
    const trailing = Object.freeze(Object.assign(new Array<number>(3), { 0: 1, 1: 2 }));
    const extra = Object.freeze(Object.assign([1, 2], { label: 'x' }));
    const cases: unknown[] = [
      packPayload(),
      { nullPrototype, sparse, trailing, extra },
      Object.freeze({ nested: Object.freeze([Object.freeze({ a: [1] })]) }),
      Object.freeze({ deep: Object.freeze({ ok: true, list: Object.freeze(['a', null]) }) }),
      7,
      'text',
      null,
    ];
    for (const value of cases) {
      expect(describeTree(freezeAssetData(value))).toEqual(
        describeTree(freezeRuntimePayload(copyAssetData(value))),
      );
    }
    const kept = freezeAssetData({ nullPrototype, sparse, trailing, extra }) as Record<
      string,
      unknown
    >;
    expect(kept.nullPrototype).not.toBe(nullPrototype);
    expect(Object.getPrototypeOf(kept.nullPrototype)).toBe(Object.prototype);
    expect(kept.sparse).not.toBe(sparse);
    expect((kept.sparse as unknown[]).length).toBe((copyAssetData(sparse) as unknown[]).length);
    expect(kept.trailing).not.toBe(trailing);
    expect(kept.extra).not.toBe(extra);
  });

  it('keeps validating content it shares', () => {
    const getter = Object.freeze(
      Object.defineProperty({}, 'value', { get: () => 1, enumerable: true }),
    );
    const symbol = Object.freeze({ [Symbol('s')]: 1 });
    const fn = Object.freeze({ run: () => 1 });
    for (const value of [getter, symbol, fn])
      expect(() => freezeAssetData({ value })).toThrow(TypeError);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    Object.freeze(cyclic);
    expect(() => freezeAssetData(cyclic)).toThrow(/cycle/);
    const tree = packPayload();
    expect(freezeAssetData(tree)).toBe(tree);
    expect(freezeAssetData(tree)).toBe(tree);
  });
});

import type { MaterialPass } from '@forgeax/engine-types';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import {
  createMaterialProgramSetDigest,
  type MaterialCookProgram,
} from '../evidence/material-cook.js';

// The serialization this owner used before canonical text reuse; digests must not change.
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function jsonValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return [...value];
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => compare(a, b))
        .map(([key, entry]) => [key, jsonValue(entry)]),
    );
  }
  return value;
}
function legacyDigest(programs: readonly unknown[], passes: unknown): string {
  const manifest = {
    passes: jsonValue(passes),
    programs: (programs as MaterialCookProgram[])
      .map((program) => ({
        artifact: {
          digest: program.artifact.digest,
          mediaType: program.artifact.mediaType,
          path: program.artifact.path,
        },
        selections: program.selections
          .map(jsonValue)
          .sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b))),
        specializationKey: program.specializationKey,
      }))
      .sort((a, b) => compare(a.specializationKey, b.specializationKey)),
  };
  return `sha256:${bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(manifest))))}`;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !ArrayBuffer.isView(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const context = {
  backend: 'webgpu',
  capability: 'storage-buffer',
  pipeline: 'forward',
  geometry: 'mesh',
  pass: 'forward',
  profile: 'forgeax-material-wgsl-v1',
  toolchain: 'naga-oil',
  instrumentation: 'none',
};

function abi(seed: number): Record<string, unknown> {
  return {
    directEntry: 'vs_main',
    sceneIndexEntry: seed % 2 === 0 ? undefined : 'vs_scene',
    materialRow: { byteLength: 16 * seed, fields: ['b', 'a', `f${seed}`], addressUnitBytes: 16 },
    vertexInputs: [{ semantic: 'color', location: seed, format: 'float32x4' }],
    '10': 'ten',
    '2': ['two', null, undefined, Number.NaN, -0, 1e21],
    __proto__x: {
      [String.fromCharCode(0xe9)]: String.fromCharCode(0xfc, 0x2028),
      [String.fromCharCode(0)]: true,
    },
    ownProto: JSON.parse('{"__proto__":{"z":1},"y":2}'),
    callback: () => 1,
    nested: [[1, [2, [3]]], {}, []],
  };
}

function programs(seed: number, freeze: boolean): MaterialCookProgram[] {
  const shared = abi(seed);
  if (freeze) deepFreeze(shared);
  return ['zeta', 'alpha', `k${seed}`].map((key, index) => ({
    specializationKey: key,
    artifact: {
      path: `${key}.wgsl`,
      mediaType: 'text/wgsl',
      digest: `sha256:${key}`,
      bytes: new Uint8Array([index, seed]),
    },
    selections: [
      { pass: 'forward', context: { ...context, geometry: 'skinned' }, abi: shared },
      { pass: 'forward', context, abi: shared, extra: new Uint8Array([3, 2, 1]) },
      { pass: 'shadow', context: { ...context, pass: 'shadow' }, entry: undefined },
    ],
  })) as unknown as MaterialCookProgram[];
}

function passes(seed: number): MaterialPass[] {
  return [
    { name: 'forward', program: { module: `m${seed}` }, renderState: { '1': 1, a: [seed] } },
    { name: 'shadow', program: { module: 'shadow', moduleSlots: { b: 'x', a: 'y' } } },
  ] as unknown as MaterialPass[];
}

describe('material program-set digest reuse', () => {
  it('matches the previous serialization for frozen, mutable, and byte inputs', () => {
    for (let seed = 1; seed <= 6; seed += 1) {
      for (const freeze of [false, true]) {
        const input = programs(seed, freeze);
        const pass = freeze ? deepFreeze(passes(seed)) : passes(seed);
        const expected = legacyDigest(input, pass);
        expect(createMaterialProgramSetDigest(input, pass)).toBe(expected);
        // A second, memoized call must return the same digest.
        expect(createMaterialProgramSetDigest(input, pass)).toBe(expected);
      }
    }
  });

  it('observes mutations of non-frozen inputs after a digest was computed', () => {
    const input = programs(3, false);
    const pass = passes(3);
    const before = createMaterialProgramSetDigest(input, pass);
    const selection = input[0]?.selections[0] as unknown as { abi: { materialRow: object } };
    (selection.abi.materialRow as { byteLength: number }).byteLength = 4096;
    const after = createMaterialProgramSetDigest(input, pass);
    expect(after).not.toBe(before);
    expect(after).toBe(legacyDigest(input, pass));
  });

  it('never caches frozen objects with accessors or mutable children', () => {
    let accessorValue = 1;
    const accessor = Object.freeze(
      Object.defineProperty({}, 'value', { enumerable: true, get: () => accessorValue }),
    );
    const mutableChild = { value: 1 };
    const frozenParent = Object.freeze({ child: mutableChild });
    const input = programs(2, true);
    const extended = input.map((program) => ({
      ...program,
      selections: program.selections.map((selection) => ({
        ...selection,
        accessor,
        frozenParent,
      })),
    })) as unknown as MaterialCookProgram[];
    const pass = passes(2);
    const first = createMaterialProgramSetDigest(extended, pass);
    expect(first).toBe(legacyDigest(extended, pass));
    accessorValue = 2;
    const second = createMaterialProgramSetDigest(extended, pass);
    expect(second).not.toBe(first);
    expect(second).toBe(legacyDigest(extended, pass));
    mutableChild.value = 2;
    const third = createMaterialProgramSetDigest(extended, pass);
    expect(third).not.toBe(second);
    expect(third).toBe(legacyDigest(extended, pass));
  });

  it('keeps toJSON, sparse, and non-string inputs on the exact previous path', () => {
    const pass = passes(4);
    const withToJson = programs(4, true).map((program) => ({
      ...program,
      selections: [
        ...program.selections,
        { pass: 'forward', context, abi: { toJSON: () => 'replaced', other: 1 } },
      ],
    })) as unknown as MaterialCookProgram[];
    expect(createMaterialProgramSetDigest(withToJson, pass)).toBe(legacyDigest(withToJson, pass));
    // biome-ignore lint/suspicious/noSparseArray: sparse arrays serialize holes as null.
    const sparse = [1, , 3];
    const withHoles = programs(5, false).map((program) => ({
      ...program,
      selections: [...program.selections, { pass: 'forward', context, sparse }],
    })) as unknown as MaterialCookProgram[];
    expect(createMaterialProgramSetDigest(withHoles, pass)).toBe(legacyDigest(withHoles, pass));
    const unusual = programs(6, false).map((program, index) => ({
      ...program,
      specializationKey: index === 0 ? undefined : program.specializationKey,
    })) as unknown as MaterialCookProgram[];
    expect(createMaterialProgramSetDigest(unusual, pass)).toBe(legacyDigest(unusual, pass));
    expect(createMaterialProgramSetDigest(programs(6, false), undefined as never)).toBe(
      legacyDigest(programs(6, false), undefined),
    );
  });
});

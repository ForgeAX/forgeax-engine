import { createHash } from 'node:crypto';
import { isShaderReflection, type ShaderReflection } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import {
  expandShaderManifestPublication,
  readOwnedShaderManifestPublication,
  readShaderManifestPublication,
  shaderSourceDigestInput,
} from '../manifest-publication';

function reflection(uvSetCount = 0) {
  return {
    schemaVersion: 'shader-reflection/3',
    uvSetCount,
    boundGlobals: [
      {
        group: 0,
        binding: 2,
        addressSpace: 'storage',
        resourceKind: 'storage-buffer',
        visibility: 4,
        members: [],
        span: 0,
        elementStride: 16,
        elementType: 'vec4<f32>',
        typeDescriptor: {
          kind: 'array',
          size: { kind: 'dynamic' },
          stride: 16,
          byteSize: 16,
          alignment: 16,
          element: {
            kind: 'vector',
            scalarKind: 'float',
            width: 4,
            components: 4,
            byteSize: 16,
            alignment: 16,
          },
        },
      },
    ],
  };
}
function publication<T>(reflections: T[]) {
  const wgsl = 'fn shared_reflection() {}';
  const digest = createHash('sha256')
    .update(shaderSourceDigestInput([createHash('sha256').update(wgsl).digest()]))
    .digest('hex');
  return {
    schemaVersion: '5.0.0',
    receipts: [],
    entryPoints: [],
    fragments: [wgsl],
    sources: { [digest]: [0] },
    reflections,
    entries: reflections.map((_, index) => ({
      hash: `entry-${index}`,
      bindings: '[]',
      sourceDigest: digest,
      reflectionIndex: index,
    })),
    materialShaders: [],
  };
}
async function admit(reflections: unknown[]) {
  const value = (await readShaderManifestPublication(publication(reflections))) as {
    entries: { reflection: ShaderReflection & Record<string, unknown> }[];
  };
  return value.entries.map((entry) => entry.reflection);
}

it('shares complete detached reflection facts within one publication without pruning table rows', async () => {
  const input = [reflection(0), reflection(1)];
  expect(input.every(isShaderReflection)).toBe(true);
  const pending = admit(input);
  const binding = input[0]?.boundGlobals[0];
  if (binding === undefined) throw new Error('Missing reflected binding');
  binding.visibility = 2;
  const [first, second] = await pending;
  expect(first).not.toBe(second);
  expect(first?.uvSetCount).toBe(0);
  expect(second?.uvSetCount).toBe(1);
  expect(first?.boundGlobals).toBe(second?.boundGlobals);
  expect(first?.boundGlobals[0]?.visibility).toBe(4);
  expect(Object.isFrozen(first?.boundGlobals[0]?.typeDescriptor)).toBe(true);
  expect(first?.boundGlobals).not.toBe(input[0]?.boundGlobals);
  const changed = await admit(input);
  expect(changed[0]?.boundGlobals[0]?.visibility).toBe(2);
  expect(changed[0]?.boundGlobals).not.toBe(first?.boundGlobals);
  expect(first?.boundGlobals[0]?.visibility).toBe(4);
});

it('preserves signed zero, omitted properties, order, multiplicity and unusual property names', async () => {
  const a = {
    ...reflection(),
    extension: JSON.parse('{"zero":-0,"list":["a","b","a"],"__proto__":{"kept":true}}'),
  };
  const b = { ...reflection(), extension: { zero: 0, list: ['a', 'a', 'b'] } };
  const values = await admit([a, b, reflection()]);
  expect(Object.is((values[0]?.extension as { zero: number }).zero, -0)).toBe(true);
  expect(Object.is((values[1]?.extension as { zero: number }).zero, 0)).toBe(true);
  expect((values[0]?.extension as { list: string[] }).list).toEqual(['a', 'b', 'a']);
  expect(Object.hasOwn(values[0]?.extension ?? {}, '__proto__')).toBe(true);
  expect((values[1]?.extension as { list: string[] }).list).toEqual(['a', 'a', 'b']);
  expect(Object.hasOwn(values[2] ?? {}, 'extension')).toBe(false);
  expect(values[0]?.boundGlobals).toBe(values[1]?.boundGlobals);
});

it('retains sparse slots, property order and shared descendants during fact admission', async () => {
  const leaf = { names: ['roughness', 'normal'] };
  const sparse = new Array<unknown>(3);
  sparse[1] = undefined;
  sparse[2] = leaf;
  const input = [
    { ...reflection(0), extension: { first: leaf, second: leaf, sparse } },
    {
      ...reflection(1),
      extension: { first: { names: [...leaf.names] }, second: leaf, sparse: [...sparse] },
    },
    { ...reflection(2), extension: { second: leaf, first: leaf, sparse } },
  ];
  const values = await admit(input);
  const [first, second, third] = values.map(
    (row) => row.extension as (typeof input)[0]['extension'],
  );
  expect(first?.first).toBe(first?.second);
  expect(first?.first).toBe(second?.first);
  expect(first?.sparse).not.toBe(second?.sparse);
  expect(Object.hasOwn(first?.sparse ?? [], 0)).toBe(false);
  expect(Object.hasOwn(first?.sparse ?? [], 1)).toBe(true);
  expect(Object.hasOwn(second?.sparse ?? [], 0)).toBe(true);
  expect(Object.keys(first ?? {})).toEqual(['first', 'second', 'sparse']);
  expect(Object.keys(third ?? {})).toEqual(['second', 'first', 'sparse']);
  expect(first).not.toBe(third);
  expect(Object.isFrozen(first?.sparse)).toBe(true);
  expect(Object.isFrozen(first?.first.names)).toBe(true);
  expect(Object.isFrozen(leaf)).toBe(false);
});

it('keeps owned null-prototype facts distinct from equal ordinary object facts', async () => {
  const dictionary = Object.assign(Object.create(null), { field: ['normal'] });
  const value = publication([
    { ...reflection(0), extension: dictionary },
    { ...reflection(1), extension: { field: ['normal'] } },
    { ...reflection(2), extension: Object.assign(Object.create(null), { field: ['normal'] }) },
  ]);
  const accepted = (await readOwnedShaderManifestPublication(value)) as {
    entries: { reflection: { extension: { field: string[] } } }[];
  };
  const [first, second, third] = accepted.entries.map((entry) => entry.reflection.extension);
  expect(Object.getPrototypeOf(first)).toBeNull();
  expect(Object.getPrototypeOf(second)).toBe(Object.prototype);
  expect(first).not.toBe(second);
  expect(first).toBe(third);
  expect(first?.field).toBe(second?.field);
  expect(Object.isFrozen(first)).toBe(true);
});

it('falls back atomically for cyclic extension data after ordinary fact descendants', async () => {
  const extension: { label: string; self?: unknown } = { label: 'cycle' };
  extension.self = extension;
  const values = await admit([
    { ...reflection(0), extension },
    { ...reflection(1), extension: { label: 'ordinary' } },
  ]);
  const accepted = values[0]?.extension as typeof extension;
  expect(accepted).not.toBe(extension);
  expect(accepted.self).toBe(accepted);
  expect(Object.isFrozen(accepted)).toBe(true);
  // A rejected structural-sharing candidate keeps the original detached-copy graph.
  expect(values[0]?.boundGlobals).not.toBe(values[1]?.boundGlobals);
  expect(Object.isFrozen(extension)).toBe(false);
});

it('does not merge non-plain extension values or introduce cross-publication retention', async () => {
  const input = { ...reflection(), extension: new Date(0) };
  const values = await admit([input, { ...reflection(), extension: new Date(0) }]);
  expect(values[0]?.extension).toBeInstanceOf(Date);
  expect(values[0]?.extension).not.toBe(input.extension);
  expect(values[0]?.extension).not.toBe(values[1]?.extension);
  const first = await admit([reflection()]);
  const second = await admit([reflection()]);
  expect(second[0]?.boundGlobals).not.toBe(first[0]?.boundGlobals);
});

it('takes explicit reflection ownership without deferring any reflection validation', () => {
  const input = publication([reflection(0), reflection(1)]);
  const expanded = expandShaderManifestPublication(input, { ownedReflections: true }).manifest as {
    entries: { reflection: ShaderReflection }[];
  };
  expect(expanded.entries[0]?.reflection).toBe(input.reflections[0]);
  expect(expanded.entries[1]?.reflection).toBe(input.reflections[1]);
  expect(Object.isFrozen(input.reflections)).toBe(true);
  expect(Object.isFrozen(input.reflections[0]?.boundGlobals)).toBe(true);
  expect(input.reflections[0]?.boundGlobals).toBe(input.reflections[1]?.boundGlobals);

  const valid = reflection();
  const invalid = publication([valid, { ...reflection(), schemaVersion: 'invalid' }]);
  expect(() => expandShaderManifestPublication(invalid, { ownedReflections: true })).toThrow(
    'Invalid shader manifest publication',
  );
  expect(Object.isFrozen(valid.boundGlobals)).toBe(false);
});

it('shares repeated immutable subtrees for deferred owned reflections while retaining row identity', async () => {
  const input = JSON.parse(JSON.stringify(publication([reflection(0), reflection(1)])));
  const result = (await readOwnedShaderManifestPublication(input)) as {
    entries: { reflection: ShaderReflection }[];
  };
  const [first, second] = result.entries.map((entry) => entry.reflection);
  expect(first).not.toBe(second);
  expect(first?.uvSetCount).toBe(0);
  expect(second?.uvSetCount).toBe(1);
  expect(first?.boundGlobals).toBe(second?.boundGlobals);
  expect(Object.isFrozen(first?.boundGlobals[0]?.typeDescriptor)).toBe(true);
  const next = (await readOwnedShaderManifestPublication(
    JSON.parse(JSON.stringify(publication([reflection(0), reflection(1)]))),
  )) as typeof result;
  expect(next.entries[0]?.reflection.boundGlobals).not.toBe(first?.boundGlobals);
  const malformed = (await readOwnedShaderManifestPublication(
    publication([{ ...reflection(), schemaVersion: 'invalid' }]),
  )) as typeof result;
  expect(() => malformed.entries[0]?.reflection).toThrow('Invalid shader manifest publication');
});

it('coalesces duplicate JSON row children before recursively interning their descendants', async () => {
  const input = JSON.parse(JSON.stringify(publication([reflection(0), reflection(1)])));
  const redundant = input.reflections[1].boundGlobals;
  const keys = vi.spyOn(Object, 'keys');
  try {
    const result = (await readOwnedShaderManifestPublication(input)) as {
      entries: { reflection: ShaderReflection }[];
    };
    // The safety walk still sees every value; structural interning must not
    // traverse the second copy after lossless JSON coalescing replaces it.
    expect(keys.mock.calls.filter(([value]) => value === redundant)).toHaveLength(1);
    expect(result.entries[0]?.reflection.boundGlobals).toBe(
      result.entries[1]?.reflection.boundGlobals,
    );
    expect(Object.isFrozen(result.entries[0]?.reflection.boundGlobals)).toBe(true);
    expect(input.reflections[1].boundGlobals).not.toBe(redundant);
  } finally {
    keys.mockRestore();
  }
});

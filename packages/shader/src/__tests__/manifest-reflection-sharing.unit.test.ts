import { createHash } from 'node:crypto';
import { isShaderReflection, type ShaderReflection } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { readShaderManifestPublication, shaderSourceDigestInput } from '../manifest-publication';

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
function publication(reflections: unknown[]) {
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

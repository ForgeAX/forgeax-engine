import { expect, it } from 'vitest';
import { isShaderEntryPointReads } from '../runtime-contracts';

const scalar = { kind: 'scalar', scalarKind: 'float', width: 4, byteSize: 4, alignment: 4 };
const vector = (components: number) => ({
  kind: 'vector',
  scalarKind: 'float',
  width: 4,
  components,
  byteSize: components * 4,
  alignment: components === 2 ? 8 : 16,
});
function facts() {
  return {
    schemaVersion: 'shader-value-member-reads/1',
    structs: [
      {
        typeDescriptor: {
          kind: 'struct',
          name: 'Input',
          span: 32,
          byteSize: 32,
          alignment: 16,
          members: [
            {
              name: 'uv',
              type: 'vec2<f32>',
              offset: 0,
              size: 8,
              alignment: 8,
              typeDescriptor: vector(2),
            },
            {
              name: 'view',
              type: 'vec3<f32>',
              offset: 16,
              size: 12,
              alignment: 16,
              typeDescriptor: vector(3),
            },
            {
              name: 'time',
              type: 'f32',
              offset: 28,
              size: 4,
              alignment: 4,
              typeDescriptor: scalar,
            },
          ],
        },
        fields: ['uv'],
        consumerGlobals: [{ kind: 'bound', group: 1, binding: 0 }],
      },
    ],
  };
}
const row = (valueReads: unknown) => [{ name: 'fs', stage: 'fragment', bindings: [], valueReads }];

it('retains v3 legacy unknown metadata while admitting explicit complete member facts', () => {
  expect(isShaderEntryPointReads([{ name: 'fs', stage: 'fragment', bindings: [] }])).toBe(true);
  expect(isShaderEntryPointReads(row(facts()))).toBe(true);
});

it.each([
  (value: ReturnType<typeof facts>) => {
    value.schemaVersion = 'unsupported-version';
  },
  (value: ReturnType<typeof facts>) => {
    Object.assign(value.structs[0] ?? {}, { fields: ['missing'] });
  },
  (value: ReturnType<typeof facts>) => {
    Object.assign(value.structs[0] ?? {}, { fields: ['uv', 'uv'] });
  },
  (value: ReturnType<typeof facts>) => {
    Object.assign(value.structs[0] ?? {}, { typeDescriptor: undefined });
  },
  (value: ReturnType<typeof facts>) => {
    Object.assign(value.structs[0]?.typeDescriptor ?? {}, { span: -1 });
  },
  (value: ReturnType<typeof facts>) => {
    const first = value.structs[0];
    if (first !== undefined) value.structs.push(first);
  },
  (value: ReturnType<typeof facts>) => {
    Object.assign(value.structs[0] ?? {}, { consumerGlobals: [{ kind: 'bound', group: 1 }] });
  },
  (value: ReturnType<typeof facts>) => {
    Object.assign(value.structs[0] ?? {}, { consumerGlobals: [{ kind: 'unbound', name: 'x' }] });
  },
  (value: ReturnType<typeof facts>) => {
    Object.assign(value.structs[0] ?? {}, { consumerGlobals: [{ kind: 'unknown' }] });
  },
])('rejects malformed optional value facts without weakening the legacy binding contract: %s', (change) => {
  const value = facts();
  change(value);
  expect(isShaderEntryPointReads(row(value))).toBe(false);
});

it('does not cache frozen entry shells while their member facts remain mutable', () => {
  const value = facts();
  const entries = Object.freeze([
    Object.freeze({
      name: 'fs',
      stage: 'fragment',
      bindings: Object.freeze([]),
      valueReads: value,
    }),
  ]);
  expect(isShaderEntryPointReads(entries)).toBe(true);
  value.schemaVersion = 'mutated-version';
  expect(isShaderEntryPointReads(entries)).toBe(false);
});

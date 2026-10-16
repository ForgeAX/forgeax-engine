import { describe, expect, it } from 'vitest';
import {
  derive,
  getAdmittedParamSchemaInterface,
  ParamSchemaProjectionOwner,
} from '../derive-paramschema';

describe('immutable schema reference', () => {
  const reference = () =>
    new ParamSchemaProjectionOwner().admit({
      ownerId: 'reference',
      revision: 1,
      schema: [
        { name: 'value', type: 'f32' },
        { name: 'map', type: 'texture2d' },
      ],
    });

  it('reuses the admitted derivation only after an exact current shape capture', () => {
    const owned = reference();
    const schema = structuredClone(owned.schema).map((entry) => ({ ...entry }));
    expect(derive(schema, owned.schema)).toBe(owned.derivedInterface);
    expect(derive(schema)).toBe(owned.derivedInterface);
    expect(getAdmittedParamSchemaInterface(schema)).toBeUndefined();
    const first = schema[0];
    if (first === undefined) throw new Error('missing first field');
    first.name = 'changed';
    const changed = derive(schema, owned.schema);
    expect(changed).not.toBe(owned.derivedInterface);
    expect(changed.numericMembers[0]?.name).toBe('changed');
  });

  it('does not reinterpret defaults or texture sample types through the hint', () => {
    const owned = reference();
    const schema = [
      { name: 'value', type: 'f32' as const, default: 17 },
      { name: 'map', type: 'texture2d' as const },
    ];
    expect(derive(schema, owned.schema)).toBe(owned.derivedInterface);
    expect(schema[0]?.default).toBe(17);
    const sample = [
      { name: 'value', type: 'f32' as const },
      { name: 'map', type: 'texture2d' as const, sampleType: 'unfilterable-float' as const },
    ];
    const changed = derive(sample, owned.schema);
    expect(changed).not.toBe(owned.derivedInterface);
    expect(changed.layoutIdentity).not.toBe(owned.derivedInterface.layoutIdentity);
    expect(changed.bglEntries[2]?.texture?.sampleType).toBe('unfilterable-float');
  });

  it('leaves an unadmitted or incompatible hint on the original path', () => {
    const owned = reference();
    const schema = structuredClone(owned.schema);
    const rawHint = structuredClone(owned.schema);
    expect(derive(schema, rawHint)).not.toBe(owned.derivedInterface);
    const other = [{ name: 'other', type: 'vec4' as const }];
    expect(derive(other, owned.schema).uboLayout).toEqual(derive(structuredClone(other)).uboLayout);
    expect(() =>
      derive(
        [
          { name: 'value', type: 'f32' },
          { name: 'value', type: 'f32' },
        ],
        owned.schema,
      ),
    ).toThrow('duplicate');
  });

  it('keeps three capacity observations and all entry reads before deciding on the reference', () => {
    const owned = reference();
    const raw = structuredClone(owned.schema).map((entry) => ({ ...entry }));
    let lengths = 0;
    const schema = new Proxy(raw, {
      get(target, key, receiver) {
        if (key === 'length' && ++lengths === 3) {
          const first = target[0];
          if (first === undefined) throw new Error('missing first field');
          first.name = 'changed-at-third-length';
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const result = derive(schema, owned.schema);
    expect(result).not.toBe(owned.derivedInterface);
    expect(result.numericMembers[0]?.name).toBe('changed-at-third-length');
    expect(lengths).toBe(6);
  });

  it('does not catch a field getter failure or read a later field', () => {
    const owned = reference();
    const error = new Error('first name failed');
    const trace: string[] = [];
    const schema = [
      {
        get name(): string {
          trace.push('name');
          throw error;
        },
        get type(): 'f32' {
          trace.push('type');
          return 'f32';
        },
      },
    ];
    expect(() => derive(schema, owned.schema)).toThrow(error);
    expect(trace).toEqual(['name']);
    expect(() =>
      derive([{ name: 'map', type: 'texture2d', sampleType: 'invalid' as 'float' }], owned.schema),
    ).toThrow('invalid texture sample type');
  });
});

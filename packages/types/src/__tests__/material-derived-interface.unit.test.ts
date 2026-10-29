import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  derive,
  deriveObserved,
  getAdmittedParamSchemaInterface,
  ParamSchemaProjectionOwner,
} from '../derive-paramschema.js';
import type { ParamSchemaEntry } from '../index.js';

const CHARACTERIZATION_RECEIPT =
  '/tmp/forgeax-material-reflection-m1-owner-abi-characterization.json';

const coordinate = (name: string) => ({
  parameter: name,
  offset: 0,
  size: 48,
  alignment: 16,
  transformMember: `${name}CoordinatesTransform`,
  metadataMember: `${name}CoordinatesMetadata`,
  rotationMember: `${name}CoordinatesRotation`,
});

describe('derived material interface contract matrix', () => {
  it('matches native SHA-256 across UTF-8 names and multiple layout blocks', () => {
    for (const count of [0, 1, 2, 7, 16, 63, 64, 65, 129]) {
      const schema: ParamSchemaEntry[] = Array.from({ length: count }, (_, index) => ({
        name: `field_${index}_${'x'.repeat(index % 65)}_\u03bb`,
        type: index % 3 === 0 ? 'texture2d' : index % 3 === 1 ? 'vec3' : 'f32',
      }));
      const output = derive(schema);
      const canonical = JSON.stringify({
        version: 2,
        bglEntries: output.bglEntries,
        numericMembers: output.numericMembers,
        coordinateRecords: output.coordinateRecords,
        resourceBindings: output.resourceBindings,
        totalBytes: output.totalBytes,
        bindingSpans: output.bindingSpans,
        userRegion: output.userRegion,
      });
      expect(output.layoutIdentity).toBe(
        `sha256-${createHash('sha256').update(canonical).digest('hex')}`,
      );
    }
  });

  it.each([
    { type: 'sampler', default: null },
    { type: 'storage_buffer', default: {} },
    { type: 'texture2d', default: [] },
  ])('rejects resource defaults consistently before publication: $type', (entry) => {
    const owner = new ParamSchemaProjectionOwner();
    const schema = [{ name: 'resource', ...entry }] as unknown as ParamSchemaEntry[];
    expect(() => owner.admit({ ownerId: 'invalid-resource', revision: 1, schema })).toThrow(
      `ParamSchemaProjectionOwner: resource (${entry.type}) cannot declare a default`,
    );
    expect(owner.get('invalid-resource', 1)).toBeUndefined();
  });

  it('derives a self-contained empty interface', () => {
    const output = derive([]);

    expect(output.schemaVersion).toBe('material-abi/1');
    expect(output.group).toBe(1);
    expect(output.visibility).toBe(2);
    expect(output.numericMembers).toEqual([]);
    expect(output.coordinateRecords).toEqual([]);
    expect(output.resourceBindings).toEqual([]);
    expect(output.totalBytes).toBe(0);
    expect(output.layoutIdentity).toMatch(/^sha256-[0-9a-f]{64}$/);
  });

  it('publishes a read-only type index under the same schema owner and mutation fence', () => {
    const schema: ParamSchemaEntry[] = [
      { name: 'scalar', type: 'f32', default: 1 },
      { name: 'volume', type: 'texture3d' },
    ];
    const first = derive(schema);
    expect(first.layoutIdentity).toBe(
      'sha256-5f3823c203a85a6487f19608669ffc28f4f321133ebc6ed947ec0580e4d32e1c',
    );
    expect([...first.parameterTypes]).toEqual([
      ['scalar', 'f32'],
      ['volume', 'texture3d'],
    ]);
    expect(() =>
      (first.parameterTypes as Map<string, string>).set('volume', 'texture2d'),
    ).toThrow();
    schema[0] = { name: 'scalar', type: 'f32', default: 2 };
    expect(derive(schema).parameterTypes).toBe(first.parameterTypes);
    schema[1] = { name: 'volume', type: 'texture_cube' };
    const changed = derive(schema);
    expect(changed.parameterTypes.get('volume')).toBe('texture_cube');
    expect(first.parameterTypes.get('volume')).toBe('texture3d');
    const owner = new ParamSchemaProjectionOwner();
    const admitted = owner.admit({ ownerId: 'type-index', revision: 1, schema });
    expect(derive(admitted.schema).parameterTypes).toBe(admitted.derivedInterface.parameterTypes);
    schema[1] = { name: 'scalar', type: 'texture_cube' };
    expect(() => derive(schema)).toThrow(/duplicate/);
    expect(derive(admitted.schema).parameterTypes.get('volume')).toBe('texture_cube');
  });

  it('identifies only admissions from the existing schema owner', () => {
    const schema = [{ name: 'texture', type: 'texture_cube' as const }];
    expect(getAdmittedParamSchemaInterface(schema)).toBeUndefined();
    derive(schema);
    expect(getAdmittedParamSchemaInterface(schema)).toBeUndefined();
    const frozen = Object.freeze([
      Object.freeze({ name: 'texture', type: 'texture_cube' as const }),
    ]);
    expect(getAdmittedParamSchemaInterface(frozen)).toBeUndefined();
    const owner = new ParamSchemaProjectionOwner();
    const admitted = owner.admit({ ownerId: 'authority', revision: 1, schema });
    expect(getAdmittedParamSchemaInterface(admitted.schema)).toBe(admitted.derivedInterface);
    expect(getAdmittedParamSchemaInterface([...admitted.schema])).toBeUndefined();
  });

  it('records binding spans and the user-region boundary in the ABI projection', () => {
    const output = derive([
      { name: 'exposure', type: 'f32' },
      { name: 'albedo', type: 'texture2d' },
    ]);

    expect(output.bindingSpans).toEqual([
      { group: 1, binding: 0, start: 0, end: 64 },
      { group: 1, binding: 1, start: 0, end: 0 },
      { group: 1, binding: 2, start: 0, end: 0 },
    ]);
    expect(output.userRegion).toEqual({ group: 1, bindingStart: 0, bindingEnd: 3 });
  });

  it('derives numeric-only std140 members from schema order', () => {
    const output = derive([
      { name: 'roughness', type: 'f32' },
      { name: 'tint', type: 'vec3' },
    ]);

    expect(output.numericMembers).toEqual([
      { name: 'roughness', offset: 0, size: 4, alignment: 4, type: 'f32' },
      { name: 'tint', offset: 16, size: 12, alignment: 16, type: 'vec3' },
    ]);
    expect(output.coordinateRecords).toEqual([]);
    expect(output.totalBytes).toBe(32);
  });

  it('derives one coordinate record and its paired resources for texture-only schema', () => {
    const output = derive([{ name: 'albedo', type: 'texture2d' }]);

    expect(output.coordinateRecords).toEqual([coordinate('albedo')]);
    expect(output.resourceBindings).toEqual([
      { name: 'albedo_sampler', parameter: 'albedo', kind: 'sampler', binding: 1 },
      { name: 'albedo', parameter: 'albedo', kind: 'texture', binding: 2 },
    ]);
    expect(output.bglEntries.map((entry) => entry.binding)).toEqual([0, 1, 2]);
    expect(output.totalBytes).toBe(48);
  });

  it('derives array and volume texture bindings with their authored view dimensions', () => {
    const output = derive([
      { name: 'layers', type: 'texture2d_array' },
      { name: 'volume', type: 'texture3d' },
    ]);

    expect(output.bglEntries).toEqual([
      { binding: 0, visibility: 0x2, buffer: { type: 'uniform' } },
      { binding: 1, visibility: 0x2, sampler: { type: 'filtering' } },
      {
        binding: 2,
        visibility: 0x2,
        texture: { sampleType: 'float', viewDimension: '2d-array', multisampled: false },
      },
      { binding: 3, visibility: 0x2, sampler: { type: 'filtering' } },
      {
        binding: 4,
        visibility: 0x2,
        texture: { sampleType: 'float', viewDimension: '3d', multisampled: false },
      },
    ]);
    expect(output.resourceBindings.map((entry) => entry.name)).toEqual([
      'layers_sampler',
      'layers',
      'volume_sampler',
      'volume',
    ]);
  });

  it('keeps numeric members and coordinate records non-overlapping when interleaved', () => {
    const output = derive([
      { name: 'exposure', type: 'f32' },
      { name: 'albedo', type: 'texture2d' },
      { name: 'tint', type: 'vec4' },
      { name: 'normal', type: 'texture2d' },
    ]);

    expect(
      output.numericMembers.map((member) => [member.name, member.offset, member.size]),
    ).toEqual([
      ['exposure', 0, 4],
      ['tint', 64, 16],
    ]);
    expect(output.coordinateRecords).toEqual([
      { ...coordinate('albedo'), offset: 16 },
      { ...coordinate('normal'), offset: 80 },
    ]);
    expect(output.totalBytes).toBe(128);
    expect(output.resourceBindings.map((resource) => resource.binding)).toEqual([1, 2, 3, 4]);
  });

  it('preserves the byte-80 and byte-96 regions in one derived payload', () => {
    const output = derive([
      { name: 'brick0', type: 'vec4' },
      { name: 'brick1', type: 'vec4' },
      { name: 'brick2', type: 'vec4' },
      { name: 'brick3', type: 'vec4' },
      { name: 'brick4', type: 'vec4' },
      { name: 'byte80', type: 'f32' },
      { name: 'byte96', type: 'vec4' },
    ]);

    expect(output.numericMembers.find((member) => member.name === 'byte80')).toMatchObject({
      offset: 80,
      size: 4,
    });
    expect(output.numericMembers.find((member) => member.name === 'byte96')).toMatchObject({
      offset: 96,
      size: 16,
    });
    expect(output.totalBytes).toBe(112);
  });

  it('uses the same identity for repeated derivation and different shader consumers', () => {
    const schema = [
      { name: 'baseColor', type: 'color' as const },
      { name: 'albedo', type: 'texture2d' as const },
    ];

    const first = derive(schema);
    const second = derive(schema);
    const differentShaderConsumer = derive(schema);

    expect(second).toBe(first);
    expect(first.layoutIdentity).toBe(differentShaderConsumer.layoutIdentity);
  });

  it('reuses only an unchanged name/type shape and keeps the result immutable', () => {
    const schema: ParamSchemaEntry[] = [
      { name: '__fallback_cache_value', type: 'f32', default: 0 },
    ];
    const first = derive(schema);

    schema[0] = { name: '__fallback_cache_value', type: 'f32', default: 1 };
    expect(derive(schema)).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.bglEntries)).toBe(true);
    expect(Object.isFrozen(first.uboLayout)).toBe(true);

    schema[0] = { name: '__fallback_cache_renamed', type: 'f32' };
    const changed = derive(schema);
    expect(changed).not.toBe(first);
    expect(changed.uboLayout.entries[0]?.name).toBe('__fallback_cache_renamed');

    schema[0] = { name: '', type: 'f32' };
    expect(() => derive(schema)).toThrow(/name/i);

    schema[0] = { name: '__fallback_cache_restored', type: 'f32' };
    expect(derive(schema).uboLayout.entries[0]?.name).toBe('__fallback_cache_restored');
  });

  it('observes fallback derivation, SHA, and identity-cache hits separately', () => {
    const schema: ParamSchemaEntry[] = [{ name: '__fallback_cache_observer', type: 'vec4' }];
    const events: string[] = [];
    const observer = {
      enabled: true,
      observe: ({ kind }: { readonly kind: string }) => events.push(kind),
    };

    deriveObserved(schema, observer, 'types-test');
    deriveObserved(schema, observer, 'types-test');

    expect(events).toEqual([
      'unregistered-fallback-derive',
      'fallback-layout-sha',
      'fallback-cache-hit',
    ]);
  });

  it('admits one immutable projection per owner revision', () => {
    const owner = new ParamSchemaProjectionOwner();
    const authored = [
      { name: 'baseColor', type: 'color' as const, default: [1, 1, 1, 1] },
      { name: 'albedo', type: 'texture2d' as const },
    ];

    const first = owner.admit({ ownerId: 'test::material', revision: 1, schema: authored });
    const originalDefault = authored[0]?.default;
    if (originalDefault === undefined) throw new Error('missing fixture default');
    originalDefault[0] = 7;
    expect(first.schema[0]).toMatchObject({ default: [1, 1, 1, 1] });
    const numeric = first.schema[0];
    if (numeric === undefined || !('default' in numeric)) throw new Error('missing numeric entry');
    expect(Object.isFrozen(numeric.default)).toBe(true);
    expect(first.schema[1]).not.toHaveProperty('default');
    authored[0] = { name: 'mutated', type: 'color', default: [0, 0, 0, 0] };
    const repeated = owner.admit({
      ownerId: 'test::material',
      revision: 1,
      schema: [
        { name: 'baseColor', type: 'color', default: [1, 1, 1, 1] },
        { name: 'albedo', type: 'texture2d' },
      ],
    });

    expect(repeated).toBe(first);
    expect(first.schema[0]?.name).toBe('baseColor');
    expect(Object.isFrozen(first.schema)).toBe(true);
    expect(Object.isFrozen(first.schema[0])).toBe(true);
    expect(Object.isFrozen(first.derivedInterface)).toBe(true);
    expect(derive(first.schema)).toBe(first.derivedInterface);
    expect(owner.stats()).toEqual({ admissions: 2, derivations: 1, projections: 1 });
  });

  it('rejects schema content changes that reuse an owner revision', () => {
    const owner = new ParamSchemaProjectionOwner();
    owner.admit({
      ownerId: 'test::material',
      revision: 1,
      schema: [{ name: 'baseColor', type: 'color' }],
    });

    expect(() =>
      owner.admit({
        ownerId: 'test::material',
        revision: 1,
        schema: [{ name: 'roughness', type: 'f32' }],
      }),
    ).toThrow(/reused with different schema content/);
  });

  it('reuses validated immutable schema facts in another owner without admitting mutable copies', () => {
    const first = new ParamSchemaProjectionOwner();
    const admitted = first.admit({
      ownerId: 'source::material',
      revision: 1,
      schema: [{ name: 'factor', type: 'f32', default: 0.5 }],
    });
    const next = new ParamSchemaProjectionOwner();
    const shared = next.admit({
      ownerId: 'receiver::material',
      revision: 1,
      schema: admitted.schema,
    });
    expect(shared.ownerId).toBe('receiver::material');
    expect(shared.schema).toBe(admitted.schema);
    expect(shared.derivedInterface).toBe(admitted.derivedInterface);
    expect(next.stats()).toEqual({ admissions: 1, derivations: 0, projections: 1 });
    // An equal mutable copy is never admitted by identity; it shares the
    // already frozen schema and derivation of the same exact content.
    const copied = structuredClone(admitted.schema);
    const mutable = next.admit({ ownerId: 'receiver::copy', revision: 1, schema: copied });
    expect(mutable.schema).not.toBe(copied);
    expect(mutable.schema).toBe(admitted.schema);
    expect(mutable.derivedInterface).toBe(admitted.derivedInterface);
    expect(next.stats()).toEqual({ admissions: 2, derivations: 0, projections: 2 });
    (copied[0] as { default: number }).default = 0.25;
    expect(mutable.schema[0]).toMatchObject({ default: 0.5 });
    const changed = next.admit({ ownerId: 'receiver::changed', revision: 1, schema: copied });
    expect(changed.schema).not.toBe(admitted.schema);
    expect(next.stats()).toEqual({ admissions: 3, derivations: 1, projections: 3 });
    // A lossy JSON spelling (an undefined field) never selects shared content.
    const plain = next.admit({
      ownerId: 'receiver::plain',
      revision: 1,
      schema: [{ name: 'factor', type: 'f32' }],
    });
    const lossy = next.admit({
      ownerId: 'receiver::lossy',
      revision: 1,
      // Runtime inputs can still carry an own undefined field.
      schema: [{ name: 'factor', type: 'f32', default: undefined } as unknown as ParamSchemaEntry],
    });
    expect(lossy.schema).not.toBe(plain.schema);
    expect(Object.hasOwn(lossy.schema[0] as object, 'default')).toBe(true);
    expect(next.stats()).toEqual({ admissions: 5, derivations: 3, projections: 5 });
    expect(() =>
      next.admit({
        ownerId: 'receiver::material',
        revision: 1,
        schema: [{ name: 'factor', type: 'f32', default: 0.75 }],
      }),
    ).toThrow('different schema content');
  });

  it('serializes current ABI owner gaps as intermediate evidence', async () => {
    const schema = [
      { name: 'roughness', type: 'f32' as const },
      { name: 'albedo', type: 'texture2d' as const },
    ];
    const output = derive(schema);
    const receipt = {
      schemaVersion: 'material-reflection-characterization/1',
      status: 'intermediate',
      owner: 'types/material/derive-paramschema',
      observations: [
        {
          id: 'material-abi-derived-layout',
          status: 'observed',
          layoutIdentity: output.layoutIdentity,
          totalBytes: output.totalBytes,
          resourceBindings: output.resourceBindings,
        },
        {
          id: 'group-visibility-identity',
          status: 'expected-failure',
          observed: 'derive accepts no group or visibility inputs',
          evidence: { layoutIdentity: output.layoutIdentity },
        },
        {
          id: 'user-region-identity',
          status: 'observed',
          userRegionBindingEnd: output.userRegionBindingEnd,
        },
      ],
    } as const;

    await writeFile(CHARACTERIZATION_RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`);
    expect(receipt.schemaVersion).toBe('material-reflection-characterization/1');
    expect(receipt.status).toBe('intermediate');
    expect(receipt.observations).toHaveLength(3);
    expect(receipt.observations[1]?.status).toBe('expected-failure');
  });
});

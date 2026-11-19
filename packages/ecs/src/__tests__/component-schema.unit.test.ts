import { describe, expect, it } from 'vitest';
import {
  FieldShapeContainerFixture,
  FieldShapePrimitiveFixture,
} from '../__fixtures__/field-shape-fixture';
import {
  assertComponentStorage,
  type Component,
  componentDefinition,
  componentSchema,
  deepFreeze,
  defineComponent,
  isSchemaVocabKeyword,
  parseManagedArraySchema,
  type SchemaFieldType,
} from '../component';

describe('component-schema', () => {
  it.each([
    ['f32', 'number', 'f32', 1, false],
    ['f64', 'number', 'f64', 1, false],
    ['i32', 'number', 'i32', 1, false],
    ['u32', 'number', 'u32', 1, false],
    ['i16', 'number', 'i16', 1, false],
    ['u16', 'number', 'u16', 1, false],
    ['i8', 'number', 'i8', 1, false],
    ['u8', 'number', 'u8', 1, false],
    ['bool', 'bool', 'bool', 1, false],
    ['enum', 'number', 'enum', 1, false],
    ['entity', 'entity', 'u32', 1, false],
    ['string', 'string', 'u32', 1, true],
    ['unique<Resource>', 'unique', 'u32', 1, true],
    ['shared<Resource>', 'shared', 'u32', 1, true],
    ['asset<mesh>', 'asset', 'u32', 1, true],
    ['array<u8>', 'array', 'u32', 3, true],
    ['array<u8, 64>', 'fixed-array', 'u8', 64, false],
    ['array<f32>', 'array', 'u32', 3, true],
    ['array<f32, 16>', 'fixed-array', 'f32', 16, false],
    ['array<entity>', 'array', 'u32', 3, true],
    ['array<entity, 4>', 'fixed-array', 'u32', 4, false],
    ['array<shared<Resource>>', 'array', 'u32', 3, true],
    ['array<shared<Resource>, 4>', 'fixed-array', 'u32', 4, true],
    ['array<asset<mesh>>', 'array', 'u32', 3, true],
    ['array<asset<mesh>, 4>', 'fixed-array', 'u32', 4, true],
  ] as const)('compiles %s storage and lifetime once', (type, kind, storage, arity, releases) => {
    const component = defineComponent(`FieldLayout_${type}`, { value: type });
    const plan = componentDefinition(component).plan.fields.value;
    expect(plan).toMatchObject({ kind, storage, arity, releases });
    expect(Object.isFrozen(plan)).toBe(true);
    if (plan?.kind === 'array' || plan?.kind === 'fixed-array') {
      const Ctor = type.includes('<f32')
        ? Float32Array
        : type.includes('<u8')
          ? Uint8Array
          : Uint32Array;
      expect(plan.element.viewCtor).toBe(Ctor);
      expect(plan.element.byteSize).toBe(Ctor.BYTES_PER_ELEMENT);
      expect(plan.element.storage).toBe(
        Ctor === Float32Array ? 'f32' : Ctor === Uint8Array ? 'u8' : 'u32',
      );
      expect(Object.isFrozen(plan.element)).toBe(true);
    }
  });

  it.each([
    'unknown-field-type',
    'buffer<abc>',
  ])('rejects invalid %s before layout compilation', (type) => {
    expect(() => defineComponent('InvalidFieldLayout', { value: type } as never)).toThrow();
  });

  it.each([
    'array<u8>',
    'array<u8, 8>',
  ] as const)('keeps %s byte semantics over the sequence storage layout', (type) => {
    const component = defineComponent('ByteSequenceLayout', { value: type });
    const definition = componentDefinition(component);
    const plan = definition.plan.fields.value;
    expect(definition.fields.value?.arrayMeta).toBe(plan?.array);
    expect(definition.plan.hasArrayField).toBe(true);
    expect(plan?.array).toEqual({
      elementType: 'u8',
      ...(type === 'array<u8>' ? {} : { length: 8 }),
    });
    expect(Object.isFrozen(plan?.array)).toBe(true);
    expect(plan?.element).toEqual({ storage: 'u8', viewCtor: Uint8Array, byteSize: 1 });
  });

  describe('component schema contract', () => {
    it('deep freezes nested field facts and owner defaults', () => {
      const component = defineComponent('SchemaFreeze', {
        mode: { type: 'enum', default: 1, labels: { idle: 0, run: 1 } },
        payload: { type: 'array<f32, 2>', default: [1, 2] as never },
      });

      expect(Object.isFrozen(component.fields)).toBe(true);
      expect(Object.isFrozen(component.fields.mode)).toBe(true);
      expect(Object.isFrozen(component.fields.mode?.labels)).toBe(true);
      const defaults = componentDefinition(component).defaults;
      expect(Object.isFrozen(defaults)).toBe(true);
      expect(Object.isFrozen(defaults?.payload)).toBe(true);
    });

    it('keeps the public token surface to name, fields, and storage', () => {
      const component = defineComponent('ComponentSurface', { value: 'f32' });
      expect(Object.keys(component)).toEqual(['name', 'fields', 'storage']);
      expect(Reflect.ownKeys(component)).toEqual(['name', 'fields', 'storage']);
      expect(Object.getPrototypeOf(component)).toBe(Object.prototype);
      expect('schema' in component).toBe(false);
      expect('id' in component).toBe(false);
      expect('defaults' in component).toBe(false);
      expect('toSchemaJSON' in component).toBe(false);
    });

    it('accepts only the closed table/sparse storage vocabulary', () => {
      expect(() => assertComponentStorage('table')).not.toThrow();
      expect(() => assertComponentStorage('sparse')).not.toThrow();
      expect(() => assertComponentStorage('columnar')).toThrow(/Expected 'table' or 'sparse'/);
      expect(deepFreeze({ nested: { value: 1 } }).nested).toEqual({ value: 1 });
    });

    it('treats typed arrays and ArrayBuffer as immutable leaf projections', () => {
      const values = new Float32Array([1, 2]);
      const buffer = new ArrayBuffer(8);

      const projected = deepFreeze({ values, buffer });
      expect(Object.isFrozen(projected)).toBe(true);
      expect(Object.isFrozen(values)).toBe(false);
      expect(Object.isFrozen(buffer)).toBe(false);
      expect(values[0]).toBe(1);
      expect(buffer.byteLength).toBe(8);
    });

    it('rejects an invalid runtime storage value before registration', () => {
      expect(() =>
        defineComponent('InvalidStorage', {}, { storage: 'columnar' as 'table' }),
      ).toThrow(/Expected 'table' or 'sparse'/);
    });
  });
});

describe('field-enum-labels-reflection', () => {
  function fieldLabels(
    comp: Component,
    field: string,
  ): Readonly<Record<string, number>> | undefined {
    const reflection = comp.fields[field as keyof typeof comp.fields] as
      | { readonly labels?: Readonly<Record<string, number>> }
      | undefined;
    return reflection?.labels;
  }

  describe('field-level enum-labels reflection (solo round-24)', () => {
    it('(a) an enum field declared with labels reflects the label→value map', () => {
      const C = defineComponent('R24_EnumLabelsA', {
        type: { type: 'enum', default: 1, labels: { static: 0, dynamic: 1, kinematic: 2 } },
        mass: { type: 'f32', default: 1 },
      });

      expect(fieldLabels(C, 'type')).toEqual({ static: 0, dynamic: 1, kinematic: 2 });
    });

    it('(b) a non-enum / label-less field reflects labels as absent (control)', () => {
      const C = defineComponent('R24_EnumLabelsB', {
        type: { type: 'enum', default: 1, labels: { static: 0, dynamic: 1, kinematic: 2 } },
        mass: { type: 'f32', default: 1 },
      });

      // exactOptionalPropertyTypes: undeclared → absence (undefined), not {}.
      expect(fieldLabels(C, 'mass')).toBeUndefined();
    });

    it('(c) bare-keyword field form leaves labels absent', () => {
      const C = defineComponent('R24_EnumLabelsC', {
        shape: 'enum',
      });

      expect(fieldLabels(C, 'shape')).toBeUndefined();
    });

    it('(d) the reflected labels map is frozen (a stable read-only projection)', () => {
      const source = { static: 0, dynamic: 1, kinematic: 2 };
      const C = defineComponent('R24_EnumLabelsD', {
        type: { type: 'enum', default: 0, labels: source },
      });

      const labels = fieldLabels(C, 'type');
      expect(Object.isFrozen(labels)).toBe(true);
      // Copied, not aliased: mutating the source afterward does not leak in.
      (source as Record<string, number>).extra = 9;
      expect(labels).toEqual({ static: 0, dynamic: 1, kinematic: 2 });
    });
  });
});

describe('field-transient-reflection', () => {
  // `transient` is a field-level reflection fact (w2 adds it to FieldReflection).
  // Read it off the concrete component product without widening to `any`.
  function fieldTransient(comp: Component, field: string): boolean | undefined {
    const reflection = comp.fields[field as keyof typeof comp.fields] as
      | { readonly transient?: boolean }
      | undefined;
    return reflection?.transient;
  }

  describe('w1 — field-level transient reflection (AC-01)', () => {
    it('(a) a field declared transient:true reflects transient===true at runtime', () => {
      const C = defineComponent('W1_FieldTransientA', {
        keep: { type: 'f32', default: 0 },
        derived: { type: 'array<f32, 16>', default: new Float32Array(16), transient: true },
      });

      // Runtime-readable through FieldReflection (component.ts:1048-1052).
      expect(fieldTransient(C, 'derived')).toBe(true);
    });

    it('(b) a field without a transient declaration reflects transient as absent (control)', () => {
      const C = defineComponent('W1_FieldTransientB', {
        keep: { type: 'f32', default: 0 },
        derived: { type: 'array<f32, 16>', default: new Float32Array(16), transient: true },
      });

      // exactOptionalPropertyTypes: undeclared fields never carry an explicit
      // transient key -- absence (undefined), not `false`.
      expect(fieldTransient(C, 'keep')).toBeUndefined();
    });

    it('(c) bare-keyword field form leaves transient absent', () => {
      const C = defineComponent('W1_FieldTransientC', {
        x: 'f32',
        y: 'f32',
      });

      expect(fieldTransient(C, 'x')).toBeUndefined();
      expect(fieldTransient(C, 'y')).toBeUndefined();
    });
  });
});

describe('field-shape-fixture', () => {
  describe('R0-03A producer-owned field-shape fixtures', () => {
    it('covers every required field shape through component reflection', () => {
      const primitive = FieldShapePrimitiveFixture.fields;
      const container = FieldShapeContainerFixture.fields;

      expect({
        scalar: primitive.scalar.shape,
        boolean: primitive.enabled.shape,
        enum: primitive.mode.shape,
        vector: primitive.vector.shape,
        quaternion: primitive.quaternion.shape,
        array: primitive.values.shape,
        'asset-ref': primitive.material.shape,
        optional: container.optionalEntity.shape,
        nested: container.nestedState.shape,
      }).toEqual({
        scalar: 'scalar',
        boolean: 'boolean',
        enum: 'enum',
        vector: 'vector',
        quaternion: 'quaternion',
        array: 'array',
        'asset-ref': 'asset-ref',
        optional: 'optional',
        nested: 'nested',
      });
    });

    it('keeps storage type, defaults, and enum labels alongside the shape tag', () => {
      expect(componentSchema(FieldShapePrimitiveFixture)).toMatchObject({
        scalar: 'f32',
        enabled: 'bool',
        mode: 'enum',
        vector: 'array<f32, 3>',
        quaternion: 'array<f32, 4>',
        values: 'array<f32>',
        material: 'asset<material>',
      });
      expect(componentDefinition(FieldShapePrimitiveFixture).defaults).toMatchObject({
        scalar: 0,
        enabled: false,
        mode: 0,
      });
      expect(FieldShapePrimitiveFixture.fields.mode.labels).toEqual({ idle: 0, active: 1 });
    });
  });
});

describe('deprecated-vocab-rejection', () => {
  describe('unsupported schema vocabulary', () => {
    it('rejects the legacy handle vocabulary with asset migration hints', () => {
      // gate-allow:ecs-brand
      let caught: unknown;
      try {
        defineComponent('w25HandleSample', { f: { type: 'handle<MeshAsset>' } } as never); // gate-allow:ecs-brand
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeDefined();
      const e = caught as { code: string; hint: string };
      expect(e.code).toBe('schema-unsupported-field');
      expect(e.hint).toContain('asset<kind>');
      expect(e.hint).toContain('AssetRegistry');
    });

    it('rejects the legacy reference vocabulary with unique migration hints', () => {
      // gate-allow:ecs-brand
      let caught: unknown;
      try {
        defineComponent('w25RefSample', { f: { type: 'ref<PhysicsBody>' } } as never); // gate-allow:ecs-brand
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeDefined();
      const e = caught as { code: string; hint: string };
      expect(e.code).toBe('schema-unsupported-field');
      expect(e.hint).toContain('unique<T>');
    });

    it("'asset<mesh>' is accepted (the new keyword still works)", () => {
      expect(() => {
        defineComponent('w25SharedSample', { f: { type: 'asset<mesh>' } });
      }).not.toThrow();
    });

    it("'unique<PhysicsBody>' is accepted (the new keyword still works)", () => {
      expect(() => {
        defineComponent('w25UniqueSample', { f: { type: 'unique<PhysicsBody>' } });
      }).not.toThrow();
    });
  });

  describe('unique reference vocabulary', () => {
    it.each(['ref', 'array<ref>', 'array<ref, 2>'])('rejects the removed %s schema', (type) => {
      expect(() => defineComponent(`RemovedReference_${type}`, { value: type } as never)).toThrow();
    });

    it('classifies unique handles independently of scalar storage', () => {
      const component = defineComponent('UniquePhysicalLayout', { value: 'unique<Resource>' });
      expect(componentDefinition(component).plan.fields.value).toMatchObject({
        kind: 'unique',
        storage: 'u32',
        arity: 1,
        releases: true,
      });
    });
  });
});

describe('schema-vocabulary-admission', () => {
  describe('one scalar and array element vocabulary', () => {
    it.each([
      'shared<bad tag>',
      'shared<bad-tag>',
      'shared<x<y>>',
      'shared<>',
    ])('rejects %s both alone and inside arrays', (element) => {
      expect(isSchemaVocabKeyword(element)).toBe(false);
      for (const field of [`array<${element}>`, `array<${element}, 4>`]) {
        expect(parseManagedArraySchema(field)).toBeNull();
        expect(() =>
          defineComponent(`Invalid_${field}`, { value: field as SchemaFieldType }),
        ).toThrow();
      }
    });
    it.each([
      'shared<material>',
      'asset<animation-clip>',
      'entity',
      'u16',
    ])('keeps valid element %s in both array forms', (element) => {
      expect(parseManagedArraySchema(`array<${element}>`)).toEqual({
        elementType: element,
        length: undefined,
      });
      expect(parseManagedArraySchema(`array<${element}, 4>`)).toEqual({
        elementType: element,
        length: 4,
      });
    });
  });
});

// m3-projection-kernel-test — ECS externalization projection kernel semantic tests.
//
// Validates pure-kernel behaviours: owned snapshot production, default fill,
// component/field transient exclusion, portable scalar/array values, injectable
// entity and fixed/variable entity array remap. Uses reflection arrayMeta rather
// than schema-text classifiers.
//
// TDD red phase: these tests are expected to FAIL until the kernel implementation
// (m3-externalization-kernel-impl) is complete.

import { describe, expect, it } from 'vitest';
import { type Component, defineComponent } from '../component';
import {
  classifyEntityField,
  createEntityRemap,
  projectComponentData,
  remapEntityFieldValue,
} from '../externalization/index';
import { World } from '../world';

// ── Test components ──────────────────────────────────────────────────────────

const Pos = defineComponent('TestPos', {
  x: { type: 'f32', default: 0 },
  y: { type: 'f32', default: 0 },
  z: { type: 'f32', default: 0 },
});

const Mixed = defineComponent('TestMixed', {
  health: { type: 'u32', default: 100 },
  name: { type: 'string', default: 'unnamed' },
  active: { type: 'bool', default: true },
  scale: { type: 'f32', default: 1.0 },
});

const WithEntity = defineComponent('TestWithEntity', {
  target: { type: 'entity' },
  friends: { type: 'array<entity>', default: [] },
});

const FixedArrayEntity = defineComponent('TestFixedArrayEntity', {
  slots: { type: 'array<entity, 4>', default: [0, 0, 0, 0] },
  // biome-ignore lint/suspicious/noExplicitAny: test component with array<entity,4> default; literal array shape is a branded handle
} as any) as Component;

const VariableArrayEntity = defineComponent('TestVariableArrayEntity', {
  items: { type: 'array<entity>', default: [] },
});

const TransientComp = defineComponent(
  'TestTransientComp',
  {
    x: { type: 'f32', default: 0 },
  },
  { transient: true },
);

const FieldTransient = defineComponent('TestFieldTransient', {
  keep: { type: 'f32', default: 0 },
  derived: { type: 'f32', default: 0, transient: true },
});

const EnumComp = defineComponent('TestEnumComp', {
  kind: { type: 'enum', default: 0, labels: { static: 0, dynamic: 1 } },
});

const BufferComp = defineComponent('TestBufferComp', {
  data: { type: 'buffer', default: 0 },
});

const FixedBufferComp = defineComponent('TestFixedBufferComp', {
  data: { type: 'buffer<256>', default: 0 },
});

const FixedArrayComp = defineComponent('TestFixedArrayComp', {
  coords: {
    type: 'array<f32, 3>', // biome-ignore lint/suspicious/noExplicitAny: test component with array<f32,3> default; literal array shape is a branded handle
    default: [0, 0, 0] as any,
  },
});

const EnumNoLabels = defineComponent('TestEnumNoLabels', {
  kind: { type: 'enum', default: 0 },
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function fieldsOf(r: Record<string, unknown>): string[] {
  return Object.keys(r).sort();
}

function hasField(r: Record<string, unknown>, field: string): boolean {
  return field in r;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('m3 — projection kernel: owned snapshot and default fill', () => {
  it('(a) produces a record with all schema fields filled', () => {
    const result = projectComponentData(Pos as Component, {});
    expect(fieldsOf(result)).toEqual(['x', 'y', 'z']);
  });

  it('(b) layer-1 explicit values survive projection', () => {
    const result = projectComponentData(Pos as Component, { x: 42, y: 7, z: 99 });
    expect(result.x).toBe(42);
    expect(result.y).toBe(7);
    expect(result.z).toBe(99);
  });

  it('(c) layer-2 defaults fill missing fields', () => {
    // Mixed.health has layer-2 default 100
    const result = projectComponentData(Mixed as Component, { name: 'hero' });
    expect(result.health).toBe(100);
    expect(result.name).toBe('hero');
    expect(result.active).toBe(true);
    expect(result.scale).toBe(1.0);
  });

  it('(d) layer-3 type defaults fill completely missing input', () => {
    const result = projectComponentData(Pos as Component, undefined);
    expect(result.x).toBe(0);
    expect(result.y).toBe(0);
    expect(result.z).toBe(0);
  });

  it('(e) projection produces a new object (owned snapshot)', () => {
    const input = { x: 1, y: 2, z: 3 };
    const result = projectComponentData(Pos as Component, input);
    // Mutating the result should not affect the input
    (result as Record<string, number>).x = 999;
    expect(input.x).toBe(1);
  });

  it('(f) string field survives projection', () => {
    const result = projectComponentData(Mixed as Component, { name: 'warrior' });
    expect(result.name).toBe('warrior');
  });

  it('(g) bool field survives projection', () => {
    const result = projectComponentData(Mixed as Component, { active: false });
    expect(result.active).toBe(false);
  });
});

describe('m3 — projection kernel: component/field transient exclusion', () => {
  it('(a) component-level transient excludes all fields from projection', () => {
    // TransientComp is transient: true — should be detected as fully transient
    const result = projectComponentData(TransientComp as Component, { x: 5 });
    // The stub currently returns all fields — this will FAIL until kernel is implemented
    expect(fieldsOf(result)).toEqual([]);
  });

  it('(b) field-level transient excludes only that field', () => {
    const result = projectComponentData(FieldTransient as Component, { keep: 10, derived: 20 });
    expect(hasField(result, 'keep')).toBe(true);
    // `derived` is transient — should NOT be in the projection
    expect(hasField(result, 'derived')).toBe(false);
    expect(result.keep).toBe(10);
  });

  it('(c) non-transient component with no transient fields projects all fields', () => {
    const result = projectComponentData(Pos as Component, { x: 1, y: 2, z: 3 });
    expect(fieldsOf(result)).toEqual(['x', 'y', 'z']);
  });
});

describe('m3 — projection kernel: portable scalar/array values', () => {
  it('(a) fixed array<f32,3> field survives projection', () => {
    const result = projectComponentData(FixedArrayComp as Component, { coords: [1, 2, 3] });
    expect(Array.isArray(result.coords)).toBe(true);
    expect((result.coords as number[]).length).toBe(3);
  });

  it('(b) enum field with labels survives projection', () => {
    const result = projectComponentData(EnumComp as Component, { kind: 1 });
    expect(result.kind).toBe(1);
  });

  it('(c) enum field without labels survives projection', () => {
    const result = projectComponentData(EnumNoLabels as Component, { kind: 0 });
    expect(result.kind).toBe(0);
  });

  it('(d) buffer field survives projection', () => {
    const result = projectComponentData(BufferComp as Component, {});
    expect(hasField(result, 'data')).toBe(true);
  });

  it('(e) fixed buffer<256> field survives projection', () => {
    const result = projectComponentData(FixedBufferComp as Component, {});
    expect(hasField(result, 'data')).toBe(true);
  });
});

describe('m3 — projection kernel: injectable entity remap', () => {
  it('(a) scalar entity field is remapped through injectable function', () => {
    const remap = (e: number) => e + 1000;
    const result = projectComponentData(WithEntity as Component, { target: 42 }, remap);
    expect(result.target).toBe(1042);
  });

  it('(b) variable array<entity> field elements are remapped', () => {
    const remap = (e: number) => e + 1000;
    const result = projectComponentData(WithEntity as Component, { friends: [1, 2, 3] }, remap);
    const friends = result.friends as number[];
    expect(friends).toEqual([1001, 1002, 1003]);
  });

  it('(c) fixed array<entity,4> field elements are remapped', () => {
    const remap = (e: number) => e + 1000;
    const result = projectComponentData(
      FixedArrayEntity as Component,
      { slots: [5, 6, 7, 8] },
      remap,
    );
    const slots = result.slots as number[];
    expect(slots).toEqual([1005, 1006, 1007, 1008]);
  });

  it('(d) no remap function leaves entity values unchanged', () => {
    const result = projectComponentData(WithEntity as Component, { target: 42, friends: [1, 2] });
    expect(result.target).toBe(42);
    expect(result.friends).toEqual([1, 2]);
  });

  it('(e) entity field with ENTITY_NULL_RAW is remapped if in range', () => {
    const remap = (e: number) => (e === 0xffffffff ? e : e + 1000);
    const result = projectComponentData(WithEntity as Component, { target: 0xffffffff }, remap);
    expect(result.target).toBe(0xffffffff);
  });

  it('(f) remaps a typed entity array read from an actual World', () => {
    const world = new World();
    const target = world.spawn().unwrap();
    const holder = world
      .spawn({ component: VariableArrayEntity, data: { items: [target] } as never })
      .unwrap();
    const raw = world.get(holder, VariableArrayEntity).unwrap();
    const result = projectComponentData(
      VariableArrayEntity as Component,
      raw,
      (entity) => entity + 1000,
    );

    expect(result.items).toEqual([target + 1000]);
  });
});

describe('m3 — projection kernel: entity field classification (arrayMeta-driven)', () => {
  it('(a) `entity` type field is classified as scalar entity', () => {
    const kind = classifyEntityField(WithEntity as Component, 'target');
    expect(kind).toEqual({ kind: 'entity', isArray: false });
  });

  it('(b) `array<entity>` type field is classified as array entity', () => {
    const kind = classifyEntityField(WithEntity as Component, 'friends');
    expect(kind).toEqual({ kind: 'entity', isArray: true });
  });

  it('(c) `array<entity,4>` type field is classified as array entity', () => {
    const kind = classifyEntityField(FixedArrayEntity as Component, 'slots');
    expect(kind).toEqual({ kind: 'entity', isArray: true });
  });

  it('(d) non-entity field returns null classification', () => {
    const kind = classifyEntityField(Pos as Component, 'x');
    expect(kind).toBeNull();
  });

  it('(e) classification uses arrayMeta.length presence, not schema text parsing', () => {
    // `array<entity,4>` → arrayMeta has length=4; `array<entity>` → arrayMeta has no length
    // Both classify as isArray: true regardless of fixed/variable
    const fixedKind = classifyEntityField(FixedArrayEntity as Component, 'slots');
    const variableKind = classifyEntityField(VariableArrayEntity as Component, 'items');
    expect(fixedKind?.isArray).toBe(true);
    expect(variableKind?.isArray).toBe(true);
  });
});

describe('m3 — remap: createEntityRemap from mapping table', () => {
  it('(a) creates a remap function that translates source ids to target ids', () => {
    const mapping = new Uint32Array([0, 100, 200, 300]);
    const remap = createEntityRemap(mapping);
    expect(remap(0)).toBe(0);
    expect(remap(1)).toBe(100);
    expect(remap(2)).toBe(200);
    expect(remap(3)).toBe(300);
  });

  it('(b) out-of-range indices return identity', () => {
    const mapping = new Uint32Array([0, 10]);
    const remap = createEntityRemap(mapping);
    expect(remap(5)).toBe(5);
    expect(remap(999)).toBe(999);
  });

  it('(c) works with plain number arrays', () => {
    const mapping = [0, 10, 20];
    const remap = createEntityRemap(mapping);
    expect(remap(0)).toBe(0);
    expect(remap(1)).toBe(10);
    expect(remap(2)).toBe(20);
  });
});

describe('m3 — remap: remapEntityFieldValue', () => {
  it('(a) scalar entity value is remapped', () => {
    const remap = (e: number) => e + 100;
    const result = remapEntityFieldValue(42, { kind: 'entity', isArray: false }, remap);
    expect(result).toBe(142);
  });

  it('(b) array<entity> values are remapped element-wise', () => {
    const remap = (e: number) => e + 100;
    const result = remapEntityFieldValue([1, 2, 3], { kind: 'entity', isArray: true }, remap);
    expect(result).toEqual([101, 102, 103]);
  });

  it('(c) null kind passes value through unchanged', () => {
    const remap = (e: number) => e + 100;
    const result = remapEntityFieldValue(42, null, remap);
    expect(result).toBe(42);
  });
});

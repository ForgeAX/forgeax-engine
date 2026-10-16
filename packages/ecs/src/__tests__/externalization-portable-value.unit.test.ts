// m3-profile-rejection-test — portable value validation / profile boundary tests.
//
// Validates that the shared kernel rejects fully-transient component selections
// and non-portable field types (unique/shared/legacy refs) with structured errors
// while portable entity fields are accepted. No network metadata in schemas.

import { describe, expect, it } from 'vitest';
import { type Component, componentSchema, defineComponent } from '../component';
import {
  isComponentFullyTransient,
  isComponentPortable,
  isFieldPortable,
  validateProfileComponents,
} from '../externalization/index';

// ── Test components ──────────────────────────────────────────────────────────

const Portable = defineComponent('TestPortable', {
  health: { type: 'u32', default: 100 },
  name: { type: 'string', default: '' },
  pos: { type: 'array<f32, 3>', default: [0, 0, 0] },
  // biome-ignore lint/suspicious/noExplicitAny: test component with array<f32,3> default shape; layer-3 defaults fill the correct shape but the TS type for the literal is a branded handle
} as any) as Component;

const WithEntity = defineComponent('TestWithEntity', {
  target: { type: 'entity' },
  friends: { type: 'array<entity>', default: [] },
});

const FullyTransient = defineComponent(
  'TestFullyTransient',
  {
    x: { type: 'f32', default: 0 },
  },
  { transient: true },
);

const AllFieldsTransient = defineComponent('TestAllFieldsTransient', {
  derived1: { type: 'f32', default: 0, transient: true },
  derived2: { type: 'f32', default: 0, transient: true },
});

const UniqueRef = defineComponent('TestUniqueRef', {
  resource: { type: 'unique<SomeResource>' },
});

const SharedRef = defineComponent('TestSharedRef', {
  asset: { type: 'shared<SomeAsset>' },
});

const SharedArrayRef = defineComponent('TestSharedArrayRef', {
  assets: { type: 'array<shared<SomeAsset>>' },
});

const LegacyRef = defineComponent('TestLegacyRef', {
  node: { type: 'ref' },
});

const MixedPortable = defineComponent('TestMixedPortable', {
  health: { type: 'u32', default: 100 },
  asset: { type: 'shared<SomeAsset>' },
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('m3 — portable value validation: fully transient component rejection', () => {
  it('(a) component-level transient is detected as fully transient', () => {
    const result = validateProfileComponents([FullyTransient as Component]);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]?.code).toBe('component-fully-transient');
    expect(result.errors[0]?.component).toBe('TestFullyTransient');
    expect(result.errors[0]?.expected).toBeTruthy();
    expect(result.errors[0]?.hint).toBeTruthy();
  });

  it('(b) all-fields-transient component is detected as fully transient', () => {
    const result = validateProfileComponents([AllFieldsTransient as Component]);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]?.code).toBe('component-fully-transient');
    expect(result.errors[0]?.component).toBe('TestAllFieldsTransient');
  });

  it('(c) isComponentFullyTransient returns true for component-level transient', () => {
    expect(isComponentFullyTransient(FullyTransient as Component)).toBe(true);
  });

  it('(d) isComponentFullyTransient returns true for all-fields-transient', () => {
    expect(isComponentFullyTransient(AllFieldsTransient as Component)).toBe(true);
  });

  it('(e) isComponentFullyTransient returns false for component with at least one portable field', () => {
    expect(isComponentFullyTransient(Portable as Component)).toBe(false);
  });
});

describe('m3 — portable value validation: non-portable field type rejection', () => {
  it('(a) unique<T> field type is not portable', () => {
    expect(isFieldPortable('unique<SomeResource>')).toBe(false);
  });

  it('(b) shared<T> field type is not portable', () => {
    expect(isFieldPortable('shared<SomeAsset>')).toBe(false);
  });

  it('(c) legacy `ref` field type is not portable', () => {
    expect(isFieldPortable('ref')).toBe(false);
  });

  it('(d) numeric scalar (f32) is portable', () => {
    expect(isFieldPortable('f32')).toBe(true);
  });

  it('(e) string is portable', () => {
    expect(isFieldPortable('string')).toBe(true);
  });

  it('(f) entity is portable', () => {
    expect(isFieldPortable('entity')).toBe(true);
  });

  it('(g) array<entity> is portable', () => {
    expect(isFieldPortable('array<entity>')).toBe(true);
  });

  it('(h) array<f32> is portable', () => {
    expect(isFieldPortable('array<f32>')).toBe(true);
  });

  it('(i) array<f32,3> is portable', () => {
    expect(isFieldPortable('array<f32, 3>')).toBe(true);
  });

  it('(j) array<shared<T>> is not portable when its elements are shared refs', () => {
    expect(isFieldPortable('array<shared<SomeAsset>>')).toBe(false);
    expect(isFieldPortable('array<shared<SomeAsset>, 2>')).toBe(false);
  });

  it('(k) bool is portable', () => {
    expect(isFieldPortable('bool')).toBe(true);
  });

  it('(l) enum is portable', () => {
    expect(isFieldPortable('enum')).toBe(true);
  });

  it('(m) buffer is portable', () => {
    expect(isFieldPortable('buffer')).toBe(true);
  });

  it('(n) buffer<N> is portable', () => {
    expect(isFieldPortable('buffer<256>')).toBe(true);
  });
});

describe('m3 — portable value validation: validateProfileComponents rejects non-portable', () => {
  it('(a) component with unique<T> field is rejected', () => {
    const result = validateProfileComponents([UniqueRef as Component]);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]?.code).toBe('field-not-portable');
    expect(result.errors[0]?.component).toBe('TestUniqueRef');
    expect(result.errors[0]?.field).toBe('resource');
    expect(result.errors[0]?.fieldType).toBe('unique<SomeResource>');
  });

  it('(b) component with shared<T> field is rejected', () => {
    const result = validateProfileComponents([SharedRef as Component]);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]?.code).toBe('field-not-portable');
    expect(result.errors[0]?.component).toBe('TestSharedRef');
    expect(result.errors[0]?.field).toBe('asset');
  });

  it('(c) component with array<shared<T>> field is rejected', () => {
    const result = validateProfileComponents([SharedArrayRef as Component]);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]?.code).toBe('field-not-portable');
    expect(result.errors[0]?.component).toBe('TestSharedArrayRef');
    expect(result.errors[0]?.field).toBe('assets');
  });

  it('(d) component with legacy `ref` field is rejected', () => {
    const result = validateProfileComponents([LegacyRef as Component]);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]?.code).toBe('field-not-portable');
    expect(result.errors[0]?.component).toBe('TestLegacyRef');
    expect(result.errors[0]?.field).toBe('node');
  });

  it('(e) component with mixed portable and non-portable fields is rejected', () => {
    // MixedPortable has health (u32, portable) and asset (shared<>, non-portable)
    const result = validateProfileComponents([MixedPortable as Component]);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]?.code).toBe('field-not-portable');
    expect(result.errors[0]?.field).toBe('asset');
  });

  it('(f) fully portable component is accepted', () => {
    const result = validateProfileComponents([Portable as Component, WithEntity as Component]);
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  it('(g) each error has structured .expected and .hint', () => {
    const result = validateProfileComponents([UniqueRef as Component]);
    expect(result.errors[0]?.expected).toBeTruthy();
    expect(result.errors[0]?.hint).toBeTruthy();
    expect(typeof result.errors[0]?.expected).toBe('string');
    expect(typeof result.errors[0]?.hint).toBe('string');
  });
});

describe('m3 — isComponentPortable', () => {
  it('(a) component with at least one portable, non-transient field is portable', () => {
    expect(isComponentPortable(Portable as Component)).toBe(true);
  });

  it('(b) component with entity field is portable', () => {
    expect(isComponentPortable(WithEntity as Component)).toBe(true);
  });

  it('(c) fully transient component is not portable', () => {
    expect(isComponentPortable(FullyTransient as Component)).toBe(false);
  });
});

// ── m3-profile-rejection-test supplemental: exhaustive rejection edge cases ──

describe('m3 — profile rejection supplemental: multi-component and multi-error', () => {
  it('(h) validateProfileComponents rejects multiple components with multiple errors', () => {
    const result = validateProfileComponents([
      FullyTransient as Component,
      AllFieldsTransient as Component,
      UniqueRef as Component,
      SharedRef as Component,
    ]);
    expect(result.valid).toBe(false);
    // First two are fully transient, next two have non-portable fields
    expect(result.errors.length).toBe(4);
    const codes = result.errors.map((e) => e.code);
    expect(codes).toEqual([
      'component-fully-transient',
      'component-fully-transient',
      'field-not-portable',
      'field-not-portable',
    ]);
  });

  it('(i) shared<T> and unique<T> are not portable (direct string test)', () => {
    // shared<SomeAsset> and unique<SomeResource> are not valid
    // defineComponent field types, so test isFieldPortable directly.
    expect(isFieldPortable('shared<SomeAsset>')).toBe(false);
    expect(isFieldPortable('unique<SomeResource>')).toBe(false);
  });

  it('(j) validateProfileComponents with no network metadata in schema', () => {
    // Components defined with defineComponent have no network-specific fields
    const result = validateProfileComponents([Portable as Component, WithEntity as Component]);
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
    // Verify schema has no network metadata
    const schema = componentSchema(Portable) as Record<string, string>;
    for (const key of Object.keys(schema)) {
      expect(key).not.toContain('network');
      expect(key).not.toContain('replicate');
      expect(key).not.toContain('profile');
    }
  });
});

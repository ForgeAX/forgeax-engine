// Retired schema vocabulary must fail with current ownership guidance.

import { describe, expect, it } from 'vitest';
import { defineComponent, fieldTypeToMetaKey, TYPE_METADATA } from '../component';

describe('unsupported schema vocabulary', () => {
  it("'handle<MeshAsset>' throws SchemaUnsupportedFieldError + hint mentions 'asset<mesh>'", () => {
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

  it("'ref<PhysicsBody>' throws SchemaUnsupportedFieldError + hint mentions 'unique<PhysicsBody>'", () => {
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
    expect(fieldTypeToMetaKey('unique<Resource>')).toBe('unique');
    expect(fieldTypeToMetaKey('ref')).toBeNull();
    expect(Object.hasOwn(TYPE_METADATA, 'ref')).toBe(false);
    expect(TYPE_METADATA.unique).toMatchObject({
      storage: 'u32',
      isManaged: true,
      isScalar: false,
    });
  });
});

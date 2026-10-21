// Retired schema vocabulary must fail with current ownership guidance.

import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';

describe('w25 deprecated schema-vocab rejection', () => {
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
    expect(e.hint).toContain("'asset<mesh>'");
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
    expect(e.hint).toContain("'unique<PhysicsBody>'");
    expect(e.hint).toContain('feat-20260614 M1');
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

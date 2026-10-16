// feat-20260614 M5 / w25 — runtime rejection tests for the two retired
// schema-vocab keyword families. Both renames preserve brand and storage
// layout; only the keyword + dispatch arm changed. The
// SchemaUnsupportedFieldError migration hint redirects AI users straight
// to the new keyword (charter F1 single-entry indexability).
//
//   'ref<T>'    -> hint contains 'unique<T>'   (M1 rename)
//   'handle<T>' -> hint contains 'shared<T>'   (M5 cut)
//
// AC-14 (requirements): writing either deprecated literal to defineComponent
// must throw a structured error with the migration hint pointing at the
// replacement keyword.

import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';

describe('w25 deprecated schema-vocab rejection', () => {
  it("'handle<MeshAsset>' throws SchemaUnsupportedFieldError + hint mentions 'shared<MeshAsset>'", () => {
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
    expect(e.hint).toContain("'shared<MeshAsset>'");
    expect(e.hint).toContain('feat-20260614 M5');
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

  it("'shared<MeshAsset>' is accepted (the new keyword still works)", () => {
    expect(() => {
      defineComponent('w25SharedSample', { f: { type: 'shared<MeshAsset>' } });
    }).not.toThrow();
  });

  it("'unique<PhysicsBody>' is accepted (the new keyword still works)", () => {
    expect(() => {
      defineComponent('w25UniqueSample', { f: { type: 'unique<PhysicsBody>' } });
    }).not.toThrow();
  });
});

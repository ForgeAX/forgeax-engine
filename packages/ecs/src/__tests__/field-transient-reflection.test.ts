// feat-20260709-transform-serialization-vec-fields-and-field-trans M1 / w1:
// Field-level transient reflection (AC-01, TDD red-first).
//
// AC-01: after a component declares a field with `transient: true`, the fact is
// readable at runtime off `component.fields[field].transient === true` through
// the FieldReflection layer (component.ts:1048-1052). A field without a
// transient declaration reflects `transient` as absent/undefined (control), the
// same shape as the component-level `transient` reflection (D-5 same-word-same-
// meaning, granularity sunk to field level).
//
// Application-point discipline (task w1 rationale): AC-01 is asserted on a real
// `defineComponent` product's FieldReflection, NOT via a standalone *.test-d.ts.
// This file uses runtime `defineComponent` calls + value assertions on
// `.fields[field].transient`.

import { describe, expect, it } from 'vitest';
import { type Component, defineComponent } from '../component';

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

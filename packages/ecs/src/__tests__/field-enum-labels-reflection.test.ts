// solo round-24 (P7 residue): field-level enum-labels reflection.
//
// An `enum` field stores a bare u32 variant index; the label→value map
// historically lived in a SEPARATE per-package const map (`RigidBodyTypeValue`)
// with no schema attachment, so no reflection consumer (the editor's
// describeComponent, an inspector UI) could learn the legal variants + their
// integers — a docs-only user had to read engine source (a back door, recurring
// friction #1 in solo rounds 15/20/22).
//
// The fix attaches an optional `labels` map to the enum FieldDescriptor,
// aggregated into `component.fields[field].labels` (FieldReflection), mirroring
// how `default` / `transient` / `arrayMeta` are already per-field reflection
// data. This test asserts the reflection round-trips (revert-to-red: drop the
// `if (desc.labels !== undefined) row.labels = …` aggregation line → red).

import { describe, expect, it } from 'vitest';
import { type Component, defineComponent } from '../component';

function fieldLabels(comp: Component, field: string): Readonly<Record<string, number>> | undefined {
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

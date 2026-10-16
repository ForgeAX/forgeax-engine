import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import { defineRelationship } from '../relationship-index';
import { Update } from '../schedule-token';
import { World } from '../world';

const Marker = defineComponent('NanPreflightMarker', {});
const Numeric = defineComponent('NanPreflightNumeric', {
  scalar: 'f32',
  values: 'array<f32>',
});
const InlineNumeric = defineComponent('NanPreflightInlineNumeric', {
  scalar: 'f32',
  values: 'array<f32, 2>',
});
const { source: ParentOf, target: ChildrenOf } = defineRelationship({
  sourceName: 'NanPreflightParentOf',
  sourceField: 'parent',
  targetName: 'NanPreflightChildrenOf',
  targetField: 'children',
});

interface NumericValueError {
  readonly code: string;
  readonly detail: {
    readonly component: string;
    readonly field: string;
    readonly received: unknown;
    readonly index?: number;
  };
}

function expectNumericValueError(
  error: unknown,
  expected: { readonly field: string; readonly received: unknown; readonly index?: number },
): void {
  expect(error).toBeDefined();
  if (error === undefined) return;
  const numericError = error as NumericValueError;
  expect(numericError.code).toBe('component-numeric-value-invalid');
  expect(numericError.detail).toMatchObject({
    component: Numeric.name,
    field: expected.field,
    received: expected.received,
    ...(expected.index === undefined ? {} : { index: expected.index }),
  });
}

describe('component NaN object-write preflight', () => {
  it('rejects spawn scalar NaN before entity or relationship mutation', () => {
    const world = new World();
    const parent = world.spawn({ component: Marker, data: {} }).unwrap();
    const beforeCount = world.inspect().entityCount;
    const beforeEpoch = world.getStructureEpoch();

    const result = world.spawn(
      { component: Numeric, data: { scalar: Number.NaN, values: [1, 2] } },
      { component: ParentOf, data: { parent } },
    );

    expect(result.ok).toBe(false);
    if (!result.ok)
      expectNumericValueError(result.error, { field: 'scalar', received: Number.NaN });
    expect(world.inspect().entityCount).toBe(beforeCount);
    expect(world.getStructureEpoch()).toBe(beforeEpoch);
    expect(world.get(parent, ChildrenOf).ok).toBe(false);
  });

  it('rejects addComponent array NaN before archetype or managed-array mutation', () => {
    const world = new World();
    const entity = world.spawn({ component: Marker, data: {} }).unwrap();
    const beforeEpoch = world.getStructureEpoch();

    const result = world.addComponent(entity, {
      component: Numeric,
      data: { scalar: 3, values: [1, Number.NaN] },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expectNumericValueError(result.error, {
        field: 'values',
        received: Number.NaN,
        index: 1,
      });
    }
    expect(world.get(entity, Numeric).ok).toBe(false);
    expect(world.getStructureEpoch()).toBe(beforeEpoch);
  });

  it('rejects set array NaN and preserves the complete old value', () => {
    const world = new World();
    const entity = world
      .spawn({ component: Numeric, data: { scalar: 4, values: [1, 2] } })
      .unwrap();

    const result = world.set(entity, Numeric, { values: [7, Number.NaN] });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expectNumericValueError(result.error, {
        field: 'values',
        received: Number.NaN,
        index: 1,
      });
    }
    const current = world.get(entity, Numeric).unwrap();
    expect(current.scalar).toBe(4);
    expect(Array.from(current.values)).toEqual([1, 2]);
  });

  it('rejects QueryRow.mut scalar NaN and preserves the old field', () => {
    const world = new World();
    const entity = world
      .spawn({ component: Numeric, data: { scalar: 5, values: [1, 2] } })
      .unwrap();
    const row = world
      .query({ write: [Numeric] })
      .unwrap()
      .at(entity);
    expect(row).toBeDefined();
    let thrown: unknown;

    try {
      if (row !== undefined) row.mut(Numeric).scalar = Number.NaN;
    } catch (error) {
      thrown = error;
    }

    expectNumericValueError(thrown, { field: 'scalar', received: Number.NaN });
    expect(world.get(entity, Numeric).unwrap().scalar).toBe(5);
  });

  it('rejects a deferred command before adding the component', () => {
    const world = new World();
    const entity = world.spawn({ component: Marker, data: {} }).unwrap();
    world
      .addSystem(Update, {
        name: 'nan-preflight-command',
        queries: [],
        fn: (_world, _queries, commands) => {
          commands.addComponent(entity, {
            component: Numeric,
            data: { scalar: Number.NaN, values: [1, 2] },
          });
        },
      })
      .unwrap();

    const result = world.update(0);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('command-failed');
      if (result.error.code === 'command-failed') {
        expectNumericValueError(result.error.detail.cause, {
          field: 'scalar',
          received: Number.NaN,
        });
      }
    }
    expect(world.get(entity, Numeric).ok).toBe(false);
    expect(world.execution.health).toBe('healthy');
  });

  it('accepts positive Infinity while leaving QuerySpan as the raw numeric boundary', () => {
    const world = new World({ storage: 'shared' });
    const entity = world
      .spawn({
        component: InlineNumeric,
        data: { scalar: Number.POSITIVE_INFINITY, values: [Number.POSITIVE_INFINITY, 2] },
      })
      .unwrap();
    expect(world.set(entity, InlineNumeric, { scalar: Number.POSITIVE_INFINITY }).ok).toBe(true);
    expect(world.get(entity, InlineNumeric).unwrap().scalar).toBe(Number.POSITIVE_INFINITY);

    const spans = world
      .query({ write: [InlineNumeric] })
      .unwrap()
      .spans()
      .unwrap();
    for (const span of spans) span.mut(InlineNumeric).scalar[0] = Number.NaN;

    expect(world.get(entity, InlineNumeric).unwrap().scalar).toBeNaN();
  });
});

import type { AssetErrorCode, Result } from '@forgeax/engine-types';
import { describe, expectTypeOf, it, test } from 'vitest';
import type { CommandBuffer } from '../commands';
import { defineComponent } from '../component';
import { type EntityHandle, entityIndex } from '../entity-handle';
import {
  type ComponentNotDefinedError,
  type EcsErrorCode,
  type EcsErrorDetail,
  StaleEntityError,
} from '../errors';
import type { MemoryErrorCode } from '../memory-types';
import { defineSystem } from '../schedule';
import { Update } from '../schedule-token';
import { type EcsError, World } from '../world';

test('every World failure code belongs to the public error code union', () => {
  expectTypeOf<EcsError['code']>().toExtend<EcsErrorCode>();
});

test('error detail projections preserve the declaring class payload', () => {
  type Detail = Extract<EcsErrorDetail, { code: 'component-not-defined' }>;
  expectTypeOf<Detail>().toExtend<ComponentNotDefinedError['detail']>();
  expectTypeOf<ComponentNotDefinedError['detail']>().toExtend<Omit<Detail, 'code'>>();
});

describe('owner error union boundary', () => {
  it("keeps 'scene-override-type-mismatch' out of EcsErrorCode", () => {
    expectTypeOf<'scene-override-type-mismatch'>().not.toExtend<EcsErrorCode>();
  });
});

describe('EcsErrorCode enum write validation', () => {
  it("includes the 'component-field-invalid-value' literal", () => {
    expectTypeOf<'component-field-invalid-value'>().toExtend<EcsErrorCode>();
  });
});

describe('spawn field-level errors (AC-09 wrong-value shape)', () => {
  it('AC-09 wrong field type: schema {value: string} rejects {value: number}', () => {
    const Name = defineComponent('Name', { value: { type: 'string' } });
    const world = new World();
    world.spawn({
      component: Name,
      data: {
        // @ts-expect-error AC-09 data.value must be string per schema; mapped-
        // tuple primary inference fires field-level TS2322 on the offending key.
        value: 42,
      },
    });
  });
});

describe('[w6] AC-L5 — world.get returns Result<ShapeOf<S>, EcsError> with structured stale payload', () => {
  it('return type is Result<{ x: number; y: number }, EcsError>; stale narrowing exposes .operation/.component', () => {
    const Position = defineComponent('Position', { x: { type: 'f32' }, y: { type: 'f32' } });

    const world = new World();
    const e = world.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
    const r = world.get(e, Position);

    // Signature shape: Result<ShapeOf<S>, EcsError>.
    expectTypeOf(r).toEqualTypeOf<Result<{ readonly x: number; readonly y: number }, EcsError>>();

    if (!r.ok) {
      const err = r.error;
      // EcsError is a union; narrowing to StaleEntityError surfaces .operation/.component.
      if (err instanceof StaleEntityError) {
        expectTypeOf(err.operation).toEqualTypeOf<string | undefined>();
        expectTypeOf(err.component).toEqualTypeOf<string | undefined>();
      }
    }
  });
});

describe('[w6] AC-L5 — world.set returns Result<void, EcsError> with structured stale payload', () => {
  it('return type is Result<void, EcsError>; stale narrowing exposes .operation/.component', () => {
    const Position = defineComponent('Position', { x: { type: 'f32' }, y: { type: 'f32' } });

    const world = new World();
    const e = world.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
    const r = world.set(e, Position, { x: 10 });

    expectTypeOf(r).toEqualTypeOf<Result<void, EcsError>>();

    if (!r.ok) {
      const err = r.error;
      if (err instanceof StaleEntityError) {
        expectTypeOf(err.operation).toEqualTypeOf<string | undefined>();
        expectTypeOf(err.component).toEqualTypeOf<string | undefined>();
      }
    }
  });
});

describe('[w6] AC-L5 — world.addComponent returns Result<void, EcsError> with structured stale payload', () => {
  it('return type is Result<void, EcsError>; stale narrowing exposes .operation/.component', () => {
    const Position = defineComponent('Position', { x: { type: 'f32' }, y: { type: 'f32' } });
    const Velocity = defineComponent('Velocity', { dx: { type: 'f32' }, dy: { type: 'f32' } });

    const world = new World();
    const e = world.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
    const r = world.addComponent(e, { component: Velocity, data: { dx: 1, dy: 0 } });

    expectTypeOf(r).toEqualTypeOf<Result<void, EcsError>>();

    if (!r.ok) {
      const err = r.error;
      if (err instanceof StaleEntityError) {
        expectTypeOf(err.operation).toEqualTypeOf<string | undefined>();
        expectTypeOf(err.component).toEqualTypeOf<string | undefined>();
      }
    }
  });
});

describe('[w6] AC-L5 — world.removeComponent returns Result<void, EcsError> with structured stale payload', () => {
  it('return type is Result<void, EcsError>; stale narrowing exposes .operation/.component', () => {
    const Position = defineComponent('Position', { x: { type: 'f32' }, y: { type: 'f32' } });

    const world = new World();
    const e = world.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
    const r = world.removeComponent(e, Position);

    expectTypeOf(r).toEqualTypeOf<Result<void, EcsError>>();

    if (!r.ok) {
      const err = r.error;
      if (err instanceof StaleEntityError) {
        expectTypeOf(err.operation).toEqualTypeOf<string | undefined>();
        expectTypeOf(err.component).toEqualTypeOf<string | undefined>();
      }
    }
  });
});

describe('[w6] AC-L5 — world.addSystem<const Qs> method signature shape (simplified counterpart of types.test-d.ts:[w15])', () => {
  it('addSystem returns void; fn receives mapped queryResults + CommandBuffer at the method-level call site', () => {
    const Position = defineComponent('Position', { x: { type: 'f32' }, y: { type: 'f32' } });

    const world = new World();
    const systemToken1 = defineSystem({
      name: 'ac-l5-shape-probe',
      queries: [{ read: [Position] }],
      fn: (_world, queryResults, commands) => {
        const query = queryResults[0];
        if (query) {
          for (const row of query) expectTypeOf(row.get(Position).x).toBeNumber();
        }
        expectTypeOf(commands).toEqualTypeOf<CommandBuffer>();
      },
    });
    const ret = world.addSystem(Update, systemToken1);

    // Class-method `addSystem` reports a structured schedule-scope result.
    expectTypeOf(ret.ok).toEqualTypeOf<boolean>();
  });
});

// w3: type-level assertion — entityIndex returns number (u32 slot, low 24 bits)
describe('[w3] Entity codec type contract', () => {
  it('entityIndex returns number', () => {
    const fake = 0 as EntityHandle;
    expectTypeOf(entityIndex(fake)).toEqualTypeOf<number>();
  });
});

// Exact type equality detects missing and unexpected codes without runtime dispatch.
describe('EcsErrorCode union completeness', () => {
  it('the complete closed error-code union includes stale codes', () => {
    const codes = [
      'component-not-defined',
      'change-epoch-exhausted',
      'derived-range-out-of-bounds',
      'stale-entity',
      'component-already-present',
      'component-not-present',
      'cyclic-dependency',
      'resource-not-found',
      'system-before-unknown',
      'unique-ref-released',
      'unique-ref-double-release',
      'unique-ref-stale',
      'shared-ref-released',
      'shared-ref-double-release',
      'shared-ref-payload-invalid',
      'shared-ref-stale',
      'managed-buffer-out-of-bounds',
      'managed-array-invalid-value',
      'array-range-out-of-bounds',
      'relationship-self-cycle',
      'relationship-detach-mismatch',
      'remove-essential-component',
      'spawn-data-unknown-field',
      'shared-field-invalid-value',
      'system-set-not-registered',
      'time-delta-invalid',
      'time-config-invalid',
      'time-scale-invalid',
      'time-scale-lease-released',
      'schedule-scope-mismatch',
      'component-field-invalid-value',
      'derived-write-active',
      'shared-kernel-ineligible',
      'shared-kernel-failed',
      'world-poisoned',
      'command-failed',
      'system-failed',
    ] as const;
    expectTypeOf<(typeof codes)[number]>().toEqualTypeOf<
      Exclude<EcsErrorCode, MemoryErrorCode | AssetErrorCode>
    >();
  });

  it('shared-ref-stale is assignable to EcsErrorCode', () => {
    const stale: EcsErrorCode = 'shared-ref-stale';
    expectTypeOf(stale).toEqualTypeOf<'shared-ref-stale'>();
  });

  it('unique-ref-stale is assignable to EcsErrorCode', () => {
    const stale: EcsErrorCode = 'unique-ref-stale';
    expectTypeOf(stale).toEqualTypeOf<'unique-ref-stale'>();
  });
});

// Byte arrays use the common fixed-array write contract.
expectTypeOf<Extract<EcsErrorCode, 'fixed-size-mismatch'>>().toEqualTypeOf<never>();

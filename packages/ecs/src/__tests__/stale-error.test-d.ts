import type { AssetErrorCode } from '@forgeax/engine-types';
import type { MemoryErrorCode } from '../memory-types';
import { defineSystem } from '../schedule';
import { Update } from '../schedule-token';
// AC-L5 stale-error compile-assertion vehicle.
//
// Sediments 5 method-level `expectTypeOf` assertions (the 4 `lookupAlive`
// callers — `get` / `set` / `addComponent` / `removeComponent` — plus
// `addSystem`) into a dedicated test-d file so that `tsc -b` (and vitest
// typecheck) certify, every release, the load-bearing type-layer contract
// of F-1's stale-error precision work:
//
//   1. Each of the 4 mutation/read methods returns `Result<..., EcsError>`
//      whose error variant — when narrowed to `StaleEntityError` — exposes
//      `.operation: string | undefined` and `.component: string | undefined`
//      (charter proposition 4: errors are structured payloads, not strings).
//   2. `addSystem`'s class-method generic shape is preserved (a method-level
//      simplified counterpart of `types.test-d.ts:[w15]` — that file owns the
//      QueryRow inference theme; this file owns the signature
//      shape theme; both coexist per plan-strategy §2 S-3 OQ-3).
//
// File structure mirrors `minimal-example.test-d.ts` (vitest test-d form,
// `expectTypeOf` based, single top-level `describe` per method group).

import type { Result } from '@forgeax/engine-types';
import { describe, expectTypeOf, it } from 'vitest';
import type { CommandBuffer } from '../commands';
import { defineComponent } from '../component';
import type { EntityHandle } from '../entity-handle';
import { entityIndex } from '../entity-handle';
import type { EcsErrorCode } from '../errors';
import { StaleEntityError } from '../errors';
import type { EcsError } from '../world';
import { World } from '../world';

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
      'relationship-mirror-component-not-registered',
      'relationship-mirror-field-type-mismatch',
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
      'managed-buffer-shrink-not-supported',
      'fixed-size-mismatch',
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

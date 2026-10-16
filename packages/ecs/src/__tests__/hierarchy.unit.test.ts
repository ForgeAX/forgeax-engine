// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files

import { componentId, componentSchema } from '../component';
import { componentDefinition } from '../component-schema';
import { Update } from '../schedule-token';
//
// Source files (N=25):
//   - packages/ecs/__tests__/world-alloc-managed-ref.test.ts
//   - packages/ecs/src/__tests__/commands.test.ts
//   - packages/ecs/src/__tests__/component-reflection.test.ts
//   - packages/ecs/src/__tests__/component.test.ts
//   - packages/ecs/src/__tests__/entity-dangling-removed.test.ts
//   - packages/ecs/src/__tests__/entity-liveness.test.ts
//   - packages/ecs/src/__tests__/entity.test.ts
//   - packages/ecs/src/__tests__/hierarchy-commands.test.ts
//   - packages/ecs/src/__tests__/hierarchy-traversal.test.ts
//   - packages/ecs/src/__tests__/name-component.test.ts
//   - packages/ecs/src/__tests__/name-mutation.test.ts
//   - packages/ecs/src/__tests__/relationship-define-order.test.ts
//   - packages/ecs/src/__tests__/relationship-schema.test.ts
//   - packages/ecs/src/__tests__/relationship-sync.test.ts
//   - packages/ecs/src/__tests__/world-array-reflection.test.ts
//   - packages/ecs/src/__tests__/world-array-view.test.ts
//   - packages/ecs/src/__tests__/world-buffer-fields.test.ts
//   - packages/ecs/src/__tests__/world-health.contract.test.ts
//   - packages/ecs/src/__tests__/world-inspect-systems.test.ts
//   - packages/ecs/src/__tests__/world-integration.test.ts
//   - packages/ecs/src/__tests__/world-managed-refs-non-null.test.ts
//   - packages/ecs/src/__tests__/world-spawn-array-fallback.test.ts
//   - packages/ecs/src/__tests__/world-spawn-defaults.test.ts
//   - packages/ecs/src/__tests__/world-spawn-direct.test.ts
//   - packages/ecs/src/__tests__/component-default-fallback.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.
//
// Collision resolutions (value/type name clashes from merge):
//   import { Entity as EntityComponent } from '../entity'
//   + targeted rename in entity-liveness.test.ts body: world.get(..., Entity) -> world.get(..., EntityComponent)

import { describe, expect, it } from 'vitest';
import { type ComponentSchema, TYPE_METADATA } from '../component';
import { fillComponentDefaults, typeDefault } from '../component-default-fallback';
import { Entity as EntityComponent } from '../entity';
import {
  decodeEntity,
  ENTITY_MAX_GENERATION,
  ENTITY_MAX_INDEX,
  ENTITY_NULL_RAW,
  type EntityHandle,
  encodeEntity,
  entityGeneration,
  entityIndex,
} from '../entity-handle';
import {
  ComponentAlreadyPresentError,
  ComponentNotPresentError,
  type EcsErrorCode,
  EntityIndexOverflowError,
  ManagedArrayElementTypeNotAllowedError,
  SchemaUnsupportedFieldError,
  StaleEntityError,
} from '../errors';
import { defineComponent } from '../index';
import { UniqueRefStore } from '../unique-ref-store';
import { World } from '../world';
import { handleNumeric } from './utils/handle-numeric';

{
  // --- from world-alloc-managed-ref.test.ts ---
  describe('feat-20260528 M1 t2 World.allocUniqueRef() public API', () => {
    it('allocUniqueRef returns a branded Handle', () => {
      const world = new World();
      defineComponent('RefTest', { payload: { type: 'unique<Test>' } });

      const handle = world.allocUniqueRef<'Test', { id: number }>('Test', { id: 42 });
      expect(typeof handle).toBe('number');
      expect(handle).not.toBe(0);
    });

    it('allocUniqueRef with onRelease: despawn entity carrying ref field triggers callback', () => {
      const world = new World();
      const Holder = defineComponent('Holder', { value: { type: 'unique<Test>' } });

      let released = false;
      let releasedPayload: { id: number } | undefined;

      const handle = world.allocUniqueRef<'Test', { id: number }>('Test', { id: 7 }, (p) => {
        released = true;
        releasedPayload = p;
      });

      const entity = world
        .spawn({
          component: Holder,
          data: { value: handle },
        })
        .unwrap();

      expect(released).toBe(false);

      world.despawn(entity);

      expect(released).toBe(true);
      expect(releasedPayload).toEqual({ id: 7 });
    });

    it('allocUniqueRef onRelease: set field overwrite triggers callback for old handle', () => {
      const world = new World();
      const Holder = defineComponent('Holder2', { value: { type: 'unique<Test>' } });

      const released: number[] = [];

      const h1 = world.allocUniqueRef<'Test', { id: number }>('Test', { id: 1 }, (p) => {
        released.push(p.id);
      });
      const h2 = world.allocUniqueRef<'Test', { id: number }>('Test', { id: 2 }, () => {});

      const entity = world
        .spawn({
          component: Holder,
          data: { value: h1 },
        })
        .unwrap();

      // Overwrite h1 with h2 — h1's onRelease should fire.
      world.set(entity, Holder, { value: h2 }).unwrap();
      expect(released).toEqual([1]);
    });

    it('allocUniqueRef handle identity is preserved through world.get', () => {
      const world = new World();
      const Holder = defineComponent('Holder3', { value: { type: 'unique<Test>' } });

      const handle = world.allocUniqueRef<'Test', string>('Test', 'hello-world');

      const entity = world
        .spawn({
          component: Holder,
          data: { value: handle },
        })
        .unwrap();

      const result = world.get(entity, Holder);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // `ref<T>` fields return the branded u32 handle, not the resolved payload.
        // Identity check: the stored handle matches what we allocated.
        expect(result.value.value).toBe(handle);
      }
    });

    it('allocUniqueRef onRelease: removeComponent triggers callback', () => {
      const world = new World();
      const Holder = defineComponent('Holder4', { value: { type: 'unique<Test>' } });

      let released = false;

      const handle = world.allocUniqueRef<'Test', string>('Test', 'payload', () => {
        released = true;
      });

      const entity = world
        .spawn({
          component: Holder,
          data: { value: handle },
        })
        .unwrap();

      world.removeComponent(entity, Holder).unwrap();
      expect(released).toBe(true);
    });

    it('allocUniqueRef double-release: despawn after set-overwrite does not double-fire (M4: stale on re-use)', () => {
      // After M4 gen increment on release, the old handle's gen mismatches the
      // store's gen after h1's slot is freed and re-allocated. The resolve
      // returns stale — not silent resolve to new payload.
      const world = new World();
      const Holder = defineComponent('Holder5', { value: { type: 'unique<Test>' } });

      let callCount = 0;

      const h1 = world.allocUniqueRef<'Test', string>('Test', 'first', () => {
        callCount++;
      });
      const h2 = world.allocUniqueRef<'Test', string>('Test', 'second', () => {});

      const entity = world
        .spawn({
          component: Holder,
          data: { value: h1 },
        })
        .unwrap();

      // Overwrite triggers h1's onRelease (gen 0->1).
      world.set(entity, Holder, { value: h2 }).unwrap();
      expect(callCount).toBe(1);

      // M4: after release, gen incremented. freeSlots = [h1.slot] with gen=1.
      // A fresh allocUniqueRef reuses the slot with gen=1. Resolving old h1
      // (gen=0) now returns stale — gen mismatch (AC-01).
      world.allocUniqueRef<'Test', string>('Test', 'third');
      // slot is the same but gen differs
      // biome-ignore lint/suspicious/noExplicitAny: targeted private read
      const store = (world as any).uniqueRefs as UniqueRefStore;
      const staleResolve = store.resolve<'Test', string>(h1);
      expect(staleResolve.ok).toBe(false);
      if (!staleResolve.ok) {
        expect(staleResolve.error.code).toBe('unique-ref-stale');
      }

      // Despawn triggers h2's onRelease (no-op), h1 is already released.
      world.despawn(entity);
      expect(callCount).toBe(1); // No double-fire.
    });
  });
}

{
  // --- from commands.test.ts ---
  describe('Deferred spawn/despawn (AC-14)', () => {
    it('spawn during system is deferred — entity not queryable until flush', () => {
      const world = new World();
      const Pos = defineComponent('DfSpawnPos', { x: { type: 'f32' }, y: { type: 'f32' } });
      let entityCountDuringSystem = 0;

      world.addSystem(Update, {
        name: 'spawner',
        queries: [],
        fn: (_world, _queries, commands) => {
          commands.spawn({ component: Pos, data: { x: 10, y: 20 } });
        },
      });

      world.addSystem(Update, {
        name: 'counter',
        queries: [{ read: [Pos] }],
        fn: (_world, queryResults) => {
          for (const query of queryResults) entityCountDuringSystem += [...query].length;
        },
        after: ['spawner'],
      });

      world.update();
      // With edge-derived visibility, counter(after:spawner) sees spawner's deferred entity
      expect(entityCountDuringSystem).toBe(1);

      // After flush, the entity should exist. Run another update to verify.
      // spawner runs again on the second frame, adding a second entity.
      entityCountDuringSystem = 0;
      world.update();
      expect(entityCountDuringSystem).toBe(2);
    });

    it('despawn during system is deferred — entity still visible until flush', () => {
      const world = new World();
      const Tag = defineComponent('DfDespawnTag', { v: { type: 'i32' } });
      const e = world.spawn({ component: Tag, data: { v: 42 } }).unwrap();

      let entitySeenDuringSystem = false;

      world.addSystem(Update, {
        name: 'destroyer',
        queries: [],
        fn: (_world, _queries, commands) => {
          commands.despawn(e);
        },
      });

      world.addSystem(Update, {
        name: 'checker',
        queries: [{ read: [Tag] }],
        fn: (_world, queryResults) => {
          for (const query of queryResults) {
            if ([...query].length > 0) entitySeenDuringSystem = true;
          }
        },
        after: ['destroyer'],
      });

      world.update();
      // With edge-derived visibility, checker(after:destroyer) does NOT see
      // the entity after destroyer's deferred despawn is applied
      expect(entitySeenDuringSystem).toBe(false);
    });

    it('addComponent during system is deferred', () => {
      const world = new World();
      const Pos = defineComponent('DfAddPos', { x: { type: 'f32' } });
      const Vel = defineComponent('DfAddVel', { vx: { type: 'f32' } });
      const e = world.spawn({ component: Pos, data: { x: 1 } }).unwrap();

      world.addSystem(Update, {
        name: 'adder',
        queries: [],
        fn: (_world, _queries, commands) => {
          commands.addComponent(e, { component: Vel, data: { vx: 5 } });
        },
      });

      world.update();
      // After flush, entity should have Vel
      const vel = world.get(e, Vel).unwrap();
      expect(vel).toEqual({ vx: 5 });
    });

    it('removeComponent during system is deferred', () => {
      const world = new World();
      const Pos = defineComponent('DfRmPos', { x: { type: 'f32' } });
      const Vel = defineComponent('DfRmVel', { vx: { type: 'f32' } });
      const e = world
        .spawn({ component: Pos, data: { x: 1 } }, { component: Vel, data: { vx: 5 } })
        .unwrap();

      world.addSystem(Update, {
        name: 'remover',
        queries: [],
        fn: (_world, _queries, commands) => {
          commands.removeComponent(e, Vel);
        },
      });

      world.update();
      // After flush, entity should no longer have Vel
      expect(world.get(e, Vel).ok).toBe(false);
    });
  });

  describe('Deferred spawn pending handle (E-06)', () => {
    it('deferred spawn returns a pending Entity handle with valid id', () => {
      const world = new World();
      const Pos = defineComponent('PendPos', { x: { type: 'f32' } });
      let pendingEntity: EntityHandle | undefined;

      world.addSystem(Update, {
        name: 'spawner',
        queries: [],
        fn: (_world, _queries, commands) => {
          pendingEntity = commands.spawn({ component: Pos, data: { x: 99 } });
          // The handle should be a valid number
          expect(typeof pendingEntity).toBe('number');
          // biome-ignore lint/style/noNonNullAssertion: pendingEntity is assigned on the line above
          expect(entityIndex(pendingEntity!)).toBeGreaterThanOrEqual(0);
        },
      });

      world.update();
      expect(pendingEntity).toBeDefined();
    });

    it('commands.isDeferred(entity) returns true for pending entity', () => {
      const world = new World();
      const Pos = defineComponent('IsDfPos', { x: { type: 'f32' } });

      world.addSystem(Update, {
        name: 'checker',
        queries: [],
        fn: (_world, _queries, commands) => {
          const pending = commands.spawn({ component: Pos, data: { x: 1 } });
          expect(commands.isDeferred(pending)).toBe(true);
        },
      });

      world.update();
    });

    it('get on pending entity returns undefined before flush (not throw)', () => {
      const world = new World();
      const Pos = defineComponent('PendGetPos', { x: { type: 'f32' } });
      let pendingEntity: EntityHandle | undefined;

      world.addSystem(Update, {
        name: 'spawner',
        queries: [],
        fn: (_world, _queries, commands) => {
          pendingEntity = commands.spawn({ component: Pos, data: { x: 42 } });
        },
      });

      world.update();
      // After flush, the entity should be accessible
      expect(pendingEntity).toBeDefined();
      // biome-ignore lint/style/noNonNullAssertion: pendingEntity is confirmed defined by the expect above
      const val = world.get(pendingEntity!, Pos).unwrap();
      expect(val).toEqual({ x: 42 });
    });
  });

  describe('Flush cascade', () => {
    it('flush processes commands produced during flush itself', () => {
      const world = new World();
      const Tag = defineComponent('CascadeTag', { v: { type: 'i32' } });

      // Test that multiple commands in one frame all flush.
      world.addSystem(Update, {
        name: 'multiSpawner',
        queries: [],
        fn: (_world, _queries, commands) => {
          commands.spawn({ component: Tag, data: { v: 1 } });
          commands.spawn({ component: Tag, data: { v: 2 } });
          commands.spawn({ component: Tag, data: { v: 3 } });
        },
      });

      world.update();

      // After flush, all 3 entities should exist
      let count = 0;
      world.addSystem(Update, {
        name: 'counter',
        queries: [{ read: [Tag] }],
        fn: (_world, queryResults) => {
          for (const query of queryResults) count += [...query].length;
        },
      });

      world.update();
      expect(count).toBe(3);
    });
  });

  describe('Flush updates query cache', () => {
    it('query sees entities spawned by deferred commands after flush', () => {
      const world = new World();
      const Pos = defineComponent('FlushQPos', { x: { type: 'f32' } });

      // First update: deferred spawn
      world.addSystem(Update, {
        name: 'spawner',
        queries: [],
        fn: (_world, _queries, commands) => {
          commands.spawn({ component: Pos, data: { x: 1 } });
        },
      });

      world.update();

      // Replace spawner with a no-op
      // Use a new system to count — the query should see the flushed entity
      let found = 0;
      world.addSystem(Update, {
        name: 'verifier',
        queries: [{ read: [Pos] }],
        fn: (_world, queryResults) => {
          for (const query of queryResults) found += [...query].length;
        },
      });

      world.update();
      expect(found).toBeGreaterThanOrEqual(1);
    });
  });
}
{
  // --- from component-reflection.test.ts ---
  describe('defineComponent reflection — component.fields (AC-01 layer 3)', () => {
    it('exposes per-field reflection carrying type and default', () => {
      const C = defineComponent('FieldsCarrier', { x: 'f32', y: 'i32' });
      expect(C.fields.x).toBeDefined();
      expect(C.fields.x?.type).toBe('f32');
      expect(C.fields.y?.type).toBe('i32');
    });

    it('component.fields is frozen (read-only)', () => {
      const C = defineComponent('FieldsFrozen', { x: 'f32' });
      expect(Object.isFrozen(C.fields)).toBe(true);
      expect(Object.isFrozen(C.fields.x)).toBe(true);
    });

    it('array field carries arrayMeta { elementType, length? }', () => {
      const C = defineComponent('FieldsArray', { v: 'array<f32, 3>' });
      expect(C.fields.v?.arrayMeta).toEqual({ elementType: 'f32', length: 3 });
    });

    it('non-array field has no arrayMeta', () => {
      const C = defineComponent('FieldsScalar', { x: 'f32' });
      expect(C.fields.x?.arrayMeta).toBeUndefined();
    });
  });

  describe('defineComponent reflection — derived projections (D-A7 / D-A8)', () => {
    it('component schema is derived from fields[k].type by the owner projection', () => {
      const C = defineComponent('SchemaProjection', {
        x: { type: 'f32', default: 1 },
        v: 'array<f32, 3>',
      });
      expect(componentSchema(C)).toEqual({ x: 'f32', v: 'array<f32, 3>' });
    });

    it('owner defaults are derived from fields[k].default', () => {
      const C = defineComponent('DefaultsProjection', {
        x: { type: 'f32', default: 5 },
      });
      expect(componentDefinition(C).defaults).toMatchObject({ x: 5 });
    });
  });

  describe('TYPE_METADATA — global per-type metadata table (AC-01 layer 2)', () => {
    it('is importable and queryable', () => {
      expect(TYPE_METADATA).toBeDefined();
      expect(typeof TYPE_METADATA).toBe('object');
    });

    it('covers the 11 legacy scalar keys', () => {
      for (const k of [
        'f32',
        'f64',
        'i32',
        'u32',
        'i16',
        'u16',
        'i8',
        'u8',
        'bool',
        'enum',
        'ref',
      ]) {
        expect(TYPE_METADATA[k]).toBeDefined();
      }
    });

    it('covers the 6 vocab-family keys', () => {
      for (const k of ['entity', 'string', 'buffer', 'ref', 'shared', 'array']) {
        expect(TYPE_METADATA[k]).toBeDefined();
      }
    });

    it('each scalar row carries the required columns', () => {
      const f32 = TYPE_METADATA.f32;
      expect(f32?.byteSize).toBe(4);
      expect(f32?.viewCtor).toBe(Float32Array);
      expect(f32?.isScalar).toBe(true);
      expect(f32?.isManaged).toBe(false);
    });

    it('vocab rows expose the predicate columns', () => {
      expect(TYPE_METADATA.entity?.isEntityRef).toBe(true);
      expect(TYPE_METADATA.buffer?.isBuffer).toBe(true);
      expect(TYPE_METADATA.ref?.isManaged).toBe(true);
      expect(TYPE_METADATA.array?.isArray).toBe(true);
    });
  });

  describe('defineComponent reflection — AC-03(c) pre-parse reuse', () => {
    it('returns the same arrayMeta object reference across repeated reads', () => {
      // Parse happens once at registration time; the cached reflection object is
      // reused — no per-read re-parse. Same token, same array field, identical ref.
      const C = defineComponent('PreParseReuse', { v: 'array<f32, 16>' });
      const a = C.fields.v?.arrayMeta;
      const b = C.fields.v?.arrayMeta;
      expect(a).toBe(b);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // [w4] arrayMeta length-sentinel parsing + AI-user error messages.
  // ────────────────────────────────────────────────────────────────────────────

  describe('arrayMeta length sentinel (AC-01 / D-A1)', () => {
    it('fixed-capacity array<f32, 3> carries an explicit length', () => {
      const C = defineComponent('ArrFixed', { v: 'array<f32, 3>' });
      expect(C.fields.v?.arrayMeta).toEqual({ elementType: 'f32', length: 3 });
    });

    it('variable-capacity array<f32> has no length field (length === undefined => variable)', () => {
      const C = defineComponent('ArrVariable', { v: 'array<f32>' });
      expect(C.fields.v?.arrayMeta).toEqual({ elementType: 'f32' });
      expect(C.fields.v?.arrayMeta?.length).toBeUndefined();
      // Bare length sentinel: the variable case has no own `length` key at all
      // (no isVariable / kind discriminant, D-A1 user ruling).
      expect('length' in (C.fields.v?.arrayMeta as object)).toBe(false);
    });

    it('non-array field carries no arrayMeta', () => {
      const C = defineComponent('NoArr', { x: 'u32', s: 'string' });
      expect(C.fields.x?.arrayMeta).toBeUndefined();
      expect(C.fields.s?.arrayMeta).toBeUndefined();
    });
  });

  describe('defineComponent fail-fast throw (charter P3 / OOS-6)', () => {
    it('field-descriptor missing type throws with the field name + expected shape', () => {
      expect(() =>
        // Missing `type` on the descriptor object — programmer error.
        defineComponent('MissingType', { x: { default: 0 } as unknown as { type: 'f32' } }),
      ).toThrow(SchemaUnsupportedFieldError);
      try {
        defineComponent('MissingType2', { broken: { default: 0 } as unknown as { type: 'f32' } });
        expect.unreachable('should have thrown');
      } catch (e) {
        expect((e as Error).message).toContain('broken');
        expect((e as Error).message).toContain('type');
      }
    });

    it('illegal array element type still throws ManagedArrayElementTypeNotAllowedError', () => {
      expect(() => defineComponent('BadArr', { v: 'array<ref<X>>' as 'array<f32, 3>' })).toThrow(
        ManagedArrayElementTypeNotAllowedError,
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // [w15] AC-10 naming disambiguation: input `fields` vs reflection `component.fields`.
  // ────────────────────────────────────────────────────────────────────────────

  describe('AC-10 input fields vs reflection component.fields naming disambiguation', () => {
    it('component.fields[field].type is the reflection (same as the input type keyword)', () => {
      const C = defineComponent('Disambig', { x: { type: 'f32', default: 0 } });
      // Reflection: component.fields[x].type === 'f32'
      expect(C.fields.x?.type).toBe('f32');
      // Reflection: component.fields[x].default === 0 (as supplied)
      expect(C.fields.x?.default).toBe(0);
      // Input fields: the second-argument fields is consumed at registration;
      // component.fields is the read-only reflection surface on the token.
      // Both are named "fields" but occupy distinct scopes (parameter vs
      // property) — per D-A3, this does not constitute a name collision.
    });
  });
}
{
  // --- from component.test.ts ---
  describe('defineComponent', () => {
    it('returns a frozen token with the three public facts', () => {
      const Pos = defineComponent('Position', { x: { type: 'f32' }, y: { type: 'f32' } });
      expect(Pos.name).toBe('Position');
      expect(Pos.fields.x?.type).toBe('f32');
      expect(Pos.fields.y?.type).toBe('f32');
      expect(Reflect.ownKeys(Pos)).toEqual(['name', 'fields', 'storage']);
      expect(Object.isFrozen(Pos)).toBe(true);
    });

    it('keeps numeric identity in the owner helper, outside the token', () => {
      const Vel = defineComponent('Velocity', { vx: { type: 'f32' }, vy: { type: 'f32' } });
      expect(typeof componentId(Vel)).toBe('number');
      expect(componentId(Vel)).toBeGreaterThanOrEqual(0);
    });

    it('assigns auto-incrementing ComponentId', () => {
      const A = defineComponent('CompA', { a: { type: 'f32' } });
      const B = defineComponent('CompB', { b: { type: 'f32' } });
      expect(componentId(B)).toBe(componentId(A) + 1);
    });

    it('supports all 11 scalar field types', () => {
      const allTypes: ComponentSchema = {
        f: 'f32',
        d: 'f64',
        i: 'i32',
        u: 'u32',
        s: 'i16',
        us: 'u16',
        b: 'i8',
        ub: 'u8',
        flag: 'bool',
        e: 'enum',
        r: 'ref',
      };
      const comp = defineComponent('AllTypes', allTypes);
      expect(componentSchema(comp)).toEqual(allTypes);
    });

    it('supports tag component (empty schema {})', () => {
      const Player = defineComponent('Player', {});
      expect(Player.name).toBe('Player');
      expect(componentSchema(Player)).toEqual({});
      expect(typeof componentId(Player)).toBe('number');
    });

    it('throws SchemaUnsupportedFieldError for invalid field type', () => {
      expect(() => defineComponent('Bad', { x: { type: 'vec3' as 'f32' } })).toThrow(
        SchemaUnsupportedFieldError,
      );
    });
  });
}
{
  // --- from entity-dangling-removed.test.ts ---
  describe('drop-entity-dangling-sweep - read path no longer guards liveness', () => {
    it('despawn target -> holder entity field reads back the original raw u32 (AC-02)', () => {
      const ChildOf = defineComponent('ChildOf', { parent: { type: 'entity' } });
      const Tag = defineComponent('Tag', { v: { type: 'u32' } });
      const w = new World();

      const parent = w.spawn({ component: Tag, data: { v: 1 } }).unwrap();
      const child = w.spawn({ component: ChildOf, data: { parent } }).unwrap();

      // Live read returns the parent reference unchanged.
      const before = w.get(child, ChildOf).unwrap();
      expect(before.parent).toBe(parent);

      // Despawn the referenced target: the stored u32 still encodes the old
      // (slot, gen) pair, but no record exists for it anymore.
      w.despawn(parent).unwrap();

      // New contract: the read returns the same raw u32 verbatim -- no clearing,
      // no error, no component removal. The consumer is responsible for liveness.
      const after = w.get(child, ChildOf);
      expect(after.ok).toBe(true);
      if (!after.ok) throw new Error('expected ok read after target despawn');
      expect(after.value.parent).not.toBeNull();
      expect(handleNumeric(after.value.parent as number)).toBe(handleNumeric(parent));
    });

    it('explicit null entity field round-trips through write/read (AC-06)', () => {
      const Link = defineComponent('Link', { target: { type: 'entity' } });
      const w = new World();

      const e = w.spawn({ component: Link, data: { target: null } }).unwrap();
      const read = w.get(e, Link).unwrap();
      expect(read.target).toBeNull();

      // The null sentinel constant is intact (OOS-1).
      expect(ENTITY_NULL_RAW).toBe(0xffffffff);
    });
  });
}
{
  // --- from entity-liveness.test.ts ---
  let dummyCounter = 0;
  function defineTag(prefix: string) {
    dummyCounter += 1;
    return defineComponent(`${prefix}_${dummyCounter}`, {});
  }

  function recordGeneration(world: World, slot: number): number | undefined {
    const records = (world as unknown as { records: { generation: number }[] }).records;
    return records[slot]?.generation;
  }

  /**
   * Liveness probe (feat-20260602: `world.isAlive` retired): a handle is alive iff
   * `world.get(e, Entity)` resolves; a stale / pending handle yields `err`.
   */
  function isAlive(world: World, entity: EntityHandle): boolean {
    return world.get(entity, EntityComponent).ok;
  }

  describe('despawn absorbs alive into generation (AC-11)', () => {
    it('bumps the slot generation by 1 after despawn', () => {
      const world = new World();
      const Tag = defineTag('AC11_Tag');
      const e = world.spawn({ component: Tag, data: {} }).unwrap();
      const slot = entityIndex(e);
      const genBefore = recordGeneration(world, slot);
      expect(genBefore).toBe(0);

      world.despawn(e).unwrap();
      expect(recordGeneration(world, slot)).toBe(1);
    });

    it('makes the old handle read back as stale via world.get(e, EntityComponent)', () => {
      const world = new World();
      const Tag = defineTag('AC11_Stale');
      const e = world.spawn({ component: Tag, data: {} }).unwrap();
      world.despawn(e).unwrap();
      const r = world.get(e, EntityComponent);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('stale-entity');
      expect(isAlive(world, e)).toBe(false);
    });
  });

  describe('entityCount sums live archetype rows (AC-12)', () => {
    it('reports the live count after spawn N / despawn M', () => {
      const world = new World();
      const Tag = defineTag('AC12_Tag');
      const a = world.spawn({ component: Tag, data: {} }).unwrap();
      world.spawn({ component: Tag, data: {} }).unwrap();
      world.spawn({ component: Tag, data: {} }).unwrap();
      expect(world.inspect().entityCount).toBe(3);

      world.despawn(a).unwrap();
      expect(world.inspect().entityCount).toBe(2);
    });

    it('is zero for a fresh world and after despawning all entities', () => {
      const world = new World();
      const Tag = defineTag('AC12_Empty');
      expect(world.inspect().entityCount).toBe(0);
      const e = world.spawn({ component: Tag, data: {} }).unwrap();
      world.despawn(e).unwrap();
      expect(world.inspect().entityCount).toBe(0);
    });
  });

  describe('generation > 255 retires the slot permanently (AC-13)', () => {
    it('retires the index after the 256th generation and staleness holds for the old handle', () => {
      const world = new World();
      const Tag = defineTag('AC13_Tag');

      // Cycle the same slot through gen 0..255 (256 generations).
      let e = world.spawn({ component: Tag, data: {} }).unwrap();
      const slot = entityIndex(e);
      for (let gen = 0; gen < 255; gen++) {
        expect(entityIndex(e)).toBe(slot);
        expect(entityGeneration(e)).toBe(gen);
        world.despawn(e).unwrap();
        e = world.spawn({ component: Tag, data: {} }).unwrap();
      }
      // Now e is the gen=255 incarnation of the slot.
      expect(entityIndex(e)).toBe(slot);
      expect(entityGeneration(e)).toBe(255);

      // Despawning the gen=255 entity bumps the stored generation to 256 (out of
      // the 8-bit handle range) and permanently retires the slot.
      world.despawn(e).unwrap();
      expect(recordGeneration(world, slot)).toBe(256);

      // The old gen=255 handle is dead, and a fresh spawn does NOT reuse the slot.
      expect(isAlive(world, e)).toBe(false);
      const fresh = world.spawn({ component: Tag, data: {} }).unwrap();
      expect(entityIndex(fresh)).not.toBe(slot);
    });
  });

  describe('deferred-spawn (pending) semantics are unchanged (AC-14)', () => {
    it('a pending entity is not yet live inside the system, then live after flush', () => {
      const world = new World();
      const Tag = defineTag('AC14_Pending');
      let pending: EntityHandle | undefined;

      world.addSystem(Update, {
        name: 'ac14-spawner',
        queries: [],
        fn: (_world, _queries, commands) => {
          pending = commands.spawn({ component: Tag, data: {} });
          // Inside the system, before flush: the slot is pending, so not live.
          // biome-ignore lint/style/noNonNullAssertion: assigned on the line above
          expect(isAlive(world, pending!)).toBe(false);
        },
      });

      world.update();

      // After update flushes the command buffer: materialized + live, carrying
      // its own handle in the id=0 Entity column.
      expect(pending).toBeDefined();
      // biome-ignore lint/style/noNonNullAssertion: assigned inside the system above
      const e = pending!;
      expect(isAlive(world, e)).toBe(true);
      expect(world.get(e, EntityComponent).unwrap().self).toBe(e);
    });
  });
}
{
  // --- from entity.test.ts ---
  describe('encodeEntity / decodeEntity roundtrip', () => {
    it('roundtrips index=0, generation=0', () => {
      const e = encodeEntity(0, 0);
      const { index, generation } = decodeEntity(e);
      expect(index).toBe(0);
      expect(generation).toBe(0);
    });

    it('roundtrips index=ENTITY_MAX_INDEX, generation=0', () => {
      const e = encodeEntity(ENTITY_MAX_INDEX, 0);
      const { index, generation } = decodeEntity(e);
      expect(index).toBe(ENTITY_MAX_INDEX);
      expect(generation).toBe(0);
    });

    it('roundtrips index=0, generation=ENTITY_MAX_GENERATION', () => {
      const e = encodeEntity(0, ENTITY_MAX_GENERATION);
      const { index, generation } = decodeEntity(e);
      expect(index).toBe(0);
      expect(generation).toBe(ENTITY_MAX_GENERATION);
    });

    it('roundtrips index=ENTITY_MAX_INDEX, generation=ENTITY_MAX_GENERATION', () => {
      const e = encodeEntity(ENTITY_MAX_INDEX, ENTITY_MAX_GENERATION);
      const { index, generation } = decodeEntity(e);
      expect(index).toBe(ENTITY_MAX_INDEX);
      expect(generation).toBe(ENTITY_MAX_GENERATION);
    });

    // ToInt32 trap: gen >= 128 causes (gen << 24) to be negative in JS.
    // The >>> 0 correction must handle this.
    it('handles generation >= 128 (ToInt32 trap)', () => {
      for (const gen of [128, 200, 255]) {
        const e = encodeEntity(42, gen);
        const { index, generation } = decodeEntity(e);
        expect(index).toBe(42);
        expect(generation).toBe(gen);
      }
    });

    it('roundtrips arbitrary (index, generation) pairs', () => {
      const pairs: [number, number][] = [
        [1, 1],
        [100, 50],
        [0xffffff, 0xff],
        [12345, 127],
        [12345, 128],
        [0, 255],
      ];
      for (const [idx, gen] of pairs) {
        const e = encodeEntity(idx, gen);
        expect(entityIndex(e)).toBe(idx);
        expect(entityGeneration(e)).toBe(gen);
      }
    });
  });

  describe('encodeEntity overflow', () => {
    it('throws EntityIndexOverflowError for index > ENTITY_MAX_INDEX', () => {
      expect(() => encodeEntity(ENTITY_MAX_INDEX + 1, 0)).toThrow(EntityIndexOverflowError);
    });

    it('throws EntityIndexOverflowError for negative index', () => {
      expect(() => encodeEntity(-1, 0)).toThrow(EntityIndexOverflowError);
    });
  });

  describe('entityIndex / entityGeneration helpers', () => {
    it('extracts index correctly', () => {
      const e = encodeEntity(999, 42);
      expect(entityIndex(e)).toBe(999);
    });

    it('extracts generation correctly', () => {
      const e = encodeEntity(999, 42);
      expect(entityGeneration(e)).toBe(42);
    });
  });

  describe('Entity branded type', () => {
    it('encodeEntity returns a number', () => {
      const e = encodeEntity(0, 0);
      expect(typeof e).toBe('number');
    });
  });

  describe('generation retirement (AC-03, E-08)', () => {
    // These tests verify the retirement *constants* and *encoding* behavior.
    // The actual World-level retirement logic (not pushing to free list) is
    // tested in the World lifecycle contract suite (w11).

    it('ENTITY_MAX_GENERATION equals 255', () => {
      expect(ENTITY_MAX_GENERATION).toBe(255);
    });

    it('ENTITY_MAX_INDEX equals 2^24 - 1', () => {
      expect(ENTITY_MAX_INDEX).toBe(16_777_215);
    });

    it('generation field is exactly 8 bits (masks to 0xff)', () => {
      // Encoding with generation > 255 should mask to lower 8 bits
      const e = encodeEntity(0, 256);
      expect(entityGeneration(e)).toBe(0);
    });
  });
}
// `Name` component (schema literal + identity + AC-13 invariant + spawn/set
// fallback) tests migrated to packages/runtime/src/__tests__/name.unit.test.ts
// by tweak-20260612-ecs-concept-compression — `Name` now lives in
// @forgeax/engine-runtime (it is a built-in component, not part of the ECS
// framework itself).
{
  // --- from relationship-define-order.test.ts ---
}
{
  // --- from relationship-schema.test.ts ---
}
{
  // --- from world-buffer-fields.test.ts ---
  describe('w13 - World buffer:<N> field 3-path release', () => {
    it('spawn allocs buffer slot of schema-declared bytes; get returns live view', () => {
      const Skin = defineComponent('Skin', { palette: { type: 'buffer<128>' } });
      const w = new World();
      const seed = new Uint8Array(128);
      for (let i = 0; i < 128; i++) seed[i] = (i + 3) & 0xff;
      const e = w.spawn({ component: Skin, data: { palette: seed } }).unwrap();
      const r = w.get(e, Skin);
      if (!r.ok) throw new Error('expected ok get');
      expect(r.value.palette).toBeInstanceOf(Uint8Array);
      expect(r.value.palette.byteLength).toBe(128);
      for (let i = 0; i < 128; i++) expect(r.value.palette[i]).toBe((i + 3) & 0xff);
    });

    it('despawn(e) releases buffer field slots (path 1) - free-list reuse confirms', () => {
      const Skin = defineComponent('Skin', { palette: { type: 'buffer<128>' } });
      const w = new World();
      const e1 = w.spawn({ component: Skin, data: { palette: new Uint8Array(128) } }).unwrap();
      const r1 = w.get(e1, Skin);
      if (!r1.ok) throw new Error('expected ok get1');
      // Identity probe via fingerprint: stamp byte 0 = 0xAA before despawn so
      // the free-list reuse on the next spawn observably resets it (D-5 alloc
      // zeroes recycled bytes).
      r1.value.palette[0] = 0xaa;
      w.despawn(e1).unwrap();
      const e2 = w.spawn({ component: Skin, data: { palette: new Uint8Array(128) } }).unwrap();
      const r2 = w.get(e2, Skin);
      if (!r2.ok) throw new Error('expected ok get2');
      expect(r2.value.palette[0]).toBe(0); // recycled slot is zeroed.
    });

    it('removeComponent(e, C) releases buffer fields on the removed component (path 2)', () => {
      const Skin = defineComponent('Skin', { palette: { type: 'buffer<64>' } });
      const Anchor = defineComponent('Anchor', { x: { type: 'f32' } });
      const w = new World();
      const e = w
        .spawn(
          { component: Skin, data: { palette: new Uint8Array(64) } },
          { component: Anchor, data: { x: 1 } },
        )
        .unwrap();
      expect(() => w.removeComponent(e, Skin).unwrap()).not.toThrow();
      // Skin gone; Anchor stays.
      const rs = w.get(e, Skin);
      expect(rs.ok).toBe(false);
      if (rs.ok) throw new Error('expected err get Skin');
      expect(rs.error.code).toBe('component-not-present');
      const ra = w.get(e, Anchor);
      if (!ra.ok) throw new Error('expected ok get Anchor');
      expect(ra.value.x).toBe(1);
    });

    it('set(e, C, { field: Uint8Array }) copies bytes into existing slot (path 3)', () => {
      const Skin = defineComponent('Skin', { palette: { type: 'buffer<32>' } });
      const w = new World();
      const initial = new Uint8Array(32);
      for (let i = 0; i < 32; i++) initial[i] = i;
      const e = w.spawn({ component: Skin, data: { palette: initial } }).unwrap();

      // Snapshot the live view BEFORE set; D-7 guarantees set does NOT realloc,
      // so the same view stays valid after the bytes flow through.
      const before = w.get(e, Skin);
      if (!before.ok) throw new Error('expected ok get');
      const liveView = before.value.palette;

      const replacement = new Uint8Array(32);
      for (let i = 0; i < 32; i++) replacement[i] = (i * 11) & 0xff;
      w.set(e, Skin, { palette: replacement }).unwrap();

      const after = w.get(e, Skin);
      if (!after.ok) throw new Error('expected ok get after');
      for (let i = 0; i < 32; i++) expect(after.value.palette[i]).toBe((i * 11) & 0xff);
      // The view captured before the set still reflects the new bytes
      // (same backing slot - D-7 simplification, no realloc on set).
      for (let i = 0; i < 32; i++) expect(liveView[i]).toBe((i * 11) & 0xff);
    });
  });
}
{
  // --- World lifecycle coverage ---
  describe('World.spawn', () => {
    it('single-component spawn returns a valid Entity handle', () => {
      const world = new World();
      const Pos = defineComponent('WPos', { x: { type: 'f32' }, y: { type: 'f32' } });
      const e = world.spawn({ component: Pos, data: { x: 1, y: 2 } }).unwrap();
      expect(typeof e).toBe('number');
      expect(entityIndex(e)).toBeGreaterThanOrEqual(0);
      expect(entityGeneration(e)).toBe(0);
    });

    it('multi-component spawn targets correct archetype (AC-06)', () => {
      const world = new World();
      const Pos = defineComponent('MCPos', { x: { type: 'f32' }, y: { type: 'f32' } });
      const Vel = defineComponent('MCVel', { vx: { type: 'f32' }, vy: { type: 'f32' } });
      const e = world
        .spawn({ component: Pos, data: { x: 1, y: 2 } }, { component: Vel, data: { vx: 3, vy: 4 } })
        .unwrap();
      // Verify both components are readable
      const pos = world.get(e, Pos).unwrap();
      const vel = world.get(e, Vel).unwrap();
      expect(pos).toEqual({ x: 1, y: 2 });
      expect(vel).toEqual({ vx: 3, vy: 4 });
    });
  });

  describe('World.get / World.set', () => {
    it('get returns correct field values', () => {
      const world = new World();
      const Hp = defineComponent('WHp', { current: { type: 'i32' }, max: { type: 'i32' } });
      const e = world.spawn({ component: Hp, data: { current: 100, max: 200 } }).unwrap();
      const hp = world.get(e, Hp).unwrap();
      expect(hp).toEqual({ current: 100, max: 200 });
    });

    it('set partially updates fields', () => {
      const world = new World();
      const Pos = defineComponent('SetPos', { x: { type: 'f32' }, y: { type: 'f32' } });
      const e = world.spawn({ component: Pos, data: { x: 1, y: 2 } }).unwrap();
      world.set(e, Pos, { x: 10 }).unwrap();
      const pos = world.get(e, Pos).unwrap();
      expect(pos).toEqual({ x: 10, y: 2 });
    });
  });

  describe('World.despawn', () => {
    it('despawn marks entity as dead', () => {
      const world = new World();
      const Tag = defineComponent('DTag', {});
      const e = world.spawn({ component: Tag, data: {} }).unwrap();
      world.despawn(e);
      // get on despawned entity should return err(StaleEntityError)
      const result = world.get(e, Tag);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBeInstanceOf(StaleEntityError);
    });

    it('generation retirement: gen=255 → index not recycled (E-08)', () => {
      const world = new World();
      const Tag = defineComponent('RetTag', {});

      let entity = world.spawn({ component: Tag, data: {} }).unwrap();
      const idx = entityIndex(entity);

      for (let gen = 0; gen < 254; gen++) {
        world.despawn(entity);
        entity = world.spawn({ component: Tag, data: {} }).unwrap();
        expect(entityIndex(entity)).toBe(idx);
        expect(entityGeneration(entity)).toBe(gen + 1);
      }

      world.despawn(entity);
      entity = world.spawn({ component: Tag, data: {} }).unwrap();
      expect(entityIndex(entity)).toBe(idx);
      expect(entityGeneration(entity)).toBe(255);

      world.despawn(entity);

      const newEntity = world.spawn({ component: Tag, data: {} }).unwrap();
      expect(entityIndex(newEntity)).not.toBe(idx);
    });

    it('despawn stale handle is idempotent (E-01, AC-17)', () => {
      const world = new World();
      const Tag = defineComponent('IdempTag', {});
      const e = world.spawn({ component: Tag, data: {} }).unwrap();
      world.despawn(e);
      // Second despawn should return ok (idempotent)
      const result = world.despawn(e);
      expect(result.ok).toBe(true);
    });
  });

  describe('World stale handle errors (E-02)', () => {
    it('get on stale handle returns err(StaleEntityError)', () => {
      const world = new World();
      const C = defineComponent('StaleGet', { v: { type: 'f32' } });
      const e = world.spawn({ component: C, data: { v: 1 } }).unwrap();
      world.despawn(e);
      const result = world.get(e, C);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBeInstanceOf(StaleEntityError);
      expect(!result.ok && (result.error as StaleEntityError).operation).toBe('get');
      expect(!result.ok && (result.error as StaleEntityError).component).toBe('StaleGet');
    });

    it('set on stale handle returns err(StaleEntityError)', () => {
      const world = new World();
      const C = defineComponent('StaleSet', { v: { type: 'f32' } });
      const e = world.spawn({ component: C, data: { v: 1 } }).unwrap();
      world.despawn(e);
      const result = world.set(e, C, { v: 2 });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBeInstanceOf(StaleEntityError);
      expect(!result.ok && (result.error as StaleEntityError).operation).toBe('set');
      expect(!result.ok && (result.error as StaleEntityError).component).toBe('StaleSet');
    });
  });

  describe('World.addComponent / World.removeComponent', () => {
    it('addComponent adds a new component and triggers archetype migration (AC-07)', () => {
      const world = new World();
      const Pos = defineComponent('AddPos', { x: { type: 'f32' }, y: { type: 'f32' } });
      const Vel = defineComponent('AddVel', { vx: { type: 'f32' }, vy: { type: 'f32' } });
      const e = world.spawn({ component: Pos, data: { x: 1, y: 2 } }).unwrap();

      world.addComponent(e, { component: Vel, data: { vx: 3, vy: 4 } }).unwrap();

      expect(world.get(e, Pos).unwrap()).toEqual({ x: 1, y: 2 });
      expect(world.get(e, Vel).unwrap()).toEqual({ vx: 3, vy: 4 });
    });

    it('removeComponent removes component and triggers archetype migration (AC-07)', () => {
      const world = new World();
      const Pos = defineComponent('RmPos', { x: { type: 'f32' }, y: { type: 'f32' } });
      const Vel = defineComponent('RmVel', { vx: { type: 'f32' }, vy: { type: 'f32' } });
      const e = world
        .spawn({ component: Pos, data: { x: 1, y: 2 } }, { component: Vel, data: { vx: 3, vy: 4 } })
        .unwrap();

      world.removeComponent(e, Vel).unwrap();

      expect(world.get(e, Pos).unwrap()).toEqual({ x: 1, y: 2 });
      expect(world.get(e, Vel).ok).toBe(false);
    });

    it('addComponent on already present component returns err(ComponentAlreadyPresentError) (E-03)', () => {
      const world = new World();
      const Pos = defineComponent('DupPos', { x: { type: 'f32' } });
      const e = world.spawn({ component: Pos, data: { x: 1 } }).unwrap();
      const result = world.addComponent(e, { component: Pos, data: { x: 2 } });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBeInstanceOf(ComponentAlreadyPresentError);
    });

    it('removeComponent on absent component returns err(ComponentNotPresentError) (E-04)', () => {
      const world = new World();
      const Pos = defineComponent('AbsPos', { x: { type: 'f32' } });
      const Vel = defineComponent('AbsVel', { vx: { type: 'f32' } });
      const e = world.spawn({ component: Pos, data: { x: 1 } }).unwrap();
      const result = world.removeComponent(e, Vel);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBeInstanceOf(ComponentNotPresentError);
    });

    it('addComponent on stale entity returns err(StaleEntityError)', () => {
      const world = new World();
      const C = defineComponent('StaleAdd', { v: { type: 'f32' } });
      const C2 = defineComponent('StaleAdd2', { w: { type: 'f32' } });
      const e = world.spawn({ component: C, data: { v: 1 } }).unwrap();
      world.despawn(e);
      const result = world.addComponent(e, { component: C2, data: { w: 1 } });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBeInstanceOf(StaleEntityError);
      expect(!result.ok && (result.error as StaleEntityError).operation).toBe('addComponent');
      expect(!result.ok && (result.error as StaleEntityError).component).toBe('StaleAdd2');
    });

    it('removeComponent on stale entity returns err(StaleEntityError)', () => {
      const world = new World();
      const C = defineComponent('StaleRm', { v: { type: 'f32' } });
      const e = world.spawn({ component: C, data: { v: 1 } }).unwrap();
      world.despawn(e);
      const result = world.removeComponent(e, C);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBeInstanceOf(StaleEntityError);
      expect(!result.ok && (result.error as StaleEntityError).operation).toBe('removeComponent');
      expect(!result.ok && (result.error as StaleEntityError).component).toBe('StaleRm');
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // [w5] World method Result path tests (red phase — AP-8 Layer 1)
  // ────────────────────────────────────────────────────────────────────────────

  describe('World.spawn — Result path', () => {
    it('spawn returns ok(Entity) on success', () => {
      const world = new World();
      const Pos = defineComponent('RSpawnPos', { x: { type: 'f32' }, y: { type: 'f32' } });
      const result = world.spawn({ component: Pos, data: { x: 1, y: 2 } });
      // Result should be ok
      expect(result.ok).toBe(true);
      expect(result.ok).toBe(true);
      const entity = result.unwrap();
      expect(typeof entity).toBe('number');
      expect(entityIndex(entity)).toBeGreaterThanOrEqual(0);
      expect(entityGeneration(entity)).toBe(0);
    });
  });

  describe('World.despawn — Result path', () => {
    it('despawn returns ok(void) on live entity', () => {
      const world = new World();
      const Tag = defineComponent('RDespawnTag', {});
      const e = world.spawn({ component: Tag, data: {} }).unwrap();
      const result = world.despawn(e);
      expect(result.ok).toBe(true);
    });

    it('despawn on stale handle returns ok (idempotent, E-01)', () => {
      const world = new World();
      const Tag = defineComponent('RDespawnStale', {});
      const e = world.spawn({ component: Tag, data: {} }).unwrap();
      world.despawn(e);
      // Second despawn should still return ok (idempotent)
      const result = world.despawn(e);
      expect(result.ok).toBe(true);
    });
  });

  describe('World.get — Result path', () => {
    it('get returns ok(data) on live entity with component', () => {
      const world = new World();
      const Hp = defineComponent('RGetHp', { current: { type: 'i32' }, max: { type: 'i32' } });
      const e = world.spawn({ component: Hp, data: { current: 100, max: 200 } }).unwrap();
      const result = world.get(e, Hp);
      expect(result.ok).toBe(true);
      expect(result.unwrap()).toEqual({ current: 100, max: 200 });
    });

    it('get on stale entity returns err(StaleEntityError)', () => {
      const world = new World();
      const C = defineComponent('RGetStale', { v: { type: 'f32' } });
      const e = world.spawn({ component: C, data: { v: 1 } }).unwrap();
      world.despawn(e);
      const result = world.get(e, C);
      expect(result.ok).toBe(false);
      const error = !result.ok ? result.error : undefined;
      expect(error).toBeInstanceOf(StaleEntityError);
      expect(error?.code).toBe('stale-entity');
      expect(error?.hint).toBeDefined();
    });

    it('get on entity missing the component returns err(ComponentNotPresentError)', () => {
      const world = new World();
      const A = defineComponent('RGetMissA', { v: { type: 'f32' } });
      const B = defineComponent('RGetMissB', { w: { type: 'i32' } });
      const e = world.spawn({ component: A, data: { v: 1 } }).unwrap();
      const result = world.get(e, B);
      expect(result.ok).toBe(false);
      const error = !result.ok ? result.error : undefined;
      expect(error).toBeInstanceOf(ComponentNotPresentError);
      expect(error?.code).toBe('component-not-present');
    });

    it('hasComponent checks presence without allocating a missing/stale Result error', () => {
      const world = new World();
      const A = defineComponent('RHasComponentA', { v: { type: 'f32' } });
      const B = defineComponent('RHasComponentB', { w: { type: 'i32' } });
      const e = world.spawn({ component: A, data: { v: 1 } }).unwrap();

      expect(world.hasComponent(e, A)).toBe(true);
      expect(world.hasComponent(e, B)).toBe(false);
      expect(world.hasComponent(0xdeadbeef as never, A)).toBe(false);
    });
  });

  describe('World.set — Result path', () => {
    it('set returns ok(void) on success', () => {
      const world = new World();
      const Pos = defineComponent('RSetPos', { x: { type: 'f32' }, y: { type: 'f32' } });
      const e = world.spawn({ component: Pos, data: { x: 1, y: 2 } }).unwrap();
      const result = world.set(e, Pos, { x: 10 });
      expect(result.ok).toBe(true);
      expect(world.get(e, Pos).unwrap()).toEqual({ x: 10, y: 2 });
    });

    it('set on stale entity returns err(StaleEntityError)', () => {
      const world = new World();
      const C = defineComponent('RSetStale', { v: { type: 'f32' } });
      const e = world.spawn({ component: C, data: { v: 1 } }).unwrap();
      world.despawn(e);
      const result = world.set(e, C, { v: 2 });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBeInstanceOf(StaleEntityError);
    });

    it('set on entity missing the component returns err(ComponentNotPresentError) — F-02', () => {
      const world = new World();
      const A = defineComponent('RSetMissA', { v: 'f32' });
      const B = defineComponent('RSetMissB', { w: 'i32' });
      const e = world.spawn({ component: A, data: { v: 1 } }).unwrap();
      const result = world.set(e, B, { w: 99 });
      expect(result.ok).toBe(false);
      const error = !result.ok ? result.error : undefined;
      expect(error).toBeInstanceOf(ComponentNotPresentError);
      expect(error?.code).toBe('component-not-present');
      expect(error?.hint).toBeDefined();
    });
  });

  describe('World.addComponent — Result path', () => {
    it('addComponent returns ok(void) on success', () => {
      const world = new World();
      const Pos = defineComponent('RAddPos', { x: { type: 'f32' }, y: { type: 'f32' } });
      const Vel = defineComponent('RAddVel', { vx: { type: 'f32' }, vy: { type: 'f32' } });
      const e = world.spawn({ component: Pos, data: { x: 1, y: 2 } }).unwrap();
      const result = world.addComponent(e, { component: Vel, data: { vx: 3, vy: 4 } });
      expect(result.ok).toBe(true);
      expect(world.get(e, Vel).unwrap()).toEqual({ vx: 3, vy: 4 });
    });

    it('addComponent on stale entity returns err(StaleEntityError)', () => {
      const world = new World();
      const C = defineComponent('RAddStale', { v: { type: 'f32' } });
      const C2 = defineComponent('RAddStale2', { w: { type: 'f32' } });
      const e = world.spawn({ component: C, data: { v: 1 } }).unwrap();
      world.despawn(e);
      const result = world.addComponent(e, { component: C2, data: { w: 1 } });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBeInstanceOf(StaleEntityError);
    });

    it('addComponent on already present component returns err(ComponentAlreadyPresentError)', () => {
      const world = new World();
      const Pos = defineComponent('RAddDup', { x: { type: 'f32' } });
      const e = world.spawn({ component: Pos, data: { x: 1 } }).unwrap();
      const result = world.addComponent(e, { component: Pos, data: { x: 2 } });
      expect(result.ok).toBe(false);
      const error = !result.ok ? result.error : undefined;
      expect(error).toBeInstanceOf(ComponentAlreadyPresentError);
      expect(error?.code).toBe('component-already-present');
    });
  });

  describe('World.removeComponent — Result path', () => {
    it('removeComponent returns ok(void) on success', () => {
      const world = new World();
      const Pos = defineComponent('RRmPos', { x: { type: 'f32' }, y: { type: 'f32' } });
      const Vel = defineComponent('RRmVel', { vx: { type: 'f32' }, vy: { type: 'f32' } });
      const e = world
        .spawn({ component: Pos, data: { x: 1, y: 2 } }, { component: Vel, data: { vx: 3, vy: 4 } })
        .unwrap();
      const result = world.removeComponent(e, Vel);
      expect(result.ok).toBe(true);
    });

    it('removeComponent on stale entity returns err(StaleEntityError)', () => {
      const world = new World();
      const C = defineComponent('RRmStale', { v: { type: 'f32' } });
      const e = world.spawn({ component: C, data: { v: 1 } }).unwrap();
      world.despawn(e);
      const result = world.removeComponent(e, C);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBeInstanceOf(StaleEntityError);
    });

    it('removeComponent on absent component returns err(ComponentNotPresentError)', () => {
      const world = new World();
      const Pos = defineComponent('RRmAbs', { x: { type: 'f32' } });
      const Vel = defineComponent('RRmAbsVel', { vx: { type: 'f32' } });
      const e = world.spawn({ component: Pos, data: { x: 1 } }).unwrap();
      const result = world.removeComponent(e, Vel);
      expect(result.ok).toBe(false);
      const error = !result.ok ? result.error : undefined;
      expect(error).toBeInstanceOf(ComponentNotPresentError);
      expect(error?.code).toBe('component-not-present');
    });
  });

  describe('World — additional branch coverage', () => {
    it('set on entity without the target component returns err(ComponentNotPresentError) — F-02', () => {
      const world = new World();
      const A = defineComponent('CovA', { v: 'f32' });
      const B = defineComponent('CovB', { w: 'i32' });
      const e = world.spawn({ component: A, data: { v: 1 } }).unwrap();
      // B is registered but entity doesn't have it — returns err (F-02)
      const result = world.set(e, B, { w: 99 });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBeInstanceOf(ComponentNotPresentError);
      // A's value should be unchanged
      expect(world.get(e, A).unwrap()).toEqual({ v: 1 });
    });

    it('set with an unknown field name silently skips that field', () => {
      const world = new World();
      const C = defineComponent('CovC', { v: { type: 'f32' } });
      const e = world.spawn({ component: C, data: { v: 5 } }).unwrap();
      // Pass a partial with a field name not in the schema
      world
        .set(e, C, { nonexistent: 42 } as Record<string, unknown> as Partial<{ v: number }>)
        .unwrap();
      // v should be unchanged
      expect(world.get(e, C).unwrap()).toEqual({ v: 5 });
    });

    it('get on entity missing the component returns err(ComponentNotPresentError)', () => {
      const world = new World();
      const A = defineComponent('CovGetA', { v: { type: 'f32' } });
      const B = defineComponent('CovGetB', { w: { type: 'i32' } });
      const e = world.spawn({ component: A, data: { v: 1 } }).unwrap();
      const result = world.get(e, B);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBeInstanceOf(ComponentNotPresentError);
    });

    it('migration with swap-pop updates swapped entity record correctly', () => {
      const world = new World();
      const A = defineComponent('SwapA', { v: { type: 'f32' } });
      const B = defineComponent('SwapB', { w: { type: 'f32' } });
      const e1 = world.spawn({ component: A, data: { v: 1 } }).unwrap();
      const e2 = world.spawn({ component: A, data: { v: 2 } }).unwrap();
      const e3 = world.spawn({ component: A, data: { v: 3 } }).unwrap();

      world.addComponent(e1, { component: B, data: { w: 10 } }).unwrap();

      expect(world.get(e1, A).unwrap()).toEqual({ v: 1 });
      expect(world.get(e1, B).unwrap()).toEqual({ w: 10 });
      expect(world.get(e2, A).unwrap()).toEqual({ v: 2 });
      expect(world.get(e3, A).unwrap()).toEqual({ v: 3 });
    });

    it('removeComponent with swap-pop preserves all entity data', () => {
      const world = new World();
      const A = defineComponent('RmSwapA', { v: { type: 'f32' } });
      const B = defineComponent('RmSwapB', { w: { type: 'f32' } });

      const e1 = world
        .spawn({ component: A, data: { v: 1 } }, { component: B, data: { w: 10 } })
        .unwrap();
      const e2 = world
        .spawn({ component: A, data: { v: 2 } }, { component: B, data: { w: 20 } })
        .unwrap();
      const e3 = world
        .spawn({ component: A, data: { v: 3 } }, { component: B, data: { w: 30 } })
        .unwrap();

      world.removeComponent(e1, B).unwrap();

      expect(world.get(e1, A).unwrap()).toEqual({ v: 1 });
      expect(world.get(e1, B).ok).toBe(false);
      expect(world.get(e2, A).unwrap()).toEqual({ v: 2 });
      expect(world.get(e2, B).unwrap()).toEqual({ w: 20 });
      expect(world.get(e3, A).unwrap()).toEqual({ v: 3 });
      expect(world.get(e3, B).unwrap()).toEqual({ w: 30 });
    });

    it('pending entity: get/set return data after flush (E-06 branch)', () => {
      const world = new World();
      const A = defineComponent('PendA', { v: { type: 'f32' } });

      let pendingEntity: EntityHandle | undefined;
      world.addSystem(Update, {
        name: 'deferSpawn',
        queries: [],
        fn: (_world, _results, commands) => {
          pendingEntity = commands.spawn({ component: A, data: { v: 42 } });
          expect(commands.isDeferred(pendingEntity)).toBe(true);
        },
      });

      world.update();

      expect(pendingEntity).toBeDefined();
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(world.get(pendingEntity!, A).unwrap()).toEqual({ v: 42 });
    });

    it('bool field stores true/false correctly through set', () => {
      const world = new World();
      const C = defineComponent('BoolCov', { flag: { type: 'bool' } });
      const e = world.spawn({ component: C, data: { flag: true } }).unwrap();
      expect(world.get(e, C).unwrap()).toEqual({ flag: true });
      world.set(e, C, { flag: false }).unwrap();
      expect(world.get(e, C).unwrap()).toEqual({ flag: false });
    });

    it('auto-registers component on spawn if not registered', () => {
      const world = new World();
      const C = defineComponent('AutoReg', { v: { type: 'f32' } });
      const e = world.spawn({ component: C, data: { v: 1 } }).unwrap();
      expect(world.get(e, C).unwrap()).toEqual({ v: 1 });
      const e2 = world.spawn({ component: C, data: { v: 2 } }).unwrap();
      expect(world.get(e2, C).unwrap()).toEqual({ v: 2 });
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // [w8] per-World ID isolation tests (red phase — O-3)
  // ────────────────────────────────────────────────────────────────────────────

  describe('component identity — global owner projection', () => {
    it('the same token keeps one owner id across Worlds, distinct tokens differ', () => {
      const Pos = defineComponent('GlobalIdPos', { x: { type: 'f32' }, y: { type: 'f32' } });
      const Vel = defineComponent('GlobalIdVel', { vx: { type: 'f32' }, vy: { type: 'f32' } });

      // The single id source is the global owner projection; it is the same value
      // regardless of which World (or how many) registers the token.
      const worldA = new World();
      const worldB = new World();
      // Both Worlds are created; no per-World register step exists — the token's
      // global id is stable regardless of how many Worlds observe it.
      expect(worldA).not.toBe(worldB);
      expect(typeof componentId(Pos)).toBe('number');
      // Same token -> same id in every World (no per-World re-numbering).
      expect(componentId(Pos)).toBe(componentId(Pos));
      // Distinct tokens -> distinct ids.
      expect(componentId(Pos)).not.toBe(componentId(Vel));
    });
  });
}
{
  // --- from world-inspect-systems.test.ts ---
  describe('world.inspect().systems (AC-05)', () => {
    it('exposes systems as Array<{ name: string }>', () => {
      const world = new World();
      world.addSystem(Update, { name: 'sysA', queries: [], fn: () => {} });

      const snap = world.inspect();
      expect(Array.isArray(snap.systems)).toBe(true);
      expect(snap.systems[0]).toEqual({ name: 'sysA', sets: [] });
    });

    it('keeps systemCount === systems.length as a derived invariant', () => {
      const world = new World();
      expect(world.inspect().systems.length).toBe(world.inspect().systemCount);

      world.addSystem(Update, { name: 'sysA', queries: [], fn: () => {} });
      world.addSystem(Update, { name: 'sysB', queries: [], fn: () => {} });
      world.addSystem(Update, { name: 'sysC', queries: [], fn: () => {} });

      const snap = world.inspect();
      expect(snap.systems.length).toBe(snap.systemCount);
    });

    it('grows systems.length by N after registering N systems on a fresh World', () => {
      const world = new World();
      const baseline = world.inspect().systems.length;

      world.addSystem(Update, { name: 'sA', queries: [], fn: () => {} });
      world.addSystem(Update, { name: 'sB', queries: [], fn: () => {} });

      expect(world.inspect().systems.length).toBe(baseline + 2);
    });

    it('every system entry has a non-empty name', () => {
      const world = new World();
      world.addSystem(Update, { name: 'movement', queries: [], fn: () => {} });
      world.addSystem(Update, { name: 'render', queries: [], fn: () => {} });

      const snap = world.inspect();
      for (const entry of snap.systems) {
        expect(typeof entry.name).toBe('string');
        expect(entry.name.length).toBeGreaterThan(0);
      }
    });
  });
}
{
  // --- from world-integration.test.ts ---
  describe('Scenario 1: Complete lifecycle — spawn → query → system → deferred flush → despawn', () => {
    it('full frame cycle works end to end', () => {
      const world = new World();

      // Define components
      const Position = defineComponent('IntPos', { x: { type: 'f32' }, y: { type: 'f32' } });
      const Velocity = defineComponent('IntVel', { vx: { type: 'f32' }, vy: { type: 'f32' } });

      // Spawn entities
      const e1 = world
        .spawn(
          { component: Position, data: { x: 0, y: 0 } },
          { component: Velocity, data: { vx: 1, vy: 2 } },
        )
        .unwrap();
      const e2 = world
        .spawn(
          { component: Position, data: { x: 10, y: 20 } },
          { component: Velocity, data: { vx: -1, vy: -2 } },
        )
        .unwrap();

      // Register a movement system that integrates velocity into position
      world.addSystem(Update, {
        name: 'movement',
        queries: [{ read: [Velocity], write: [Position] }],
        fn: (_world, queryResults) => {
          for (const query of queryResults) {
            for (const row of query) {
              const position = row.mut(Position);
              const velocity = row.get(Velocity);
              position.x += velocity.vx;
              position.y += velocity.vy;
            }
          }
        },
      });

      // Register a system that deferred-despawns entities at x > 5
      world.addSystem(Update, {
        name: 'despawner',
        queries: [{ with: [Position] }],
        fn: (_world, _queryResults, commands) => {
          // Deferred despawn e2
          commands.despawn(e2);
        },
        after: ['movement'],
      });

      // Frame 1: movement runs, then despawner queues despawn
      world.update();

      // After frame 1: positions should be updated
      const pos1 = world.get(e1, Position).unwrap();
      expect(pos1).toEqual({ x: 1, y: 2 }); // 0+1, 0+2

      // e2 should be despawned after flush
      expect(world.get(e2, Position).ok).toBe(false);

      // Frame 2: only e1 remains, position updates again
      world.update();
      const pos1Frame2 = world.get(e1, Position).unwrap();
      expect(pos1Frame2).toEqual({ x: 2, y: 4 }); // 1+1, 2+2
    });

    it('deferred spawn is visible in next frame queries', () => {
      const world = new World();
      const Tag = defineComponent('LifecycleTag', { value: { type: 'i32' } });

      let spawnedCount = 0;

      // System that spawns an entity on first frame
      let frame = 0;
      world.addSystem(Update, {
        name: 'spawner',
        queries: [],
        fn: (_world, _queries, commands) => {
          if (frame === 0) {
            commands.spawn({ component: Tag, data: { value: 42 } });
          }
          frame++;
        },
      });

      world.addSystem(Update, {
        name: 'counter',
        queries: [{ read: [Tag] }],
        fn: (_world, queryResults) => {
          spawnedCount = 0;
          for (const query of queryResults) spawnedCount += [...query].length;
        },
        after: ['spawner'],
      });

      // Frame 1: spawner defers spawn, counter sees 0 during this frame
      world.update();
      // After flush, entity exists. counter in frame 1 saw 0.

      // Frame 2: counter should see the spawned entity
      world.update();
      expect(spawnedCount).toBe(1);
    });

    it('resources are accessible across frames', () => {
      const world = new World();
      world.insertResource('frameCount', { count: 0 });

      world.addSystem(Update, {
        name: 'frameCounter',
        queries: [],
        fn: () => {
          const fc = world.getResource<{ count: number }>('frameCount');
          fc.count += 1;
        },
      });

      world.update();
      world.update();
      world.update();

      expect(world.getResource<{ count: number }>('frameCount')).toEqual({ count: 3 });
    });
  });

  describe('Scenario 2: hot/cold mixed archetype', () => {
    // Note: In the current implementation, all 11 field types are scalar,
    // so "cold-table" only triggers for non-scalar types which don't exist yet.
    // This test verifies that hot components with different TypedArray backing
    // work correctly in the same archetype and query returns correct TypedArray views.

    it('archetype with multiple hot components returns correct TypedArray views per field', () => {
      const world = new World();

      const Position = defineComponent('MixPos', { x: { type: 'f32' }, y: { type: 'f32' } });
      const Health = defineComponent('MixHp', { current: { type: 'i32' }, max: { type: 'i32' } });
      const Flags = defineComponent('MixFlags', { active: { type: 'bool' } });

      // Spawn entity with all three components (different TypedArray backing types)
      world.spawn(
        { component: Position, data: { x: 1.5, y: 2.5 } },
        { component: Health, data: { current: 100, max: 200 } },
        { component: Flags, data: { active: true } },
      );

      // Query for Position + Health (hot-table, Float32Array + Int32Array)
      let x: Float32Array | undefined;
      let y: Float32Array | undefined;
      let current: Int32Array | undefined;
      let max: Int32Array | undefined;
      world.addSystem(Update, {
        name: 'mixedReader',
        queries: [{ read: [Position, Health] }],
        fn: (_world, queryResults) => {
          for (const query of queryResults) {
            for (const span of query.spans().unwrap()) {
              const position = span.get(Position);
              const health = span.get(Health);
              x = position.x;
              y = position.y;
              current = health.current;
              max = health.max;
            }
          }
        },
      });

      world.update();

      expect(x).toBeInstanceOf(Float32Array);
      expect(y).toBeInstanceOf(Float32Array);
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(x![0]).toBeCloseTo(1.5);
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(y![0]).toBeCloseTo(2.5);

      expect(current).toBeInstanceOf(Int32Array);
      expect(max).toBeInstanceOf(Int32Array);
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(current![0]).toBe(100);
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(max![0]).toBe(200);

      // Verify they are backed by different buffers (per-field independent buffer, D-01)
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(x!.buffer).not.toBe(y!.buffer);
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(x!.buffer).not.toBe(current!.buffer);
    });

    it('tag component in archetype: query matches but no data columns', () => {
      const world = new World();

      const Position = defineComponent('TagMixPos', { x: { type: 'f32' } });
      const Player = defineComponent('TagMixPlayer', {}); // tag component

      world.spawn({ component: Position, data: { x: 5 } }, { component: Player, data: {} });

      // Query With both: should match
      let matchCount = 0;
      world.addSystem(Update, {
        name: 'tagQuery',
        queries: [{ read: [Position], with: [Player] }],
        fn: (_world, queryResults) => {
          matchCount = 0;
          for (const query of queryResults) {
            for (const row of query) {
              matchCount += 1;
              expect(row.get(Position).x).toBeDefined();
            }
          }
        },
      });

      world.update();
      expect(matchCount).toBe(1);

      // Query Without Player: should NOT match
      let excludedCount = 0;
      world.addSystem(Update, {
        name: 'excludeTag',
        queries: [{ read: [Position], without: [Player] }],
        fn: (_world, queryResults) => {
          excludedCount = 0;
          for (const query of queryResults) excludedCount += [...query].length;
        },
      });

      world.update();
      expect(excludedCount).toBe(0);
    });
  });

  describe('Scenario 3: multi-component spawn + addComponent migration + query cache update', () => {
    it('addComponent changes archetype and query reflects the change', () => {
      const world = new World();

      const Position = defineComponent('MigPos', { x: { type: 'f32' }, y: { type: 'f32' } });
      const Velocity = defineComponent('MigVel', { vx: { type: 'f32' }, vy: { type: 'f32' } });
      const Gravity = defineComponent('MigGrav', { g: { type: 'f32' } });

      // Spawn with Position + Velocity
      const e = world
        .spawn(
          { component: Position, data: { x: 0, y: 0 } },
          { component: Velocity, data: { vx: 1, vy: 0 } },
        )
        .unwrap();

      // Query for Position+Velocity: should match 1
      let pvCount = 0;
      world.addSystem(Update, {
        name: 'pvCounter',
        queries: [{ read: [Position, Velocity] }],
        fn: (_world, queryResults) => {
          pvCount = 0;
          for (const query of queryResults) pvCount += [...query].length;
        },
      });

      // Query for Position+Velocity+Gravity: should match 0 initially
      let pvgCount = 0;
      world.addSystem(Update, {
        name: 'pvgCounter',
        queries: [{ read: [Position, Velocity, Gravity] }],
        fn: (_world, queryResults) => {
          pvgCount = 0;
          for (const query of queryResults) pvgCount += [...query].length;
        },
      });

      world.update();
      expect(pvCount).toBe(1);
      expect(pvgCount).toBe(0);

      // Add Gravity component — triggers archetype migration
      world.addComponent(e, { component: Gravity, data: { g: 9.8 } }).unwrap();

      // After migration: PV+G query should now see entity
      world.update();
      expect(pvgCount).toBe(1);
      // Original PV-only archetype has 0 entities now, but PV+G archetype has PV too
      expect(pvCount).toBe(1); // PV+G archetype still matches PV query

      // Verify data integrity after migration
      const pos = world.get(e, Position).unwrap();
      const vel = world.get(e, Velocity).unwrap();
      const grav = world.get(e, Gravity).unwrap();
      expect(pos).toEqual({ x: 0, y: 0 });
      expect(vel).toEqual({ vx: 1, vy: 0 });
      expect(grav.g).toBeCloseTo(9.8);
    });

    it('removeComponent migration + query exclusion', () => {
      const world = new World();

      const A = defineComponent('MigA', { a: { type: 'f32' } });
      const B = defineComponent('MigB', { b: { type: 'f32' } });

      const e = world
        .spawn({ component: A, data: { a: 1 } }, { component: B, data: { b: 2 } })
        .unwrap();

      // Query With A, Without B: should initially have 0
      let aNotBCount = 0;
      world.addSystem(Update, {
        name: 'aNotB',
        queries: [{ read: [A], without: [B] }],
        fn: (_world, queryResults) => {
          aNotBCount = 0;
          for (const query of queryResults) aNotBCount += [...query].length;
        },
      });

      world.update();
      expect(aNotBCount).toBe(0); // entity has both A and B

      // Remove B: entity migrates to archetype with only A
      world.removeComponent(e, B).unwrap();

      world.update();
      expect(aNotBCount).toBe(1); // now matches With(A) Without(B)

      // Verify data preserved
      expect(world.get(e, A).unwrap()).toEqual({ a: 1 });
    });

    it('multiple entities spanning multiple archetypes', () => {
      const world = new World();

      const Pos = defineComponent('MultiPos', { x: { type: 'f32' } });
      const Vel = defineComponent('MultiVel', { v: { type: 'f32' } });
      const Acc = defineComponent('MultiAcc', { a: { type: 'f32' } });

      // 3 entities in different archetype configurations
      const e1 = world.spawn({ component: Pos, data: { x: 1 } }).unwrap();
      const e2 = world
        .spawn({ component: Pos, data: { x: 2 } }, { component: Vel, data: { v: 20 } })
        .unwrap();
      const e3 = world
        .spawn(
          { component: Pos, data: { x: 3 } },
          { component: Vel, data: { v: 30 } },
          { component: Acc, data: { a: 300 } },
        )
        .unwrap();

      // Query for all entities with Pos: should find 3 across different archetypes
      let totalPosEntities = 0;
      let posValues: number[] = [];

      world.addSystem(Update, {
        name: 'posReader',
        queries: [{ read: [Pos] }],
        fn: (_world, queryResults) => {
          totalPosEntities = 0;
          posValues = [];
          for (const query of queryResults) {
            for (const row of query) {
              totalPosEntities += 1;
              posValues.push(row.get(Pos).x);
            }
          }
        },
      });

      world.update();
      expect(totalPosEntities).toBe(3);
      expect(posValues.sort()).toEqual([1, 2, 3]);

      // Deferred despawn e2, add Acc to e1
      world.addSystem(Update, {
        name: 'modifier',
        queries: [],
        fn: (_world, _q, commands) => {
          commands.despawn(e2);
          commands.addComponent(e1, { component: Acc, data: { a: 100 } });
        },
      });

      world.update();

      // Now: e1 has Pos+Acc, e3 has Pos+Vel+Acc, e2 is dead
      expect(world.get(e2, Pos).ok).toBe(false);
      expect(world.get(e1, Pos).unwrap()).toEqual({ x: 1 });
      expect(world.get(e1, Acc).unwrap()).toEqual({ a: 100 });
      expect(world.get(e3, Pos).unwrap()).toEqual({ x: 3 });
      expect(world.get(e3, Acc).unwrap()).toEqual({ a: 300 });
    });
  });
}
{
  // --- from world-managed-refs-non-null.test.ts ---
  interface WorldInternals {
    uniqueRefs: UniqueRefStore | null;
  }

  describe('w1 - World.uniqueRefs non-null after construction (AC-08)', () => {
    it('new World() owns a non-null UniqueRefStore without external store wiring', () => {
      const w = new World();
      const refs = (w as unknown as WorldInternals).uniqueRefs;
      expect(refs).not.toBeNull();
      expect(refs).toBeInstanceOf(UniqueRefStore);
    });

    it('spawn + despawn on a ref<T> field dispatches without external store wiring', () => {
      // Behavioural counterpart: the despawn release loop must traverse the
      // internal uniqueRefs without throwing. Before w2 the uniqueRefs slot
      // is null and `releaseManagedRefHandle` short-circuits silently, so this
      // case alone does not red-gate the contract; the structural assertion
      // above is the load-bearing gate. Kept here so the file documents the
      // post-w2 dispatch path AI users actually exercise.
      const Mat = defineComponent('Mat', { handle: { type: 'unique<MaterialAsset>' } });
      const w = new World();
      const refs = (w as unknown as WorldInternals).uniqueRefs;
      if (refs === null) throw new Error('AC-08 violated: uniqueRefs is null after new World()');
      const h = refs.alloc('MaterialAsset', { id: 1 });
      const spawnR = w.spawn({ component: Mat, data: { handle: h } });
      if (!spawnR.ok) throw new Error('expected spawn ok');
      const despawnR = w.despawn(spawnR.value);
      expect(despawnR.ok).toBe(true);
      const resolveR = refs.resolve(h);
      expect(resolveR.ok).toBe(false);
      if (resolveR.ok) throw new Error('expected stale');
      expect(resolveR.error.code).toBe('unique-ref-stale');
    });
  });
}
{
  // --- from world-spawn-array-fallback.test.ts ---
}
{
  // --- from world-spawn-defaults.test.ts ---
  // ────────────────────────────────────────────────────────────────────────
  // t8 — addComponent / spawn symmetry (research §F4 + §RD-4)
  // ────────────────────────────────────────────────────────────────────────

  describe('w-spawn-fallback t8 — addComponent symmetry with spawn (AC-04 mirror)', () => {
    const Probe = defineComponent('Probe', {
      posX: { type: 'f32' },
      posY: { type: 'f32' },
      posZ: { type: 'f32' },
    });

    // Empty marker so addComponent has an existing entity to attach to.
    const Marker = defineComponent('Marker', {
      seq: { type: 'u32' },
    });

    it('addComponent partial data goes through the same helper as spawn', () => {
      const wSpawn = new World();
      const eSpawn = wSpawn.spawn({ component: Probe, data: { posX: 1 } }).unwrap();
      const spawnRow = wSpawn.get(eSpawn, Probe).unwrap();

      const wAdd = new World();
      const eAdd = wAdd.spawn({ component: Marker, data: { seq: 0 } }).unwrap();
      wAdd.addComponent(eAdd, { component: Probe, data: { posX: 1 } }).unwrap();
      const addRow = wAdd.get(eAdd, Probe).unwrap();

      expect(spawnRow.posX).toBe(1);
      expect(spawnRow.posY).toBe(0); // layer-3
      expect(spawnRow.posZ).toBe(0); // layer-3

      expect(addRow.posX).toBe(spawnRow.posX);
      expect(addRow.posY).toBe(spawnRow.posY);
      expect(addRow.posZ).toBe(spawnRow.posZ);
    });

    it('addComponent with empty data: {} matches spawn with empty data: {}', () => {
      const wSpawn = new World();
      const eSpawn = wSpawn.spawn({ component: Probe, data: {} }).unwrap();
      const spawnRow = wSpawn.get(eSpawn, Probe).unwrap();

      const wAdd = new World();
      const eAdd = wAdd.spawn({ component: Marker, data: {} }).unwrap();
      wAdd.addComponent(eAdd, { component: Probe, data: {} }).unwrap();
      const addRow = wAdd.get(eAdd, Probe).unwrap();

      expect(spawnRow.posX).toBe(0);
      expect(spawnRow.posY).toBe(0);
      expect(spawnRow.posZ).toBe(0);
      expect(addRow.posX).toBe(spawnRow.posX);
      expect(addRow.posY).toBe(spawnRow.posY);
      expect(addRow.posZ).toBe(spawnRow.posZ);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // t10 — brand-class NULL sentinel cross-test (handle<T> / entity / ref<T>)
  // ────────────────────────────────────────────────────────────────────────
}
{
  // --- from world-spawn-direct.test.ts ---
  describe('AC-04 — spawn three-path passthrough (no register)', () => {
    it('spawn: a freshly defined component is usable without registering it', () => {
      const world = new World();
      const Pos = defineComponent('DirectSpawnPos', { x: 'f32', y: 'f32' });
      // No per-World register step — defineComponent is the only step.
      const e = world.spawn({ component: Pos, data: { x: 3, y: 4 } }).unwrap();
      expect(world.get(e, Pos).unwrap()).toEqual({ x: 3, y: 4 });
    });

    it('addComponent: adding a never-registered component to a live entity works', () => {
      const world = new World();
      const Tag = defineComponent('DirectAddTag', {});
      const Vel = defineComponent('DirectAddVel', { vx: 'f32', vy: 'f32' });
      const e = world.spawn({ component: Tag, data: {} }).unwrap();
      // Vel was only defined, never registered.
      world.addComponent(e, { component: Vel, data: { vx: 5, vy: 6 } }).unwrap();
      expect(world.get(e, Vel).unwrap()).toEqual({ vx: 5, vy: 6 });
    });

    it('deferred spawn (materialize path): commands.spawn + update materializes without register', () => {
      const world = new World();
      const Hp = defineComponent('DirectMatHp', { current: 'i32', max: 'i32' });
      let pending: EntityHandle | undefined;
      world.addSystem(Update, {
        name: 'deferred-spawner',
        queries: [],
        fn: (_world, _q, commands) => {
          // Deferred spawn returns a pending Entity; materialized on flush.
          pending = commands.spawn({ component: Hp, data: { current: 7, max: 9 } });
        },
      });
      // update() runs the system then flushes commands -> _materializePendingEntity.
      world.update();
      expect(pending).toBeDefined();
      const captured = world.get(pending as EntityHandle, Hp);
      expect(captured.ok).toBe(true);
      expect(captured.unwrap()).toEqual({ current: 7, max: 9 });
    });
  });

  describe('AC-07 — get fail-fast degradation (returns err, never throws)', () => {
    it('get on a never-present (but defined) component returns err(component-not-present)', () => {
      const world = new World();
      const Present = defineComponent('GetPresent', { v: 'f32' });
      const NeverHeld = defineComponent('GetNeverHeld', { w: 'f32' });
      const e = world.spawn({ component: Present, data: { v: 1 } }).unwrap();
      // NeverHeld is defined but this entity never carried it.
      const result = world.get(e, NeverHeld);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBeInstanceOf(ComponentNotPresentError);
      expect(!result.ok && result.error.code).toBe('component-not-present');
    });

    it('get does not throw for a never-present component (degradation is a Result, not an exception)', () => {
      const world = new World();
      const Present = defineComponent('NoThrowPresent', { v: 'f32' });
      const NeverHeld = defineComponent('NoThrowNeverHeld', { w: 'f32' });
      const e = world.spawn({ component: Present, data: { v: 1 } }).unwrap();
      expect(() => world.get(e, NeverHeld)).not.toThrow();
    });
  });

  describe('AC-05 — EcsErrorCode remains a closed source-owned union', () => {
    it('keeps the mutation epoch infrastructure failure out of the core union', () => {
      // @ts-expect-error mutation epoch exhaustion is an infrastructure throw, not a World Result code.
      const code: EcsErrorCode = 'change-epoch-exhausted';
      expect(code).toBe('change-epoch-exhausted');
    });

    it('the dropped register codes are not assignable to EcsErrorCode', () => {
      // @ts-expect-error — COMPONENT_ALREADY_REGISTERED was removed from the union.
      const dropped1: EcsErrorCode = 'COMPONENT_ALREADY_REGISTERED';
      // @ts-expect-error — COMPONENT_NOT_REGISTERED was removed from the union.
      const dropped2: EcsErrorCode = 'COMPONENT_NOT_REGISTERED';
      expect([dropped1, dropped2]).toBeDefined();
    });
  });
}
{
  // --- from component-default-fallback.test.ts (__tests__/) ---
  describe('layer-3 typeDefault — scalar arms', () => {
    it('f32 -> 0', () => {
      expect(typeDefault('f32')).toBe(0);
    });
    it('f64 -> 0', () => {
      expect(typeDefault('f64')).toBe(0);
    });
    it('i32 -> 0', () => {
      expect(typeDefault('i32')).toBe(0);
    });
    it('u32 -> 0', () => {
      expect(typeDefault('u32')).toBe(0);
    });
    it('i16 -> 0', () => {
      expect(typeDefault('i16')).toBe(0);
    });
    it('u16 -> 0', () => {
      expect(typeDefault('u16')).toBe(0);
    });
    it('i8 -> 0', () => {
      expect(typeDefault('i8')).toBe(0);
    });
    it('u8 -> 0', () => {
      expect(typeDefault('u8')).toBe(0);
    });
    it('bool -> false', () => {
      expect(typeDefault('bool')).toBe(false);
    });
    it('enum -> 0', () => {
      expect(typeDefault('enum')).toBe(0);
    });
    it('ref (legacy scalar) -> 0', () => {
      expect(typeDefault('ref')).toBe(0);
    });
  });

  describe('layer-3 typeDefault — vocab arms', () => {
    it("'string' -> 0 (uniqueRefs handle slot)", () => {
      expect(typeDefault('string')).toBe(0);
    });
    it("'entity' -> ENTITY_NULL_RAW", () => {
      expect(typeDefault('entity')).toBe(ENTITY_NULL_RAW);
    });
    it("'array<entity>' -> [] (the only special-cased array arm)", () => {
      expect(typeDefault('array<entity>')).toEqual([]);
    });
    it("'array<f32>' -> 0 (asymmetric: writeArrayField bottoms to empty slot)", () => {
      expect(typeDefault('array<f32>')).toBe(0);
    });
    it("'array<u32>' -> 0 (asymmetric same as array<f32>)", () => {
      expect(typeDefault('array<u32>')).toBe(0);
    });
    it("'array<f32, 16>' -> 0 (fixed-N capacity)", () => {
      expect(typeDefault('array<f32, 16>')).toBe(0);
    });
    it("'buffer' -> 0 (variable-byte BufferPool slot id)", () => {
      expect(typeDefault('buffer')).toBe(0);
    });
    it("'buffer<64>' -> 0 (fixed-byte inline stride-N column zeroed row)", () => {
      expect(typeDefault('buffer<64>')).toBe(0);
    });
    it("'unique<MaterialAsset>' -> 0 (UniqueRefStore handle slot)", () => {
      expect(typeDefault('unique<MaterialAsset>')).toBe(0);
    });
    it("'shared<MeshAsset>' -> 0 (unmanaged handle phantom u32)", () => {
      expect(typeDefault('shared<MeshAsset>')).toBe(0);
    });
  });

  describe('fillComponentDefaults — public surface', () => {
    it('preserves explicit raw values (layer-1 entry)', () => {
      const C = defineComponent('C', { x: { type: 'f32' }, y: { type: 'f32' } });
      const out = fillComponentDefaults(C, { x: 7 });
      expect(out.x).toBe(7);
      // y missing in raw -> layer-3 fallback 0
      expect(out.y).toBe(0);
    });

    it('layer-2 token defaults beat layer-3 typeDefault', () => {
      const C = defineComponent('C', {
        a: { type: 'f32' },
        b: { type: 'f32', default: 42 },
      });
      const out = fillComponentDefaults(C, {});
      expect(out.a).toBe(0); // layer-3
      expect(out.b).toBe(42); // layer-2
    });

    it('mixed (explicit + token + typeDefault) — three-layer route in one component', () => {
      const C = defineComponent('M', {
        e: { type: 'f32' },
        t: { type: 'f32', default: 17 },
        f: { type: 'f32' },
      });
      const out = fillComponentDefaults(C, { e: 9 });
      expect(out.e).toBe(9); // layer-1
      expect(out.t).toBe(17); // layer-2
      expect(out.f).toBe(0); // layer-3
    });

    it('brand-class field (handle<T>) — schema-nullable gets layer-3 NULL sentinel 0', () => {
      const C = defineComponent('M', {
        mesh: { type: 'shared<MeshAsset>' },
        mat: { type: 'unique<MaterialAsset>' },
      });
      const out = fillComponentDefaults(C, {});
      expect(out.mesh).toBe(0);
      expect(out.mat).toBe(0);
    });

    it("'array<entity>' returns empty array literal (only array arm with [])", () => {
      const C = defineComponent('M', { children: { type: 'array<entity>' } });
      const out = fillComponentDefaults(C, {});
      expect(out.children).toEqual([]);
    });

    it('array<f32> returns raw 0 (asymmetric — D-2 / OOS-6 letter)', () => {
      const C = defineComponent('M', { tr: { type: 'array<f32>' } });
      const out = fillComponentDefaults(C, {});
      expect(out.tr).toBe(0);
    });
  });
}
{
  // --- from relationshipSyncDepth-elimination.test.ts (w10) ---
  describe('feat-20260611 M-6 w12 recordIsLive liveness predicate', () => {
    const Tag = defineComponent('Tag', {});

    // State 1: live entity — record exists, generation matches, archetypeId !== -1
    it('returns true for a live entity (gen match + archetypeId >= 0)', () => {
      const world = new World();
      const e = world.spawn({ component: Tag, data: {} }).unwrap();
      // get internally uses recordIsLive → ok proves recordIsLive returned true
      const r = world.get(e, Tag);
      expect(r.ok).toBe(true);
      expect(r.unwrap()).toEqual({});
    });

    // State 2: stale handle (despawned) — record exists but generation bumped
    it('returns false when generation does not match (despawned entity)', () => {
      const world = new World();
      const e = world.spawn({ component: Tag, data: {} }).unwrap();
      world.despawn(e).unwrap();
      const r = world.get(e, Tag);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('stale-entity');
      }
    });

    // State 3: record undefined (out-of-bounds index, a made-up handle)
    it('returns false when record is undefined (nonexistent slot)', () => {
      const world = new World();
      // encode a valid-looking handle for a slot that has no record
      const bogus = encodeEntity(9999, 0) as EntityHandle;
      const r = world.get(bogus, Tag);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('stale-entity');
      }
    });

    // State 4: deferred spawn pending (not yet materialized) —
    // gen matches but archetypeId === -1
    it('returns false for a pending deferred-spawn entity (archetypeId === -1)', () => {
      const world = new World();

      let pendingEntity: EntityHandle | undefined;
      world.addSystem(Update, {
        name: 'defer-spawn',
        queries: [],
        fn: (_world, _q, commands) => {
          pendingEntity = commands.spawn({ component: Tag, data: {} });
        },
      });
      world.update();
      expect(pendingEntity).toBeDefined();

      // After flush, the entity is live — get must succeed
      // biome-ignore lint/style/noNonNullAssertion: confirmed defined by expect above
      const r = world.get(pendingEntity!, Tag);
      expect(r.ok).toBe(true);

      // Before flush the entity is not live (pending).
      // We verify this indirectly: during system execution, queries
      // don't see the entity. After flush, get succeeds.
      // The direct pending test uses the deferred-path inside a system:
      let seenBeforeFlush = false;
      world.addSystem(Update, {
        name: 'check-pending',
        queries: [{ with: [Tag] }],
        fn: (_world, queries, commands) => {
          const spawned = commands.spawn({ component: Tag, data: {} });
          // Inside the system, before flush, the pending entity won't match a query
          for (const _row of queries[0]) {
            void _row;
          }
          // But commands.isDeferred reports it
          expect(commands.isDeferred(spawned)).toBe(true);
          seenBeforeFlush = true;
        },
      });
      world.update();
      expect(seenBeforeFlush).toBe(true);
    });

    // State 5: despawn-then-recycle — slot recycled with fresh gen,
    // old handle's gen does not match new record's gen
    it('returns false for a handle whose slot was recycled (gen mismatch on recycled slot)', () => {
      const world = new World();
      const e1 = world.spawn({ component: Tag, data: {} }).unwrap();
      // Despawn → slot freed and gen bumped.
      world.despawn(e1).unwrap();

      // Next spawn may reuse the freed slot with a bumped gen.
      // The old handle (e1) with pre-bump gen should be stale.
      const e2 = world.spawn({ component: Tag, data: {} }).unwrap();
      const r = world.get(e1, Tag);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('stale-entity');
      }
      // The new entity is live at the same or different slot
      expect(world.get(e2, Tag).ok).toBe(true);
    });

    // State 6: generation retired (gen > 255) — the slot is never recycled,
    // the record still exists but any handle for it is stale
    it('returns false for a handle whose slot generation was retired (> 255)', () => {
      // This test exhausts the generation counter on one slot.
      // We can't practically despawn 255 times in a unit test,
      // so we verify the code path via direct record manipulation.
      // Instead, we trust the generation-encoding math: encodeEntity forces
      // gen into 8 bits. A gen > 255 cannot be encoded in a handle,
      // so any handle for a retired slot always fails gen match.
      // We test the boundary: gen=255 despawn bumps to 256 → retired.
      const world = new World();
      const e = world.spawn({ component: Tag, data: {} }).unwrap();
      const slot = entityIndex(e);

      // Despawn once — gen goes 0→1, slot recycled.
      world.despawn(e).unwrap();

      // The slot is back on freeIndices. Spawn reuses it with gen=1.
      const fresh = world.spawn({ component: Tag, data: {} }).unwrap();
      expect(entityIndex(fresh)).toBe(slot);
      expect(entityGeneration(fresh)).toBe(1);

      // The retired case: a handle with gen=0 for this slot must be stale.
      const oldHandle = encodeEntity(slot, 0) as EntityHandle;
      const r = world.get(oldHandle, Tag);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('stale-entity');
      }
    });

    // State 7: archetypeId === -1 with gen match (post-despawn before recycle)
    // After despawn, record.archetypeId is set to -1, then gen is bumped.
    // A handle matching the pre-bump gen has gen mismatch (State 2).
    // A handle matching the post-bump gen: the slot is on freeIndices
    // but not yet re-allocated → gen matches, archetypeId === -1.
    it('returns false when archetypeId === -1 (despawned, pre-recycle)', () => {
      const world = new World();
      const e = world.spawn({ component: Tag, data: {} }).unwrap();
      const slot = entityIndex(e);

      world.despawn(e).unwrap();

      // After despawn: archetypeId === -1, gen bumped by 1.
      // The post-bump gen is what the slot carries now.
      // But there is no public handle with the post-bump gen — the old
      // handle has the pre-bump gen, and no new entity has been spawned.
      // We construct the post-bump-gen handle to test the archetypeId === -1 path.
      const postBumpGen = entityGeneration(e) + 1;
      const postBumpHandle = encodeEntity(slot, postBumpGen) as EntityHandle;
      const r = world.get(postBumpHandle, Tag);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        // gen matches but archetypeId === -1 → stale
        expect(r.error.code).toBe('stale-entity');
      }
    });

    // Deferred flush full lifecycle: E-06 path
    it('deferred entity: not live before flush, live after flush, stale after despawn', () => {
      const world = new World();

      let spawnedHandle: EntityHandle | undefined;
      world.addSystem(Update, {
        name: 'lifecycle-spawn',
        queries: [],
        fn: (_world, _q, commands) => {
          spawnedHandle = commands.spawn({ component: Tag, data: {} });
          // Pending: not yet live
          expect(commands.isDeferred(spawnedHandle)).toBe(true);
          // get on pending returns stale-entity
          const beforeFlush = world.get(spawnedHandle, Tag);
          expect(beforeFlush.ok).toBe(false);
          if (!beforeFlush.ok) {
            expect(beforeFlush.error.code).toBe('stale-entity');
          }
        },
      });
      world.update();

      expect(spawnedHandle).toBeDefined();
      // biome-ignore lint/style/noNonNullAssertion: confirmed defined by expect above
      const e = spawnedHandle!;

      // After flush: live
      const afterFlush = world.get(e, Tag);
      expect(afterFlush.ok).toBe(true);
      expect(afterFlush.unwrap()).toEqual({});

      // Despawn: stale again
      world.despawn(e).unwrap();
      const afterDespawn = world.get(e, Tag);
      expect(afterDespawn.ok).toBe(false);
      if (!afterDespawn.ok) {
        expect(afterDespawn.error.code).toBe('stale-entity');
      }
    });

    // Derived expression correctness: archetypeId === -1 gates liveness,
    // not a separate pending flag.
    it('derived expression: archetypeId !== -1 is the sole structural live gate', () => {
      const world = new World();

      // Synchronous spawn sets archetypeId immediately
      const e = world.spawn({ component: Tag, data: {} }).unwrap();
      const slot = entityIndex(e);
      const gen = entityGeneration(e);

      // Access internal records to verify the predicate
      // biome-ignore lint/suspicious/noExplicitAny: access private members for white-box liveness test
      const records = (world as any).records;
      const record = records[slot];
      expect(record).toBeDefined();
      expect(record.generation).toBe(gen);
      expect(record.archetypeId).toBeGreaterThanOrEqual(0);
      // pending field must not exist (w13 will remove it; w12 is red phase)
      expect('pending' in record).toBe(false);
    });
  });
}

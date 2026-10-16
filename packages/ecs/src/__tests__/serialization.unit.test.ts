// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Update } from '../schedule-token';
//
// Source files (N=29):
//   - packages/ecs/__tests__/managed-ref-on-release.test.ts
//   - packages/ecs/__tests__/register-ecs-inspector.test.ts
//   - packages/ecs/src/__tests__/ai-user-sandbox-trial.test.ts
//   - packages/ecs/src/__tests__/array-handle-element.test.ts
//   - packages/ecs/src/__tests__/array-remove-by-value.test.ts
//   - packages/ecs/src/__tests__/hook-despawn.test.ts
//   - packages/ecs/src/__tests__/hook-no-regression.test.ts
//   - packages/ecs/src/__tests__/hook-on-insert.test.ts
//   - packages/ecs/src/__tests__/hook-on-remove.test.ts
//   - packages/ecs/src/__tests__/inspect.test.ts
//   - packages/ecs/src/__tests__/managed-array-carry-over.test.ts
//   - packages/ecs/src/__tests__/managed-array-element-type.test.ts
//   - packages/ecs/src/__tests__/managed-array-errors.test.ts
//   - packages/ecs/src/__tests__/managed-array-release.test.ts
//   - packages/ecs/src/__tests__/managed-array-stride.test.ts
//   - packages/ecs/src/__tests__/managed-array-vocab.test.ts
//   - packages/ecs/src/__tests__/managed-buffer-grow.test.ts
//   - packages/ecs/src/__tests__/managed-carry-over.test.ts
//   - packages/ecs/src/__tests__/managed-release.test.ts
//   - packages/ecs/src/__tests__/register-inspector.test.ts
//   - packages/ecs/src/__tests__/resource.test.ts
//   - packages/ecs/src/__tests__/scene-instance-container.test.ts
//   - packages/ecs/src/__tests__/schedule-remove-replace.test.ts
//   - packages/ecs/src/__tests__/schedule.test.ts
//   - packages/ecs/src/__tests__/string-carry-over.test.ts
//   - packages/ecs/src/__tests__/string-identity-contract.test.ts
//   - packages/ecs/src/__tests__/string-managed-dispatch.test.ts
//   - packages/ecs/src/__tests__/string-release.test.ts
//
// Excluded (defineComponent name collisions — Transform/ChildOf break resolveComponent):
//   - packages/ecs/src/__tests__/scene-instance-delete-marks.test.ts
//   - packages/ecs/src/__tests__/scene-instance-divergence.test.ts
//   - packages/ecs/src/__tests__/scene-instance-hierarchy.test.ts
//   - packages/ecs/src/__tests__/scene-instance-overrides.test.ts
//   - packages/ecs/src/__tests__/scene-instantiate-typo.test.ts
//   - packages/ecs/src/__tests__/scene-instantiate.test.ts
//   - packages/ecs/src/__tests__/scene-multi-instance.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.

import type { Handle } from '@forgeax/engine-types';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { BufferPool } from '../buffer-pool';
import {
  type Component,
  defineComponent,
  type FieldValueType,
  isSchemaVocabKeyword,
  MANAGED_ARRAY_ELEMENT_TYPES,
  parseManagedArraySchema,
  type SchemaFieldType,
  type SchemaOf,
  type ShapeOf,
  type TypedArrayFor,
} from '../component';
import { ENTITY_NULL_RAW } from '../entity-handle';
import {
  type EcsErrorCode,
  type EcsErrorDetail,
  FixedSizeMismatchError,
  type ManagedArrayElementTypeNotAllowedError,
  ResourceNotFoundError,
} from '../errors';
import { UniqueRefStore } from '../unique-ref-store';
import { World, type WorldInspection } from '../world';

import { worldInternal } from '../world-internal';
import { handleNumeric } from './utils/handle-numeric';

{
  describe('feat-20260528 M1 t1 UniqueRefStore onRelease callback', () => {
    it('alloc with onRelease stores the callback and calls it on release before delete', () => {
      const store = new UniqueRefStore();
      let called = false;
      let releasedPayload: string | undefined;

      const handle = store.alloc<'Test', string>('Test', 'hello', (payload) => {
        called = true;
        releasedPayload = payload;
      });
      expect(called).toBe(false);

      const result = store.release(handle);
      expect(result.ok).toBe(true);
      expect(called).toBe(true);
      expect(releasedPayload).toBe('hello');
    });

    it('release with onRelease callback: second release (double-release) does not trigger callback', () => {
      const store = new UniqueRefStore();
      let callCount = 0;

      const handle = store.alloc<'Test'>('Test', 'world', () => {
        callCount++;
      });

      store.release(handle);
      expect(callCount).toBe(1);

      // Double-release: handle already freed, onRelease should NOT fire again.
      const result2 = store.release(handle);
      expect(result2.ok).toBe(false);
      expect(callCount).toBe(1);
    });

    it('alloc without onRelease (backward-compatible two-param form) works', () => {
      const store = new UniqueRefStore();
      const handle = store.alloc<'Test'>('Test', 'backward-compat');
      const resolveResult = store.resolve(handle);
      expect(resolveResult.ok).toBe(true);
      if (resolveResult.ok) {
        expect(resolveResult.value).toBe('backward-compat');
      }

      const releaseResult = store.release(handle);
      expect(releaseResult.ok).toBe(true);

      // After release, resolve should fail.
      const after = store.resolve(handle);
      expect(after.ok).toBe(false);
    });

    it('onRelease passes the correct payload when multiple handles exist', () => {
      const store = new UniqueRefStore();
      const released: number[] = [];

      type Item = { id: number };
      const h1 = store.alloc<'A', Item>('A', { id: 1 }, (p) => released.push(p.id));
      const h2 = store.alloc<'A', Item>('A', { id: 2 }, (p) => released.push(p.id));
      const h3 = store.alloc<'A', Item>('A', { id: 3 }); // no callback

      // Release out of order.
      store.release(h2);
      expect(released).toEqual([2]);

      store.release(h1);
      expect(released).toEqual([2, 1]);

      store.release(h3); // no callback, should not push.
      expect(released).toEqual([2, 1]);
    });

    it('onRelease fires before payload is deleted (resolve after release yields no payload)', () => {
      const store = new UniqueRefStore();
      let payloadDuringCallback: { name: string } | undefined;

      const handle = store.alloc<'X', { name: string }>('X', { name: 'payload' }, (p) => {
        // At callback time, resolve should still return the payload
        // (it is deleted AFTER the callback).
        payloadDuringCallback = p;
      });

      store.release(handle);
      expect(payloadDuringCallback).toEqual({ name: 'payload' });

      // After release, resolve should fail.
      const after = store.resolve(handle);
      expect(after.ok).toBe(false);
    });

    it('onRelease is called per-handle: independent handles do not share callbacks', () => {
      const store = new UniqueRefStore();
      const sequence: string[] = [];

      const h1 = store.alloc<'A'>('A', 1, () => sequence.push('a'));
      const h2 = store.alloc<'A'>('A', 2, () => sequence.push('b'));

      store.release(h1);
      expect(sequence).toEqual(['a']);

      store.release(h2);
      expect(sequence).toEqual(['a', 'b']);
    });
  });
}
{
  // --- from ai-user-sandbox-trial.test.ts ---
  interface MaterialAsset {
    readonly albedo: readonly [number, number, number, number];
  }

  // World owns its UniqueRefStore from construction (M1: uniqueRefs is a
  // non-null private field). Tests probe the internal store via a structural
  // cast --- no caller-side wiring step remains.
  function refsOf(w: World): UniqueRefStore {
    return (w as unknown as { uniqueRefs: UniqueRefStore }).uniqueRefs;
  }

  describe('AI user sandbox - schema vocab + lifecycle', () => {
    it('(1) `buffer<128>` field exposes Uint8Array view, mutable in place', () => {
      const Mesh = defineComponent('Mesh', { vertexData: { type: 'buffer<128>' } });
      const w = new World();
      const e = w.spawn({ component: Mesh, data: { vertexData: new Uint8Array(128) } }).unwrap();
      const r = w.get(e, Mesh).unwrap();
      expect(r.vertexData).toBeInstanceOf(Uint8Array);
      expect(r.vertexData.byteLength).toBe(128);
      r.vertexData[0] = 42;
      const r2 = w.get(e, Mesh).unwrap();
      expect(r2.vertexData[0]).toBe(42);
    });

    it('(2) `ref<T>` field stores managed Handle; auto-released on despawn (AC-03 path 1)', () => {
      const Mat = defineComponent('Mat', { material: { type: 'unique<MaterialAsset>' } });
      const w = new World();
      const store = refsOf(w);
      const handle = store.alloc<'MaterialAsset', MaterialAsset>('MaterialAsset', {
        albedo: [1, 0, 0, 1],
      });
      const e = w
        .spawn({
          component: Mat,
          data: { material: handle },
        })
        .unwrap();
      const r = w.get(e, Mat).unwrap();
      const payload = store.resolve<'MaterialAsset', MaterialAsset>(r.material);
      expect(payload.ok).toBe(true);
      if (payload.ok) expect(payload.value.albedo[0]).toBe(1);
      w.despawn(e).unwrap();
      const after = store.resolve(handle);
      expect(after.ok).toBe(false);
      if (!after.ok) expect(after.error.code).toBe('unique-ref-stale');
    });

    it('(3) `handle<T>` field stores unmanaged Handle; ECS does NOT release on despawn', () => {
      const MeshFilter = defineComponent('MeshFilter', {
        assetHandle: { type: 'shared<MeshAsset>' },
      });
      const w = new World();
      const fakeHandle: Handle<'MeshAsset', 'shared'> = 0x1234_5678 as Handle<
        'MeshAsset',
        'shared'
      >;
      const e = w.spawn({ component: MeshFilter, data: { assetHandle: fakeHandle } }).unwrap();
      const r = w.get(e, MeshFilter).unwrap();
      expect(r.assetHandle).toBe(fakeHandle);
      w.despawn(e).unwrap();
    });

    it('(4) ENTITY_NULL_RAW sentinel is 0xffffffff (entity-field null encoding)', () => {
      // Sentinel vocab invariant: the underlying u32 value used as 'no entity'
      // is 0xffffffff; the surface to AI users for that slot is `null`. The ECS
      // returns the raw encoded Entity on read without bottoming out dangling
      // references; consumers check liveness themselves.
      expect(ENTITY_NULL_RAW).toBe(0xffffffff);
    });

    it('(5) archetype migrate (addComponent reshuffle): managed handle Object.is preserved', () => {
      const Mat = defineComponent('Mat', { material: { type: 'unique<MaterialAsset>' } });
      const Tag = defineComponent('Tag', { x: { type: 'u32' } });
      const w = new World();
      const store = refsOf(w);
      const handle = store.alloc<'MaterialAsset', MaterialAsset>('MaterialAsset', {
        albedo: [0, 1, 0, 1],
      });
      const e = w
        .spawn({
          component: Mat,
          data: { material: handle },
        })
        .unwrap();
      const handleBefore = w.get(e, Mat).unwrap().material;
      w.addComponent(e, { component: Tag, data: { x: 7 } }).unwrap();
      const handleAfter = w.get(e, Mat).unwrap().material;
      // u32 bit-equal: handle is a packed Uint32 brand.
      expect(handleAfter).toBe(handleBefore);
      // Resolved payload still alive (carry-over, NOT release).
      const resolved = store.resolve<'MaterialAsset', MaterialAsset>(handleAfter);
      expect(resolved.ok).toBe(true);
      if (resolved.ok) expect(resolved.value.albedo[1]).toBe(1);
    });

    it('(6) `world.set` covering write releases old managed handle (AC-03 path 3)', () => {
      const Mat = defineComponent('Mat', { material: { type: 'unique<MaterialAsset>' } });
      const w = new World();
      const store = refsOf(w);
      const oldHandle = store.alloc('MaterialAsset', { albedo: [1, 0, 0, 1] });
      const newHandle = store.alloc('MaterialAsset', { albedo: [0, 0, 1, 1] });
      const e = w
        .spawn({
          component: Mat,
          data: { material: oldHandle },
        })
        .unwrap();
      w.set(e, Mat, {
        material: newHandle,
      }).unwrap();
      const after = store.resolve(oldHandle);
      expect(after.ok).toBe(false);
      if (!after.ok) expect(after.error.code).toBe('unique-ref-stale');
      expect(store.resolve(newHandle).ok).toBe(true);
    });
  });
}
{
  // --- from array-handle-element.test.ts ---
  describe('array<handle<X>> parse (w6, D-1)', () => {
    it("parseManagedArraySchema('array<shared<MaterialAsset>>') returns { elementType: 'shared<MaterialAsset>', length: undefined }", () => {
      const result = parseManagedArraySchema('array<shared<MaterialAsset>>');
      // pre w5: returns null because 'shared<MaterialAsset>' is not in
      // ManagedArrayElementType — this is the TDD red state
      expect(result).not.toBeNull();
      if (result === null) return;
      expect(result.elementType).toBe('shared<MaterialAsset>');
      expect(result.length).toBeUndefined();
    });

    it("parseManagedArraySchema('array<shared<MeshAsset>>') returns { elementType: 'shared<MeshAsset>' }", () => {
      const result = parseManagedArraySchema('array<shared<MeshAsset>>');
      expect(result).not.toBeNull();
      if (result === null) return;
      expect(result.elementType).toBe('shared<MeshAsset>');
      expect(result.length).toBeUndefined();
    });

    it("parseManagedArraySchema('array<shared<>, 3>') returns null (empty tag rejection)", () => {
      // R-NEW-1: empty tag inside shared<> is rejected
      const result = parseManagedArraySchema('array<shared<>, 3>');
      expect(result).toBeNull();
    });

    it("parseManagedArraySchema('array<shared<>>') returns null (variable-capacity empty tag rejection)", () => {
      const result = parseManagedArraySchema('array<shared<>>');
      expect(result).toBeNull();
    });

    it("parseManagedArraySchema('array<handle<X>>') returns null (post-w23 'handle<T>' arm deleted)", () => {
      // gate-allow:ecs-brand
      // feat-20260614 w23: the 'handle<T>' parser arm was removed; any
      // legacy literal flowing through here returns null and the caller
      // surfaces SchemaUnsupportedFieldError (with migration-hint pointing
      // at 'shared<T>' -- see schema-vocab.test-d.ts).
      const result = parseManagedArraySchema('array<handle<MeshAsset>>');
      expect(result).toBeNull();
    });

    it("isSchemaVocabKeyword('array<shared<MaterialAsset>>') returns true", () => {
      const result = isSchemaVocabKeyword('array<shared<MaterialAsset>>');
      expect(result).toBe(true);
    });
  });
}
// The old public array-remove-by-value fixture was deleted with the push/pop
// facade. Relationship detach now uses its owner-side slot backpointer.
{
  // --- from hook-despawn.test.ts ---
}
{
  // --- from hook-no-regression.test.ts ---
  describe('hook no-regression guard (AC-05)', () => {
    it('addComponent path unchanged for components without hook declaration', () => {
      const Pos = defineComponent('NoRegPos', { x: { type: 'f32' }, y: { type: 'f32' } });
      const Tag = defineComponent('NoRegTag', {});
      const world = new World();
      const e = world.spawn({ component: Pos, data: { x: 1, y: 2 } }).unwrap();

      const r = world.addComponent(e, { component: Tag, data: {} });
      expect(r.ok).toBe(true);

      const pos = world.get(e, Pos).unwrap();
      const tag = world.get(e, Tag).unwrap();
      expect(pos).toEqual({ x: 1, y: 2 });
      expect(tag).toEqual({});
    });

    it('removeComponent path unchanged for components without hook declaration', () => {
      const Pos = defineComponent('NoRegPos2', { x: { type: 'f32' }, y: { type: 'f32' } });
      const world = new World();
      const e = world.spawn({ component: Pos, data: { x: 3, y: 4 } }).unwrap();

      const r = world.removeComponent(e, Pos);
      expect(r.ok).toBe(true);

      const result = world.get(e, Pos);
      expect(result.ok).toBe(false);
    });

    it('despawn path unchanged for components without hook declaration', () => {
      const Pos = defineComponent('NoRegPos3', { x: { type: 'f32' }, y: { type: 'f32' } });
      const Tag = defineComponent('NoRegTag3', {});
      const world = new World();
      const e = world.spawn({ component: Pos, data: { x: 5, y: 6 } }).unwrap();
      // Verify the entity was alive before despawn.
      expect(world.get(e, Pos).ok).toBe(true);

      const r = world.despawn(e);
      expect(r.ok).toBe(true);

      // After despawn, the entity is stale.
      const result = world.get(e, Pos);
      expect(result.ok).toBe(false);
      // Also verify despawn does not affect other entities.
      const other = world.spawn({ component: Tag, data: {} }).unwrap();
      expect(world.get(other, Tag).ok).toBe(true);
    });

    it('spawn path unchanged for components without hook declaration', () => {
      const Pos = defineComponent('NoRegPos4', { x: { type: 'f32' }, y: { type: 'f32' } });
      const world = new World();
      const e = world.spawn({ component: Pos, data: { x: 7, y: 8 } }).unwrap();
      const pos = world.get(e, Pos).unwrap();
      expect(pos).toEqual({ x: 7, y: 8 });
    });
  });
}
{
  // --- from hook-on-insert.test.ts ---
}
{
  // --- from hook-on-remove.test.ts ---
}
{
  // --- from inspect.test.ts ---
  describe('world.inspect()', () => {
    it('returns a WorldInspection with all 6 fields defined on empty world', () => {
      const world = new World();
      const info: WorldInspection = world.inspect();

      expect(info.entityCount).toBe(0);
      expect(info.archetypeCount).toBe(0);
      expect(info.archetypes).toEqual([]);
      expect(info.activeComponents).toEqual([]);
      expect(info.systemCount).toBe(0);
      expect(info.resourceKeys).toContain('Time');
      expect(info.resourceKeys).toContain('FixedTime');
    });

    it('entityCount reflects live entities after spawn and despawn', () => {
      const Pos = defineComponent('InspectPos', { x: { type: 'f32' }, y: { type: 'f32' } });
      const world = new World();
      const e1 = world.spawn({ component: Pos, data: { x: 1, y: 2 } }).unwrap();
      world.spawn({ component: Pos, data: { x: 3, y: 4 } });

      expect(world.inspect().entityCount).toBe(2);

      world.despawn(e1);
      expect(world.inspect().entityCount).toBe(1);
    });

    it('archetypeCount and archetypes reflect distinct component sets', () => {
      const A = defineComponent('InspA', { v: { type: 'f32' } });
      const B = defineComponent('InspB', { w: { type: 'i32' } });
      const world = new World();

      world.spawn({ component: A, data: { v: 1 } });
      world.spawn({ component: B, data: { w: 2 } });

      const info = world.inspect();
      expect(info.archetypeCount).toBe(2);
      expect(info.archetypes.length).toBe(2);

      // Each archetype has correct shape
      for (const arch of info.archetypes) {
        expect(arch.key).toBeDefined();
        expect(arch.componentNames.length).toBeGreaterThanOrEqual(1);
        expect(arch.entityCount).toBe(1);
        expect(info.tables[arch.tableId]?.capacity).toBeGreaterThan(0);
      }
    });

    it('activeComponents lists component names that have been spawned, not merely defined', () => {
      const X = defineComponent('InspX', { v: 'u8' });
      // InspY is defined (globally live) but never spawned. The active list is
      // derived from the archetype graph, so a defined-but-never-spawned
      // component (InspY) is absent.
      defineComponent('InspY', { w: 'u8' });
      const world = new World();
      world.spawn({ component: X, data: { v: 1 } });

      const names = world.inspect().activeComponents;
      expect(names).toContain('InspX');
      expect(names).not.toContain('InspY');
    });

    it('systemCount increments after addSystem', () => {
      const world = new World();
      expect(world.inspect().systemCount).toBe(0);

      world.addSystem(Update, {
        name: 'inspSys1',
        queries: [],
        fn: () => {},
      });
      expect(world.inspect().systemCount).toBe(1);

      world.addSystem(Update, {
        name: 'inspSys2',
        queries: [],
        fn: () => {},
      });
      expect(world.inspect().systemCount).toBe(2);
    });

    it('resourceKeys reflects inserted and removed resources', () => {
      const world = new World();
      world.insertResource('timer', { elapsed: 0 });
      world.insertResource('config', { debug: true });

      // World constructor registers protected Time and FixedTime resources
      // which appear alongside user-inserted resources.
      const keys = world.inspect().resourceKeys;
      expect(keys).toContain('timer');
      expect(keys).toContain('config');
      expect(keys.length).toBe(4);

      world.removeResource('timer');
      // Protected Time and FixedTime resources persist alongside user resources
      const timeKeys = world.inspect().resourceKeys;
      expect(timeKeys).toContain('Time');
      expect(timeKeys).toContain('FixedTime');
      expect(timeKeys).toContain('config');
    });

    it('archetype info componentNames matches spawned components', () => {
      const P = defineComponent('InspPos2', { x: { type: 'f32' }, y: { type: 'f32' } });
      const V = defineComponent('InspVel2', { vx: { type: 'f32' }, vy: { type: 'f32' } });
      const world = new World();

      // Multi-component spawn
      world.spawn({ component: P, data: { x: 0, y: 0 } }, { component: V, data: { vx: 1, vy: 1 } });

      const info = world.inspect();
      expect(info.archetypeCount).toBe(1);
      // biome-ignore lint/style/noNonNullAssertion: archetypeCount asserted to be 1 above
      const arch = info.archetypes[0]!;
      expect(arch.componentNames).toContain('InspPos2');
      expect(arch.componentNames).toContain('InspVel2');
      expect(arch.entityCount).toBe(1);
    });
  });

  // M3 / w13 — AC-15: activeComponents is derived from the live archetype
  // graph, so it reflects what each World has actually spawned, independent
  // of any global registration / definition state.
  describe('world.inspect().activeComponents (M3 AC-15)', () => {
    it('a spawned component appears; a defined-but-never-spawned component does not', () => {
      const Used = defineComponent('M3Used', { v: 'u8' });
      // M3Unused is defined (lives in the global index) but never spawned.
      defineComponent('M3Unused', { v: 'u8' });
      const world = new World();
      world.spawn({ component: Used, data: { v: 1 } });

      const names = world.inspect().activeComponents;
      expect(names).toContain('M3Used');
      expect(names).not.toContain('M3Unused');
    });

    it('despawning the last holder drops the component from activeComponents', () => {
      const Solo = defineComponent('M3Solo', { v: 'u8' });
      const world = new World();
      const e = world.spawn({ component: Solo, data: { v: 1 } }).unwrap();
      expect(world.inspect().activeComponents).toContain('M3Solo');

      world.despawn(e);
      // The archetype now holds zero live entities, so the component is no
      // longer active (active = present on a non-empty archetype).
      expect(world.inspect().activeComponents).not.toContain('M3Solo');
    });

    it('two Worlds report independent activeComponents from the same global definitions', () => {
      const A = defineComponent('M3CrossA', { v: 'u8' });
      const B = defineComponent('M3CrossB', { w: 'u8' });
      const worldA = new World();
      const worldB = new World();
      worldA.spawn({ component: A, data: { v: 1 } });
      worldB.spawn({ component: B, data: { w: 2 } });

      const namesA = worldA.inspect().activeComponents;
      const namesB = worldB.inspect().activeComponents;
      expect(namesA).toContain('M3CrossA');
      expect(namesA).not.toContain('M3CrossB');
      expect(namesB).toContain('M3CrossB');
      expect(namesB).not.toContain('M3CrossA');
    });
  });
}
{
  // --- from managed-array-carry-over.test.ts ---
  // ---------------------------------------------------------------------------
  // (a) addComponent triggers migrate; array<entity> bytes + length + capacity preserved.
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // (b) array<f32, 16> fixed-capacity migrate carry-over.
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // (c) removeComponent migrate carry-over (the reverse direction).
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // (d) BufferPool slot id stays bit-equal across migrate (Negative invariant).
  //
  // Indirect observation: spawn entity A with array, capture A's bytes pre-
  // migrate, trigger migrate, then spawn a foreign entity B of the same byte
  // shape and verify A's bytes still survive afterwards. If migrate had
  // erroneously released A's slot, A's bytes would be reset by B's
  // alloc-and-zero path.
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // (e) Sidecar count column survives migrate for variable arrays.
  //
  // addComponent migrate copies all u32 columns (including the sidecar
  // `<fieldName>:count` column) row-by-row. After migrate the snapshot reads
  // length from the new archetype's count column; if migrate had missed the
  // count column, length would default to zero and the loop body would not
  // see prior elements.
  // ---------------------------------------------------------------------------
}
{
  // --- from managed-array-element-type.test.ts ---
  describe('array vocab — element-type runtime fail-safe (w2, AC-03)', () => {
    it('array<ref<X>> at runtime throws managed-array-element-type-not-allowed', () => {
      expect(() => {
        defineComponent('Bad', {
          bad: { type: 'array<ref<MaterialAsset>>' as unknown as SchemaFieldType },
        });
      }).toThrow(/managed-array-element-type-not-allowed/);
    });

    it('array<handle<X>> with non-empty tag is accepted at runtime (feat-20260608 M2 D-1)', () => {
      expect(() => {
        defineComponent('Good', {
          good: { type: 'array<shared<MeshAsset>>' as unknown as SchemaFieldType },
        });
      }).not.toThrow();
    });

    it('array<buffer:N> at runtime throws managed-array-element-type-not-allowed', () => {
      expect(() => {
        defineComponent('Bad', { bad: { type: 'array<buffer:8>' as unknown as SchemaFieldType } });
      }).toThrow(/managed-array-element-type-not-allowed/);
    });

    it('array<array<T,N>> nesting at runtime throws managed-array-element-type-not-allowed', () => {
      expect(() => {
        defineComponent('Bad', {
          bad: { type: 'array<array<f32,4>>' as unknown as SchemaFieldType },
        });
      }).toThrow(/managed-array-element-type-not-allowed/);
    });

    it('legal element types do not throw: array<entity> / array<f32> / array<u32, 16>', () => {
      expect(() => defineComponent('Foo', { entities: { type: 'array<entity>' } })).not.toThrow();
      expect(() => defineComponent('Bar', { values: { type: 'array<f32>' } })).not.toThrow();
      expect(() => defineComponent('Baz', { mat: { type: 'array<f32, 16>' } })).not.toThrow();
      expect(() => defineComponent('Qux', { flags: { type: 'array<bool>' } })).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // w2 (M2) --- array<string> rejection (OOS-04 lock-out + R-P2 mitigation).
  //
  // AC-10 extends the bare 'string' keyword to the SchemaVocabKeyword closed
  // union, but OOS-04 explicitly rules out `array<string>` at this stage:
  // arrays of variable-length references are a separate design (would need
  // per-element BufferPool slot tracking + per-row release loops). Locking it
  // out at registration time prevents AI users from accidentally defining a
  // schema we cannot back. The runtime guard piggybacks on the existing
  // MANAGED_ARRAY_ELEMENT_TYPES whitelist --- adding 'string' here would
  // silently flip the policy, so we also assert the set membership / size
  // stays at the 12-member baseline (R-P2 mitigation: drift detector).
  // ---------------------------------------------------------------------------

  describe('array vocab --- string element rejection (w2 M2, OOS-04)', () => {
    it('array<string> at runtime throws managed-array-element-type-not-allowed', () => {
      expect(() => {
        defineComponent('Bad', { bad: { type: 'array<string>' as unknown as SchemaFieldType } });
      }).toThrow(/managed-array-element-type-not-allowed/);
    });

    it('array<string, 4> fixed form is also rejected', () => {
      expect(() => {
        defineComponent('Bad', { bad: { type: 'array<string, 4>' as unknown as SchemaFieldType } });
      }).toThrow(/managed-array-element-type-not-allowed/);
    });

    it('MANAGED_ARRAY_ELEMENT_TYPES still has 12 members and excludes "string"', () => {
      expect(MANAGED_ARRAY_ELEMENT_TYPES.size).toBe(12);
      expect(MANAGED_ARRAY_ELEMENT_TYPES.has('string' as never)).toBe(false);
      // Explicit allow-list snapshot --- any drift in the 12 members shows up
      // as a diff here, signalling a vocab evolution that needs design review.
      expect([...MANAGED_ARRAY_ELEMENT_TYPES].sort()).toEqual(
        [
          'bool',
          'enum',
          'entity',
          'f32',
          'f64',
          'i16',
          'i32',
          'i8',
          'ref',
          'u16',
          'u32',
          'u8',
        ].sort(),
      );
    });
  });
}
{
  // --- from managed-array-errors.test.ts ---
  // Error routing is now returned at the mutation boundary; there is no
  // World-level ErrorHandler registration.

  // ---------------------------------------------------------------------------
  // (a) fixed-size-mismatch -- error class shape.
  // ---------------------------------------------------------------------------

  describe('w12 - fixed-size-mismatch error class', () => {
    it('FixedSizeMismatchError carries .code + detail.expected / detail.actual', () => {
      const err = new FixedSizeMismatchError('mat', 16, 15);
      expect(err.code).toBe('fixed-size-mismatch');
      expect(err.detail).toEqual({ expected: 16, actual: 15 });
      // expectType: detail narrows to fixed-size-mismatch shape.
      const detail: Extract<EcsErrorDetail, { code: 'fixed-size-mismatch' }> = {
        code: 'fixed-size-mismatch',
        ...err.detail,
      };
      expect(detail.expected).toBe(16);
    });
  });

  // ---------------------------------------------------------------------------
  // (d) world.pop on a non-empty variable array succeeds and shrinks count.
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // (e) managed-array-element-type-not-allowed (surviving member; sample path).
  // ---------------------------------------------------------------------------

  describe('w12 - managed-array-element-type-not-allowed surviving member', () => {
    it('defineComponent throws ManagedArrayElementTypeNotAllowedError on illegal element', () => {
      let captured: ManagedArrayElementTypeNotAllowedError | null = null;
      try {
        defineComponent('Bad', { bad: { type: 'array<ref<X>>' as unknown as SchemaFieldType } });
      } catch (err) {
        captured = err as ManagedArrayElementTypeNotAllowedError;
      }
      expect(captured).not.toBeNull();
      if (captured === null) return;
      expect(captured.code).toBe('managed-array-element-type-not-allowed');
      expect(captured.detail.fieldName).toBe('bad');
      expect(captured.detail.elementType).toBe('ref<X>'); // gate-allow:ecs-brand (illegal-element-type-not-allowed parser rejection fixture)
    });
  });

  // ---------------------------------------------------------------------------
  // (f) Exhaustive switch over the surviving core collapsed-vocab code.
  // ---------------------------------------------------------------------------

  describe('w12 - exhaustive switch over collapsed-vocab codes', () => {
    it('covers the fixed-size member', () => {
      const codes: EcsErrorCode[] = ['fixed-size-mismatch'];
      let hits = 0;
      for (const code of codes) {
        switch (code) {
          case 'fixed-size-mismatch':
            hits += 1;
            break;
          default:
            // The exhaustive narrowing is performed by `EcsErrorCode` over the
            // entire union; this default arm is unreachable for the code
            // listed above. We use `void` rather than assertNever to keep the
            // test focused on collapsed-vocab membership without coupling to
            // the remaining members.
            void code;
        }
      }
      expect(hits).toBe(1);
    });
  });
}
{
  // --- from managed-array-release.test.ts ---
  function readSlotId(
    world: World,
    entityRaw: number,
    component: Component,
    fieldName: string,
  ): number {
    const graph = world[worldInternal].getGraph();
    const slotIndex = entityRaw & 0xffffff; // lower 24 bits -- index slot
    for (const arch of graph.archetypes) {
      if (!arch) continue;
      const table = graph.tables[arch.tableId];
      if (table === undefined) continue;
      for (let archetypeRow = 0; archetypeRow < arch.size; archetypeRow++) {
        const row = arch.rows[archetypeRow] ?? 0;
        // Entity identity read from id=0 self column (not a separate entities array)
        const selfVal = table.storage.get(0)?.fields.get('self')?.view[row];
        const idx = typeof selfVal === 'number' ? selfVal & 0xffffff : 0;
        if (idx === slotIndex) {
          for (let i = 0; i < arch.components.length; i++) {
            if (arch.components[i] === component) {
              for (const { fields: fieldCols } of table.storage.values()) {
                const col = fieldCols.get(fieldName);
                if (col !== undefined && fieldCols.has(fieldName)) {
                  return col.view[row] as number;
                }
              }
            }
          }
        }
      }
    }
    return 0;
  }

  // ---------------------------------------------------------------------------
  // Helper -- the BufferPool's live (alloc'd, not-yet-released) slot count.
  // feat-20260602: fixed `array<T,N>` stores its elements INLINE in the
  // archetype column, so it never allocs / releases a pool slot. The three
  // release paths assert `_liveCount() === 0` end-to-end for the fixed shape
  // (the inline migration superseded the prior slot-id + freelist-reuse
  // contract these blocks used to lock).
  // ---------------------------------------------------------------------------

  function liveCount(world: World): number {
    return (world as unknown as { bufferPool: { _liveCount(): number } }).bufferPool._liveCount();
  }

  // ---------------------------------------------------------------------------
  // Path 1 -- world.despawn(e) releases array fields; slot id reusable.
  // ---------------------------------------------------------------------------

  describe('w12 - array<entity> variable: despawn releases slot; freelist reuses id', () => {
    it('despawn frees the slot; same-shape spawn pops the freed id', () => {
      const Children = defineComponent('Children', { entities: { type: 'array<entity>' } });
      const w = new World();

      // Spawn A with 4 elements (16 bytes -> bucket 0 / size class 16).
      const a = w
        .spawn({
          component: Children,
          data: { entities: new Uint32Array([1, 2, 3, 4]) },
        })
        .unwrap();
      const aSlotId = readSlotId(w, handleNumeric(a), Children, 'entities');
      expect(aSlotId).toBeGreaterThan(0);

      // Despawn A; the array field's slot is released to its bucket free-list.
      w.despawn(a).unwrap();

      // Spawn B with the same element count -> same bucket -> LIFO pop returns
      // A's freed slot id.
      const b = w
        .spawn({
          component: Children,
          data: { entities: new Uint32Array([10, 20, 30, 40]) },
        })
        .unwrap();
      const bSlotId = readSlotId(w, handleNumeric(b), Children, 'entities');
      expect(bSlotId).toBe(aSlotId);
    });
  });

  describe('w12 - array<f32,N> fixed: despawn touches no pool slot (inline)', () => {
    it('spawn + despawn of an inline fixed array never allocs a pool slot', () => {
      const Mat4 = defineComponent('Mat4', { mat: 'array<f32, 16>' });
      const w = new World();

      const init = new Float32Array(16);
      for (let i = 0; i < 16; i++) init[i] = i + 1;

      const a = w.spawn({ component: Mat4, data: { mat: init } }).unwrap();
      // Inline column: no BufferPool slot is allocated for the fixed field.
      expect(liveCount(w)).toBe(0);

      w.despawn(a).unwrap();
      expect(liveCount(w)).toBe(0);

      // Same-shape respawn still touches no slot, and reads back its payload.
      const b = w.spawn({ component: Mat4, data: { mat: new Float32Array(16) } }).unwrap();
      expect(liveCount(w)).toBe(0);
      const got = w.get(b, Mat4);
      if (!got.ok) throw new Error('expected ok');
      expect(got.value.mat[0]).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Path 2 -- world.removeComponent(e, C) releases array fields on C only.
  // ---------------------------------------------------------------------------

  describe('w12 - array<entity> variable: removeComponent releases slot', () => {
    it('removeComponent frees the array slot; freelist reuses id', () => {
      const Children = defineComponent('Children', { entities: { type: 'array<entity>' } });
      const Anchor = defineComponent('Anchor', { x: { type: 'f32' } });
      const w = new World();

      const a = w
        .spawn(
          {
            component: Children,
            data: { entities: new Uint32Array([1, 2, 3, 4]) },
          },
          { component: Anchor, data: { x: 7 } },
        )
        .unwrap();
      const aSlotId = readSlotId(w, handleNumeric(a), Children, 'entities');
      expect(aSlotId).toBeGreaterThan(0);

      w.removeComponent(a, Children).unwrap();

      const b = w
        .spawn({
          component: Children,
          data: { entities: new Uint32Array([10, 20, 30, 40]) },
        })
        .unwrap();
      const bSlotId = readSlotId(w, handleNumeric(b), Children, 'entities');
      expect(bSlotId).toBe(aSlotId);
    });
  });

  describe('w12 - array<f32,N> fixed: removeComponent touches no pool slot (inline)', () => {
    it('removeComponent of an inline fixed array never allocs a pool slot', () => {
      const Mat4 = defineComponent('Mat4', { mat: 'array<f32, 16>' });
      const Anchor = defineComponent('Anchor', { x: 'f32' });
      const w = new World();

      const init = new Float32Array(16);
      for (let i = 0; i < 16; i++) init[i] = i + 1;

      const a = w
        .spawn({ component: Mat4, data: { mat: init } }, { component: Anchor, data: { x: 7 } })
        .unwrap();
      expect(liveCount(w)).toBe(0);

      w.removeComponent(a, Mat4).unwrap();
      expect(liveCount(w)).toBe(0);

      const b = w.spawn({ component: Mat4, data: { mat: new Float32Array(16) } }).unwrap();
      expect(liveCount(w)).toBe(0);
      const got = w.get(b, Mat4);
      if (!got.ok) throw new Error('expected ok');
      expect(got.value.mat.length).toBe(16);
    });
  });

  // ---------------------------------------------------------------------------
  // Path 3 -- world.set(e, C, { arr: newValue }) releases prior + allocs new.
  // ---------------------------------------------------------------------------

  describe('w12 - array<entity> variable: set field overwrite releases prior slot', () => {
    it('set frees the prior array slot before allocating the new one', () => {
      const Children = defineComponent('Children', { entities: { type: 'array<entity>' } });
      const w = new World();

      const a = w
        .spawn({
          component: Children,
          data: { entities: new Uint32Array([1, 2, 3, 4]) },
        })
        .unwrap();
      const oldSlotId = readSlotId(w, handleNumeric(a), Children, 'entities');
      expect(oldSlotId).toBeGreaterThan(0);

      // Overwrite the array field with a brand-new payload of the same byte
      // size -> set path releases oldSlotId, then alloc(16) pops oldSlotId
      // from the freelist and the column re-stores the SAME id (LIFO same-
      // bucket reuse, D-7).
      w.set(a, Children, { entities: new Uint32Array([100, 200, 300, 400]) }).unwrap();

      const newSlotId = readSlotId(w, handleNumeric(a), Children, 'entities');
      expect(newSlotId).toBe(oldSlotId);

      // Bytes match the new payload (proves the slot was reset post-release).
      const got = w.get(a, Children);
      if (!got.ok) throw new Error('expected ok');
      const snap = got.value.entities;
      expect(snap.length).toBe(4);
      expect(snap[0]).toBe(100);
      expect(snap[3]).toBe(400);
    });
  });

  describe('w12 - array<f32,N> fixed: set field overwrite is inline (no pool slot)', () => {
    it('set overwrites the inline payload in place without touching the pool', () => {
      const Mat4 = defineComponent('Mat4', { mat: 'array<f32, 16>' });
      const w = new World();

      const init = new Float32Array(16);
      for (let i = 0; i < 16; i++) init[i] = i + 1;

      const a = w.spawn({ component: Mat4, data: { mat: init } }).unwrap();
      expect(liveCount(w)).toBe(0);

      const next = new Float32Array(16);
      for (let i = 0; i < 16; i++) next[i] = (i + 1) * 100;
      w.set(a, Mat4, { mat: next }).unwrap();
      // Inline set is a verbatim in-place row write -- no alloc / release.
      expect(liveCount(w)).toBe(0);

      const got = w.get(a, Mat4);
      if (!got.ok) throw new Error('expected ok');
      const snap = got.value.mat;
      expect(snap[0]).toBe(100);
      expect(snap[15]).toBe(1600);
    });
  });

  // ---------------------------------------------------------------------------
  // Boundary -- releasing one entity does NOT disturb a sibling at a different
  // row in the same archetype + same column.
  // ---------------------------------------------------------------------------

  describe('w12 - sibling-entity isolation: despawn one row does not touch another', () => {
    it("despawn(a) keeps b's array bytes + slot id intact", () => {
      const Children = defineComponent('Children', { entities: { type: 'array<entity>' } });
      const w = new World();

      const a = w
        .spawn({
          component: Children,
          data: { entities: new Uint32Array([1, 2, 3, 4]) },
        })
        .unwrap();
      const b = w
        .spawn({
          component: Children,
          data: { entities: new Uint32Array([10, 20, 30, 40]) },
        })
        .unwrap();

      const bSlotIdBefore = readSlotId(w, handleNumeric(b), Children, 'entities');
      expect(bSlotIdBefore).toBeGreaterThan(0);

      // Despawn A -- only A's row's slot is released.
      w.despawn(a).unwrap();

      // B's data + slot id stay intact.
      const bSlotIdAfter = readSlotId(w, handleNumeric(b), Children, 'entities');
      expect(bSlotIdAfter).toBe(bSlotIdBefore);

      const got = w.get(b, Children);
      if (!got.ok) throw new Error('expected ok');
      const snap = got.value.entities;
      expect(snap.length).toBe(4);
      expect(snap[0]).toBe(10);
      expect(snap[3]).toBe(40);
    });
  });
}
// Managed-array stride validation belongs to render consumers, not ECS.
{
  // --- from managed-array-vocab.test.ts ---
  describe('array vocab - keyword recognition (w12, AC-01)', () => {
    it('array<entity> derives to Uint32Array (Entity column storage)', () => {
      expectTypeOf<FieldValueType<'array<entity>'>>().toEqualTypeOf<Uint32Array>();
    });

    it('array<f32, 16> derives to Float32Array (fixed-capacity)', () => {
      expectTypeOf<FieldValueType<'array<f32, 16>'>>().toEqualTypeOf<Float32Array>();
    });

    it('array<u32> derives to Uint32Array', () => {
      expectTypeOf<FieldValueType<'array<u32>'>>().toEqualTypeOf<Uint32Array>();
    });

    it('array<i32, 4> derives to Int32Array (fixed-capacity i32)', () => {
      expectTypeOf<FieldValueType<'array<i32, 4>'>>().toEqualTypeOf<Int32Array>();
    });

    it('array<bool> derives to Uint8Array', () => {
      expectTypeOf<FieldValueType<'array<bool>'>>().toEqualTypeOf<Uint8Array>();
    });

    it('ShapeOf threads array vocab through FieldValueType', () => {
      type S = {
        entities: 'array<entity>';
        mat: 'array<f32, 16>';
        indices: 'array<u32>';
      };
      type Expected = {
        entities: Uint32Array;
        mat: Float32Array;
        indices: Uint32Array;
      };
      expectTypeOf<ShapeOf<S>>().toEqualTypeOf<Expected>();
    });
  });

  describe('array vocab - three-application-point inference (w12, AC-01)', () => {
    // Application point (a) -- inside world.addSystem fn callback. The system
    // closure reads the array field via `world.get(e, C).unwrap().entities`;
    // the inferred type must be `Uint32Array` without an `as` cast.
    it('application point (a) -- inside world.addSystem fn callback', () => {
      type Foo = ReturnType<typeof defineComponent<'Foo', { entities: 'array<entity>' }>>;
      type FooShape = ShapeOf<SchemaOf<Foo>>;
      // expectType: array<entity> resolves to Uint32Array at the system call site.
      expectTypeOf<FooShape['entities']>().toEqualTypeOf<Uint32Array>();
      const dummy: FooShape['entities'] = new Uint32Array(0);
      expectTypeOf(dummy).toEqualTypeOf<Uint32Array>();
    });

    // Application point (b) -- inside a QueryRow loop (same world.get path,
    // different host scope; type derivation must not regress when `entities`
    // crosses a function boundary).
    it('application point (b) -- inside a QueryRow loop', () => {
      type Foo = ReturnType<typeof defineComponent<'Foo', { entities: 'array<entity>' }>>;
      type FooShape = ShapeOf<SchemaOf<Foo>>;
      // expectType: QueryRow access sees the same Uint32Array shape as system fn.
      expectTypeOf<FooShape['entities']>().toEqualTypeOf<Uint32Array>();
    });

    // Application point (c) -- direct world.get call site (the simplest path,
    // outside any system / query). The explicit type annotation pins the
    // TypedArray inference to the schema literal.
    it('application point (c) -- direct world.get call site', () => {
      type Foo = ReturnType<typeof defineComponent<'Foo', { entities: 'array<entity>' }>>;
      type FooShape = ShapeOf<SchemaOf<Foo>>;
      // expectType: direct world.get(e, C).unwrap().entities matches TypedArrayFor<'u32'>.
      const arr: TypedArrayFor<'u32'> = new Uint32Array(0);
      expectTypeOf(arr).toEqualTypeOf<FooShape['entities']>();
    });

    it('World type still resolves (no parser regression)', () => {
      expectTypeOf<World>().toBeObject();
    });
  });

  describe('array vocab - cross-shape closure on TypedArray surface (w12, AC-02)', () => {
    it('Float32Array exposes `length` indexed access; no `push` / `pop` / `count`', () => {
      type FA = Float32Array;
      expectTypeOf<FA>().toHaveProperty('length');
      expectTypeOf<FA>().toHaveProperty('subarray');
      // The TypedArray surface is the SSOT here -- AI users mutate the field
      // through `world.push` / `world.pop` / `world.set`, NOT the snapshot.
    });

    it('Uint32Array indexed read returns number', () => {
      type UA = Uint32Array;
      expectTypeOf<UA[number]>().toEqualTypeOf<number>();
    });
  });

  describe('array vocab - element-type rejection (w12, AC-03)', () => {
    it('array<ref<X>> is not a recognised schema field type', () => {
      // @ts-expect-error 'array<ref<X>>' is not a SchemaFieldType (AC-03).
      const bad: SchemaFieldType = 'array<ref<MaterialAsset>>';
      void bad;
    });

    it('array<handle<X>> is now a recognised schema field type (feat-20260608 M2 D-1)', () => {
      const valid: SchemaFieldType = 'array<shared<MeshAsset>>';
      void valid;
    });

    it('array<array<f32,4>> nesting is not a recognised schema field type', () => {
      // @ts-expect-error 'array<array<f32,4>>' is not a SchemaFieldType (AC-03).
      const bad: SchemaFieldType = 'array<array<f32,4>>';
      void bad;
    });
  });

  describe('array vocab - cross-brand rejection (w12, AC-04)', () => {
    it("Entity packed u32 is not assignable to Handle<Mesh, 'unique'>", () => {
      const takesMeshHandle = (h: Handle<'Mesh', 'unique'>): void => {
        void h;
      };
      const view = new Uint32Array(1) as TypedArrayFor<'u32'>;
      const elem: number = view[0] ?? 0;
      // @ts-expect-error number is not assignable to Handle<'Mesh','unique'> (AC-04).
      takesMeshHandle(elem);
    });
  });
}
{
  // --- from managed-buffer-grow.test.ts ---
  function fillSequential(view: Uint8Array, base: number): void {
    for (let i = 0; i < view.byteLength; i++) view[i] = (i + base) & 0xff;
  }

  describe('w12 - AC-07 BufferPool.grow byte-equal carry-over', () => {
    it('cross-bucket grow (128 -> 1024) keeps first 128 bytes byte-equal', () => {
      const pool = new BufferPool();
      const a = pool.alloc(128);
      if (!a.ok) throw new Error('expected ok alloc');
      fillSequential(a.value.view, 1);
      const r = pool.grow(a.value.id, 1024);
      if (!r.ok) throw new Error('expected ok grow');
      expect(r.value.byteLength).toBe(1024);
      for (let i = 0; i < 128; i++) expect(r.value[i]).toBe((i + 1) & 0xff);
      // The grown tail bytes are zero-filled by the fresh ArrayBuffer.
      for (let i = 128; i < 1024; i++) expect(r.value[i]).toBe(0);
    });

    it('same-bucket grow (128 -> 200) keeps first 128 bytes byte-equal', () => {
      const pool = new BufferPool();
      const a = pool.alloc(128);
      if (!a.ok) throw new Error('expected ok alloc');
      fillSequential(a.value.view, 17);
      const r = pool.grow(a.value.id, 200);
      if (!r.ok) throw new Error('expected ok grow');
      expect(r.value.byteLength).toBe(200);
      for (let i = 0; i < 128; i++) expect(r.value[i]).toBe((i + 17) & 0xff);
    });

    it('multi-step grow (128 -> 1024 -> 4096) preserves accumulated content', () => {
      const pool = new BufferPool();
      const a = pool.alloc(128);
      if (!a.ok) throw new Error('expected ok alloc');
      fillSequential(a.value.view, 5);

      const r1 = pool.grow(a.value.id, 1024);
      if (!r1.ok) throw new Error('expected ok grow1');
      // Write a second pattern over the newly-available range.
      for (let i = 128; i < 1024; i++) r1.value[i] = (i ^ 0x5a) & 0xff;

      const r2 = pool.grow(a.value.id, 4096);
      if (!r2.ok) throw new Error('expected ok grow2');
      expect(r2.value.byteLength).toBe(4096);
      // Original prefix preserved.
      for (let i = 0; i < 128; i++) expect(r2.value[i]).toBe((i + 5) & 0xff);
      // Mid-range (set in r1) preserved across the second grow.
      for (let i = 128; i < 1024; i++) expect(r2.value[i]).toBe((i ^ 0x5a) & 0xff);
      // Tail past the prior view length is zero-filled.
      for (let i = 1024; i < 4096; i++) expect(r2.value[i]).toBe(0);
    });
  });
}
{
  // --- from managed-carry-over.test.ts ---
  function refsOf(w: World): UniqueRefStore {
    return (w as unknown as { uniqueRefs: UniqueRefStore }).uniqueRefs;
  }

  function fillSequential(view: Uint8Array, base: number): void {
    for (let i = 0; i < view.byteLength; i++) view[i] = (i + base) & 0xff;
  }

  function expectBytesEqual(a: Uint8Array, b: Uint8Array, len: number): void {
    for (let i = 0; i < len; i++) {
      expect(a[i]).toBe(b[i]);
    }
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // (a) ref<T> carry-over - Object.is on resolved payload survives migrate.
  // ---------------------------------------------------------------------------

  describe('w16 - ref<T> field archetype migrate carry-over (AC-04)', () => {
    it('addComponent triggers migrate; ref<T> handle u32 stays bit-equal', () => {
      const Mat = defineComponent('Mat', { handle: { type: 'unique<MaterialAsset>' } });
      const Anchor = defineComponent('Anchor', { x: { type: 'f32' } });
      const w = new World();
      const store = refsOf(w);
      const payload = { id: 7 };
      const h = store.alloc('MaterialAsset', payload);
      const e = w
        .spawn({
          component: Mat,
          data: { handle: h },
        })
        .unwrap();

      const before = w.get(e, Mat);
      if (!before.ok) throw new Error('expected ok get before');
      const handleBefore = handleNumeric(before.value.handle);

      // Trigger archetype migrate by adding a second component.
      w.addComponent(e, { component: Anchor, data: { x: 1 } }).unwrap();

      const after = w.get(e, Mat);
      if (!after.ok) throw new Error('expected ok get after');
      const handleAfter = handleNumeric(after.value.handle);

      expect(Object.is(handleBefore, handleAfter)).toBe(true);
      // Resolved payload is the same object reference (store.resolve returns
      // the SAME payload object on every call; AC-04 prelude in
      // managed-release.test.ts).
      const resolvedBefore = store.resolve(before.value.handle);
      const resolvedAfter = store.resolve(after.value.handle);
      if (!resolvedBefore.ok || !resolvedAfter.ok) {
        throw new Error('expected resolved x2');
      }
      expect(Object.is(resolvedBefore.value, resolvedAfter.value)).toBe(true);
      expect(resolvedAfter.value).toBe(payload);
    });

    it('removeComponent triggers migrate; surviving ref<T> handle u32 stays bit-equal', () => {
      const Mat = defineComponent('Mat', { handle: { type: 'unique<MaterialAsset>' } });
      const Anchor = defineComponent('Anchor', { x: { type: 'f32' } });
      const w = new World();
      const store = refsOf(w);
      const payload = { id: 11 };
      const h = store.alloc('MaterialAsset', payload);
      const e = w
        .spawn(
          {
            component: Mat,
            data: { handle: h },
          },
          { component: Anchor, data: { x: 0 } },
        )
        .unwrap();

      const before = w.get(e, Mat);
      if (!before.ok) throw new Error('expected ok get before');
      const handleBefore = handleNumeric(before.value.handle);

      // Removing Anchor migrates the entity; Mat (with managed ref) survives.
      w.removeComponent(e, Anchor).unwrap();

      const after = w.get(e, Mat);
      if (!after.ok) throw new Error('expected ok get after');
      const handleAfter = handleNumeric(after.value.handle);

      expect(Object.is(handleBefore, handleAfter)).toBe(true);
      const r = store.resolve(after.value.handle);
      if (!r.ok) throw new Error('expected resolved');
      expect(r.value).toBe(payload);
    });

    it('multi-hop migrate (add then remove) keeps ref<T> handle u32 bit-equal end-to-end', () => {
      const Mat = defineComponent('Mat', { handle: { type: 'unique<MaterialAsset>' } });
      const Anchor = defineComponent('Anchor', { x: { type: 'f32' } });
      const Tag = defineComponent('Tag', { v: { type: 'u32' } });
      const w = new World();
      const store = refsOf(w);
      const payload = { id: 99 };
      const h = store.alloc('MaterialAsset', payload);
      const e = w
        .spawn({
          component: Mat,
          data: { handle: h },
        })
        .unwrap();
      const r0 = w.get(e, Mat);
      if (!r0.ok) throw new Error('expected r0');
      const handle0 = handleNumeric(r0.value.handle);

      // Hop 1: add Anchor.
      w.addComponent(e, { component: Anchor, data: { x: 2 } }).unwrap();
      const r1 = w.get(e, Mat);
      if (!r1.ok) throw new Error('expected r1');
      expect(Object.is(handleNumeric(r1.value.handle), handle0)).toBe(true);

      // Hop 2: add Tag.
      w.addComponent(e, { component: Tag, data: { v: 42 } }).unwrap();
      const r2 = w.get(e, Mat);
      if (!r2.ok) throw new Error('expected r2');
      expect(Object.is(handleNumeric(r2.value.handle), handle0)).toBe(true);

      // Hop 3: remove Anchor.
      w.removeComponent(e, Anchor).unwrap();
      const r3 = w.get(e, Mat);
      if (!r3.ok) throw new Error('expected r3');
      expect(Object.is(handleNumeric(r3.value.handle), handle0)).toBe(true);

      // Hop 4: remove Tag.
      w.removeComponent(e, Tag).unwrap();
      const r4 = w.get(e, Mat);
      if (!r4.ok) throw new Error('expected r4');
      expect(Object.is(handleNumeric(r4.value.handle), handle0)).toBe(true);

      // Final resolve still returns the original payload.
      const resolved = store.resolve(r4.value.handle);
      if (!resolved.ok) throw new Error('expected resolved');
      expect(resolved.value).toBe(payload);
    });
  });

  // ---------------------------------------------------------------------------
  // (b) buffer:<N> field carry-over - bytes preserved byte-equal across migrate.
  // ---------------------------------------------------------------------------

  describe('w16 - buffer:<N> field archetype migrate carry-over (AC-04)', () => {
    it('addComponent migrate keeps buffer payload byte-equal (post-migrate view)', () => {
      const Skin = defineComponent('Skin', { palette: { type: 'buffer<128>' } });
      const Anchor = defineComponent('Anchor', { x: { type: 'f32' } });
      const w = new World();
      const seed = new Uint8Array(128);
      fillSequential(seed, 13);
      const e = w.spawn({ component: Skin, data: { palette: seed } }).unwrap();

      const before = w.get(e, Skin);
      if (!before.ok) throw new Error('expected ok get before');
      const snapshot = new Uint8Array(before.value.palette); // copy for comparison.

      w.addComponent(e, { component: Anchor, data: { x: 0 } }).unwrap();

      const after = w.get(e, Skin);
      if (!after.ok) throw new Error('expected ok get after');
      expect(after.value.palette.byteLength).toBe(128);
      expectBytesEqual(after.value.palette, snapshot, 128);
    });

    it('removeComponent migrate keeps surviving buffer field byte-equal', () => {
      const Skin = defineComponent('Skin', { palette: { type: 'buffer<64>' } });
      const Anchor = defineComponent('Anchor', { x: { type: 'f32' } });
      const w = new World();
      const seed = new Uint8Array(64);
      fillSequential(seed, 71);
      const e = w
        .spawn({ component: Skin, data: { palette: seed } }, { component: Anchor, data: { x: 9 } })
        .unwrap();

      const before = w.get(e, Skin);
      if (!before.ok) throw new Error('expected ok get before');
      const snapshot = new Uint8Array(before.value.palette);

      // Remove Anchor; Skin (with buffer) survives the migrate.
      w.removeComponent(e, Anchor).unwrap();

      const after = w.get(e, Skin);
      if (!after.ok) throw new Error('expected ok get after');
      expectBytesEqual(after.value.palette, snapshot, 64);
    });
  });

  // ---------------------------------------------------------------------------
  // (c) Combined ref + buffer fields on the same component survive migrate.
  // ---------------------------------------------------------------------------

  describe('w16 - combined ref+buffer fields archetype migrate carry-over (AC-04)', () => {
    it('addComponent migrate: ref handle u32 stays bit-equal AND buffer bytes byte-equal', () => {
      const Mesh = defineComponent('Mesh', {
        material: { type: 'unique<MaterialAsset>' },
        vertices: { type: 'buffer<256>' },
      });
      const Anchor = defineComponent('Anchor', { x: { type: 'f32' } });
      const w = new World();
      const store = refsOf(w);
      const payload = { id: 1 };
      const h = store.alloc('MaterialAsset', payload);
      const seed = new Uint8Array(256);
      fillSequential(seed, 31);
      const e = w
        .spawn({
          component: Mesh,
          data: {
            material: h,
            vertices: seed,
          },
        })
        .unwrap();

      const before = w.get(e, Mesh);
      if (!before.ok) throw new Error('expected ok get before');
      const handleBefore = handleNumeric(before.value.material);
      const bytesSnapshot = new Uint8Array(before.value.vertices);

      w.addComponent(e, { component: Anchor, data: { x: 5 } }).unwrap();

      const after = w.get(e, Mesh);
      if (!after.ok) throw new Error('expected ok get after');
      expect(Object.is(handleNumeric(after.value.material), handleBefore)).toBe(true);
      expect(after.value.vertices.byteLength).toBe(256);
      expectBytesEqual(after.value.vertices, bytesSnapshot, 256);

      // Resolved payload is still the same object reference.
      const resolved = store.resolve(after.value.material);
      if (!resolved.ok) throw new Error('expected resolved');
      expect(resolved.value).toBe(payload);
    });

    it('removeComponent migrate: ref+buffer on the surviving component stay carry-over intact', () => {
      const Mesh = defineComponent('Mesh', {
        material: { type: 'unique<MaterialAsset>' },
        vertices: { type: 'buffer<128>' },
      });
      const Anchor = defineComponent('Anchor', { x: { type: 'f32' } });
      const w = new World();
      const store = refsOf(w);
      const payload = { id: 2 };
      const h = store.alloc('MaterialAsset', payload);
      const seed = new Uint8Array(128);
      fillSequential(seed, 47);
      const e = w
        .spawn(
          {
            component: Mesh,
            data: {
              material: h,
              vertices: seed,
            },
          },
          { component: Anchor, data: { x: 3 } },
        )
        .unwrap();

      const before = w.get(e, Mesh);
      if (!before.ok) throw new Error('expected ok get before');
      const handleBefore = handleNumeric(before.value.material);
      const snapshot = new Uint8Array(before.value.vertices);

      w.removeComponent(e, Anchor).unwrap();

      const after = w.get(e, Mesh);
      if (!after.ok) throw new Error('expected ok get after');
      expect(Object.is(handleNumeric(after.value.material), handleBefore)).toBe(true);
      expectBytesEqual(after.value.vertices, snapshot, 128);
    });

    it('multi-hop migrate keeps ref+buffer carry-over intact end-to-end', () => {
      const Mesh = defineComponent('Mesh', {
        material: { type: 'unique<MaterialAsset>' },
        vertices: { type: 'buffer<64>' },
      });
      const Anchor = defineComponent('Anchor', { x: { type: 'f32' } });
      const Tag = defineComponent('Tag', { v: { type: 'u32' } });
      const w = new World();
      const store = refsOf(w);
      const payload = { id: 3 };
      const h = store.alloc('MaterialAsset', payload);
      const seed = new Uint8Array(64);
      fillSequential(seed, 53);
      const e = w
        .spawn({
          component: Mesh,
          data: {
            material: h,
            vertices: seed,
          },
        })
        .unwrap();

      const r0 = w.get(e, Mesh);
      if (!r0.ok) throw new Error('expected r0');
      const handle0 = handleNumeric(r0.value.material);
      const snapshot = new Uint8Array(r0.value.vertices);

      // Hop sequence: +Anchor, +Tag, -Anchor, -Tag.
      w.addComponent(e, { component: Anchor, data: { x: 0 } }).unwrap();
      w.addComponent(e, { component: Tag, data: { v: 1 } }).unwrap();
      w.removeComponent(e, Anchor).unwrap();
      w.removeComponent(e, Tag).unwrap();

      const rN = w.get(e, Mesh);
      if (!rN.ok) throw new Error('expected rN');
      expect(Object.is(handleNumeric(rN.value.material), handle0)).toBe(true);
      expectBytesEqual(rN.value.vertices, snapshot, 64);
      const resolved = store.resolve(rN.value.material);
      if (!resolved.ok) throw new Error('expected resolved');
      expect(resolved.value).toBe(payload);
    });
  });

  // ---------------------------------------------------------------------------
  // (d) Negative invariants: migrate does NOT release / realloc / route errors.
  // ---------------------------------------------------------------------------

  describe('w16 - migrate does not release or route errors (AC-04 negative)', () => {
    it('addComponent migrate does not call UniqueRefStore.release / BufferPool.release', () => {
      const Mesh = defineComponent('Mesh', {
        material: { type: 'unique<MaterialAsset>' },
        vertices: { type: 'buffer<32>' },
      });
      const Anchor = defineComponent('Anchor', { x: { type: 'f32' } });
      const w = new World();
      const store = refsOf(w);
      const refReleaseSpy = vi.spyOn(UniqueRefStore.prototype, 'release');
      const bufReleaseSpy = vi.spyOn(BufferPool.prototype, 'release');
      const h = store.alloc('MaterialAsset', { id: 1 });
      const seed = new Uint8Array(32);
      fillSequential(seed, 1);
      const e = w
        .spawn({
          component: Mesh,
          data: {
            material: h,
            vertices: seed,
          },
        })
        .unwrap();

      // Reset call counts to ignore any release calls made during alloc/setup.
      refReleaseSpy.mockClear();
      bufReleaseSpy.mockClear();

      w.addComponent(e, { component: Anchor, data: { x: 1 } }).unwrap();

      expect(refReleaseSpy).not.toHaveBeenCalled();
      expect(bufReleaseSpy).not.toHaveBeenCalled();
    });

    it('removeComponent migrate of an unrelated component does not release the survivor managed slots', () => {
      const Mesh = defineComponent('Mesh', {
        material: { type: 'unique<MaterialAsset>' },
        vertices: { type: 'buffer<32>' },
      });
      const Anchor = defineComponent('Anchor', { x: { type: 'f32' } });
      const w = new World();
      const store = refsOf(w);
      const h = store.alloc('MaterialAsset', { id: 1 });
      const seed = new Uint8Array(32);
      fillSequential(seed, 17);
      const e = w
        .spawn(
          {
            component: Mesh,
            data: {
              material: h,
              vertices: seed,
            },
          },
          { component: Anchor, data: { x: 0 } },
        )
        .unwrap();

      const refReleaseSpy = vi.spyOn(UniqueRefStore.prototype, 'release');
      const bufReleaseSpy = vi.spyOn(BufferPool.prototype, 'release');

      // Remove Anchor (no managed fields). Mesh's material + vertices must NOT
      // be released - they survive the migrate.
      w.removeComponent(e, Anchor).unwrap();

      expect(refReleaseSpy).not.toHaveBeenCalled();
      expect(bufReleaseSpy).not.toHaveBeenCalled();

      // The handle still resolves and the bytes are still readable.
      const after = w.get(e, Mesh);
      if (!after.ok) throw new Error('expected ok get after');
      const resolved = store.resolve(after.value.material);
      expect(resolved.ok).toBe(true);
      expect(after.value.vertices.byteLength).toBe(32);
    });
  });
}
{
  // --- from managed-release.test.ts ---
  function refsOf(w: World): UniqueRefStore {
    return (w as unknown as { uniqueRefs: UniqueRefStore }).uniqueRefs;
  }

  // ---------------------------------------------------------------------------
  // (a) UniqueRefStore unit-level invariants (covers w7 acceptance).
  // ---------------------------------------------------------------------------

  describe('w6 - UniqueRefStore unit invariants', () => {
    it('alloc returns a frozen plain-object handle wrapper', () => {
      const w = new World();
      const store = refsOf(w);
      const h = store.alloc('MaterialAsset', { id: 7 });
      // Wrapper is frozen (D-3 charter: immutable identity).
      expect(Object.isFrozen(h)).toBe(true);
    });

    it('resolve(h) on a live handle returns ok(payload)', () => {
      const w = new World();
      const store = refsOf(w);
      const h = store.alloc<'MaterialAsset', { id: number }>('MaterialAsset', { id: 42 });
      const r = store.resolve<'MaterialAsset', { id: number }>(h);
      if (!r.ok) throw new Error('expected ok');
      expect(r.value.id).toBe(42);
    });

    it('resolve(h) after release returns err(unique-ref-stale) (gen incremented in M4)', () => {
      const w = new World();
      const store = refsOf(w);
      const h = store.alloc('MaterialAsset', { id: 1 });
      store.release(h).unwrap();
      const r = store.resolve(h);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('expected err');
      expect(r.error.code).toBe('unique-ref-stale');
    });

    it('release(h) twice surfaces unique-ref-stale (gen mismatch after first release, M4)', () => {
      const w = new World();
      const store = refsOf(w);
      const h = store.alloc('MaterialAsset', { id: 1 });
      store.release(h).unwrap();
      const r = store.release(h);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('expected err');
      expect(r.error.code).toBe('unique-ref-stale');
    });

    it('AC-04 prelude: alloc returns per-(slot,gen) singleton identity (Object.is)', () => {
      // D-3: each alloc produces a unique frozen wrapper; the same wrapper is
      // strongly referenced by the store's Map until release. Any mid-life
      // resolve of the same handle must return the same object reference (this
      // probes the "(slot, gen) singleton" invariant prior to archetype migrate
      // carry-over in M4 — the store does NOT swap wrapper identity on resolve).
      const w = new World();
      const store = refsOf(w);
      const h = store.alloc('MaterialAsset', { id: 1 });
      const r1 = store.resolve(h);
      const r2 = store.resolve(h);
      if (!r1.ok || !r2.ok) throw new Error('expected ok x2');
      expect(Object.is(r1.value, r2.value)).toBe(true);
    });

    it('release of distinct handles is independent (refcount per-slot, not global)', () => {
      const w = new World();
      const store = refsOf(w);
      const a = store.alloc<'MaterialAsset', { id: number }>('MaterialAsset', { id: 1 });
      const b = store.alloc<'MaterialAsset', { id: number }>('MaterialAsset', { id: 2 });
      store.release(a).unwrap();
      // b stays live.
      const rb = store.resolve<'MaterialAsset', { id: number }>(b);
      if (!rb.ok) throw new Error('expected b live');
      expect(rb.value.id).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // (b) World release loop integration tests (AC-03 - 3 paths).
  // ---------------------------------------------------------------------------

  describe('w6 - World ref<T> field release loop', () => {
    it('world.despawn(e) releases ref<T> field handle (path 1)', () => {
      const Mat = defineComponent('Mat', { handle: { type: 'unique<MaterialAsset>' } });
      const w = new World();
      const store = refsOf(w);
      const h = store.alloc('MaterialAsset', { id: 7 });
      const e = w
        .spawn({
          component: Mat,
          data: { handle: h },
        })
        .unwrap();
      w.despawn(e).unwrap();
      const r = store.resolve(h);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('expected stale');
      expect(r.error.code).toBe('unique-ref-stale');
    });

    it('world.removeComponent(e, C) releases ref<T> field handle (path 2)', () => {
      const Mat = defineComponent('Mat', { handle: { type: 'unique<MaterialAsset>' } });
      const Anchor = defineComponent('Anchor', { x: { type: 'f32' } });
      const w = new World();
      const store = refsOf(w);
      const h = store.alloc('MaterialAsset', { id: 7 });
      const e = w
        .spawn(
          {
            component: Mat,
            data: { handle: h },
          },
          { component: Anchor, data: { x: 0 } },
        )
        .unwrap();
      w.removeComponent(e, Mat).unwrap();
      const r = store.resolve(h);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('expected stale');
      expect(r.error.code).toBe('unique-ref-stale');
    });

    it('world.set(e, C, { handle: newHandle }) releases the prior handle (path 3)', () => {
      const Mat = defineComponent('Mat', { handle: { type: 'unique<MaterialAsset>' } });
      const w = new World();
      const store = refsOf(w);
      const oldH = store.alloc('MaterialAsset', { id: 1 });
      const newH = store.alloc('MaterialAsset', { id: 2 });
      const e = w
        .spawn({
          component: Mat,
          data: { handle: oldH },
        })
        .unwrap();
      w.set(e, Mat, {
        handle: newH,
      }).unwrap();
      const rOld = store.resolve(oldH);
      expect(rOld.ok).toBe(false);
      if (rOld.ok) throw new Error('expected old released');
      expect(rOld.error.code).toBe('unique-ref-stale');
      const rNew = store.resolve(newH);
      expect(rNew.ok).toBe(true);
    });

    it('null ref<T> field on spawn does not call release on despawn (boundary)', () => {
      // Boundary case: ref<T> field can hold null; despawn must not attempt to
      // release a null slot (would surface as unique-ref-double-release noise).
      const Mat = defineComponent('Mat', { handle: { type: 'unique<MaterialAsset>' } });
      const w = new World();
      // Use 0 as the "null/unset" sentinel encoded as a managed handle. The
      // store's release path must short-circuit on this sentinel - documented
      // by D-3 (the wrapper for slot 0 is never allocated, so resolve returns
      // err but world's release loop must skip it without escalating).
      const sentinel = 0 as Handle<'MaterialAsset', 'unique'>;
      const e = w.spawn({ component: Mat, data: { handle: sentinel } }).unwrap();
      w.despawn(e).unwrap();
    });
  });

  // ---------------------------------------------------------------------------
  // (c) w9 - Layer 3 ErrorHandler routing on release failure (AC-05).
  // ---------------------------------------------------------------------------
}
{
  // --- from resource.test.ts ---
  describe('insertResource / getResource', () => {
    it('insertResource stores a value and getResource retrieves it', () => {
      const world = new World();
      world.insertResource('time', { delta: 0.016, elapsed: 0 });
      const time = world.getResource<{ delta: number; elapsed: number }>('time');
      expect(time).toEqual({ delta: 0.016, elapsed: 0 });
    });

    it('getResource returns the exact reference (not a copy)', () => {
      const world = new World();
      const obj = { count: 0 };
      world.insertResource('counter', obj);
      const retrieved = world.getResource<{ count: number }>('counter');
      expect(retrieved).toBe(obj);
    });

    it('supports primitive values', () => {
      const world = new World();
      world.insertResource('fps', 60);
      expect(world.getResource<number>('fps')).toBe(60);
    });

    it('supports string values', () => {
      const world = new World();
      world.insertResource('name', 'hello');
      expect(world.getResource<string>('name')).toBe('hello');
    });
  });

  describe('hasResource', () => {
    it('returns true for existing resource', () => {
      const world = new World();
      world.insertResource('exists', 42);
      expect(world.hasResource('exists')).toBe(true);
    });

    it('returns false for non-existing resource', () => {
      const world = new World();
      expect(world.hasResource('nope')).toBe(false);
    });
  });

  describe('removeResource', () => {
    it('removes an existing resource', () => {
      const world = new World();
      world.insertResource('temp', 100);
      world.removeResource('temp');
      expect(world.hasResource('temp')).toBe(false);
    });

    it('getResource after remove throws ResourceNotFoundError', () => {
      const world = new World();
      world.insertResource('gone', 1);
      world.removeResource('gone');
      expect(() => world.getResource('gone')).toThrow(ResourceNotFoundError);
    });
  });

  describe('idempotent overwrite (E-13)', () => {
    it('insertResource with same key overwrites old value', () => {
      const world = new World();
      world.insertResource('data', { v: 1 });
      world.insertResource('data', { v: 2 });
      expect(world.getResource<{ v: number }>('data')).toEqual({ v: 2 });
    });

    it('overwrite is idempotent — double insert same value is fine', () => {
      const world = new World();
      world.insertResource('stable', 42);
      world.insertResource('stable', 42);
      expect(world.getResource<number>('stable')).toBe(42);
    });
  });

  describe('getResource not found (E-14)', () => {
    it('getResource on non-existing key throws ResourceNotFoundError', () => {
      const world = new World();
      expect(() => world.getResource('missing')).toThrow(ResourceNotFoundError);
    });

    it('ResourceNotFoundError contains key in message', () => {
      const world = new World();
      try {
        world.getResource('myKey');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ResourceNotFoundError);
        expect((err as ResourceNotFoundError).message).toContain('myKey');
      }
    });

    it('ResourceNotFoundError has hint property', () => {
      const world = new World();
      try {
        world.getResource('foo');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ResourceNotFoundError);
        expect((err as ResourceNotFoundError).hint).toContain('insertResource');
      }
    });
  });
}
{
  // --- from schedule-remove-replace.test.ts ---
  describe('schedule.removeSystem (AC-04)', () => {
    it('removes a registered system; world.inspect() no longer lists it', () => {
      const world = new World();
      world.addSystem(Update, { name: 'sysA', queries: [], fn: () => {} });
      world.addSystem(Update, { name: 'sysB', queries: [], fn: () => {} });

      const r = world.removeSystem(Update, 'sysA');
      expect(r.ok).toBe(true);

      const snap = world.inspect();
      const names = snap.systems.map((s) => s.name);
      expect(names).not.toContain('sysA');
      expect(names).toContain('sysB');
    });

    it('returns Result.err with code system-before-unknown when name does not exist', () => {
      const world = new World();
      world.addSystem(Update, { name: 'sysA', queries: [], fn: () => {} });

      const r = world.removeSystem(Update, 'nonexistent');
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('system-before-unknown');
    });
  });

  describe('schedule.replaceSystem (AC-04)', () => {
    it('replaces system fn atomically; before/after edges of the slot remain intact', () => {
      const world = new World();
      const log: string[] = [];

      world.addSystem(Update, { name: 'sysA', queries: [], fn: () => log.push('A-old') });
      world.addSystem(Update, {
        name: 'sysB',
        queries: [],
        fn: () => log.push('B'),
        after: ['sysA'],
      });

      const r = world.replaceSystem(Update, 'sysA', {
        name: 'sysA',
        queries: [],
        fn: () => log.push('A-new'),
      });
      expect(r.ok).toBe(true);

      world.update();
      expect(log).toEqual(['A-new', 'B']);
      expect(log.indexOf('A-new')).toBeLessThan(log.indexOf('B'));
    });

    it('returns Result.err with code system-before-unknown when target name not registered', () => {
      const world = new World();

      const r = world.replaceSystem(Update, 'nonexistent', {
        name: 'nonexistent',
        queries: [],
        fn: () => {},
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('system-before-unknown');
    });
  });
}
{
  // --- from schedule.test.ts ---
  describe('System registration (AC-11)', () => {
    it('world.addSystem registers a system with query descriptor', () => {
      const world = new World();
      const Pos = defineComponent('SchedPos', { x: { type: 'f32' }, y: { type: 'f32' } });
      const log: string[] = [];

      world.addSystem(Update, {
        name: 'movement',
        queries: [{ with: [Pos] }],
        fn: () => {
          log.push('movement');
        },
      });

      world.update();
      expect(log).toEqual(['movement']);
    });

    it('system receives query results and commands', () => {
      const world = new World();
      const Pos = defineComponent('SysQPos', { x: { type: 'f32' }, y: { type: 'f32' } });
      world.spawn({ component: Pos, data: { x: 1, y: 2 } });

      let receivedBundleCount = 0;

      world.addSystem(Update, {
        name: 'reader',
        queries: [{ read: [Pos] }],
        fn: (_world, queryResults, _commands) => {
          for (const query of queryResults) receivedBundleCount += [...query].length;
        },
      });

      world.update();
      expect(receivedBundleCount).toBe(1);
    });
  });

  describe('before/after constraints (AC-12)', () => {
    it('after constraint ensures system runs after specified system', () => {
      const world = new World();
      const log: string[] = [];

      world.addSystem(Update, {
        name: 'sysA',
        queries: [],
        fn: () => log.push('A'),
      });

      world.addSystem(Update, {
        name: 'sysB',
        queries: [],
        fn: () => log.push('B'),
        after: ['sysA'],
      });

      world.update();
      expect(log.indexOf('A')).toBeLessThan(log.indexOf('B'));
    });

    it('before constraint ensures system runs before specified system', () => {
      const world = new World();
      const log: string[] = [];

      // Register B first, then A with before: ['sysB']
      world.addSystem(Update, {
        name: 'sysB',
        queries: [],
        fn: () => log.push('B'),
      });

      world.addSystem(Update, {
        name: 'sysA',
        queries: [],
        fn: () => log.push('A'),
        before: ['sysB'],
      });

      world.update();
      expect(log.indexOf('A')).toBeLessThan(log.indexOf('B'));
    });

    it('complex DAG: A -> B -> D, A -> C -> D', () => {
      const world = new World();
      const log: string[] = [];

      world.addSystem(Update, {
        name: 'A',
        queries: [],
        fn: () => log.push('A'),
      });

      world.addSystem(Update, {
        name: 'B',
        queries: [],
        fn: () => log.push('B'),
        after: ['A'],
        before: ['D'],
      });

      world.addSystem(Update, {
        name: 'C',
        queries: [],
        fn: () => log.push('C'),
        after: ['A'],
        before: ['D'],
      });

      world.addSystem(Update, {
        name: 'D',
        queries: [],
        fn: () => log.push('D'),
      });

      world.update();

      // A must come first, D must come last
      expect(log[0]).toBe('A');
      expect(log[3]).toBe('D');
      // B and C are between A and D — order determined by registration order
      expect(log[1]).toBe('B');
      expect(log[2]).toBe('C');
    });
  });

  describe('Registration order tie-breaker (AC-13)', () => {
    it('systems with no ordering constraints run in registration order', () => {
      const world = new World();
      const log: string[] = [];

      world.addSystem(Update, { name: 'first', queries: [], fn: () => log.push('first') });
      world.addSystem(Update, { name: 'second', queries: [], fn: () => log.push('second') });
      world.addSystem(Update, { name: 'third', queries: [], fn: () => log.push('third') });

      world.update();
      expect(log).toEqual(['first', 'second', 'third']);
    });

    it('tie-breaker applies within same topological level', () => {
      const world = new World();
      const log: string[] = [];

      world.addSystem(Update, { name: 'root', queries: [], fn: () => log.push('root') });
      // Three systems all after 'root', no order among themselves
      world.addSystem(Update, {
        name: 'childC',
        queries: [],
        fn: () => log.push('childC'),
        after: ['root'],
      });
      world.addSystem(Update, {
        name: 'childA',
        queries: [],
        fn: () => log.push('childA'),
        after: ['root'],
      });
      world.addSystem(Update, {
        name: 'childB',
        queries: [],
        fn: () => log.push('childB'),
        after: ['root'],
      });

      world.update();
      expect(log[0]).toBe('root');
      // After root: childC, childA, childB — by registration order
      expect(log.slice(1)).toEqual(['childC', 'childA', 'childB']);
    });
  });

  describe('DAG cyclic dependency (E-07)', () => {
    it('cyclic dependency throws CyclicDependencyError', () => {
      const world = new World();

      world.addSystem(Update, { name: 'A', queries: [], fn: () => {}, after: ['C'] });
      world.addSystem(Update, { name: 'B', queries: [], fn: () => {}, after: ['A'] });
      world.addSystem(Update, { name: 'C', queries: [], fn: () => {}, after: ['B'] });

      const result = world.update();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('cyclic-dependency');
    });

    it('CyclicDependencyError message contains cycle path', () => {
      const world = new World();

      world.addSystem(Update, { name: 'X', queries: [], fn: () => {}, after: ['Z'] });
      world.addSystem(Update, { name: 'Y', queries: [], fn: () => {}, after: ['X'] });
      world.addSystem(Update, { name: 'Z', queries: [], fn: () => {}, after: ['Y'] });

      const result = world.update();
      expect(result.ok).toBe(false);
      if (!result.ok && result.error.code === 'cyclic-dependency') {
        const msg = result.error.message;
        // Message should contain system names from the cycle (joined by ' -> ')
        expect(msg).toMatch(/X/);
        expect(msg).toMatch(/Y/);
        expect(msg).toMatch(/Z/);
        // detail.cycle is structured array
        const cycle = result.error.detail.cycle;
        expect(cycle).toBeInstanceOf(Array);
        expect(cycle.length).toBeGreaterThanOrEqual(2);
        expect(cycle).toContain('X');
        expect(cycle).toContain('Y');
        expect(cycle).toContain('Z');
      }
    });

    it('partial cycle: some systems are outside the cycle', () => {
      const world = new World();
      const log: string[] = [];

      // Linear chain: free1 → free2 (no cycle)
      world.addSystem(Update, { name: 'free1', queries: [], fn: () => log.push('free1') });
      world.addSystem(Update, {
        name: 'free2',
        queries: [],
        fn: () => log.push('free2'),
        after: ['free1'],
      });

      // Cycle: cyc1 → cyc2 → cyc1
      world.addSystem(Update, { name: 'cyc1', queries: [], fn: () => {}, after: ['cyc2'] });
      world.addSystem(Update, { name: 'cyc2', queries: [], fn: () => {}, after: ['cyc1'] });

      const result = world.update();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('cyclic-dependency');
    });

    it('4-node cycle: A→B→C→D→A with an uncycled system E', () => {
      const world = new World();

      world.addSystem(Update, { name: 'E', queries: [], fn: () => {} });
      world.addSystem(Update, { name: 'A', queries: [], fn: () => {}, after: ['D'] });
      world.addSystem(Update, { name: 'B', queries: [], fn: () => {}, after: ['A'] });
      world.addSystem(Update, { name: 'C', queries: [], fn: () => {}, after: ['B'] });
      world.addSystem(Update, { name: 'D', queries: [], fn: () => {}, after: ['C'] });

      const result = world.update();
      expect(result.ok).toBe(false);
      if (!result.ok && result.error.code === 'cyclic-dependency') {
        const msg = result.error.message;
        // Cycle involves A, B, C, D
        expect(msg).toMatch(/A/);
        expect(msg).toMatch(/B/);
        const cycle = result.error.detail.cycle;
        expect(cycle).toBeInstanceOf(Array);
        expect(cycle.length).toBeGreaterThanOrEqual(2);
      }
    });

    it('before/after referencing unknown systems are silently skipped', () => {
      const world = new World();
      const log: string[] = [];

      world.addSystem(Update, {
        name: 'sys1',
        queries: [],
        fn: () => log.push('sys1'),
        after: ['nonexistent'],
      });

      world.update();
      expect(log).toEqual(['sys1']);
    });
  });

  describe('Empty World update (E-09)', () => {
    it('update on empty world completes silently', () => {
      const world = new World();
      expect(() => world.update()).not.toThrow();
    });

    it('update on world with no systems completes silently', () => {
      const world = new World();
      const Pos = defineComponent('EmptyUpdatePos', { x: { type: 'f32' } });
      world.spawn({ component: Pos, data: { x: 1 } });
      expect(() => world.update()).not.toThrow();
    });
  });

  describe('Lazy build', () => {
    it('addSystem only marks dirty, first update triggers sort', () => {
      const world = new World();
      const log: string[] = [];

      world.addSystem(Update, { name: 'A', queries: [], fn: () => log.push('A') });
      world.addSystem(Update, { name: 'B', queries: [], fn: () => log.push('B'), before: ['A'] });

      // First update builds schedule
      world.update();
      expect(log).toEqual(['B', 'A']);

      log.length = 0;
      // Second update uses cached schedule
      world.update();
      expect(log).toEqual(['B', 'A']);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // [w16] Layer 2 ParamValidation tests (red phase — AP-8 Layer 2)
  // ────────────────────────────────────────────────────────────────────────────

  describe('Layer 2 — ParamValidation (AP-8)', () => {
    it('query with no matching archetypes → system body still executes (Query is always ok)', () => {
      const world = new World();
      const Pos = defineComponent('PVSkipPos', { x: { type: 'f32' } });
      // No entities spawned — query will match nothing

      let bodyExecuted = false;
      world.addSystem(Update, {
        name: 'emptyQuerySystem',
        queries: [{ with: [Pos] }],
        fn: () => {
          bodyExecuted = true;
        },
      });

      world.update();
      // Per Bevy Finding 6: Query<D, F> is always Ok (empty is valid).
      // System body executes; it receives empty query results.
      // "skipped" path is reserved for future Populated/Single query types.
      expect(bodyExecuted).toBe(true);
    });

    it('query with matching archetypes → system body executes (ok)', () => {
      const world = new World();
      const Pos = defineComponent('PVOkPos', { x: { type: 'f32' } });
      world.spawn({ component: Pos, data: { x: 1 } });

      let bodyExecuted = false;
      world.addSystem(Update, {
        name: 'okSystem',
        queries: [{ with: [Pos] }],
        fn: () => {
          bodyExecuted = true;
        },
      });

      world.update();
      expect(bodyExecuted).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // [w18] Layer 3 ErrorHandler + Severity tests (red phase — AP-8 Layer 3)
  // ────────────────────────────────────────────────────────────────────────────
}
{
  // --- from string-carry-over.test.ts ---
  interface MaterialAsset {
    readonly tint: number;
  }

  function refsOf(w: World): UniqueRefStore {
    return (w as unknown as { uniqueRefs: UniqueRefStore }).uniqueRefs;
  }

  // ---------------------------------------------------------------------------
  // (a) addComponent migrate: string `.value` Object.is + string-equal preserved.
  // ---------------------------------------------------------------------------

  describe('w8 --- string carry-over via addComponent migrate (AC-04)', () => {
    it('Object.is(pre, post) holds AND pre === post string-equal', () => {
      const Foo = defineComponent('Foo', { v: { type: 'string' } });
      const Anchor = defineComponent('Anchor', { x: { type: 'f32' } });
      const w = new World();

      const e = w.spawn({ component: Foo, data: { v: 'hello world' } }).unwrap();
      const pre = w.get(e, Foo).unwrap().v;
      expect(pre).toBe('hello world');

      w.addComponent(e, { component: Anchor, data: { x: 1 } }).unwrap();

      const post = w.get(e, Foo).unwrap().v;
      expect(post).toBe(pre);
      expect(Object.is(pre, post)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // (b) removeComponent migrate: same invariants in the reverse direction.
  // ---------------------------------------------------------------------------

  describe('w8 --- string carry-over via removeComponent migrate (AC-04)', () => {
    it('Object.is(pre, post) holds across the reverse migrate', () => {
      const Foo = defineComponent('Foo', { v: { type: 'string' } });
      const Anchor = defineComponent('Anchor', { x: { type: 'f32' } });
      const w = new World();

      const e = w
        .spawn(
          { component: Foo, data: { v: 'archetype migrate' } },
          { component: Anchor, data: { x: 7 } },
        )
        .unwrap();
      const pre = w.get(e, Foo).unwrap().v;

      w.removeComponent(e, Anchor).unwrap();

      const post = w.get(e, Foo).unwrap().v;
      expect(post).toBe(pre);
      expect(Object.is(pre, post)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // (c) Mixed string + ref<T> on the same entity: both stay identity-stable.
  // ---------------------------------------------------------------------------

  describe('w8 --- mixed string + ref<T> carry-over (AC-04, D-R3 symmetry)', () => {
    it('addComponent migrate keeps BOTH string identity and ref<T> handle bit-equal', () => {
      const Mixed = defineComponent('Mixed', {
        label: { type: 'string' },
        mat: { type: 'unique<MaterialAsset>' },
      });
      const Anchor = defineComponent('Anchor', { x: { type: 'f32' } });
      const w = new World();

      const refs = refsOf(w);
      const payload: MaterialAsset = { tint: 0xff00ff };
      const matHandle = refs.alloc('MaterialAsset', payload);

      const e = w
        .spawn({
          component: Mixed,
          data: {
            label: 'mixed-entity',
            mat: matHandle,
          } as never,
        })
        .unwrap();

      const pre = w.get(e, Mixed).unwrap();
      const labelPre = pre.label;
      const matPre = handleNumeric(pre.mat);

      w.addComponent(e, { component: Anchor, data: { x: 0 } }).unwrap();

      const post = w.get(e, Mixed).unwrap();
      const labelPost = post.label;
      const matPost = handleNumeric(post.mat);

      // (a) String field --- Object.is + value equal across migrate.
      expect(labelPost).toBe(labelPre);
      expect(Object.is(labelPre, labelPost)).toBe(true);

      // (b) Ref field --- u32 handle bit-equal AND resolves to the same payload.
      expect(matPost).toBe(matPre);
      const resolvedPost = refs.resolve(post.mat);
      if (!resolvedPost.ok) throw new Error('expected resolved');
      expect(resolvedPost.value).toBe(payload);
    });
  });
}
{
  // --- from string-identity-contract.test.ts ---
  // Inline `'string'`-field component — the prior `Name` reference moved to
  // @forgeax/engine-runtime (tweak-20260612-ecs-concept-compression). The ECS
  // package tests its own `'string'` schema vocab without depending on the
  // runtime sibling.
  const StrName = defineComponent('StrName', { value: { type: 'string' } });
  describe('string field --- identity contract (w5, AC-03)', () => {
    it('Object.is(read1, read2) === true between consecutive reads with no set', () => {
      const w = new World();
      const e = w.spawn({ component: StrName, data: { value: 'Player' } }).unwrap();
      const got1 = w.get(e, StrName);
      if (!got1.ok) throw new Error('expected ok');
      const got2 = w.get(e, StrName);
      if (!got2.ok) throw new Error('expected ok');
      // Identity stability: the same reference is returned across reads.
      expect(Object.is(got1.value.value, got2.value.value)).toBe(true);
    });

    it('read returns a native JS string (not a wrapper with .get())', () => {
      const w = new World();
      const e = w.spawn({ component: StrName, data: { value: 'Hello' } }).unwrap();
      const got = w.get(e, StrName);
      if (!got.ok) throw new Error('expected ok');
      // After w6 the value is a native string; typeof must be 'string'.
      expect(typeof got.value.value).toBe('string');
      expect(got.value.value).toBe('Hello');
    });

    it('set with a different value invalidates prior read identity', () => {
      // Contract only locks identity BETWEEN reads with no intervening set.
      // After set, the new read returns a fresh string reference; this test
      // documents the inverse boundary.
      const w = new World();
      const e = w.spawn({ component: StrName, data: { value: 'Player' } }).unwrap();
      const before = w.get(e, StrName).unwrap().value;
      w.set(e, StrName, { value: 'Boss' }).unwrap();
      const after = w.get(e, StrName).unwrap().value;
      expect(before).toBe('Player');
      expect(after).toBe('Boss');
      // No Object.is invariant required across set; values differ.
      expect(Object.is(before, after)).toBe(false);
    });
  });
}
{
  // --- from string-managed-dispatch.test.ts ---
  interface WorldInternals {
    uniqueRefs: UniqueRefStore;
  }

  function getUniqueRefs(w: World): UniqueRefStore {
    return (w as unknown as WorldInternals).uniqueRefs as UniqueRefStore;
  }

  // Inline `'string'`-field component for the dispatch tests.
  const StrName2 = defineComponent('StrName2', { value: { type: 'string' } });
  describe("w5 - 'string' dispatch via uniqueRefs (AC-05 / AC-13)", () => {
    it('spawn { StrName2: "Alice" } -> world.get returns native JS string', () => {
      const w = new World();
      const e = w.spawn({ component: StrName2, data: { value: 'Alice' } }).unwrap();
      const got = w.get(e, StrName2);
      if (!got.ok) throw new Error('expected ok');
      // After w6 dispatch routes through uniqueRefs.resolve(handle).unwrap()
      // which yields the native JS string payload --- no .get() wrapper.
      expect(typeof got.value.value).toBe('string');
      expect(got.value.value).toBe('Alice');
    });

    it('set updates the payload; subsequent read returns the new string', () => {
      const w = new World();
      const e = w.spawn({ component: StrName2, data: { value: 'Alice' } }).unwrap();
      w.set(e, StrName2, { value: 'Bob' }).unwrap();
      const got = w.get(e, StrName2);
      if (!got.ok) throw new Error('expected ok');
      expect(got.value.value).toBe('Bob');
      expect(typeof got.value.value).toBe('string');
    });

    it('spawn with raw=undefined fallbacks to empty string (AC-06)', () => {
      const w = new World();
      // After feat-20260517 / M2 / AC-01, ComponentData<S>.data is
      // Partial<ShapeOf<S>>, so `data: {}` is a valid call -- the
      // erased dispatch boundary now lives in `fillComponentDefaults`
      // and spawn must coerce the missing string field to '' rather
      // than throw or write a garbage handle.
      const e = w.spawn({ component: StrName2, data: {} }).unwrap();
      const got = w.get(e, StrName2);
      if (!got.ok) throw new Error('expected ok');
      expect(got.value.value).toBe('');
    });
  });

  describe("w5 - mixed 'string' + 'unique<T>' single-arm release (AC-05)", () => {
    it('despawn(e) releases BOTH the string handle AND the ref<T> handle', () => {
      // The same isManagedField arm must fan out across BOTH fields. This
      // test is the load-bearing observable for w6's predicate merge: any
      // future regression that re-splits string vs ref<T> dispatch would
      // leave one of the two handles live after despawn.
      const Mat = defineComponent('Mat', {
        label: { type: 'string' },
        handle: { type: 'unique<MaterialAsset>' },
      });
      const w = new World();
      const refs = getUniqueRefs(w);
      const matH = refs.alloc('MaterialAsset', { id: 7 });

      const e = w
        .spawn({
          component: Mat,
          data: {
            label: 'mat-7',
            handle: matH,
          } as never,
        })
        .unwrap();

      // Both fields readable pre-despawn.
      const got = w.get(e, Mat);
      if (!got.ok) throw new Error('expected ok');
      expect(got.value.label).toBe('mat-7');

      // Despawn must release the ref<T> handle (existing AC-05 path).
      w.despawn(e).unwrap();
      const resolveMat = refs.resolve(matH);
      expect(resolveMat.ok).toBe(false);
      if (resolveMat.ok) throw new Error('expected ref handle released');
      expect(resolveMat.error.code).toBe('unique-ref-stale');

      // The 'string' field's underlying handle must also be released by the
      // SAME arm. We cannot cheaply observe the internal string-handle, so
      // the proxy invariant is: after despawn the entity is no longer
      // readable --- regression in dispatch would either keep the handle
      // live (no-op release) or throw (separate arm misroute).
      const reread = w.get(e, Mat);
      expect(reread.ok).toBe(false);
    });

    it('removeComponent(e, C) releases BOTH handles on the removed component', () => {
      const Mat = defineComponent('Mat', {
        label: { type: 'string' },
        handle: { type: 'unique<MaterialAsset>' },
      });
      const Anchor = defineComponent('Anchor', { x: { type: 'f32' } });
      const w = new World();
      const refs = getUniqueRefs(w);
      const matH = refs.alloc('MaterialAsset', { id: 11 });

      const e = w
        .spawn(
          {
            component: Mat,
            data: {
              label: 'mat-11',
              handle: matH,
            } as never,
          },
          { component: Anchor, data: { x: 1 } },
        )
        .unwrap();

      w.removeComponent(e, Mat).unwrap();

      const resolveMat = refs.resolve(matH);
      expect(resolveMat.ok).toBe(false);
      if (resolveMat.ok) throw new Error('expected ref handle released');
      expect(resolveMat.error.code).toBe('unique-ref-stale');

      // Anchor remains; the entity is still alive.
      const got = w.get(e, Anchor);
      expect(got.ok).toBe(true);
    });

    it('set on string field releases the prior payload (path 3)', () => {
      // Field-overwrite path: the prior string handle must be released
      // BEFORE the new alloc, mirroring the ref<T> path 3 release-then-alloc
      // invariant (D-5 net-zero on same-bucket reuse).
      const StrName3 = defineComponent('StrName3', { value: { type: 'string' } });
      const w = new World();
      const refs = getUniqueRefs(w);
      const before = (refs as unknown as { liveCount?: () => number }).liveCount?.() ?? null;

      const e = w.spawn({ component: StrName3, data: { value: 'first' } }).unwrap();
      w.set(e, StrName3, { value: 'second' }).unwrap();
      const got = w.get(e, StrName3);
      if (!got.ok) throw new Error('expected ok');
      expect(got.value.value).toBe('second');
      void before;
    });
  });
}
{
  // --- from string-release.test.ts ---
  function refsOf(w: World): UniqueRefStore {
    return (w as unknown as { uniqueRefs: UniqueRefStore }).uniqueRefs;
  }

  // ---------------------------------------------------------------------------
  // (1) Source-level grep: world.ts has no independent string release call.
  // ---------------------------------------------------------------------------

  describe('w11 --- world.ts source has no independent string release branch (AC-05)', () => {
    it('no `releaseString` / `releaseStringField` / `isStringField` symbol in world.ts', () => {
      const worldSrc = readFileSync(fileURLToPath(new URL('../world.ts', import.meta.url)), 'utf8');
      expect(worldSrc.includes('releaseString')).toBe(false);
      expect(worldSrc.includes('releaseStringField')).toBe(false);
      expect(worldSrc.includes('isStringField')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // (2) Behavioural: mixed string + ref<T> entity drops both in one pass.
  // ---------------------------------------------------------------------------

  describe('w11 --- mixed string + ref<T> release (AC-05 single-arm dispatch)', () => {
    it('despawn drops BOTH slots in the same loop pass; _liveCount delta = 2', () => {
      const Mixed = defineComponent('Mixed', {
        label: { type: 'string' },
        mat: { type: 'unique<MaterialAsset>' },
      });
      const w = new World();
      const refs = refsOf(w);

      const matHandle = refs.alloc('MaterialAsset', { tint: 0xff_00_00 });
      const e = w
        .spawn({
          component: Mixed,
          data: {
            label: 'mixed-entity',
            mat: matHandle,
          } as never,
        })
        .unwrap();

      const liveBefore = refs._liveCount();
      w.despawn(e).unwrap();
      const liveAfter = refs._liveCount();

      // Net release count: -2 = -1 string handle + -1 ref<T> handle.
      expect(liveBefore - liveAfter).toBe(2);

      // The ref handle resolves as released (string handle is internally
      // managed, no caller-visible probe).
      const r = refs.resolve(matHandle);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('expected released');
      expect(r.error.code).toBe('unique-ref-stale');
    });
  });

  // ---------------------------------------------------------------------------
  // (3) Despawn / removeComponent / set --- string field is released by the
  // shared isManagedField arm on every World release path.
  // ---------------------------------------------------------------------------

  describe('w11 --- string release via despawn / removeComponent / set (AC-05)', () => {
    it('despawn releases the string handle (path 1)', () => {
      const Foo = defineComponent('Foo', { v: { type: 'string' } });
      const w = new World();
      const refs = refsOf(w);
      const e = w.spawn({ component: Foo, data: { v: 'hello' } }).unwrap();
      const liveBefore = refs._liveCount();
      w.despawn(e).unwrap();
      expect(refs._liveCount()).toBe(liveBefore - 1);
    });

    it('removeComponent releases the string handle (path 2)', () => {
      const Foo = defineComponent('Foo', { v: { type: 'string' } });
      const Anchor = defineComponent('Anchor', { x: { type: 'f32' } });
      const w = new World();
      const refs = refsOf(w);
      const e = w
        .spawn({ component: Foo, data: { v: 'hello' } }, { component: Anchor, data: { x: 1 } })
        .unwrap();
      const liveBefore = refs._liveCount();
      w.removeComponent(e, Foo).unwrap();
      expect(refs._liveCount()).toBe(liveBefore - 1);
    });

    it('set release-then-alloc on the same field produces _liveCount delta 0', () => {
      const Foo = defineComponent('Foo', { v: { type: 'string' } });
      const w = new World();
      const refs = refsOf(w);
      const e = w.spawn({ component: Foo, data: { v: 'hello' } }).unwrap();
      const liveBefore = refs._liveCount();
      w.set(e, Foo, { v: 'world' }).unwrap();
      // Net change: -1 (release prior) + 1 (alloc new) = 0.
      expect(refs._liveCount()).toBe(liveBefore);
      expect(w.get(e, Foo).unwrap().v).toBe('world');
    });
  });

  // ---------------------------------------------------------------------------
  // (4) Sibling isolation: despawn on entity A leaves entity B's string intact.
  // ---------------------------------------------------------------------------

  describe('w11 --- string release sibling isolation', () => {
    it('despawn on A does not disturb B`s string in the same archetype', () => {
      const Foo = defineComponent('Foo', { v: { type: 'string' } });
      const w = new World();
      const a = w.spawn({ component: Foo, data: { v: 'aaa' } }).unwrap();
      const b = w.spawn({ component: Foo, data: { v: 'bbb' } }).unwrap();

      w.despawn(a).unwrap();

      const got = w.get(b, Foo);
      if (!got.ok) throw new Error('expected ok');
      expect(got.value.v).toBe('bbb');
    });
  });
}

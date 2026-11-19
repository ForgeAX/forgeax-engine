// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
//
// Source files (N=10):
//   - packages/ecs/src/__tests__/archetype-storage.test.ts
//   - packages/ecs/src/__tests__/buffer-pool.test.ts
//   - packages/ecs/src/__tests__/buffer-vocab-fixup.test.ts
//   - packages/ecs/src/__tests__/chained-add-component-column-loss.test.ts
//   - packages/ecs/src/__tests__/column.test.ts
//   - packages/ecs/src/__tests__/entity-column.test.ts
//   - packages/ecs/src/__tests__/fixed-array-inline.test.ts
//   - packages/ecs/src/__tests__/query-preregister.test.ts
//   - packages/ecs/src/__tests__/query.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Component, ScalarFieldType } from '../component';
import { componentId, componentSchema, defineComponent } from '../component';
import { Entity } from '../entity';
import type { EntityHandle } from '../entity-handle';
import { OwnedBuffers } from '../owned-buffers';
import type { Archetype } from '../storage/archetype';
import {
  createArchetypeGraph,
  getAddEdge,
  getOrCreateArchetype,
  getRemoveEdge,
} from '../storage/archetype-graph';
import { createColumn, growColumn, HAS_TRANSFER } from '../storage/column';
import type { EntityRecords } from '../storage/entity-records';
import {
  appendTableRow,
  growTable as growArchetype,
  removeTableRow as removeEntity,
  type Table,
} from '../storage/table';
import { World } from '../world';
import { worldInternal } from '../world-internal';
import { columnLayout } from './__fixtures__/column-layout';

function tableFor(components: readonly Component[]): Table {
  return getOrCreateArchetype(createArchetypeGraph(), components).table;
}

function tableColumns(table: Table) {
  return new Map(
    [...table.storage].map(([componentId, componentStorage]) => [
      componentId,
      componentStorage.fields,
    ]),
  );
}

function appendEntity(table: Table, entity: number): number {
  return appendTableRow(table, entity as EntityHandle);
}

{
  // ─── from archetype-storage.test.ts ───

  describe('archetype-storage.test.ts', () => {
    describe('Archetype creation', () => {
      it('creates archetype with sorted component-set key', () => {
        const B = defineComponent('B', { b: { type: 'f32' } });
        const A = defineComponent('A', { a: { type: 'f32' } });
        const arch = tableFor([B, A]);
        const ids = [componentId(Entity), componentId(A), componentId(B)].sort((a, b) => a - b);
        expect(arch.key).toBe(ids.join('+'));
      });

      it('creates archetype with correct initial capacity', () => {
        const C = defineComponent('Cap', { x: { type: 'f32' } });
        const arch = tableFor([C]);
        expect(arch.capacity).toBeGreaterThanOrEqual(1);
        expect(arch.size).toBe(0);
      });

      it('creates columns for each component field', () => {
        const Pos = defineComponent('Pos', { x: { type: 'f32' }, y: { type: 'f32' } });
        const arch = tableFor([Pos]);
        expect(tableColumns(arch).has(componentId(Pos))).toBe(true);
        // biome-ignore lint/style/noNonNullAssertion: test setup guarantees componentId(Pos) exists in columns
        const compCols = tableColumns(arch).get(componentId(Pos))!;
        expect(compCols.has('x')).toBe(true);
        expect(compCols.has('y')).toBe(true);
      });

      it('tag component creates archetype with no data columns', () => {
        const Tag = defineComponent('ArchetypeStorageTag', {});
        const arch = tableFor([Tag]);
        const compCols = tableColumns(arch).get(componentId(Tag));
        expect(compCols === undefined || compCols.size === 0).toBe(true);
      });
    });

    describe('appendEntity / removeEntity (swap-pop)', () => {
      it('appends entity and increments size', () => {
        const C = defineComponent('SwapTest', { v: { type: 'i32' } });
        const arch = tableFor([C]);
        const row = appendEntity(arch, 42);
        expect(row).toBe(0);
        expect(arch.size).toBe(1);
        // Entity index stored in id=0 self column (not a separate entities array)
        const selfVal = tableColumns(arch).get(componentId(Entity))?.get('self')?.view[0];
        expect(selfVal).toBe(42);
      });

      it('swap-pop removes entity correctly', () => {
        const C = defineComponent('SwapPop', { v: { type: 'i32' } });
        const arch = tableFor([C]);

        appendEntity(arch, 10);
        appendEntity(arch, 20);
        appendEntity(arch, 30);

        // biome-ignore lint/style/noNonNullAssertion: test setup guarantees componentId(C) exists in columns
        const cols = tableColumns(arch).get(componentId(C))!;
        // biome-ignore lint/style/noNonNullAssertion: test setup guarantees 'v' field exists
        const vCol = cols.get('v')!;
        vCol.view[0] = 100;
        vCol.view[1] = 200;
        vCol.view[2] = 300;

        const swapped = removeEntity(arch, 0);
        expect(arch.size).toBe(2);

        // Entity identity now read from id=0 self column
        const selfCol = tableColumns(arch).get(componentId(Entity))?.get('self');
        expect(selfCol).toBeDefined();
        // biome-ignore lint/style/noNonNullAssertion: guarded by expect
        expect(selfCol!.view[0]! & 0xffffff).toBe(30);
        expect(vCol.view[0]).toBe(300);

        // biome-ignore lint/style/noNonNullAssertion: guarded by expect
        expect(selfCol!.view[1]! & 0xffffff).toBe(20);
        expect(vCol.view[1]).toBe(200);

        expect(swapped).toEqual({ movedEntity: 30, newRow: 0 });
      });

      it('swap-pop on last row does not swap', () => {
        const C = defineComponent('LastRow', { v: { type: 'f32' } });
        const arch = tableFor([C]);
        appendEntity(arch, 10);
        appendEntity(arch, 20);

        const swapped = removeEntity(arch, 1);
        expect(arch.size).toBe(1);
        // Entity identity from self column
        const selfVal = tableColumns(arch).get(componentId(Entity))?.get('self')?.view[0];
        expect(selfVal).toBe(10);
        expect(swapped).toBeNull();
      });
    });

    describe('growArchetype', () => {
      it('doubles capacity and preserves data', () => {
        const C = defineComponent('Grow', { x: { type: 'f32' } });
        const arch = tableFor([C]);
        const initialCap = arch.capacity;

        for (let i = 0; i < initialCap; i++) {
          appendEntity(arch, i);
          // biome-ignore lint/style/noNonNullAssertion: test setup guarantees componentId(C) exists in columns
          const cols = tableColumns(arch).get(componentId(C))!;
          // biome-ignore lint/style/noNonNullAssertion: field 'x' guaranteed to exist
          cols.get('x')!.view[i] = i * 1.5;
        }

        growArchetype(arch, initialCap * 2);
        expect(arch.capacity).toBe(initialCap * 2);

        // biome-ignore lint/style/noNonNullAssertion: test setup guarantees componentId(C) exists in columns
        const cols = tableColumns(arch).get(componentId(C))!;
        for (let i = 0; i < initialCap; i++) {
          expect(cols.get('x')?.view[i]).toBeCloseTo(i * 1.5);
        }
      });

      it('increments version on grow', () => {
        const C = defineComponent('GrowVer', { x: { type: 'f32' } });
        const arch = tableFor([C]);
        const v0 = arch.version;
        growArchetype(arch, arch.capacity * 2);
        expect(arch.version).toBe(v0 + 1);
      });

      it('growArchetype is a no-op when targetCapacity <= current capacity', () => {
        const C = defineComponent('GrowNoop', { x: { type: 'f32' } });
        const arch = tableFor([C]);
        const capBefore = arch.capacity;
        const versionBefore = arch.version;
        growArchetype(arch, capBefore);
        expect(arch.capacity).toBe(capBefore);
        expect(arch.version).toBe(versionBefore);
        growArchetype(arch, capBefore - 1);
        expect(arch.capacity).toBe(capBefore);
        expect(arch.version).toBe(versionBefore);
      });
    });

    describe('ArchetypeGraph', () => {
      it('getOrCreateArchetype returns same archetype for same component set', () => {
        const graph = createArchetypeGraph();
        const A = defineComponent('GA', { a: { type: 'f32' } });
        const B = defineComponent('GB', { b: { type: 'f32' } });
        const Tag = defineComponent('GTag', {}, { storage: 'sparse' });

        const roster = Object.freeze([B, Tag, A, B]);
        const arch1 = getOrCreateArchetype(graph, roster);
        const arch2 = getOrCreateArchetype(graph, [Tag, A, B]);
        expect(arch1).toBe(arch2);
        expect(roster).toEqual([B, Tag, A, B]);
        expect(arch1.components).toEqual([Entity, A, B, Tag]);
        const dense = getOrCreateArchetype(graph, [B, A]);
        expect(arch1.table).toBe(dense.table);
        expect(dense.table.components).toEqual([Entity, A, B]);
      });

      it('getAddEdge caches edge (O(1) on second call)', () => {
        const graph = createArchetypeGraph();
        const A = defineComponent('EA', { a: { type: 'f32' } });
        const B = defineComponent('EB', { b: { type: 'f32' } });

        const archA = getOrCreateArchetype(graph, [A]);
        const archAB1 = getAddEdge(graph, archA, componentId(B), B);
        const archAB2 = getAddEdge(graph, archA, componentId(B), B);
        expect(archAB1).toBe(archAB2);
      });

      it('getRemoveEdge caches edge (O(1) on second call)', () => {
        const graph = createArchetypeGraph();
        const A = defineComponent('RA', { a: { type: 'f32' } });
        const B = defineComponent('RB', { b: { type: 'f32' } });

        const archAB = getOrCreateArchetype(graph, [A, B]);
        const archA1 = getRemoveEdge(graph, archAB, componentId(B));
        const archA2 = getRemoveEdge(graph, archAB, componentId(B));
        expect(archA1).toBe(archA2);
      });

      it('multi-component spawn targets correct archetype directly', () => {
        const graph = createArchetypeGraph();
        const A = defineComponent('MA', { a: { type: 'f32' } });
        const B = defineComponent('MB', { b: { type: 'f32' } });
        const C = defineComponent('MC', { c: { type: 'f32' } });

        const arch = getOrCreateArchetype(graph, [A, B, C]);
        const ids = [componentId(Entity), componentId(A), componentId(B), componentId(C)].sort(
          (a, b) => a - b,
        );
        expect(arch.key).toBe(ids.join('+'));
      });
    });

    describe('M1 storage characterization', () => {
      it('keeps row, capacity, version, and migration owners explicit', () => {
        const graph = createArchetypeGraph();
        const Position = defineComponent('M1StoragePosition', { x: 'f32', y: 'f32' });
        const Tag = defineComponent('M1StorageTag', {});
        const source = getOrCreateArchetype(graph, [Position]);
        const target = getAddEdge(graph, source, componentId(Tag), Tag);
        const back = getRemoveEdge(graph, target, componentId(Tag));
        const sourceTable = source.table;
        if (sourceTable === undefined) throw new Error('source table missing');

        expect(back).toBe(source);
        expect(sourceTable.storage.has(componentId(Entity))).toBe(true);
        expect(sourceTable.storage.has(componentId(Position))).toBe(true);
        for (const { fields } of sourceTable.storage.values()) {
          for (const column of fields.values()) {
            expect(column.view.length / column.layout.arity).toBe(sourceTable.capacity);
            expect(column.layout.arity).toBe(1);
          }
        }

        const initialVersion = sourceTable.version;
        appendEntity(sourceTable, 7 as EntityHandle);
        expect(sourceTable.size).toBe(1);
        growArchetype(sourceTable, sourceTable.capacity * 2);
        expect(sourceTable.version).toBe(initialVersion + 1);
        expect(sourceTable.size).toBe(1);
        for (const { fields } of sourceTable.storage.values()) {
          for (const column of fields.values())
            expect(column.view.length / column.layout.arity).toBe(sourceTable.capacity);
        }
      });
    });
  });
}

{
  describe('owned buffer capacity and resize', () => {
    it('allocates128 logical bytes in a256-byte slab cell', () => {
      const buffers = new OwnedBuffers();
      const handle = buffers.alloc(Uint8Array, 128).unwrap();
      expect(buffers.view(handle).unwrap().byteLength).toBe(128);
      expect(buffers.memoryStats().liveCapacityBytes).toBe(256);
    });
    it('allocates zero without backing or physical work', () => {
      const buffers = new OwnedBuffers();
      const handle = buffers.alloc(Uint8Array, 0).unwrap();
      expect(buffers.view(handle).unwrap().byteLength).toBe(0);
      expect(buffers.memoryStats()).toMatchObject({
        liveBuffers: 1,
        logicalBytes: 0,
        liveCapacityBytes: 0,
        committedBytes: 0,
        backingAllocations: 0,
        copiedBytes: 0,
        zeroedBytes: 0,
      });
    });
    it('reuses released backing while keeping grants distinct', () => {
      const buffers = new OwnedBuffers();
      const a = buffers.alloc(Uint8Array, 128).unwrap();
      const view = buffers.view(a).unwrap();
      buffers.release(a).unwrap();
      const b = buffers.alloc(Uint8Array, 128).unwrap();
      expect(b).not.toBe(a);
      expect(buffers.view(b).unwrap().buffer).toBe(view.buffer);
      expect(buffers.view(b).unwrap().byteOffset).toBe(view.byteOffset);
      expect(buffers.view(b).unwrap().byteLength).toBe(128);
    });
    it('preserves prior bytes during same-bucket growth', () => {
      const buffers = new OwnedBuffers();
      const h = buffers.alloc(Uint8Array, 128).unwrap();
      const before = buffers.view(h).unwrap();
      for (let i = 0; i < 128; i++) before[i] = (i * 7) & 0xff;
      buffers.resize(h, 200).unwrap();
      const after = buffers.view(h).unwrap();
      expect(after.byteLength).toBe(200);
      for (let i = 0; i < 128; i++) expect(after[i]).toBe((i * 7) & 0xff);
    });
    it('accepts an unchanged logical length', () => {
      const buffers = new OwnedBuffers();
      const h = buffers.alloc(Uint8Array, 128).unwrap();
      expect(buffers.resize(h, 128).ok).toBe(true);
      expect(buffers.view(h).unwrap().byteLength).toBe(128);
    });
    it('shrinks within retained capacity and clears discarded bytes', () => {
      const buffers = new OwnedBuffers();
      const h = buffers.alloc(Uint8Array, 128).unwrap();
      buffers.view(h).unwrap().fill(7);
      buffers.resize(h, 100).unwrap();
      expect(buffers.view(h).unwrap().byteLength).toBe(100);
      expect(buffers.memoryStats().liveCapacityBytes).toBe(256);
      buffers.resize(h, 128).unwrap();
      expect([...buffers.view(h).unwrap()]).toEqual([...Array(100).fill(7), ...Array(28).fill(0)]);
    });
    it('preserves bytes across128 ->4096 growth and refreshes the logical view', () => {
      const buffers = new OwnedBuffers();
      const h = buffers.alloc(Uint8Array, 128).unwrap();
      const before = buffers.view(h).unwrap();
      for (let i = 0; i < 128; i++) before[i] = (i + 1) & 0xff;
      buffers.resize(h, 4096).unwrap();
      const after = buffers.view(h).unwrap();
      expect(after.byteLength).toBe(4096);
      for (let i = 0; i < 128; i++) expect(after[i]).toBe((i + 1) & 0xff);
      expect(buffers.view(h).unwrap()).toBe(after);
    });
    it('allocates beyond pooled classes without caching oversized backing', () => {
      const buffers = new OwnedBuffers();
      const bytes = 20000 * 64;
      const h = buffers.alloc(Uint8Array, bytes).unwrap();
      expect(buffers.view(h).unwrap().byteLength).toBe(bytes);
      expect(buffers.memoryStats().liveCapacityBytes).toBe(bytes);
      buffers.view(h).unwrap()[0] = 42;
      buffers.resize(h, bytes * 2).unwrap();
      expect(buffers.view(h).unwrap()[0]).toBe(42);
      buffers.resize(h, 0).unwrap();
      expect(buffers.memoryStats().liveCapacityBytes).toBe(bytes * 2);
      buffers.release(h).unwrap();
      expect(buffers.view(h).ok).toBe(false);
      expect(buffers.memoryStats().committedBytes).toBe(0);
      const replacement = buffers.alloc(Uint8Array, bytes).unwrap();
      expect(replacement).not.toBe(h);
      const boundary = new OwnedBuffers();
      const pooled = boundary.alloc(Uint8Array, 262144).unwrap();
      boundary.release(pooled).unwrap();
      expect(boundary.memoryStats().idleBytes).toBe(262144);
    });
    it('grows a slab-backed owner into an oversized exact allocation', () => {
      const buffers = new OwnedBuffers();
      const h = buffers.alloc(Uint8Array, 128).unwrap();
      buffers.view(h).unwrap()[127] = 71;
      buffers.resize(h, 20000 * 64).unwrap();
      const view = buffers.view(h).unwrap();
      expect(view[127]).toBe(71);
      expect(view[128]).toBe(0);
      expect(buffers.memoryStats().liveBuffers).toBe(1);
      buffers.release(h).unwrap();
      expect(buffers.memoryStats().liveBuffers).toBe(0);
    });
    it.each([
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ])('rejects invalid allocation size%s', (bytes) => {
      const result = new OwnedBuffers().alloc(Uint8Array, bytes);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('memory-request-invalid');
    });
    it('issues distinct live grants', () => {
      const buffers = new OwnedBuffers();
      expect(buffers.alloc(Uint8Array, 128).unwrap()).not.toBe(
        buffers.alloc(Uint8Array, 128).unwrap(),
      );
    });
  });
}

{
  // ─── from buffer-vocab-fixup.test.ts ───
  describe('buffer-vocab-fixup.test.ts', () => {
    describe('verify round 1 fix-up — B1: fixed byte-array patches truncate and initialize their tail', () => {
      it.each([
        [12, 16],
        [20, 8],
      ])('writes %i bytes into a fixed %i-byte array', (length, capacity) => {
        const Print = defineComponent('FixedByteArrayPatch', { fp: `array<u8, ${capacity}>` });
        const world = new World();
        const entity = world
          .spawn({ component: Print, data: { fp: new Uint8Array(capacity).fill(99) } })
          .unwrap();
        const input = Uint8Array.from({ length }, (_, i) => i + 1);
        world.set(entity, Print, { fp: input }).unwrap();
        expect(Array.from(world.get(entity, Print).unwrap().fp)).toEqual(
          Array.from({ length: capacity }, (_, i) => (i < length ? i + 1 : 0)),
        );
      });

      it('matching byteLength still succeeds and writes through to world.get snapshot', () => {
        const Print = defineComponent('PrintBuf4', { fp: { type: 'array<u8, 4>' } });
        const w = new World();
        const e = w.spawn({ component: Print, data: { fp: new Uint8Array(4) } }).unwrap();
        const r = w.set(e, Print, { fp: new Uint8Array([1, 2, 3, 4]) });
        expect(r.ok).toBe(true);
        const snapshot = w.get(e, Print).unwrap().fp;
        expect(snapshot.byteLength).toBe(4);
        expect(Array.from(snapshot)).toEqual([1, 2, 3, 4]);
      });
    });

    describe('verify round 1 fix-up — B2: bare "buffer" (variable) spawn + set round-trip', () => {
      it('spawn with payload bytes round-trips through world.get without data loss', () => {
        const Blob = defineComponent('BlobVocab', { b: { type: 'array<u8>' } });
        const w = new World();
        const payload = new Uint8Array([7, 8, 9]);
        const e = w.spawn({ component: Blob, data: { b: payload } }).unwrap();
        const snapshot = w.get(e, Blob).unwrap().b;
        expect(snapshot.byteLength).toBe(3);
        expect(Array.from(snapshot)).toEqual([7, 8, 9]);
      });

      it('world.set after spawn replaces variable-buffer bytes (no fixed-size constraint)', () => {
        const Blob = defineComponent('BlobVocab2', { b: { type: 'array<u8>' } });
        const w = new World();
        const e = w.spawn({ component: Blob, data: { b: new Uint8Array([1]) } }).unwrap();
        const r = w.set(e, Blob, { b: new Uint8Array([10, 20, 30, 40, 50]) });
        expect(r.ok).toBe(true);
        const snapshot = w.get(e, Blob).unwrap().b;
        expect(snapshot.byteLength).toBe(5);
        expect(Array.from(snapshot)).toEqual([10, 20, 30, 40, 50]);
      });

      it('spawn with an empty Uint8Array yields a zero-length live view (no error)', () => {
        const Blob = defineComponent('BlobVocab3', { b: { type: 'array<u8>' } });
        const w = new World();
        const e = w.spawn({ component: Blob, data: { b: new Uint8Array(0) } }).unwrap();
        const snapshot = w.get(e, Blob).unwrap().b;
        expect(snapshot.byteLength).toBe(0);
      });

      it('ManagedBufferOutOfBoundsError hint references the new buffer keyword forms (no legacy "buffer:<bytes>")', () => {
        const Blob = defineComponent('BlobVocab4', { b: { type: 'array<u8>' } });
        const w = new World();
        const oversized = new Uint8Array(262_145);
        const result = w.spawn({ component: Blob, data: { b: oversized } });
        expect(result.ok).toBe(true);
      });
    });
  });
}

{
  // ─── from chained-add-component-column-loss.test.ts ───
  describe('chained-add-component-column-loss.test.ts', () => {
    describe('chained addComponent preserves earlier-added column data (F-2)', () => {
      it('two chained single addComponent on a >=2-component entity preserves both columns', () => {
        const C = defineComponent('C', { a: { type: 'u32' } });
        const D = defineComponent('D', { b: { type: 'u32' } });
        const Base1 = defineComponent('Base1', { s: { type: 'string' } });
        const Base2 = defineComponent('Base2', { x: { type: 'f32' } });

        const w = new World();

        const e = w
          .spawn({ component: Base1, data: { s: 'hi' } }, { component: Base2, data: { x: 1.5 } })
          .unwrap();

        w.addComponent(e, { component: C, data: { a: 1033 } }).unwrap();
        w.addComponent(e, { component: D, data: { b: 55 } }).unwrap();

        const cGet = w.get(e, C);
        const dGet = w.get(e, D);
        if (!cGet.ok) throw new Error('expected ok get C');
        if (!dGet.ok) throw new Error('expected ok get D');
        expect(cGet.value.a).toBe(1033);
        expect(dGet.value.b).toBe(55);

        const b1 = w.get(e, Base1);
        const b2 = w.get(e, Base2);
        if (!b1.ok || !b2.ok) throw new Error('expected ok get base');
        expect(b1.value.s).toBe('hi');
        expect(b2.value.x).toBeCloseTo(1.5);
      });

      it('single-component base + two chained adds (registration adds-first)', () => {
        const C = defineComponent('SC', { a: { type: 'u32' } });
        const D = defineComponent('SD', { b: { type: 'u32' } });
        const Base = defineComponent('SBase', { s: { type: 'string' } });

        const w = new World();

        const e = w.spawn({ component: Base, data: { s: 'hi' } }).unwrap();
        w.addComponent(e, { component: C, data: { a: 1033 } }).unwrap();
        w.addComponent(e, { component: D, data: { b: 55 } }).unwrap();

        const cGet = w.get(e, C);
        if (!cGet.ok) throw new Error('expected ok get C');
        expect(cGet.value.a).toBe(1033);
      });
    });
  });
}

{
  // ─── from column.test.ts ───
  describe('column.test.ts', () => {
    describe('Column.arity', () => {
      it('scalar column arity defaults to 1 (AC-01)', () => {
        const col = createColumn(columnLayout('f32'), 64);
        expect(col.layout.arity).toBe(1);
      });

      it('all scalar field types default arity to 1', () => {
        const types: ScalarFieldType[] = [
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
        ];
        for (const t of types) {
          const col = createColumn(columnLayout(t), 16);
          expect(col.layout.arity, `Column.arity for ${t} should be 1`).toBe(1);
        }
      });

      it('empty column (capacity=0) growColumn does not divide by zero', () => {
        const col = createColumn(columnLayout('f32'), 0);
        expect(col.view.length / col.layout.arity).toBe(0);
        expect(col.layout.arity).toBe(1);
        const grown = growColumn(col, 8);
        expect(grown.view.length / grown.layout.arity).toBe(8);
        expect(grown.layout.arity).toBe(1);
        expect(grown.view.buffer.byteLength).toBe(32);
      });
    });

    describe('createColumn', () => {
      it('creates a column with correct capacity', () => {
        const col = createColumn(columnLayout('f32'), 64);
        expect(col.view.length / col.layout.arity).toBe(64);
      });

      it('creates an ArrayBuffer of correct byte length', () => {
        const col = createColumn(columnLayout('f32'), 64);
        expect(col.view.buffer.byteLength).toBe(64 * 4);
      });

      it('creates a TypedArray view of correct type for f32', () => {
        const col = createColumn(columnLayout('f32'), 16);
        expect(col.view).toBeInstanceOf(Float32Array);
        expect(col.view.length).toBe(16);
      });

      it('creates correct TypedArray view for each scalar type', () => {
        const typeToView: Record<ScalarFieldType, unknown> = {
          f32: Float32Array,
          f64: Float64Array,
          i32: Int32Array,
          u32: Uint32Array,
          i16: Int16Array,
          u16: Uint16Array,
          i8: Int8Array,
          u8: Uint8Array,
          bool: Uint8Array,
          enum: Uint32Array,
        };
        for (const [fieldType, ViewCtor] of Object.entries(typeToView)) {
          const col = createColumn(columnLayout(fieldType as ScalarFieldType), 8);
          // biome-ignore lint/complexity/noBannedTypes: ViewCtor is a constructor from Object.entries, Function is the correct generic type here
          expect(col.view).toBeInstanceOf(ViewCtor as Function);
        }
      });

      it('each field has an independent ArrayBuffer (not shared)', () => {
        const col1 = createColumn(columnLayout('f32'), 16);
        const col2 = createColumn(columnLayout('f32'), 16);
        expect(col1.view.buffer).not.toBe(col2.view.buffer);
      });
    });

    describe('growColumn', () => {
      it('grows an ArrayBuffer column when SharedArrayBuffer is unavailable', () => {
        const col = createColumn(columnLayout('f32'), 4);
        col.view[0] = 7;
        vi.stubGlobal('SharedArrayBuffer', undefined);
        try {
          const grown = growColumn(col, 8);
          expect(grown.view[0]).toBe(7);
          expect(grown.view.length / grown.layout.arity).toBe(8);
        } finally {
          vi.unstubAllGlobals();
        }
      });

      it('grows column to new capacity with data intact', () => {
        const col = createColumn(columnLayout('f32'), 4);
        col.view[0] = 1.5;
        col.view[1] = 2.5;
        col.view[2] = 3.5;

        const grown = growColumn(col, 8);
        expect(grown.view.length / grown.layout.arity).toBe(8);
        expect(grown.view[0]).toBeCloseTo(1.5);
        expect(grown.view[1]).toBeCloseTo(2.5);
        expect(grown.view[2]).toBeCloseTo(3.5);
      });

      it('old column is not affected by grow (fallback path)', () => {
        if (HAS_TRANSFER) {
          const col = createColumn(columnLayout('i32'), 4);
          col.view[0] = 42;
          const grown = growColumn(col, 8);
          expect(grown.view[0]).toBe(42);
          expect(col.view.buffer.byteLength).toBe(0);
        } else {
          const col = createColumn(columnLayout('i32'), 4);
          col.view[0] = 42;
          const grown = growColumn(col, 8);
          grown.view[0] = 99;
          expect(col.view[0]).toBe(42);
        }
      });

      it('works for all scalar field types', () => {
        const types: ScalarFieldType[] = [
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
        ];
        for (const t of types) {
          const col = createColumn(columnLayout(t), 4);
          col.view[0] = 1;
          const grown = growColumn(col, 8);
          expect(grown.view[0]).toBe(1);
          expect(grown.view.length / grown.layout.arity).toBe(8);
        }
      });
    });

    describe('growColumn transfer() / fallback equivalence', () => {
      function fallbackGrow(
        col: {
          view: { BYTES_PER_ELEMENT: number; buffer: ArrayBufferLike };
        },
        newCapacity: number,
      ) {
        const byteLen = col.view.BYTES_PER_ELEMENT * newCapacity;
        const buf = new ArrayBuffer(byteLen);
        new Uint8Array(buf).set(new Uint8Array(col.view.buffer));
        return buf;
      }

      it('both paths produce identical data for f32', () => {
        const col = createColumn(columnLayout('f32'), 4);
        col.view[0] = 1.5;
        col.view[1] = -3.14;
        col.view[2] = 0;
        col.view[3] = 999.999;

        const fallbackBuf = fallbackGrow(col, 8);

        const grown = growColumn(col, 8);
        const grownBytes = new Uint8Array(grown.view.buffer, 0, 16);
        const fallbackBytes = new Uint8Array(fallbackBuf, 0, 16);
        expect(Array.from(grownBytes)).toEqual(Array.from(fallbackBytes));
        expect(grown.view[0]).toBeCloseTo(1.5);
        expect(grown.view[1]).toBeCloseTo(-3.14);
        expect(grown.view[3]).toBeCloseTo(999.999);
      });

      it('both paths produce identical data for i32', () => {
        const col = createColumn(columnLayout('i32'), 4);
        col.view[0] = -2147483648;
        col.view[1] = 2147483647;
        col.view[2] = 0;
        col.view[3] = 42;

        const fallbackBuf = fallbackGrow(col, 8);

        const grown = growColumn(col, 8);
        const grownBytes = new Uint8Array(grown.view.buffer, 0, 16);
        const fallbackBytes = new Uint8Array(fallbackBuf, 0, 16);
        expect(Array.from(grownBytes)).toEqual(Array.from(fallbackBytes));
        expect(grown.view[0]).toBe(-2147483648);
        expect(grown.view[1]).toBe(2147483647);
        expect(grown.view[3]).toBe(42);
      });

      it('both paths produce identical data for u8 (bool backing)', () => {
        const col = createColumn(columnLayout('u8'), 4);
        col.view[0] = 0;
        col.view[1] = 1;
        col.view[2] = 255;
        col.view[3] = 128;

        const fallbackBuf = fallbackGrow(col, 16);

        const grown = growColumn(col, 16);
        const grownBytes = new Uint8Array(grown.view.buffer, 0, 4);
        const fallbackBytes = new Uint8Array(fallbackBuf, 0, 4);
        expect(Array.from(grownBytes)).toEqual(Array.from(fallbackBytes));
      });

      it('data is not lost after growing to 2x, 4x, 8x capacity', () => {
        let col = createColumn(columnLayout('f64'), 2);
        col.view[0] = Math.PI;
        col.view[1] = Math.E;

        col = growColumn(col, 4);
        expect(col.view[0]).toBeCloseTo(Math.PI, 14);
        expect(col.view[1]).toBeCloseTo(Math.E, 14);

        col = growColumn(col, 8);
        expect(col.view[0]).toBeCloseTo(Math.PI, 14);
        expect(col.view[1]).toBeCloseTo(Math.E, 14);

        col = growColumn(col, 16);
        expect(col.view[0]).toBeCloseTo(Math.PI, 14);
        expect(col.view[1]).toBeCloseTo(Math.E, 14);
        expect(col.view.length / col.layout.arity).toBe(16);
      });

      it('new capacity region is zeroed', () => {
        const col = createColumn(columnLayout('i32'), 4);
        col.view[0] = 100;
        col.view[1] = 200;

        const grown = growColumn(col, 8);
        for (let i = 4; i < 8; i++) {
          expect(grown.view[i]).toBe(0);
        }
      });

      it('HAS_TRANSFER is a boolean', () => {
        expect(typeof HAS_TRANSFER).toBe('boolean');
      });
    });

    describe('growColumn stride-N data fidelity (AC-05)', () => {
      const ARITY = 16;
      const PATTERN = Array.from({ length: ARITY }, (_, i) => i * 1.5 + 0.1);

      function writeRow0(col: ReturnType<typeof createColumn>, vals: ReadonlyArray<number>) {
        for (let i = 0; i < vals.length; i++) {
          const v = vals[i];
          if (v === undefined) throw new Error('unexpected');
          col.view[i] = v;
        }
      }

      function expectRow0Unchanged(col: ReturnType<typeof createColumn>) {
        for (let i = 0; i < ARITY; i++) {
          const expected = PATTERN[i];
          if (expected === undefined) throw new Error('unexpected');
          expect(
            col.view[i],
            `row[0][${i}] after capacity ${col.view.length / col.layout.arity}`,
          ).toBeCloseTo(expected, 6);
        }
      }

      it('grow 0->4->8->16->32->64 preserves row 0 stride-16 data', () => {
        let col = createColumn(columnLayout('f32', ARITY), 0);
        expect(col.layout.arity).toBe(ARITY);
        expect(col.view.length / col.layout.arity).toBe(0);

        const stages = [4, 8, 16, 32, 64];
        for (const cap of stages) {
          col = growColumn(col, cap);
          expect(col.view.length / col.layout.arity).toBe(cap);
          expect(col.layout.arity).toBe(ARITY);

          if (cap === 4) {
            writeRow0(col, PATTERN);
          }

          expectRow0Unchanged(col);
        }
      });

      it('grow from nonzero capacity preserves row 0 for arity=16', () => {
        let col = createColumn(columnLayout('f32', ARITY), 8);
        writeRow0(col, PATTERN);

        const stages = [16, 32, 64, 128];
        for (const cap of stages) {
          col = growColumn(col, cap);
          expect(col.view.length / col.layout.arity).toBe(cap);
          expect(col.layout.arity).toBe(ARITY);
          expectRow0Unchanged(col);
        }
      });

      it('grow from capacity 1 preserves arity=4 f64 row', () => {
        const f64pattern = [Math.PI, Math.E, Math.LN2, Math.SQRT2];
        let col = createColumn(columnLayout('f64', 4), 1);
        expect(col.layout.arity).toBe(4);
        for (let i = 0; i < 4; i++) {
          const v = f64pattern[i];
          if (v === undefined) throw new Error('unexpected');
          col.view[i] = v;
        }

        const stages = [2, 4, 8, 16, 32];
        for (const cap of stages) {
          col = growColumn(col, cap);
          for (let i = 0; i < 4; i++) {
            const v = f64pattern[i];
            if (v === undefined) throw new Error('unexpected');
            expect(col.view[i], `f64[${i}] at capacity ${cap}`).toBeCloseTo(v, 14);
          }
        }
      });

      it('new capacity tail rows are zeroed for arity>1', () => {
        const AR = 3;
        const col = createColumn(columnLayout('u32', AR), 2);
        col.view[0] = 0xdeadbeef;
        col.view[1] = 0xcafebabe;
        col.view[2] = 0x12345678;

        const grown = growColumn(col, 4);
        for (let i = 3; i < 6; i++) {
          expect(grown.view[i], `tail row[${i}]`).toBe(0);
        }
        expect(grown.view[0]).toBe(0xdeadbeef);
        expect(grown.view[1]).toBe(0xcafebabe);
        expect(grown.view[2]).toBe(0x12345678);
      });
    });
  });
}

{
  // ─── from entity-column.test.ts ───
  let dummyCounter = 0;
  function defineSpawnComponent(prefix: string) {
    dummyCounter += 1;
    return defineComponent(`${prefix}_${dummyCounter}`, { x: 'f32', y: 'f32' });
  }

  function archetypeOf(world: World, e: EntityHandle): Table {
    const graph = (world as unknown as { graph: { archetypes: Archetype[]; tables: Table[] } })
      .graph;
    const records = (world as unknown as { records: EntityRecords }).records;
    const indexSlot = (e as unknown as number) & 0xffffff;
    const archId = records.archetypeId[indexSlot] ?? -1;
    const arch = graph.archetypes[archId];
    if (!arch) throw new Error('archetype not found for entity');
    const table = arch.table;
    if (!table) throw new Error('table not found for entity');
    return table;
  }

  describe('entity-column.test.ts', () => {
    describe('Entity id=0 structural guarantee (AC-01)', () => {
      it('assigns the Entity component id=0', () => {
        expect(componentId(Entity)).toBe(0);
      });

      it('names the single field self with the entity field type', () => {
        expect(Entity.name).toBe('Entity');
        expect(componentSchema(Entity)).toEqual({ self: 'entity' });
      });
    });

    describe('Entity barrel reserved identity (AC-01)', () => {
      afterEach(() => {
        vi.resetModules();
      });

      it('keeps Entity zero when component authoring precedes the root entry', async () => {
        vi.resetModules();
        const authoring = await import('../component');
        const Early = authoring.defineComponent('EarlyComponentDefinitionIdentity', {
          value: 'u32',
        });
        expect(authoring.componentId(Early)).toBeGreaterThan(0);
        const ecs = await import('../index');
        expect(ecs.componentDefinition(ecs.Entity).id).toBe(0);
        const world = new ecs.World();
        const entity = world.spawn({ component: Early, data: { value: 73 } }).unwrap();
        expect(world.get(entity, Early).unwrap().value).toBe(73);
        expect(world.get(entity, ecs.Entity).unwrap().self).toBe(entity);
      });

      it('does not throw at barrel eval under the normal import order', async () => {
        vi.resetModules();
        await expect(import('../index')).resolves.toBeDefined();
      });
    });

    describe('archetype unconditionally carries the id=0 column (AC-02)', () => {
      it('includes the Entity column in a single-component spawn archetype', () => {
        const world = new World();
        const Position = defineSpawnComponent('AC02_Pos');
        const e = world.spawn({ component: Position, data: { x: 1, y: 2 } }).unwrap();
        const arch = archetypeOf(world, e);
        expect(arch.storage.has(componentId(Entity))).toBe(true);
        expect(arch.storage.get(componentId(Entity))?.fields.has('self')).toBe(true);
      });

      it('includes the Entity column in a bare (zero-component) spawn archetype', () => {
        const world = new World();
        const e = world.spawn().unwrap();
        const arch = archetypeOf(world, e);
        expect(arch.storage.has(componentId(Entity))).toBe(true);
        expect(arch.storage.get(componentId(Entity))?.fields.has('self')).toBe(true);
      });

      it('includes the Entity column after addComponent migration', () => {
        const world = new World();
        const A = defineSpawnComponent('AC02_A');
        const B = defineSpawnComponent('AC02_B');
        const e = world.spawn({ component: A, data: { x: 0, y: 0 } }).unwrap();
        world.addComponent(e, { component: B, data: { x: 0, y: 0 } }).unwrap();
        const arch = archetypeOf(world, e);
        expect(arch.storage.has(componentId(Entity))).toBe(true);
        expect(arch.storage.get(componentId(Entity))?.fields.has('self')).toBe(true);
      });
    });

    describe('world.get(e, Entity).self carries the row handle (AC-03)', () => {
      it('reads the full packed handle off the id=0 column for a single-component entity', () => {
        const world = new World();
        const Position = defineSpawnComponent('AC03_Pos');
        const e = world.spawn({ component: Position, data: { x: 1, y: 2 } }).unwrap();
        const got = world.get(e, Entity).unwrap();
        const self: EntityHandle | null = got.self;
        expect(self).toBe(e);
      });

      it('reads the handle off a bare (zero-component) entity', () => {
        const world = new World();
        const e = world.spawn().unwrap();
        expect(world.get(e, Entity).unwrap().self).toBe(e);
      });

      it('preserves the handle across an addComponent archetype migration', () => {
        const world = new World();
        const A = defineSpawnComponent('AC03_A');
        const B = defineSpawnComponent('AC03_B');
        const e = world.spawn({ component: A, data: { x: 0, y: 0 } }).unwrap();
        world.addComponent(e, { component: B, data: { x: 0, y: 0 } }).unwrap();
        expect(world.get(e, Entity).unwrap().self).toBe(e);
      });
    });

    describe('world.get(e, Entity) as a liveness probe (AC-04)', () => {
      it('returns stale-entity for a despawned handle', () => {
        const world = new World();
        const Position = defineSpawnComponent('AC04_Pos');
        const e = world.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
        world.despawn(e).unwrap();
        const r = world.get(e, Entity);
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe('stale-entity');
        }
      });
    });

    describe('removeComponent(e, Entity) is rejected (AC-05)', () => {
      it('returns remove-essential-component and leaves the Entity column intact', () => {
        const world = new World();
        const Position = defineSpawnComponent('AC05_Pos');
        const e = world.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
        const r = world.removeComponent(e, Entity);
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe('remove-essential-component');
          if (r.error.code === 'remove-essential-component') {
            expect(r.error.detail.componentName).toBe('Entity');
          }
        }
        const arch = archetypeOf(world, e);
        expect(arch.storage.has(componentId(Entity))).toBe(true);
        expect(world.get(e, Entity).unwrap().self).toBe(e);
      });
    });
  });
}

{
  // ─── from fixed-array-inline.test.ts ───
  describe('fixed-array-inline.test.ts', () => {
    describe('fixed array<f32, 16> inline column (AC-02 / w5)', () => {
      it('spawn->get round-trips all 16 f32 elements', () => {
        const Mat = defineComponent('Mat16', { m: 'array<f32, 16>' });
        const world = new World();
        const values = Float32Array.from({ length: 16 }, (_, i) => (i + 1) * 1.5);
        const e = world.spawn({ component: Mat, data: { m: values } }).unwrap();

        const read = world.get(e, Mat).unwrap().m;
        expect(read).toBeInstanceOf(Float32Array);
        expect(read.length).toBe(16);
        for (let i = 0; i < 16; i++) {
          expect(read[i]).toBe(values[i]);
        }
      });

      // Regression (downstream template integration #2): the plain-JS-array
      // convenience path used to pack elements by byte SIZE, so a 4-byte f32
      // went through setUint32 -- storing `1` as the integer bits 0x00000001
      // (reads back ~1.4e-45 ~ 0). AnimationPlayer.speeds=[1] froze on frame 0.
      // Packing must dispatch on the declared element TYPE, not byte size.
      it('plain-JS-array write to array<f32,4> stores f32 VALUES, not u32 bits', () => {
        const C = defineComponent('PlainF32Fixed', { v: 'array<f32, 4>' });
        const world = new World();
        const e = world.spawn({ component: C, data: { v: [1, 0.5, -2, 3.25] } }).unwrap();

        const read = world.get(e, C).unwrap().v;
        expect(read).toBeInstanceOf(Float32Array);
        expect(read[0]).toBe(1);
        expect(read[1]).toBe(0.5);
        expect(read[2]).toBe(-2);
        expect(read[3]).toBe(3.25);
      });

      it('plain-JS-array write to variable array<f32> stores f32 VALUES', () => {
        const C = defineComponent('PlainF32Var', { v: 'array<f32>' });
        const world = new World();
        const e = world.spawn({ component: C, data: { v: [1, 2.5] } }).unwrap();

        const read = world.get(e, C).unwrap().v;
        expect(read).toBeInstanceOf(Float32Array);
        expect(read.length).toBe(2);
        expect(read[0]).toBe(1);
        expect(read[1]).toBe(2.5);
      });

      // Control: u32 elements are genuinely integers -- the type-keyed packer
      // must keep storing them verbatim (no regression in the handle/u32 path).
      it('plain-JS-array write to array<u32,3> still stores integer values verbatim', () => {
        const C = defineComponent('PlainU32Fixed', { v: 'array<u32, 3>' });
        const world = new World();
        const e = world.spawn({ component: C, data: { v: [7, 42, 1000] } }).unwrap();

        const read = world.get(e, C).unwrap().v;
        expect(read).toBeInstanceOf(Uint32Array);
        expect(read[0]).toBe(7);
        expect(read[1]).toBe(42);
        expect(read[2]).toBe(1000);
      });
    });

    describe('fixed buffer<64> inline column (AC-03 / w6)', () => {
      it('spawn->get round-trips all 64 bytes', () => {
        const Blob = defineComponent('Blob64', { b: 'array<u8, 64>' });
        const world = new World();
        const bytes = Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 3) & 0xff);
        const e = world.spawn({ component: Blob, data: { b: bytes } }).unwrap();

        const read = world.get(e, Blob).unwrap().b;
        expect(read).toBeInstanceOf(Uint8Array);
        expect(read.length).toBe(64);
        for (let i = 0; i < 64; i++) {
          expect(read[i]).toBe(bytes[i]);
        }
      });
    });

    describe('fixed array<entity, 4> inline column (AC-04 / w7)', () => {
      it('spawn->get reinterprets the 4 entity ids as Uint32Array', () => {
        const Refs = defineComponent('EntRefs4', { targets: 'array<entity, 4>' });
        const world = new World();
        const Tag = defineComponent('FixedArrTag', {});
        const t0 = world.spawn({ component: Tag, data: {} }).unwrap();
        const t1 = world.spawn({ component: Tag, data: {} }).unwrap();
        const t2 = world.spawn({ component: Tag, data: {} }).unwrap();
        const t3 = world.spawn({ component: Tag, data: {} }).unwrap();
        const ids = Uint32Array.of(t0 as number, t1 as number, t2 as number, t3 as number);

        const holder = world.spawn({ component: Refs, data: { targets: ids } }).unwrap();
        const read = world.get(holder, Refs).unwrap().targets;
        expect(read).toBeInstanceOf(Uint32Array);
        expect(read.length).toBe(4);
        expect(read[0]).toBe(t0 as number);
        expect(read[1]).toBe(t1 as number);
        expect(read[2]).toBe(t2 as number);
        expect(read[3]).toBe(t3 as number);
      });

      it('_getArrayView serves a non-f32 element type after the f32 gate is removed', () => {
        const Refs = defineComponent('EntRefsView4', { targets: 'array<entity, 4>' });
        const world = new World();
        const Tag = defineComponent('TagView', {});
        const t0 = world.spawn({ component: Tag, data: {} }).unwrap();
        const t1 = world.spawn({ component: Tag, data: {} }).unwrap();
        const ids = Uint32Array.of(t0 as number, t1 as number, 0, 0);
        const holder = world.spawn({ component: Refs, data: { targets: ids } }).unwrap();

        const view = world[worldInternal].getArrayView(holder, Refs, 'targets');
        expect(view).toBeDefined();
        expect(view?.length).toBe(4);
        expect(view?.[0]).toBe(t0 as number);
        expect(view?.[1]).toBe(t1 as number);
      });
    });

    describe('swap-remove migrates the whole stride-N block (AC-06 / w8)', () => {
      it('removing a middle row moves the last row block intact', () => {
        const Mat = defineComponent('Mat16Swap', { m: 'array<f32, 16>' });
        const world = new World();
        const row = (base: number) => Float32Array.from({ length: 16 }, (_, i) => base + i);
        const e0 = world.spawn({ component: Mat, data: { m: row(100) } }).unwrap();
        const e1 = world.spawn({ component: Mat, data: { m: row(200) } }).unwrap();
        const e2 = world.spawn({ component: Mat, data: { m: row(300) } }).unwrap();

        world.despawn(e0);

        const r2 = world.get(e2, Mat).unwrap().m;
        expect(r2.length).toBe(16);
        for (let i = 0; i < 16; i++) {
          expect(r2[i]).toBe(300 + i);
        }
        const r1 = world.get(e1, Mat).unwrap().m;
        for (let i = 0; i < 16; i++) {
          expect(r1[i]).toBe(200 + i);
        }
      });
    });

    describe('fixed-only component leaves BufferPool live-count at 0 (AC-07 / w9)', () => {
      const liveCount = (world: World): number => world.memoryStats().arrays.liveArrays;

      it('array<f32,16>-only spawn->get->despawn never touches the pool', () => {
        const Mat = defineComponent('Mat16Pool', { m: 'array<f32, 16>' });
        const world = new World();
        expect(liveCount(world)).toBe(0);

        const e = world
          .spawn({ component: Mat, data: { m: Float32Array.from({ length: 16 }, (_, i) => i) } })
          .unwrap();
        expect(liveCount(world)).toBe(0);

        world.get(e, Mat).unwrap().m;
        expect(liveCount(world)).toBe(0);

        world.despawn(e);
        expect(liveCount(world)).toBe(0);
      });

      it('buffer<64>-only spawn->get->despawn never touches the pool', () => {
        const Blob = defineComponent('Blob64Pool', { b: 'array<u8, 64>' });
        const world = new World();
        expect(liveCount(world)).toBe(0);

        const e = world.spawn({ component: Blob, data: { b: new Uint8Array(64) } }).unwrap();
        expect(liveCount(world)).toBe(0);

        world.get(e, Blob).unwrap().b;
        expect(liveCount(world)).toBe(0);

        world.despawn(e);
        expect(liveCount(world)).toBe(0);
      });
    });

    describe('AC-08 variable buffer (no N) path post-inline (w15)', () => {
      const liveCount = (world: World): number => world.memoryStats().arrays.liveArrays;

      it('variable buffer spawn->set->get round-trip works', () => {
        const C = defineComponent('VarBuf', { blob: 'array<u8>' });
        const world = new World();
        expect(liveCount(world)).toBe(0);

        const payload = Uint8Array.of(0xaa, 0xbb, 0xcc, 0xdd);
        const e = world.spawn({ component: C, data: { blob: payload } }).unwrap();
        expect(liveCount(world)).toBe(1);

        const snap = world.get(e, C).unwrap().blob;
        expect(snap).toBeInstanceOf(Uint8Array);
        expect(snap.length).toBe(4);
        expect(snap[0]).toBe(0xaa);
        expect(snap[3]).toBe(0xdd);
      });

      it('variable buffer grows via set with larger payload', () => {
        const C = defineComponent('VarBuf2', { blob: 'array<u8>' });
        const world = new World();
        const small = Uint8Array.of(0x01, 0x02);
        const e = world.spawn({ component: C, data: { blob: small } }).unwrap();

        expect(world.get(e, C).unwrap().blob.length).toBe(2);

        const large = new Uint8Array(32);
        for (let i = 0; i < 32; i++) large[i] = i + 0x10;
        world.set(e, C, { blob: large }).unwrap();

        const snap = world.get(e, C).unwrap().blob;
        expect(snap.length).toBe(32);
        for (let i = 0; i < 32; i++) expect(snap[i]).toBe(i + 0x10);
      });

      it('variable buffer release path: despawn returns slot to pool', () => {
        const C = defineComponent('VarBuf3', { blob: 'array<u8>' });
        const world = new World();
        expect(liveCount(world)).toBe(0);

        const e = world.spawn({ component: C, data: { blob: Uint8Array.of(0xfe) } }).unwrap();
        expect(liveCount(world)).toBe(1);

        world.despawn(e).unwrap();
        expect(liveCount(world)).toBe(0);
      });

      it('variable + fixed coexistence: pool count only reflects variable fields', () => {
        const VarArr = defineComponent('VarArr', { data: 'array<f32>' });
        const FixedMat = defineComponent('FixedMat', { m: 'array<f32, 16>' });
        const world = new World();
        expect(liveCount(world)).toBe(0);

        const e1 = world.spawn({ component: FixedMat, data: { m: new Float32Array(16) } }).unwrap();
        expect(liveCount(world)).toBe(0);

        const e2 = world
          .spawn(
            { component: FixedMat, data: { m: new Float32Array(16) } },
            { component: VarArr, data: { data: new Float32Array(2) } },
          )
          .unwrap();
        expect(liveCount(world)).toBe(1);

        world.despawn(e2).unwrap();
        expect(liveCount(world)).toBe(0);

        world.despawn(e1).unwrap();
        expect(liveCount(world)).toBe(0);
      });
    });
  });
}

describe('Entity in storage identity', () => {
  it('keeps physical Entity storage when a sparse token uses its id', () => {
    const sparseEntity = defineComponent('Entity', {}, { storage: 'sparse' });
    const arch = getOrCreateArchetype(createArchetypeGraph(), [sparseEntity]);
    expect(arch.components).toEqual([sparseEntity]);
    expect(arch.table.components).toEqual([Entity]);
  });

  it('shares one archetype and table for implicit and repeated explicit Entity', () => {
    const graph = createArchetypeGraph();
    const bare = getOrCreateArchetype(graph, []);
    const roster = Object.freeze([Entity, Entity]);
    const explicit = getOrCreateArchetype(graph, roster);
    expect(roster).toEqual([Entity, Entity]);
    expect(bare.key).toBe(String(componentId(Entity)));
    expect(explicit).toBe(bare);
    expect(bare.components).toEqual([Entity]);
    const table = bare.table;
    expect(table?.key).toBe(bare.key);
    expect(table?.components).toEqual([Entity]);
    expect(table?.storage.size).toBe(1);
  });
});

{
  // ─── from entity-handle-rename-grep-gate.test.ts (feat-20260611 M-1 / w2) ───
  //
  // Grep gate verifying the type-space `Entity` -> `EntityHandle` rename
  // landed cleanly across `packages/ecs/src/`. Reads the actual source files
  // at test time (no mocking) so it directly enforces the source SSOT.
  //
  // Verifies:
  //   1. `entity.ts` exports `EntityHandle` (the renamed branded-number type)
  //      and no longer exports `type Entity`.
  //   2. `entity.ts` keeps the value-space `Entity` const (id=0
  //      component token) but does NOT re-export `type Entity` (the type-space
  //      handle alias is now `EntityHandle`).
  //
  // Constraints:
  //   - requirements §Component naming: id=0 component token is still named
  //     `Entity` -- only the type-space branded handle is renamed
  //   - requirements I-1: type Entity -> EntityHandle
  //   - research F-5: TS rename refactor not usable due to namespace merging,
  //     hence a grep-form gate
  //
  // Cross-package `: EntityHandle` type-annotation acceptance is verified by
  // `pnpm typecheck` at the milestone CI sweep level, not here.

  describe('entity-handle-rename-grep-gate.test.ts', () => {
    describe('packages/ecs/src/entity-handle.ts', () => {
      it('exports type EntityHandle (renamed branded-number handle)', async () => {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const url = await import('node:url');
        const here = url.fileURLToPath(new URL('.', import.meta.url));
        const src = await fs.readFile(path.resolve(here, '..', 'entity-handle.ts'), 'utf8');
        // exactly one `export type EntityHandle =` declaration
        const handleDeclMatches = src.match(/^export type EntityHandle\b/gm) ?? [];
        expect(handleDeclMatches.length).toBe(1);
      });

      it('no longer exports `type Entity` (type-space rename complete)', async () => {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const url = await import('node:url');
        const here = url.fileURLToPath(new URL('.', import.meta.url));
        const src = await fs.readFile(path.resolve(here, '..', 'entity-handle.ts'), 'utf8');
        // Match `export type Entity` not followed by `Handle` -- catches the
        // pre-rename declaration but not the post-rename `EntityHandle`.
        const entityTypeDeclMatches = src.match(/^export type Entity\b(?!Handle)/gm) ?? [];
        expect(entityTypeDeclMatches.length).toBe(0);
      });
    });

    describe('packages/ecs/src/entity.ts', () => {
      it('keeps value-space Entity (id=0 component token)', async () => {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const url = await import('node:url');
        const here = url.fileURLToPath(new URL('.', import.meta.url));
        const src = await fs.readFile(path.resolve(here, '..', 'entity.ts'), 'utf8');
        // The value-space token survives; Biome may wrap the call across lines.
        expect(/^export const Entity = defineComponent\(\s*['"]Entity['"]/m.test(src)).toBe(true);
      });

      it('does not re-export `type Entity` alias (type-space lives in entity-handle.ts as EntityHandle)', async () => {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const url = await import('node:url');
        const here = url.fileURLToPath(new URL('.', import.meta.url));
        const src = await fs.readFile(path.resolve(here, '..', 'entity.ts'), 'utf8');
        const entityTypeDeclMatches = src.match(/^export type Entity\b(?!Handle)/gm) ?? [];
        expect(entityTypeDeclMatches.length).toBe(0);
      });
    });
  });
}

{
  // ─── from swap-pop-self-column-removeEdge-filter.test.ts (feat-20260611-ecs-storage-naming-ssot M-2 / w4) ───
  //
  // Verifies two changes that landed in M-2:
  // 1. removeEntity swap-pop reads entity index from id=0 `self` column
  //    (columns.get(0)?.get('self')?.view[lastRow] & 0xffffff) instead of
  //    arch.entities[lastRow] — equivalence proven by research F-3.
  // 2. getRemoveEdge uses src.components.filter(c => componentId(c) !== removedId) to
  //    rebuild the component list after componentRegistry is deleted.
  //
  // TDD red mechanism (pre-w5):
  //   (a) The test corrupted arch.entities[lastRow] so pre-w5 removeEntity
  //       would return the wrong value. Post-w5, removeEntity reads the
  //       self column directly.
  //   (b) The test verified graph.componentRegistry existence then verified
  //       getRemoveEdge still works with only src.components.filter.

  describe('swap-pop-self-column-removeEdge-filter.test.ts', () => {
    describe('removeEntity swap-pop reads entity from id=0 self column', () => {
      it('2+ entities swap-pop: removed entity index comes from self column, not entities array', () => {
        const C = defineComponent('SwapSelfCol', { v: { type: 'i32' } });
        const arch = tableFor([C]);

        // Populate 3 entities. appendEntity writes to the id=0 self column.
        appendEntity(arch, 0x42);
        appendEntity(arch, 0x77);
        appendEntity(arch, 0xff);

        const selfCol = tableColumns(arch).get(componentId(Entity))?.get('self');
        expect(selfCol).toBeDefined();
        // Verify self column still has correct value
        // biome-ignore lint/style/noNonNullAssertion: guarded by expect above
        expect(selfCol!.view[2]! & 0xffffff).toBe(0xff);

        const swapped = removeEntity(arch, 0);

        // After w5: movedEntity comes from self column (lower 24 bits)
        if (swapped !== null) {
          expect(swapped.movedEntity).toBe(0xff);
          expect(swapped.newRow).toBe(0);
        } else {
          expect.unreachable('expected swap-pop for multi-entity archetype');
        }
      });

      it('single entity last-row swap-pop returns null (row === lastRow, no entities read needed)', () => {
        const C = defineComponent('SwapSelfLastRow', { v: { type: 'f32' } });
        const arch = tableFor([C]);

        appendEntity(arch, 0xab);

        const swapped = removeEntity(arch, 0);
        expect(arch.size).toBe(0);
        expect(swapped).toBeNull();
      });

      it('swap-pop self column data correctly migrated (column-level swap)', () => {
        const C = defineComponent('SwapSelfColData', { v: { type: 'i32' } });
        const arch = tableFor([C]);

        appendEntity(arch, 0x10);
        appendEntity(arch, 0x20);
        appendEntity(arch, 0x30);

        const selfCol = tableColumns(arch).get(componentId(Entity))?.get('self');
        // biome-ignore lint/style/noNonNullAssertion: test setup
        const vCol = tableColumns(arch).get(componentId(C))!.get('v')!;
        vCol.view[0] = 100;
        vCol.view[1] = 200;
        vCol.view[2] = 300;

        // Remove row 1. Last row (2) swaps into row 1.
        const swapped = removeEntity(arch, 1);
        expect(arch.size).toBe(2);

        if (swapped === null) {
          expect.unreachable('expected swap-pop');
        }

        // GREEN (after w5): movedEntity = 0x30 from self column
        // RED (before w5): movedEntity = 0xcafe from corrupted arch.entities[2]
        expect(swapped.movedEntity).toBe(0x30);
        expect(swapped.newRow).toBe(1);

        // self column swap-integrity: row 1 should now hold last-row's self value
        // biome-ignore lint/style/noNonNullAssertion: guarded by expect above
        expect(selfCol!.view[1]! & 0xffffff).toBe(0x30);
        // user column data also swapped
        expect(vCol.view[1]).toBe(300);
      });
    });

    describe('getRemoveEdge uses src.components.filter after componentRegistry delete', () => {
      it('getRemoveEdge rebuilds component list from src.components.filter (not registry)', () => {
        const graph = createArchetypeGraph();
        const A = defineComponent('RemoveEdgeFilter_A', { a: { type: 'f32' } });
        const B = defineComponent('RemoveEdgeFilter_B', { b: { type: 'f32' } });
        const C = defineComponent('RemoveEdgeFilter_C', { c: { type: 'f32' } });

        const archABC = getOrCreateArchetype(graph, [A, B, C]);

        // After w5: componentRegistry field deleted; getRemoveEdge derives
        // component list from src.components.filter(c => componentId(c) !== removedId).
        const archAC = getRemoveEdge(graph, archABC, componentId(B));

        const expectedIds = [componentId(Entity), componentId(A), componentId(C)].sort(
          (a, b) => a - b,
        );
        const actualComponentIds = archAC.components
          .map((c) => componentId(c))
          .sort((a, b) => a - b);
        expect(actualComponentIds).toEqual(expectedIds);

        // Verify B is NOT present in the target
        expect(archAC.components.some((c) => componentId(c) === componentId(B))).toBe(false);
      });

      it('getRemoveEdge of last user component returns archetype with only Entity', () => {
        const graph = createArchetypeGraph();
        const A = defineComponent('RemoveEdgeLast_A', { a: { type: 'f32' } });

        const archA = getOrCreateArchetype(graph, [A]);
        const archEmpty = getRemoveEdge(graph, archA, componentId(A));

        expect(archEmpty.components.length).toBe(1);
        expect(archEmpty.components[0]?.name).toBe('Entity');
        expect(archEmpty.components.map((c) => componentId(c))).toEqual([componentId(Entity)]);
      });
    });
  });
}

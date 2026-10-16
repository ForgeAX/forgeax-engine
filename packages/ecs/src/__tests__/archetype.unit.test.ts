// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
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
import { BufferPool, SIZE_CLASSES } from '../buffer-pool';
import type { ScalarFieldType } from '../component';
import {
  componentId,
  componentSchema,
  defineComponent,
  fieldTypeToMetaKey,
  isEntityField,
  isManagedArrayField,
  isManagedBufferField,
  isManagedField,
  TYPE_METADATA,
} from '../component';
import { Entity } from '../entity';
import type { EntityHandle } from '../entity-handle';
import type { Archetype } from '../storage/archetype';
import {
  createArchetypeGraph,
  getAddEdge,
  getOrCreateArchetype,
  getRemoveEdge,
} from '../storage/archetype-graph';
import { createColumn, growColumn, HAS_TRANSFER } from '../storage/column';
import {
  appendTableRow,
  createTable as createArchetype,
  growTable as growArchetype,
  removeTableRow as removeEntity,
  type Table,
} from '../storage/table';
import { World } from '../world';

import { worldInternal } from '../world-internal';

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
  /** Auto-incrementing archetype ID for test isolation. */
  let testArchId = 0;

  describe('archetype-storage.test.ts', () => {
    describe('Archetype creation', () => {
      it('creates archetype with sorted component-set key', () => {
        const B = defineComponent('B', { b: { type: 'f32' } });
        const A = defineComponent('A', { a: { type: 'f32' } });
        const arch = createArchetype([B, A], testArchId++);
        const ids = [componentId(Entity), componentId(A), componentId(B)].sort((a, b) => a - b);
        expect(arch.key).toBe(ids.join('+'));
      });

      it('creates archetype with correct initial capacity', () => {
        const C = defineComponent('Cap', { x: { type: 'f32' } });
        const arch = createArchetype([C], testArchId++);
        expect(arch.capacity).toBeGreaterThanOrEqual(1);
        expect(arch.size).toBe(0);
      });

      it('creates columns for each component field', () => {
        const Pos = defineComponent('Pos', { x: { type: 'f32' }, y: { type: 'f32' } });
        const arch = createArchetype([Pos], testArchId++);
        expect(tableColumns(arch).has(componentId(Pos))).toBe(true);
        // biome-ignore lint/style/noNonNullAssertion: test setup guarantees componentId(Pos) exists in columns
        const compCols = tableColumns(arch).get(componentId(Pos))!;
        expect(compCols.has('x')).toBe(true);
        expect(compCols.has('y')).toBe(true);
      });

      it('tag component creates archetype with no data columns', () => {
        const Tag = defineComponent('ArchetypeStorageTag', {});
        const arch = createArchetype([Tag], testArchId++);
        const compCols = tableColumns(arch).get(componentId(Tag));
        expect(compCols === undefined || compCols.size === 0).toBe(true);
      });
    });

    describe('appendEntity / removeEntity (swap-pop)', () => {
      it('appends entity and increments size', () => {
        const C = defineComponent('SwapTest', { v: { type: 'i32' } });
        const arch = createArchetype([C], testArchId++);
        const row = appendEntity(arch, 42);
        expect(row).toBe(0);
        expect(arch.size).toBe(1);
        // Entity index stored in id=0 self column (not a separate entities array)
        const selfVal = tableColumns(arch).get(componentId(Entity))?.get('self')?.view[0];
        expect(selfVal).toBe(42);
      });

      it('swap-pop removes entity correctly', () => {
        const C = defineComponent('SwapPop', { v: { type: 'i32' } });
        const arch = createArchetype([C], testArchId++);

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
        const arch = createArchetype([C], testArchId++);
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
        const arch = createArchetype([C], testArchId++);
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
        const arch = createArchetype([C], testArchId++);
        const v0 = arch.version;
        growArchetype(arch, arch.capacity * 2);
        expect(arch.version).toBe(v0 + 1);
      });

      it('growArchetype is a no-op when targetCapacity <= current capacity', () => {
        const C = defineComponent('GrowNoop', { x: { type: 'f32' } });
        const arch = createArchetype([C], testArchId++);
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

        const arch1 = getOrCreateArchetype(graph, [componentId(A), componentId(B)], [A, B]);
        const arch2 = getOrCreateArchetype(graph, [componentId(B), componentId(A)], [B, A]);
        expect(arch1).toBe(arch2);
      });

      it('getAddEdge caches edge (O(1) on second call)', () => {
        const graph = createArchetypeGraph();
        const A = defineComponent('EA', { a: { type: 'f32' } });
        const B = defineComponent('EB', { b: { type: 'f32' } });

        const archA = getOrCreateArchetype(graph, [componentId(A)], [A]);
        const archAB1 = getAddEdge(graph, archA, componentId(B), B);
        const archAB2 = getAddEdge(graph, archA, componentId(B), B);
        expect(archAB1).toBe(archAB2);
      });

      it('getRemoveEdge caches edge (O(1) on second call)', () => {
        const graph = createArchetypeGraph();
        const A = defineComponent('RA', { a: { type: 'f32' } });
        const B = defineComponent('RB', { b: { type: 'f32' } });

        const archAB = getOrCreateArchetype(graph, [componentId(A), componentId(B)], [A, B]);
        const archA1 = getRemoveEdge(graph, archAB, componentId(B));
        const archA2 = getRemoveEdge(graph, archAB, componentId(B));
        expect(archA1).toBe(archA2);
      });

      it('multi-component spawn targets correct archetype directly', () => {
        const graph = createArchetypeGraph();
        const A = defineComponent('MA', { a: { type: 'f32' } });
        const B = defineComponent('MB', { b: { type: 'f32' } });
        const C = defineComponent('MC', { c: { type: 'f32' } });

        const arch = getOrCreateArchetype(
          graph,
          [componentId(A), componentId(B), componentId(C)],
          [A, B, C],
        );
        const ids = [componentId(Entity), componentId(A), componentId(B), componentId(C)].sort(
          (a, b) => a - b,
        );
        expect(arch.key).toBe(ids.join('+'));
      });

      it('increments global archetype generation on new archetype creation', () => {
        const graph = createArchetypeGraph();
        const gen0 = graph.generation;
        const X = defineComponent('GenX', { x: { type: 'f32' } });
        getOrCreateArchetype(graph, [componentId(X)], [X]);
        expect(graph.generation).toBe(gen0 + 1);

        getOrCreateArchetype(graph, [componentId(X)], [X]);
        expect(graph.generation).toBe(gen0 + 1);
      });
    });

    describe('M1 storage characterization', () => {
      it('keeps row, capacity, version, and migration owners explicit', () => {
        const graph = createArchetypeGraph();
        const Position = defineComponent('M1StoragePosition', { x: 'f32', y: 'f32' });
        const Tag = defineComponent('M1StorageTag', {});
        const source = getOrCreateArchetype(graph, [componentId(Position)], [Position]);
        const target = getAddEdge(graph, source, componentId(Tag), Tag);
        const back = getRemoveEdge(graph, target, componentId(Tag));
        const sourceTable = graph.tables[source.tableId];
        if (sourceTable === undefined) throw new Error('source table missing');

        expect(back).toBe(source);
        expect(sourceTable.storage.has(componentId(Entity))).toBe(true);
        expect(sourceTable.storage.has(componentId(Position))).toBe(true);
        for (const { fields } of sourceTable.storage.values()) {
          for (const column of fields.values()) {
            expect(column.capacity).toBe(sourceTable.capacity);
            expect(column.arity).toBe(1);
          }
        }

        const initialVersion = sourceTable.version;
        appendEntity(sourceTable, 7 as EntityHandle);
        expect(sourceTable.size).toBe(1);
        growArchetype(sourceTable, sourceTable.capacity * 2);
        expect(sourceTable.version).toBe(initialVersion + 1);
        expect(sourceTable.size).toBe(1);
        for (const { fields } of sourceTable.storage.values()) {
          for (const column of fields.values()) expect(column.capacity).toBe(sourceTable.capacity);
        }
      });
    });
  });
}

{
  // ─── from buffer-pool.test.ts ───
  describe('buffer-pool.test.ts', () => {
    describe('w10 - BufferPool size-class allocation', () => {
      it('alloc(128) returns a view of byteLength === 128 (bucket 256B)', () => {
        const pool = new BufferPool();
        const r = pool.alloc(128);
        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error('expected ok');
        expect(r.value.view.byteLength).toBe(128);
        expect(r.value.id).toBeGreaterThan(0);
      });

      it('alloc(0) is legal and returns a zero-length view (no bucket)', () => {
        const pool = new BufferPool();
        const r = pool.alloc(0);
        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error('expected ok');
        expect(r.value.view.byteLength).toBe(0);
      });

      it('release then alloc(128) reuses a slot from the free-list', () => {
        const pool = new BufferPool();
        const a = pool.alloc(128);
        if (!a.ok) throw new Error('expected ok a');
        const idA = a.value.id;
        const rel = pool.release(idA);
        expect(rel.ok).toBe(true);
        const b = pool.alloc(128);
        if (!b.ok) throw new Error('expected ok b');
        expect(b.value.id).toBe(idA);
        expect(b.value.view.byteLength).toBe(128);
      });
    });

    describe('w10 - BufferPool.grow (D-6 Result semantics, D-7 no-shrink)', () => {
      it('grow preserves prior content byte-equal across same-bucket growth', () => {
        const pool = new BufferPool();
        const a = pool.alloc(128);
        if (!a.ok) throw new Error('expected ok a');
        const view0 = a.value.view;
        for (let i = 0; i < 128; i++) view0[i] = (i * 7) & 0xff;
        const r = pool.grow(a.value.id, 200);
        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error('expected ok grow');
        const view1 = r.value;
        expect(view1.byteLength).toBe(200);
        for (let i = 0; i < 128; i++) expect(view1[i]).toBe((i * 7) & 0xff);
      });

      it('grow(view, byteLength === current) returns ok no-op view', () => {
        const pool = new BufferPool();
        const a = pool.alloc(128);
        if (!a.ok) throw new Error('expected ok a');
        const r = pool.grow(a.value.id, 128);
        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error('expected ok grow');
        expect(r.value.byteLength).toBe(128);
      });

      it('grow(view, smaller) returns err(managed-buffer-shrink-not-supported)', () => {
        const pool = new BufferPool();
        const a = pool.alloc(128);
        if (!a.ok) throw new Error('expected ok a');
        const r = pool.grow(a.value.id, 100);
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected err grow');
        expect(r.error.code).toBe('managed-buffer-shrink-not-supported');
        if (r.error.code !== 'managed-buffer-shrink-not-supported') throw new Error('narrow');
        expect(r.error.detail.requested).toBe(100);
        expect(r.error.detail.current).toBe(128);
      });

      it('cross-bucket grow (128 -> 4096) preserves prior content byte-equal', () => {
        const pool = new BufferPool();
        const a = pool.alloc(128);
        if (!a.ok) throw new Error('expected ok a');
        const view0 = a.value.view;
        for (let i = 0; i < 128; i++) view0[i] = (i + 1) & 0xff;
        const r = pool.grow(a.value.id, 4096);
        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error('expected ok grow');
        const view1 = r.value;
        expect(view1.byteLength).toBe(4096);
        for (let i = 0; i < 128; i++) expect(view1[i]).toBe((i + 1) & 0xff);
        const refreshed = pool.view(a.value.id);
        expect(refreshed.byteLength).toBe(4096);
      });

      it('allocates beyond the pooled classes without retaining a large free bucket', () => {
        const pool = new BufferPool();
        const bytes = 20_000 * 64;
        const large = pool.alloc(bytes).unwrap();
        expect(large.view.byteLength).toBe(bytes);
        expect(pool.byteCapacity(large.id)).toBe(bytes);
        large.view[0] = 42;
        pool.grow(large.id, bytes * 2).unwrap();
        expect(pool.view(large.id)[0]).toBe(42);
        pool.setLogicalLength(large.id, 0).unwrap();
        expect(pool.byteCapacity(large.id)).toBe(bytes * 2);
        pool.release(large.id).unwrap();
        expect(pool.byteCapacity(large.id)).toBe(0);
        expect(pool.view(large.id)).toHaveLength(0);
        expect(pool.alloc(bytes).unwrap().id).not.toBe(large.id);
        expect(SIZE_CLASSES.at(-1)).toBe(262_144);
      });

      it('grows from a small pooled field into a dedicated large field', () => {
        const pool = new BufferPool();
        const small = pool.alloc(128).unwrap();
        small.view[127] = 71;
        const grown = pool.grow(small.id, 20_000 * 64).unwrap();
        expect(grown[127]).toBe(71);
        expect(grown[128]).toBe(0);
        expect(pool._liveCount()).toBe(1);
        pool.release(small.id).unwrap();
        expect(pool._liveCount()).toBe(0);
      });

      it.each([
        -1,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
      ])('rejects invalid allocation size %s', (bytes) => {
        const result = new BufferPool().alloc(bytes);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe('managed-buffer-out-of-bounds');
      });

      it('M4 prelude: distinct ids on consecutive alloc with no release in between', () => {
        const pool = new BufferPool();
        const a = pool.alloc(128);
        const b = pool.alloc(128);
        if (!a.ok || !b.ok) throw new Error('expected ok x2');
        expect(a.value.id).not.toBe(b.value.id);
      });
    });
  });
}

{
  // ─── from buffer-vocab-fixup.test.ts ───
  describe('buffer-vocab-fixup.test.ts', () => {
    describe('verify round 1 fix-up — B1: world.set on buffer<N> validates byteLength', () => {
      it('returns Result.err with code "fixed-size-mismatch" when M < N', () => {
        const Print = defineComponent('Print', { fp: { type: 'buffer<16>' } });
        const w = new World();
        const e = w.spawn({ component: Print, data: { fp: new Uint8Array(16) } }).unwrap();
        const r = w.set(e, Print, { fp: new Uint8Array(12) });
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe('fixed-size-mismatch');
          if (r.error.code === 'fixed-size-mismatch') {
            expect(r.error.detail).toEqual({ expected: 16, actual: 12 });
            expect(r.error.hint).toContain('buffer<16>');
            expect(r.error.hint).toContain('byteLength 12');
          }
        }
      });

      it('returns Result.err with code "fixed-size-mismatch" when M > N', () => {
        const PrintBuf8 = defineComponent('PrintBuf8', { fp: { type: 'buffer<8>' } });
        const w = new World();
        const e = w.spawn({ component: PrintBuf8, data: { fp: new Uint8Array(8) } }).unwrap();
        const r = w.set(e, PrintBuf8, { fp: new Uint8Array(20) });
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe('fixed-size-mismatch');
          if (r.error.code === 'fixed-size-mismatch') {
            expect(r.error.detail).toEqual({ expected: 8, actual: 20 });
          }
        }
      });

      it('matching byteLength still succeeds and writes through to world.get snapshot', () => {
        const Print = defineComponent('PrintBuf4', { fp: { type: 'buffer<4>' } });
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
        const Blob = defineComponent('BlobVocab', { b: { type: 'buffer' } });
        const w = new World();
        const payload = new Uint8Array([7, 8, 9]);
        const e = w.spawn({ component: Blob, data: { b: payload } }).unwrap();
        const snapshot = w.get(e, Blob).unwrap().b;
        expect(snapshot.byteLength).toBe(3);
        expect(Array.from(snapshot)).toEqual([7, 8, 9]);
      });

      it('world.set after spawn replaces variable-buffer bytes (no fixed-size constraint)', () => {
        const Blob = defineComponent('BlobVocab2', { b: { type: 'buffer' } });
        const w = new World();
        const e = w.spawn({ component: Blob, data: { b: new Uint8Array([1]) } }).unwrap();
        const r = w.set(e, Blob, { b: new Uint8Array([10, 20, 30, 40, 50]) });
        expect(r.ok).toBe(true);
        const snapshot = w.get(e, Blob).unwrap().b;
        expect(snapshot.byteLength).toBe(5);
        expect(Array.from(snapshot)).toEqual([10, 20, 30, 40, 50]);
      });

      it('spawn with an empty Uint8Array yields a zero-length live view (no error)', () => {
        const Blob = defineComponent('BlobVocab3', { b: { type: 'buffer' } });
        const w = new World();
        const e = w.spawn({ component: Blob, data: { b: new Uint8Array(0) } }).unwrap();
        const snapshot = w.get(e, Blob).unwrap().b;
        expect(snapshot.byteLength).toBe(0);
      });

      it('ManagedBufferOutOfBoundsError hint references the new buffer keyword forms (no legacy "buffer:<bytes>")', () => {
        const Blob = defineComponent('BlobVocab4', { b: { type: 'buffer' } });
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
        const col = createColumn('f32', 64);
        expect(col.arity).toBe(1);
      });

      it('all 11 scalar field types default arity to 1', () => {
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
          'ref',
        ];
        for (const t of types) {
          const col = createColumn(t, 16);
          expect(col.arity, `Column.arity for ${t} should be 1`).toBe(1);
        }
      });

      it('empty column (capacity=0) growColumn does not divide by zero', () => {
        const col = createColumn('f32', 0, 1);
        expect(col.capacity).toBe(0);
        expect(col.arity).toBe(1);
        const grown = growColumn(col, 8);
        expect(grown.capacity).toBe(8);
        expect(grown.arity).toBe(1);
        expect(grown.buffer.byteLength).toBe(32);
      });
    });

    describe('createColumn', () => {
      it('creates a column with correct capacity', () => {
        const col = createColumn('f32', 64);
        expect(col.capacity).toBe(64);
      });

      it('creates an ArrayBuffer of correct byte length', () => {
        const col = createColumn('f32', 64);
        expect(col.buffer.byteLength).toBe(64 * 4);
      });

      it('creates a TypedArray view of correct type for f32', () => {
        const col = createColumn('f32', 16);
        expect(col.view).toBeInstanceOf(Float32Array);
        expect(col.view.length).toBe(16);
      });

      it('creates correct TypedArray view for each of the 11 scalar types', () => {
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
          ref: Uint32Array,
        };
        for (const [fieldType, ViewCtor] of Object.entries(typeToView)) {
          const col = createColumn(fieldType as ScalarFieldType, 8);
          // biome-ignore lint/complexity/noBannedTypes: ViewCtor is a constructor from Object.entries, Function is the correct generic type here
          expect(col.view).toBeInstanceOf(ViewCtor as Function);
        }
      });

      it('each field has an independent ArrayBuffer (not shared)', () => {
        const col1 = createColumn('f32', 16);
        const col2 = createColumn('f32', 16);
        expect(col1.buffer).not.toBe(col2.buffer);
      });
    });

    describe('growColumn', () => {
      it('grows an ArrayBuffer column when SharedArrayBuffer is unavailable', () => {
        const col = createColumn('f32', 4);
        col.view[0] = 7;
        vi.stubGlobal('SharedArrayBuffer', undefined);
        try {
          const grown = growColumn(col, 8);
          expect(grown.view[0]).toBe(7);
          expect(grown.capacity).toBe(8);
        } finally {
          vi.unstubAllGlobals();
        }
      });

      it('grows column to new capacity with data intact', () => {
        const col = createColumn('f32', 4);
        col.view[0] = 1.5;
        col.view[1] = 2.5;
        col.view[2] = 3.5;

        const grown = growColumn(col, 8);
        expect(grown.capacity).toBe(8);
        expect(grown.view[0]).toBeCloseTo(1.5);
        expect(grown.view[1]).toBeCloseTo(2.5);
        expect(grown.view[2]).toBeCloseTo(3.5);
      });

      it('old column is not affected by grow (fallback path)', () => {
        if (HAS_TRANSFER) {
          const col = createColumn('i32', 4);
          col.view[0] = 42;
          const grown = growColumn(col, 8);
          expect(grown.view[0]).toBe(42);
          expect(col.buffer.byteLength).toBe(0);
        } else {
          const col = createColumn('i32', 4);
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
          'ref',
        ];
        for (const t of types) {
          const col = createColumn(t, 4);
          col.view[0] = 1;
          const grown = growColumn(col, 8);
          expect(grown.view[0]).toBe(1);
          expect(grown.capacity).toBe(8);
        }
      });
    });

    describe('growColumn transfer() / fallback equivalence', () => {
      function fallbackGrow(
        col: {
          buffer: ArrayBufferLike;
          fieldType: ScalarFieldType;
          capacity: number;
          view: { BYTES_PER_ELEMENT: number };
        },
        newCapacity: number,
      ) {
        const byteLen = col.view.BYTES_PER_ELEMENT * newCapacity;
        const buf = new ArrayBuffer(byteLen);
        new Uint8Array(buf).set(new Uint8Array(col.buffer));
        return buf;
      }

      it('both paths produce identical data for f32', () => {
        const col = createColumn('f32', 4);
        col.view[0] = 1.5;
        col.view[1] = -3.14;
        col.view[2] = 0;
        col.view[3] = 999.999;

        const fallbackBuf = fallbackGrow(col, 8);

        const grown = growColumn(col, 8);
        const grownBytes = new Uint8Array(grown.buffer, 0, 16);
        const fallbackBytes = new Uint8Array(fallbackBuf, 0, 16);
        expect(Array.from(grownBytes)).toEqual(Array.from(fallbackBytes));
        expect(grown.view[0]).toBeCloseTo(1.5);
        expect(grown.view[1]).toBeCloseTo(-3.14);
        expect(grown.view[3]).toBeCloseTo(999.999);
      });

      it('both paths produce identical data for i32', () => {
        const col = createColumn('i32', 4);
        col.view[0] = -2147483648;
        col.view[1] = 2147483647;
        col.view[2] = 0;
        col.view[3] = 42;

        const fallbackBuf = fallbackGrow(col, 8);

        const grown = growColumn(col, 8);
        const grownBytes = new Uint8Array(grown.buffer, 0, 16);
        const fallbackBytes = new Uint8Array(fallbackBuf, 0, 16);
        expect(Array.from(grownBytes)).toEqual(Array.from(fallbackBytes));
        expect(grown.view[0]).toBe(-2147483648);
        expect(grown.view[1]).toBe(2147483647);
        expect(grown.view[3]).toBe(42);
      });

      it('both paths produce identical data for u8 (bool backing)', () => {
        const col = createColumn('u8', 4);
        col.view[0] = 0;
        col.view[1] = 1;
        col.view[2] = 255;
        col.view[3] = 128;

        const fallbackBuf = fallbackGrow(col, 16);

        const grown = growColumn(col, 16);
        const grownBytes = new Uint8Array(grown.buffer, 0, 4);
        const fallbackBytes = new Uint8Array(fallbackBuf, 0, 4);
        expect(Array.from(grownBytes)).toEqual(Array.from(fallbackBytes));
      });

      it('data is not lost after growing to 2x, 4x, 8x capacity', () => {
        let col = createColumn('f64', 2);
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
        expect(col.capacity).toBe(16);
      });

      it('new capacity region is zeroed', () => {
        const col = createColumn('i32', 4);
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
          expect(col.view[i], `row[0][${i}] after capacity ${col.capacity}`).toBeCloseTo(
            expected,
            6,
          );
        }
      }

      it('grow 0->4->8->16->32->64 preserves row 0 stride-16 data', () => {
        let col = createColumn('f32', 0, ARITY);
        expect(col.arity).toBe(ARITY);
        expect(col.capacity).toBe(0);

        const stages = [4, 8, 16, 32, 64];
        for (const cap of stages) {
          col = growColumn(col, cap);
          expect(col.capacity).toBe(cap);
          expect(col.arity).toBe(ARITY);

          if (cap === 4) {
            writeRow0(col, PATTERN);
          }

          expectRow0Unchanged(col);
        }
      });

      it('grow from nonzero capacity preserves row 0 for arity=16', () => {
        let col = createColumn('f32', 8, ARITY);
        writeRow0(col, PATTERN);

        const stages = [16, 32, 64, 128];
        for (const cap of stages) {
          col = growColumn(col, cap);
          expect(col.capacity).toBe(cap);
          expect(col.arity).toBe(ARITY);
          expectRow0Unchanged(col);
        }
      });

      it('grow from capacity 1 preserves arity=4 f64 row', () => {
        const f64pattern = [Math.PI, Math.E, Math.LN2, Math.SQRT2];
        let col = createColumn('f64', 1, 4);
        expect(col.arity).toBe(4);
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
        const col = createColumn('u32', 2, AR);
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
    const records = (world as unknown as { records: { archetypeId: number }[] }).records;
    const indexSlot = (e as unknown as number) & 0xffffff;
    const archId = records[indexSlot]?.archetypeId ?? -1;
    const arch = graph.archetypes[archId];
    if (!arch) throw new Error('archetype not found for entity');
    const table = graph.tables[arch.tableId];
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

    describe('Entity barrel forced-registration fail-fast (AC-01)', () => {
      afterEach(() => {
        vi.resetModules();
      });

      it('throws at barrel eval when a component registers before Entity', async () => {
        vi.resetModules();
        const { defineComponent: freshDefine } = await import('../component');
        freshDefine('TamperOrderDummy', { x: 'f32' });
        // feat-20260611 D-9: assertion text switched from `expected id=0` to
        // `ESSENTIAL_COMPONENT_IDS invariant violated` (SSOT-driven contract).
        await expect(import('../index')).rejects.toThrow(/ESSENTIAL_COMPONENT_IDS/);
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
        const Blob = defineComponent('Blob64', { b: 'buffer<64>' });
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
      const liveCount = (world: World): number =>
        (world as unknown as { bufferPool: { _liveCount(): number } }).bufferPool._liveCount();

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
        const Blob = defineComponent('Blob64Pool', { b: 'buffer<64>' });
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
      const liveCount = (world: World): number =>
        (world as unknown as { bufferPool: { _liveCount(): number } }).bufferPool._liveCount();

      it('variable buffer spawn->set->get round-trip works', () => {
        const C = defineComponent('VarBuf', { blob: 'buffer' });
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
        const C = defineComponent('VarBuf2', { blob: 'buffer' });
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
        const C = defineComponent('VarBuf3', { blob: 'buffer' });
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
            { component: VarArr, data: { data: new Float32Array(0) } },
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

{
  // ─── from query-preregister.test.ts ───
  describe('foldEssentials.test.ts', () => {
    describe('ESSENTIAL_COMPONENT_IDS SSOT', () => {
      it('is a frozen readonly array containing componentId(Entity)', async () => {
        const mod = await import('../entity');
        const ESSENTIAL_COMPONENT_IDS = (
          mod as unknown as { ESSENTIAL_COMPONENT_IDS: ReadonlyArray<number> }
        ).ESSENTIAL_COMPONENT_IDS;
        expect(Array.isArray(ESSENTIAL_COMPONENT_IDS)).toBe(true);
        expect(ESSENTIAL_COMPONENT_IDS.length).toBe(1);
        expect(ESSENTIAL_COMPONENT_IDS[0]).toBe(componentId(Entity));
        expect(Object.isFrozen(ESSENTIAL_COMPONENT_IDS)).toBe(true);
      });
    });

    describe('foldEssentials() helper', () => {
      it('input containing componentId(Entity) returns deduped copy', async () => {
        const mod = await import('../entity');
        const foldEssentials = (
          mod as unknown as { foldEssentials: (ids: ReadonlyArray<number>) => number[] }
        ).foldEssentials;
        const input = [componentId(Entity), 2, 5];
        const out = foldEssentials(input);
        // componentId(Entity) appears exactly once
        expect(out.filter((id) => id === componentId(Entity)).length).toBe(1);
        // No id is dropped
        expect(out).toContain(2);
        expect(out).toContain(5);
        expect(out).toContain(componentId(Entity));
      });

      it('input not containing componentId(Entity) returns array prefixed with componentId(Entity)', async () => {
        const mod = await import('../entity');
        const foldEssentials = (
          mod as unknown as { foldEssentials: (ids: ReadonlyArray<number>) => number[] }
        ).foldEssentials;
        const input = [2, 5, 7];
        const out = foldEssentials(input);
        expect(out.length).toBe(4);
        expect(out[0]).toBe(componentId(Entity));
        expect(out).toContain(2);
        expect(out).toContain(5);
        expect(out).toContain(7);
      });

      it('empty input returns [componentId(Entity)]', async () => {
        const mod = await import('../entity');
        const foldEssentials = (
          mod as unknown as { foldEssentials: (ids: ReadonlyArray<number>) => number[] }
        ).foldEssentials;
        const out = foldEssentials([]);
        expect(out).toEqual([componentId(Entity)]);
      });

      it('does not mutate input array', async () => {
        const mod = await import('../entity');
        const foldEssentials = (
          mod as unknown as { foldEssentials: (ids: ReadonlyArray<number>) => number[] }
        ).foldEssentials;
        const input = [2, 5];
        const inputSnapshot = [...input];
        const out = foldEssentials(input);
        expect(input).toEqual(inputSnapshot);
        // returned array must be a NEW array (different reference) when fold
        // had to insert componentId(Entity)
        expect(out).not.toBe(input);
      });
    });
  });
}

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
    let testArchId = 0;

    describe('removeEntity swap-pop reads entity from id=0 self column', () => {
      it('2+ entities swap-pop: removed entity index comes from self column, not entities array', () => {
        const C = defineComponent('SwapSelfCol', { v: { type: 'i32' } });
        const arch = createArchetype([C], testArchId++);

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
        const arch = createArchetype([C], testArchId++);

        appendEntity(arch, 0xab);

        const swapped = removeEntity(arch, 0);
        expect(arch.size).toBe(0);
        expect(swapped).toBeNull();
      });

      it('swap-pop self column data correctly migrated (column-level swap)', () => {
        const C = defineComponent('SwapSelfColData', { v: { type: 'i32' } });
        const arch = createArchetype([C], testArchId++);

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

        const archABC = getOrCreateArchetype(
          graph,
          [componentId(A), componentId(B), componentId(C)],
          [A, B, C],
        );

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

      it('getRemoveEdge of last non-essential component returns archetype with only Entity', () => {
        const graph = createArchetypeGraph();
        const A = defineComponent('RemoveEdgeLast_A', { a: { type: 'f32' } });

        const archA = getOrCreateArchetype(graph, [componentId(A)], [A]);
        const archEmpty = getRemoveEdge(graph, archA, componentId(A));

        expect(archEmpty.components.length).toBe(1);
        expect(archEmpty.components[0]?.name).toBe('Entity');
        expect(archEmpty.components.map((c) => componentId(c))).toEqual([componentId(Entity)]);
      });
    });
  });
}

{
  // ─── from isManaged-column-4-predicate-equivalence.test.ts (feat-20260611-ecs-storage-naming-ssot M-3 / w6) ───
  //
  // Verifies:
  //   1. Every TYPE_METADATA row has an `isManaged` boolean column.
  //   2. The 4 `isXxxField` predicates produce the same boolean result as the
  //      new TYPE_METADATA[].isXxx single-column lookups.
  //   3. `isManagedField` recognizes `'string'` and `'unique<T>'` (both isManaged).
  //
  // tweak-20260612-ecs-concept-compression dropped the redundant per-vocab
  // managed-ref predicate column (100% identical to `isManaged`); the
  // equivalence assertion below now reads `isManaged` directly.
  //
  // Plan-strategy D-3 (approach A): TYPE_METADATA gains an `isManaged` column;
  // 4 predicates are 1:1 derivations from TYPE_METADATA columns, zero OR.
  //
  // Plan-strategy D-4: `isManagedBufferField` semantic widening accepted —
  // `buffer<abc>` resolves to metaKey 'buffer', `isBuffer` returns true; the
  // upstream `isSchemaVocabKeyword` gate already rejects malformed keywords.
  //
  // TDD: these tests are RED before w7 (isManaged column does not yet exist on
  // TypeMetadataRow). They turn GREEN after w7 adds the column + rewrites
  // predicates.

  describe('isManaged-column-4-predicate-equivalence.test.ts', () => {
    describe('isManaged column exists on every TYPE_METADATA row', () => {
      it('every TYPE_METADATA row has a boolean isManaged property', () => {
        for (const [key, row] of Object.entries(TYPE_METADATA)) {
          expect(
            typeof (row as unknown as Record<string, unknown>).isManaged,
            `TYPE_METADATA['${key}'].isManaged must be boolean`,
          ).toBe('boolean');
        }
      });

      it('isManaged === true exactly for the managed-ref vocab + scalar rows ("string" + "ref" + "shared")', () => {
        // feat-20260614-ecs-shared-component-and-unique-rename M3 (D-3): the
        // independent `'shared'` TYPE_METADATA row joins the managed-ref tier
        // alongside `'string'` (UniqueRefStore-backed) and `'ref'` (the
        // post-M2 `'unique<T>'` family). Each meta key carries its own
        // release-semantics dispatch (M4 wires the sub-branches).
        for (const [key, row] of Object.entries(TYPE_METADATA)) {
          const im = (row as unknown as Record<string, unknown>).isManaged as boolean;
          const expected = key === 'string' || key === 'ref' || key === 'shared';
          expect(im, `TYPE_METADATA['${key}'].isManaged`).toBe(expected);
        }
      });

      it('"string" row has isManaged === true', () => {
        const stringRow = TYPE_METADATA.string;
        if (stringRow === undefined) throw new Error('string row missing');
        const im = (stringRow as unknown as Record<string, unknown>).isManaged;
        expect(im).toBe(true);
      });

      it('"ref" row has isManaged === true (shared scalar + vocab row)', () => {
        const refRow = TYPE_METADATA.ref;
        if (refRow === undefined) throw new Error('ref row missing');
        const im = (refRow as unknown as Record<string, unknown>).isManaged;
        expect(im).toBe(true);
      });

      it('non-managed rows (entity, buffer, array, scalars) have isManaged === false', () => {
        const nonManagedKeys = [
          'entity',
          'buffer',
          'array',
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
        for (const key of nonManagedKeys) {
          const row = TYPE_METADATA[key];
          if (row === undefined) throw new Error(`row ${key} missing`);
          const im = (row as unknown as Record<string, unknown>).isManaged as boolean;
          expect(im, `TYPE_METADATA['${key}'].isManaged`).toBe(false);
        }
      });
    });

    describe('4 predicate equivalence (old impl vs new TYPE_METADATA column)', () => {
      // Legal SchemaFieldType samples: all 11 legacy scalars (keywords) +
      // 6 vocab-family parametric representatives. Every sample is a
      // syntactically valid keyword accepted by `defineComponent`.
      //
      // Deliberately excluded: 'buffer<0>' (invalid N, /^[1-9]\d*$/ rejects
      // 0), 'buffer<abc>' (non-integer N), 'handle<>' (empty tag). These
      // are never accepted by `defineComponent` (gated via `isSchemaVocabKeyword`),
      // so they never flow through the runtime predicates. The D-4 semantic
      // widening only affects invalid inputs — a dead path.
      const SAMPLE_FIELD_TYPES: string[] = [
        // 11 legacy scalar keys
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
        // 6 vocab-family parametric reps
        'entity',
        'string',
        'buffer',
        'buffer<64>',
        'unique<MaterialAsset>',
        'shared<MaterialAsset>',
        'array<f32>',
        'array<f32, 16>',
        'array<entity>',
        'array<entity, 4>',
        'array<shared<MaterialAsset>>',
        'unknown-field-type',
      ];

      it('isManagedField: equivalence between current impl and TYPE_METADATA[].isManaged', () => {
        for (const t of SAMPLE_FIELD_TYPES) {
          const oldResult = isManagedField(t);
          const metaKey = fieldTypeToMetaKey(t) ?? '';
          const newResult =
            ((TYPE_METADATA[metaKey] as unknown as Record<string, unknown>)
              ?.isManaged as boolean) ?? false;
          expect(newResult, `isManagedField('${t}'): old=${oldResult} new=${newResult}`).toBe(
            oldResult,
          );
        }
      });

      it('isManagedBufferField: equivalence between current impl and TYPE_METADATA[].isBuffer', () => {
        for (const t of SAMPLE_FIELD_TYPES) {
          const oldResult = isManagedBufferField(t);
          const metaKey = fieldTypeToMetaKey(t) ?? '';
          const newResult = TYPE_METADATA[metaKey]?.isBuffer ?? false;
          expect(newResult, `isManagedBufferField('${t}'): old=${oldResult} new=${newResult}`).toBe(
            oldResult,
          );
        }
      });

      it('isEntityField: equivalence between current impl and TYPE_METADATA[].isEntityRef', () => {
        for (const t of SAMPLE_FIELD_TYPES) {
          const oldResult = isEntityField(t);
          const metaKey = fieldTypeToMetaKey(t) ?? '';
          const newResult = TYPE_METADATA[metaKey]?.isEntityRef ?? false;
          expect(newResult, `isEntityField('${t}'): old=${oldResult} new=${newResult}`).toBe(
            oldResult,
          );
        }
      });

      it('isManagedArrayField: equivalence between current impl and TYPE_METADATA[].isArray', () => {
        for (const t of SAMPLE_FIELD_TYPES) {
          const oldResult = isManagedArrayField(t);
          const metaKey = fieldTypeToMetaKey(t) ?? '';
          const newResult = TYPE_METADATA[metaKey]?.isArray ?? false;
          expect(newResult, `isManagedArrayField('${t}'): old=${oldResult} new=${newResult}`).toBe(
            oldResult,
          );
        }
      });
    });

    describe('isManagedBufferField semantic widening (D-4 acceptance)', () => {
      it("'buffer<abc>' maps to metaKey 'buffer' so isBuffer returns true", () => {
        // D-4 states this widening is acceptable: defineComponent rejects
        // 'buffer<abc>' via isSchemaVocabKeyword (non-integer N), so it
        // never reaches the runtime predicate. The column-based predicate
        // unavoidably returns true via metaKey 'buffer'.isBuffer === true.
        const metaKey = fieldTypeToMetaKey('buffer<abc>') ?? '';
        expect(metaKey).toBe('buffer');
        expect(TYPE_METADATA[metaKey]?.isBuffer ?? false).toBe(true);
        // The new column-based predicate returns true for this dead path
        // (old regex impl returned false). Accepted per D-4.
        expect(isManagedBufferField('buffer<abc>')).toBe(true);
      });
    });

    describe('isManagedField coverage: string and ref<T>', () => {
      it("returns true for 'string' literal", () => {
        expect(isManagedField('string')).toBe(true);
      });

      it("returns true for 'unique<Foo>' template", () => {
        expect(isManagedField('unique<Foo>')).toBe(true);
      });

      it("returns true for 'shared<X>' (rc-tracked managed scalar)", () => {
        expect(isManagedField('shared<X>')).toBe(true);
      });

      it("returns false for 'entity', 'buffer', 'array<T>', and bare scalars", () => {
        expect(isManagedField('entity')).toBe(false);
        expect(isManagedField('buffer')).toBe(false);
        expect(isManagedField('buffer<64>')).toBe(false);
        expect(isManagedField('array<f32>')).toBe(false);
        expect(isManagedField('f32')).toBe(false);
      });
    });
  });
}

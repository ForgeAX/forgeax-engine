import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { World } from '@forgeax/engine-ecs';
import { expect, it } from 'vitest';
import { worldRenderResources } from '../../publication/resource-scope';
import type { RenderableSnapshot } from '../../render-system-extract';
import { DynamicGeometryReceipt } from '../dynamic-geometry-receipt';

const row = (entityKey: number, assetHandle = 9) => ({
  source: { worldId: 0, entityKey, assetHandle } as RenderableSnapshot,
});

it('reuses completed receipt storage without registering every entity again', () => {
  const scope = worldRenderResources(new World());
  const receipt = new DynamicGeometryReceipt();
  const rows = Array.from({ length: 128 }, (_, entity) => row(entity));
  for (const lane of ['cpu', 'gpu'] as const) {
    const record = receipt.onRenderableDraw([scope]);
    for (const entry of rows) record(entry, lane);
    receipt.commit();
  }
  const record = receipt.onRenderableDraw([scope]);
  const set = Map.prototype.set;
  const get = WeakMap.prototype.get;
  let writes = 0;
  let reads = 0;
  WeakMap.prototype.get = function (key: object) {
    reads++;
    return get.call(this, key);
  };
  Map.prototype.set = function (key: unknown, value: unknown) {
    writes++;
    return set.call(this, key, value);
  };
  try {
    for (const entry of rows) record(entry);
  } finally {
    Map.prototype.set = set;
    WeakMap.prototype.get = get;
  }
  expect(receipt.recordStageLane(scope, 7, 9)).toBe('gpu');
  receipt.commit();
  expect(receipt.recordStageLane(scope, 7, 9)).toBe('cpu');
  expect(writes).toBeLessThanOrEqual(4);
  expect(reads).toBeLessThanOrEqual(4);
  const sparse = receipt.onRenderableDraw([scope]);
  sparse(row(0));
  receipt.commit();
  expect(receipt.recordStageLane(scope, 0, 9)).toBe('cpu');
  expect(receipt.recordStageLane(scope, 7, 9)).toBeUndefined();
});

it('keeps frame-local mixed lanes and replaces a changed mesh without changing accepted evidence', () => {
  const scope = worldRenderResources(new World());
  const receipt = new DynamicGeometryReceipt();
  const first = receipt.onRenderableDraw([scope]);
  first(row(7), 'gpu');
  first(row(7), 'cpu');
  receipt.commit();
  expect(receipt.recordStageLane(scope, 7, 9)).toBe('mixed');
  const second = receipt.onRenderableDraw([scope]);
  second(row(7), 'gpu');
  second(row(7, 10), 'cpu');
  expect(receipt.recordStageLane(scope, 7, 9)).toBe('mixed');
  receipt.commit();
  expect(receipt.recordStageLane(scope, 7, 9)).toBeUndefined();
  expect(receipt.recordStageLane(scope, 7, 10)).toBe('cpu');
  receipt.onRenderableDraw([scope])(row(8));
  receipt.clear();
  expect(receipt.recordStageLane(scope, 7, 10)).toBeUndefined();
  expect(receipt.recordStageLane(scope, 8, 9)).toBeUndefined();
  receipt.onRenderableDraw([scope])(row(7), 'gpu');
  receipt.commit();
  expect(receipt.recordStageLane(scope, 7, 9)).toBe('gpu');
});

it('isolates receipt scopes and discards entries from empty accepted frames', () => {
  const a = worldRenderResources(new World());
  const b = worldRenderResources(new World());
  const receipt = new DynamicGeometryReceipt();
  receipt.onRenderableDraw([a])(row(7), 'gpu');
  receipt.onRenderableDraw([b])(row(7), 'cpu');
  receipt.commit();
  expect(receipt.recordStageLane(a, 7, 9)).toBe('gpu');
  expect(receipt.recordStageLane(b, 7, 9)).toBe('cpu');
  receipt.commit();
  expect(receipt.recordStageLane(a, 7, 9)).toBeUndefined();
  expect(receipt.recordStageLane(b, 7, 9)).toBeUndefined();
  receipt.onRenderableDraw([a])(row(8));
  receipt.commit();
  expect(receipt.recordStageLane(a, 7, 9)).toBeUndefined();
  expect(receipt.recordStageLane(a, 8, 9)).toBe('cpu');
});

it('keeps an old callback out of a recycled pending receipt', () => {
  const scope = worldRenderResources(new World());
  const receipt = new DynamicGeometryReceipt();
  const stale = receipt.onRenderableDraw([scope]);
  stale(row(7));
  receipt.commit();
  receipt.onRenderableDraw([scope])(row(7), 'gpu');
  receipt.commit();
  receipt.onRenderableDraw([scope])(row(8));
  stale(row(9), 'gpu');
  receipt.commit();
  expect(receipt.recordStageLane(scope, 7, 9)).toBeUndefined();
  expect(receipt.recordStageLane(scope, 8, 9)).toBe('cpu');
  expect(receipt.recordStageLane(scope, 9, 9)).toBeUndefined();
});

it.each([
  'empty',
  'clear',
] as const)('releases cold receipt maps with a live scope and old callback after %s', async (mode) => {
  setFlagsFromString('--expose-gc');
  const collect = runInNewContext('gc') as () => void;
  const scope = worldRenderResources(new World());
  const receipt = new DynamicGeometryReceipt();
  const tables: WeakRef<Map<unknown, unknown>>[] = [];
  let held: ReturnType<DynamicGeometryReceipt['onRenderableDraw']> | undefined;
  const set = Map.prototype.set;
  Map.prototype.set = function (key: unknown, value: unknown) {
    if (typeof value === 'object' && value !== null && 'meshHandle' in value)
      tables.push(new WeakRef(this));
    return set.call(this, key, value);
  };
  try {
    for (let frame = 0; frame < 2; frame++) {
      const record = receipt.onRenderableDraw([scope]);
      if (frame === 0) held = record;
      record(row(7));
      receipt.commit();
    }
  } finally {
    Map.prototype.set = set;
  }
  expect(tables).toHaveLength(2);
  if (mode === 'clear') receipt.clear();
  else for (let frame = 0; frame < 8; frame++) receipt.commit();
  await new Promise((resolve) => setTimeout(resolve, 0));
  collect();
  expect(tables.every((table) => table.deref() === undefined)).toBe(true);
  held?.(row(9));
  expect(receipt.recordStageLane(scope, 9, 9)).toBeUndefined();
  expect(receipt.recordStageLane(scope, 7, 9)).toBeUndefined();
  receipt.onRenderableDraw([scope])(row(8));
  receipt.commit();
  expect(receipt.recordStageLane(scope, 8, 9)).toBe('cpu');
});

it('does not make an accepted weak resource domain strong through its hot lookup', async () => {
  setFlagsFromString('--expose-gc');
  const collect = runInNewContext('gc') as () => void;
  const receipt = new DynamicGeometryReceipt();
  const set = Map.prototype.set;
  let table: WeakRef<Map<unknown, unknown>> | undefined;
  Map.prototype.set = function (key: unknown, value: unknown) {
    if (typeof value === 'object' && value !== null && 'meshHandle' in value)
      table = new WeakRef(this);
    return set.call(this, key, value);
  };
  let domain: WeakRef<object>;
  try {
    domain = (() => {
      // The receipt only uses the scope's object identity; no asset methods are called.
      const scope = Object.create(null) as Parameters<DynamicGeometryReceipt['isConsumed']>[0];
      receipt.onRenderableDraw([scope])(row(7));
      receipt.commit();
      return new WeakRef(scope);
    })();
  } finally {
    Map.prototype.set = set;
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  collect();
  expect(domain.deref()).toBeUndefined();
  expect(table?.deref()).toBeUndefined();
  receipt.commit();
});

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { afterEach, expect, it, vi } from 'vitest';
import { MeshFilter, MeshRenderer } from '../../components';
import { GpuInputArena } from '../../gpu-input-arena';
import { FrameSet } from '../../scene/frame-set';
import { RowContents } from '../../scene/row-contents';
import { SkinInputs } from '../../scene/skin-inputs';
import { type Roster, RosterCursor, rosterMerge, rosterPut } from '../../scene/slot-roster';
import { createRenderPublisher } from '../publisher';
import { RenderPublicationReceiver } from '../receiver';
import {
  encodeRenderPublication,
  renderPublicationAssetTransfers,
  renderPublicationTransfers,
} from '../record';

// Cold start, recovery and level load admit every row in one batch through the
// incremental path. These falsifiers count the work that must not grow per row:
// content keys, page copies and typed-array constructions beyond column growth.

const NativeFloat64Array = globalThis.Float64Array;
const NativeUint32Array = globalThis.Uint32Array;
afterEach(() => {
  globalThis.Float64Array = NativeFloat64Array;
  globalThis.Uint32Array = NativeUint32Array;
  vi.restoreAllMocks();
});

/** Count typed-array constructions (including species copies) while `run` executes. */
function countTypedArrays<T>(run: () => T): { value: T; count: number } {
  let count = 0;
  class CountingFloat64Array extends NativeFloat64Array {
    // Admission validates columns with instanceof against the global constructor.
    static override [Symbol.hasInstance](value: unknown): boolean {
      return value instanceof NativeFloat64Array;
    }
    constructor(...args: unknown[]) {
      super(...(args as [number]));
      count++;
    }
  }
  class CountingUint32Array extends NativeUint32Array {
    static override [Symbol.hasInstance](value: unknown): boolean {
      return value instanceof NativeUint32Array;
    }
    constructor(...args: unknown[]) {
      super(...(args as [number]));
      count++;
    }
  }
  globalThis.Float64Array = CountingFloat64Array as unknown as Float64ArrayConstructor;
  globalThis.Uint32Array = CountingUint32Array as unknown as Uint32ArrayConstructor;
  try {
    return { value: run(), count };
  } finally {
    globalThis.Float64Array = NativeFloat64Array;
    globalThis.Uint32Array = NativeUint32Array;
  }
}

function rosterEntries(root: Roster | undefined): number[] {
  const cursor = new RosterCursor(root);
  const result: number[] = [];
  while (cursor.next()) result.push(cursor.key, cursor.value);
  return result;
}

function scene(count: number) {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const handle = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  for (let index = 0; index < count; index++)
    world
      .spawn(
        { component: Transform, data: { pos: [index, 0, 0] } },
        { component: MeshFilter, data: { assetHandle: handle } },
        { component: MeshRenderer, data: {} },
      )
      .unwrap();
  return { assets, world };
}

/** One complete first publication and its receiver admission. */
function firstPublication(count: number) {
  const { assets, world } = scene(count);
  const identity = { source: 'bulk-admission', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity);
  world.update(1 / 60).unwrap();
  const stringify = vi.spyOn(JSON, 'stringify');
  const candidate = publisher.prepare(0).unwrap();
  // Content-key derivations stringify with a replacer; extraction itself does not.
  const keyDerivations = stringify.mock.calls.filter(
    ([, replacer]) => replacer !== undefined,
  ).length;
  stringify.mockRestore();
  const packet = structuredClone(candidate.packet, {
    transfer: [
      ...renderPublicationTransfers(candidate.message),
      ...renderPublicationAssetTransfers(candidate.message),
    ],
  });
  candidate.accept();
  const receiver = new RenderPublicationReceiver(identity);
  const keyed = vi.spyOn(
    RowContents.prototype as unknown as { acquireKeyed(source: object): unknown },
    'acquireKeyed',
  );
  const message = encodeRenderPublication(packet);
  const admitted = countTypedArrays(() => receiver.accept(message).unwrap());
  const contentKeys = keyed.mock.calls.length;
  keyed.mockRestore();
  return {
    templates: packet.templates.length,
    keyDerivations,
    contentKeys,
    typedArrays: admitted.count,
    rows: admitted.value.frame.renderables.length,
  };
}

it('admits a first publication with per-template keys and typed-array growth only', () => {
  const small = firstPublication(256);
  const large = firstPublication(2048);
  expect(small.rows).toBe(256);
  expect(large.rows).toBe(2048);
  // Rows of one Mesh/material tuple share one template and one staged content.
  expect(large.templates).toBe(small.templates);
  expect(large.keyDerivations).toBe(small.keyDerivations);
  expect(large.contentKeys).toBeLessThanOrEqual(large.templates);
  // Columns grow by pages; a per-row page copy would construct >= 1 array per row.
  expect(large.typedArrays - small.typedArrays).toBeLessThan((2048 - 256) / 8);
});

it('merges a bulk roster batch page by page and agrees with single insertions', () => {
  let seed = 7;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  let expected: Roster | undefined;
  let merged: Roster | undefined;
  for (let round = 0; round < 12; round++) {
    const batch: number[] = [];
    const size = round % 3 === 0 ? 2000 : Math.floor(random() * 300);
    for (let index = 0; index < size; index++) {
      const key = round % 4 === 1 ? 1e6 + round * 1e4 + index : Math.floor(random() * 50_000);
      const value = Math.floor(random() * 1e6);
      batch.push(key, value);
      expected = rosterPut(expected, key, value);
    }
    merged = rosterMerge(merged, batch);
    expect(rosterEntries(merged)).toEqual(rosterEntries(expected));
    expect(merged?.count ?? 0).toBe(expected?.count ?? 0);
  }
  const ascending: number[] = [];
  for (let index = 0; index < 10_000; index++) ascending.push(index, index * 2);
  const counted = countTypedArrays(() => rosterMerge(undefined, ascending));
  // Two typed arrays per filled 128-entry page, not two per entry.
  expect(counted.count).toBeLessThanOrEqual(2 * Math.ceil(10_000 / 128));
  expect(counted.value?.count).toBe(10_000);
});

it('edits many FrameSet keys copying each touched page once', () => {
  let seed = 3;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  let expected = new FrameSet();
  let edited = new FrameSet();
  for (let round = 0; round < 10; round++) {
    const edits = new Map<number, boolean>();
    for (let index = 0; index < 500; index++) {
      const key = Math.floor(random() * 20_000);
      const present = random() < 0.7;
      edits.set(key, present);
    }
    for (const [key, present] of edits)
      expected = present ? expected.with(key) : expected.without(key);
    const before = edited;
    edited = edited.edit(edits);
    expect([...edited]).toEqual([...expected]);
    const visited: number[] = [];
    edited.changesSince(before, (key) => visited.push(key));
    for (const key of visited) expect(before.has(key)).not.toBe(edited.has(key));
  }
  expect(edited.edit(new Map([[5, edited.has(5)]]))).toBe(edited);
  const bulk = new Map<number, boolean>();
  for (let key = 0; key < 100_000; key++) bulk.set(key, true);
  const counted = countTypedArrays(() => new FrameSet().edit(bulk));
  expect(counted.value.size).toBe(100_000);
  expect(counted.count).toBeLessThanOrEqual(Math.ceil(100_000 / 1024));
});

it('binds many Skin rows into an exclusive root without copying the page path per row', () => {
  const arena = new GpuInputArena();
  const skin = new SkinInputs(arena);
  const source = skin.source();
  const skeleton = skin.skeleton(
    1,
    new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  );
  const allocate = vi.spyOn(arena, 'allocateDescriptor');
  const rows = 4096;
  for (let slot = 0; slot < rows; slot++) skin.bind(slot, source, skeleton, [slot + 1]);
  // One descriptor per Binding row plus pages per 256 keys; a path copy per row
  // would allocate eight 256-word pages for every Binding.
  expect(allocate.mock.calls.length).toBeLessThan(rows + (rows / 256 + 8) * 8);
  const frame = skin.capture();
  expect(frame.jointCapacity).toBe(rows);
  frame.release?.();
});

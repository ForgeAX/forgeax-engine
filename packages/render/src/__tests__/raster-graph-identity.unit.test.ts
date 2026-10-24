import { describe, expect, it } from 'vitest';
import { RasterGraphIdentity } from '../gpu-driven/raster-graph-identity';

const resources = {
  resourceGeneration: 1,
  candidateCapacity: 64,
  batchCapacity: 64,
  indirectCapacity: 128,
};

describe('raster graph dependency projections', () => {
  it('retains only the stock identity across physical mesh replacement', () => {
    const owner = new RasterGraphIdentity(),
      bindings = {};
    const first = {
      ...owner.update(
        {},
        1,
        resources,
        [{ classKey: 'mesh-a/layout-a', recordingClassKey: 'layout-a' }],
        bindings,
        undefined,
      ),
    };
    const replaced = {
      ...owner.update(
        {},
        1,
        resources,
        [{ classKey: 'mesh-b/layout-a', recordingClassKey: 'layout-a' }],
        bindings,
        undefined,
      ),
    };
    expect(replaced.raw).not.toBe(first.raw);
    expect(replaced.recording).toBe(first.recording);
    const layout = owner.update(
      {},
      1,
      resources,
      [{ classKey: 'mesh-b/layout-b', recordingClassKey: 'layout-b' }],
      bindings,
      undefined,
    );
    expect(layout.raw).not.toBe(replaced.raw);
    // A new stock class is projected into the compiled graph, not recompiled.
    expect(layout.recording).toBe(replaced.recording);
  });

  it('invalidates both projections on a pass-list generation change', () => {
    const field = 'resourceGeneration';
    const owner = new RasterGraphIdentity(),
      source = {},
      bindings = {},
      batches = [{ classKey: 'raw', recordingClassKey: 'stock' }];
    const first = { ...owner.update(source, 1, resources, batches, bindings, undefined) };
    const replacement = owner.update(
      source,
      1,
      { ...resources, [field]: resources[field] + 1 },
      batches,
      bindings,
      undefined,
    );
    expect(replacement.raw).not.toBe(first.raw);
    expect(replacement.recording).not.toBe(first.recording);
  });

  it.each([
    'candidateCapacity',
    'batchCapacity',
    'indirectCapacity',
  ] as const)('keeps both projections when %s grows (view storage is resolved at execute time)', (field) => {
    const owner = new RasterGraphIdentity(),
      source = {},
      bindings = {},
      batches = [{ classKey: 'raw', recordingClassKey: 'stock' }];
    const first = { ...owner.update(source, 1, resources, batches, bindings, undefined) };
    const grown = owner.update(
      source,
      1,
      { ...resources, [field]: resources[field] * 2 },
      batches,
      bindings,
      undefined,
    );
    expect(grown.raw).toBe(first.raw);
    expect(grown.recording).toBe(first.recording);
  });

  it('keeps the graph across table and skin binding replacement and observes scene identity', () => {
    const owner = new RasterGraphIdentity(),
      source = {},
      rigid = {},
      skin = {},
      batches = [{ classKey: 'raw', recordingClassKey: 'stock' }];
    const first = { ...owner.update(source, 1, resources, batches, rigid, skin) };
    // Visible-window bindings are resolved per encode, never compiled in.
    const changedSkin = { ...owner.update(source, 1, resources, batches, rigid, {}) };
    expect(changedSkin.raw).toBe(first.raw);
    expect(changedSkin.recording).toBe(first.recording);
    const changedTables = { ...owner.update(source, 1, resources, batches, {}, {}) };
    expect(changedTables.recording).toBe(changedSkin.recording);
    const scene = { ...owner.update(source, 2, resources, batches, rigid, skin) };
    expect(scene.raw).not.toBe(first.raw);
    expect(scene.recording).not.toBe(first.recording);
    owner.clear();
    const recovered = owner.update(source, 1, resources, batches, rigid, skin);
    expect(recovered.raw).not.toBe(first.raw);
    expect(recovered.recording).not.toBe(first.recording);
  });
});

describe('stock-recorder raster classes', () => {
  it('keeps the recording identity when classes appear, disappear and return', () => {
    const owner = new RasterGraphIdentity(),
      bindings = {};
    const update = (...keys: string[]) =>
      owner.update(
        {},
        1,
        resources,
        keys.map((key) => ({ classKey: `mesh/${key}`, recordingClassKey: key })),
        bindings,
        undefined,
      );
    const base = update('a').recording;
    owner.built(['a']);
    // A grenade-like class first seen in battle joins the compiled graph.
    expect(update('a', 'b').recording).toBe(base);
    expect(update('a').recording).toBe(base);
    expect(update('a', 'b').recording).toBe(base);
    expect(owner.changes.lateRecordingClasses).toBe(1);
    // The raw projection still follows its class set.
    expect(update('a', 'c').raw).not.toBe(update('a').raw);
    // Only a pass-list generation change rebuilds the stock graph.
    const rebuilt = owner.update(
      {},
      1,
      { ...resources, resourceGeneration: 2 },
      [{ classKey: 'mesh/a', recordingClassKey: 'a' }],
      bindings,
      undefined,
    ).recording;
    expect(rebuilt).not.toBe(base);
  });
});

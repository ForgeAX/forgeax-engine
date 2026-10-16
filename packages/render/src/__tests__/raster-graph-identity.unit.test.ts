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
    expect(layout.recording).not.toBe(replaced.recording);
  });

  it.each([
    'resourceGeneration',
    'candidateCapacity',
    'batchCapacity',
    'indirectCapacity',
  ] as const)('invalidates both projections on %s replacement', (field) => {
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

  it('observes table and skin bindings even when the source publication is unchanged', () => {
    const owner = new RasterGraphIdentity(),
      source = {},
      rigid = {},
      skin = {},
      batches = [{ classKey: 'raw', recordingClassKey: 'stock' }];
    const first = { ...owner.update(source, 1, resources, batches, rigid, skin) };
    const changedSkin = { ...owner.update(source, 1, resources, batches, rigid, {}) };
    expect(changedSkin.raw).toBe(first.raw);
    expect(changedSkin.recording).not.toBe(first.recording);
    const changedTables = { ...owner.update(source, 1, resources, batches, {}, {}) };
    expect(changedTables.recording).not.toBe(changedSkin.recording);
    const scene = { ...owner.update(source, 2, resources, batches, rigid, skin) };
    expect(scene.raw).not.toBe(first.raw);
    expect(scene.recording).not.toBe(first.recording);
    owner.clear();
    const recovered = owner.update(source, 1, resources, batches, rigid, skin);
    expect(recovered.raw).not.toBe(first.raw);
    expect(recovered.recording).not.toBe(first.recording);
  });
});

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { defineComponent, type EcsError, World } from '@forgeax/engine-ecs';
import { AssetError, err, ok, type SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { retainSceneSourceReferences } from '../instances/source-references';

const SourceValues = defineComponent('StreamSourceValues', {
  mesh: 'asset<mesh>',
  material: 'shared<FixtureMaterial>',
});

function fixture() {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  world.components.register(SourceValues).unwrap();
  const records = runtimeAssets(assets);
  const mesh = records.create('mesh', { positions: new Float32Array([1, 2, 3]) }).unwrap();
  const material = world.allocSharedRef('FixtureMaterial', { name: 'original' });
  const source: SceneAsset = {
    kind: 'scene',
    entities: {
      a: { components: { StreamSourceValues: { mesh, material } } },
      b: { components: { StreamSourceValues: { mesh, material } } },
    },
  };
  return { world, assets, records, mesh, material, source };
}

describe('Scene source-reference custody handoff', () => {
  it('transfers existing source holds before root cleanup and defers all decrements until the custodian drains', () => {
    const f = fixture();
    let queued = 0;
    let transferred: readonly number[] = [];
    let task: ReturnType<typeof f.records.deferRelease> | undefined;
    const release = retainSceneSourceReferences(f.world, f.source, {
      take: (assets, shared) => {
        task = f.records.deferRelease(assets);
        if (!task.ok) return err(task.error as unknown as EcsError);
        transferred = shared;
        return ok(() => {
          queued++;
        });
      },
    }).unwrap();
    f.assets.release(f.mesh).unwrap();
    f.world.sharedRefs.release(f.material).unwrap();
    expect(f.records.validate(f.mesh).ok).toBe(true);
    expect(f.world.sharedRefs.refcount(f.material)).toBe(1);
    release();
    release();
    expect(queued).toBe(1);
    expect(f.records.validate(f.mesh).ok).toBe(true);
    expect(f.world.sharedRefs.refcount(f.material)).toBe(1);
    if (task === undefined) throw new Error('source holds were not transferred');
    task.unwrap().step(1).unwrap();
    for (const handle of transferred)
      f.world.sharedRefs.release(handle as typeof f.material).unwrap();
    expect(f.records.validate(f.mesh).ok).toBe(false);
    expect(f.world.sharedRefs.refcount(f.material)).toBe(0);
  });

  it('rolls back acquired source holds when the custodian refuses the atomic transfer', () => {
    const f = fixture();
    const failure = new AssetError({
      code: 'asset-budget-exceeded',
      expected: 'available retirement capacity',
      hint: 'drain existing work',
    });
    const result = retainSceneSourceReferences(f.world, f.source, {
      take: () => err(failure as unknown as EcsError),
    });
    expect(result).toEqual(err(failure));
    expect(f.world.sharedRefs.refcount(f.material)).toBe(1);
    f.assets.release(f.mesh).unwrap();
    f.world.sharedRefs.release(f.material).unwrap();
    expect(f.records.inspect().assets).toBe(0);
    expect(f.world.sharedRefs.refcount(f.material)).toBe(0);
  });
});

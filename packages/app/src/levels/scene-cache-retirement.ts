import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';

interface Visit {
  readonly handle: number;
  dependencies?: Iterator<number>;
}

/** Cache grants are evicted after instance retirement. Other borrowers keep their own grants. */
export function* retireUnusedSceneCache(assets: AssetRegistry, scene: number): Generator<void> {
  const records = runtimeAssets(assets);
  const visited = new Set([scene]);
  const stack: Visit[] = [{ handle: scene }];
  const order: number[] = [];
  while (stack.length > 0) {
    const visit = stack[stack.length - 1];
    if (visit === undefined) break;
    if (visit.dependencies === undefined) {
      const dependencies = records.dependencies(visit.handle);
      visit.dependencies = (dependencies.ok ? dependencies.value : [])[Symbol.iterator]();
    }
    const child = visit.dependencies.next();
    if (child.done) {
      order.push(visit.handle);
      stack.pop();
    } else if (!visited.has(child.value)) {
      visited.add(child.value);
      stack.push({ handle: child.value });
    }
    yield;
  }

  for (let i = order.length - 1; i >= 0; i--) {
    const handle = order[i];
    if (handle === undefined) continue;
    const guid = assets.guidOf(handle);
    // unload only succeeds while the exact identity has just its own cache reference.
    if (guid !== undefined) {
      for (;;) {
        const result = assets.unload(guid);
        if (result.ok) break;
        if (result.error.code !== 'asset-write-conflict') throw result.error;
        yield;
        if (assets.guidOf(handle) !== guid) break;
      }
    }
    yield;
  }
}

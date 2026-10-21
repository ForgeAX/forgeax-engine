import type { AssetReferenceOwner } from '@forgeax/engine-types';
import { runtimeAssets } from './runtime-assets';

interface Entry {
  readonly holds: number;
  readonly dependencies: readonly number[];
  readonly revision: number;
}

/** A consumer's held dependency closure. Content changes never enumerate root users. */
export class AssetClosure {
  private readonly entries = new Map<number, Entry>();

  get size(): number {
    return this.entries.size;
  }
  has(handle: number): boolean {
    return this.entries.has(handle);
  }
  version(handle: number): number | undefined {
    return this.entries.get(handle)?.revision;
  }

  begin(owner: AssetReferenceOwner) {
    const records = runtimeAssets(owner);
    const edits = new Map<number, Entry>();
    const changed = new Set<number>();
    const entry = (handle: number) => edits.get(handle) ?? this.entries.get(handle);
    const acquire = (handle: number): void => {
      const pending = [handle];
      while (pending.length > 0) {
        const handle = pending.pop();
        if (handle === undefined || handle === 0) continue;
        const current = entry(handle);
        if (current !== undefined && current.holds > 0) {
          edits.set(handle, { ...current, holds: current.holds + 1 });
          continue;
        }
        const dependencies = records.dependencies(handle).unwrap();
        edits.set(handle, { holds: 1, dependencies, revision: records.version(handle).unwrap() });
        changed.add(handle);
        for (const dependency of dependencies) pending.push(dependency);
      }
    };
    const release = (handle: number): void => {
      const pending = [handle];
      while (pending.length > 0) {
        const handle = pending.pop();
        if (handle === undefined || handle === 0) continue;
        const current = entry(handle);
        if (current === undefined || current.holds === 0)
          throw new Error('unbalanced asset closure hold');
        edits.set(handle, { ...current, holds: current.holds - 1 });
        if (current.holds === 1)
          for (const dependency of current.dependencies) pending.push(dependency);
      }
    };
    return {
      acquire,
      release,
      changed: changed as ReadonlySet<number>,
      has: (handle: number): boolean => (entry(handle)?.holds ?? 0) > 0,
      version: (handle: number): number | undefined => entry(handle)?.revision,
      update: (handle: number): boolean => {
        const current = entry(handle);
        if (current === undefined || current.holds === 0) return false;
        const revision = records.version(handle).unwrap();
        if (revision === current.revision) return false;
        const dependencies = records.dependencies(handle).unwrap();
        if (dependencies !== current.dependencies) {
          for (const dependency of dependencies) acquire(dependency);
          for (const dependency of current.dependencies) release(dependency);
        }
        edits.set(handle, { holds: entry(handle)?.holds ?? current.holds, dependencies, revision });
        changed.add(handle);
        return true;
      },
      retired: (): readonly number[] =>
        [...edits].flatMap(([handle, value]) =>
          value.holds === 0 && this.entries.has(handle) ? [handle] : [],
        ),
      commit: (): void => {
        for (const [handle, value] of edits) {
          if (value.holds === 0) this.entries.delete(handle);
          else this.entries.set(handle, value);
        }
      },
    };
  }

  clear(): void {
    this.entries.clear();
  }
}

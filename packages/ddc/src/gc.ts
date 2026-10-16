import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { withDdcLock } from './lifecycle.js';

export interface DdcGcInput {
  readonly currentKeys: readonly string[];
  readonly lastKnownGoodKeys: readonly string[];
  readonly activeLeaseKeys: readonly string[];
  readonly scopeIds?: readonly string[];
}

export interface DdcGcResult {
  readonly deleted: readonly string[];
  readonly protected: readonly string[];
}

/** Mark current/LKG/lease roots, then sweep only the same project root. */
export async function collectDdcGarbage(root: string, input: DdcGcInput): Promise<DdcGcResult> {
  return withDdcLock(root, 'gc', async () => {
    const protectedKeys = new Set([
      ...input.currentKeys,
      ...input.lastKnownGoodKeys,
      ...input.activeLeaseKeys,
    ]);
    const entries = await readdir(join(root, 'entries'), { withFileTypes: true }).catch(() => []);
    const deleted: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || protectedKeys.has(entry.name)) continue;
      await rm(join(root, 'entries', entry.name), { recursive: true, force: false });
      deleted.push(entry.name);
    }
    return { deleted, protected: [...protectedKeys].sort() };
  });
}

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertRuntimeScope,
  collectDdcGarbage,
  createRuntimeScope,
  DdcEntryStore,
  DdcLifecycle,
  ddcOutputDigest,
} from '@forgeax/engine/ddc';
import { defineFeature } from '../../lab/feature';
import { codeOf } from './support/fixture';

const GUID = '019f1a00-0000-7000-8000-0000000001e1';
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const KEY_C = 'c'.repeat(64);
const ORPHAN = 'd'.repeat(64);

async function writeEntry(root: string, key: string): Promise<void> {
  const base = {
    key,
    guid: GUID,
    payload: { key },
    refs: [],
    artifacts: {},
    receipt: { guid: GUID, key, producer: 'feature-lab', inputFingerprint: key, outputDigest: '' },
  } as const;
  await new DdcEntryStore(root).write({
    ...base,
    receipt: { ...base.receipt, outputDigest: ddcOutputDigest(base) },
  });
}

async function thrownCode(body: () => Promise<unknown>): Promise<string> {
  try {
    await body();
    return 'no-throw';
  } catch (error) {
    return codeOf(error);
  }
}

export default defineFeature({
  title: 'DDC lifecycle/CAS',
  catalog: 'DDC lifecycle/CAS',
  kind: 'headless',
  summary:
    'DdcLifecycle keeps one CAS head per GUID: a lease-guarded missing -> cooking -> current transition, last-known-good retention across failed recooks, stale and lease-lost refusals for superseded attempts, scoped runtime roots, and a mark-and-sweep GC that never deletes current, LKG, or leased entries.',
  expect:
    'Commit of a written entry becomes current and a missing entry is "invalid"; a failed recook keeps currentKey/LKG; an old key after the desired key moved, or a superseded in-flight attempt, is "stale"; replaying a consumed lease is "lease-lost"; runtime scope metadata is verified; GC deletes only the unprotected orphan.',
  async run(checks) {
    const root = await mkdtemp(join(tmpdir(), 'feature-lab-ddc-lifecycle-'));
    try {
      const lifecycle = new DdcLifecycle(root);
      checks.equal(
        'fresh GUID is missing',
        (await lifecycle.inspect(GUID, KEY_A)).state,
        'missing',
      );
      const first = await lifecycle.begin(GUID, KEY_A);
      checks.equal(
        'begin moves to cooking',
        (await lifecycle.inspect(GUID, KEY_A)).state,
        'cooking',
      );
      await writeEntry(root, KEY_A);
      checks.equal('commit of a written entry is current', await lifecycle.commit(first, KEY_A), {
        result: 'current',
        key: KEY_A,
      });
      const current = await lifecycle.readCurrentEntry(GUID);
      checks.equal(
        'current head and entry read together',
        [current.head.currentKey, current.entry?.key],
        [KEY_A, KEY_A],
      );

      const recook = await lifecycle.begin(GUID, KEY_B);
      await lifecycle.fail(recook, { code: 'producer-failed', detail: 'invalid source' });
      const failed = await lifecycle.inspect(GUID, KEY_B);
      checks.equal(
        'failed recook keeps current and LKG',
        [failed.state, failed.currentKey, failed.lastKnownGoodKey],
        ['failed', KEY_A, KEY_A],
      );

      const moved = await lifecycle.begin(GUID, KEY_B);
      checks.equal(
        'old key after desired key moved is stale',
        (await lifecycle.commit(moved, KEY_A)).result,
        'stale',
      );

      const older = await lifecycle.begin(GUID, KEY_C);
      const newer = await lifecycle.begin(GUID, KEY_C);
      checks.equal(
        'commit without a written entry is invalid',
        (await lifecycle.commit(newer, KEY_C)).result,
        'invalid',
      );
      checks.equal(
        'superseded in-flight attempt is stale',
        (await lifecycle.commit(older, KEY_C)).result,
        'stale',
      );
      const retry = await lifecycle.begin(GUID, KEY_C);
      await writeEntry(root, KEY_C);
      checks.equal('the retry commits', (await lifecycle.commit(retry, KEY_C)).result, 'current');
      await lifecycle.begin(GUID, KEY_C);
      checks.equal(
        'replaying a consumed lease is lease-lost',
        (await lifecycle.commit(retry, KEY_C)).result,
        'lease-lost',
      );

      const scope = await createRuntimeScope(root, 'feature-lab-scope');
      checks.ok(
        'runtime scope verifies',
        (await assertRuntimeScope(root, scope)).scopeHash === scope.scopeHash,
      );
      checks.equal(
        'forged scope hash code',
        await thrownCode(() => assertRuntimeScope(root, { ...scope, scopeHash: '0'.repeat(64) })),
        'ddc-scope-mismatch',
      );
      checks.equal(
        'empty scope id code',
        await thrownCode(() => createRuntimeScope(root, '')),
        'ddc-scope-mismatch',
      );

      await writeEntry(root, ORPHAN);
      const gc = await collectDdcGarbage(root, {
        currentKeys: [KEY_C],
        lastKnownGoodKeys: [KEY_A],
        activeLeaseKeys: [KEY_B],
      });
      checks.equal('GC deletes only the orphan', gc.deleted, [ORPHAN]);
      checks.equal(
        'GC keeps current, LKG, and leased entries',
        (await readdir(join(root, 'entries'))).sort(),
        [KEY_A, KEY_C],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
});

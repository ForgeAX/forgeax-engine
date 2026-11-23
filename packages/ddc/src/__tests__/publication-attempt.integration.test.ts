import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { temporaryDirectories } from '../../../../scripts/test/temporary-directories.mjs';
import { testGate } from '../../../../scripts/test/test-gate.mjs';
import { type DdcEntry, DdcEntryStore, ddcOutputDigest } from '../entry-store.js';
import { DdcLifecycle } from '../lifecycle.js';
import { ddcEntryFixture } from './entry-fixture.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const native = await importOriginal<typeof import('node:fs/promises')>();
  return { ...native, readFile: vi.fn(native.readFile) };
});

const GUID = '019e3969-1d48-7c3b-ac24-6d68f457065f';
const KEY = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const KEY_C = 'c'.repeat(64);

function entry(key = KEY): DdcEntry {
  return ddcEntryFixture(
    {
      key,
      guid: GUID,
      payload: { kind: 'fixture', key },
      refs: [],
      artifacts: {},
    },
    'fixture',
    'sha256:source',
  );
}

describe('DDC publication attempt integration', () => {
  const scratch = temporaryDirectories();

  let root: string;
  let lifecycle: DdcLifecycle;
  let store: DdcEntryStore;
  beforeEach(async () => {
    root = await scratch.make('forgeax-ddc-attempt-');
    lifecycle = new DdcLifecycle(root);
    store = new DdcEntryStore(root);
  });
  afterEach(scratch.clear);

  it.each([
    false,
    true,
  ])('revalidates an existing staged publication once before fencing its head (corrupt=%s)', async (corrupt) => {
    await store.write(entry());
    const candidate = await lifecycle.stagePublication(entry());
    const payloadPath = join(root, 'entries', KEY, 'payload.json');
    try {
      if (corrupt) {
        await writeFile(payloadPath, '{"corrupt":true}');
        await expect(candidate.commit()).rejects.toThrow();
        expect((await lifecycle.inspect(GUID, KEY)).state).not.toBe('current');
      } else {
        vi.mocked(readFile).mockClear();
        await expect(candidate.commit()).resolves.toMatchObject({ result: 'current' });
        expect(
          vi.mocked(readFile).mock.calls.filter(([path]) => String(path) === payloadPath),
        ).toHaveLength(1);
        await expect(new DdcLifecycle(root).inspect(GUID, KEY)).resolves.toMatchObject({
          state: 'current',
          currentKey: KEY,
        });
      }
    } finally {
      await candidate.discard();
    }
  });

  it('fences a cancelled attempt before its in-flight commit can advance the head', async () => {
    const candidate = await lifecycle.stagePublication(entry());
    const { promise: reachedFence, resolve: validated } = testGate();
    const { promise: allowed, resolve: release } = testGate();
    const publish = DdcEntryStore.prototype.publishForCommit;
    const hold = vi
      .spyOn(DdcEntryStore.prototype, 'publishForCommit')
      .mockImplementation(async function (this: DdcEntryStore, staged) {
        const stored = await publish.call(this, staged);
        validated();
        await allowed;
        return stored;
      });
    const committing = candidate.commit();
    try {
      await Promise.race([reachedFence, committing]);
      const discarding = candidate.discard();
      try {
        await vi.waitFor(async () => {
          expect((await lifecycle.inspect(GUID, KEY)).activeLease).toBeUndefined();
        });
      } finally {
        release();
        await discarding;
      }
      await expect(committing).resolves.toMatchObject({ result: 'lease-lost' });
      expect((await lifecycle.inspect(GUID, KEY)).currentKey).toBeUndefined();
    } finally {
      release();
      await committing.catch(() => {});
      hold.mockRestore();
    }
  });

  it('heartbeats staged candidates during a long generation before commit', async () => {
    // Advance lease time independently of contended filesystem/CPU scheduling.
    // The attempt still uses real timers and writes real on-disk heartbeats.
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const lifecycle = new DdcLifecycle(root, { leaseTtlMs: 100 });
    const candidate = await lifecycle.stagePublication(entry());
    try {
      const initialExpiry = candidate.lease.expiresAt;
      for (let beat = 0; beat < 2; beat++) {
        const previousExpiry = candidate.lease.expiresAt;
        now = previousExpiry - 25;
        await vi.waitFor(() => expect(candidate.lease.expiresAt).toBeGreaterThan(previousExpiry), {
          timeout: 2000,
          interval: 10,
        });
      }
      expect(now).toBeGreaterThan(initialExpiry);
      await expect(candidate.commit()).resolves.toMatchObject({
        result: 'current',
      });
    } finally {
      try {
        await candidate.discard();
      } finally {
        clock.mockRestore();
      }
    }
  });

  it('discards a candidate while its real heartbeat completion is pending', async () => {
    // Keep the real timer and filesystem heartbeat while isolating this test from host clock delay.
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const { promise: started, resolve: notifyStarted } = testGate();
    let notifyHeartbeatFailure = (_error: unknown) => {};
    const heartbeatFailure = new Promise<unknown>((resolve) => {
      notifyHeartbeatFailure = resolve;
    });
    const { promise: completion, resolve: resume } = testGate();
    const actualHeartbeat = DdcLifecycle.prototype.heartbeat;
    const heartbeat = vi
      .spyOn(DdcLifecycle.prototype, 'heartbeat')
      .mockImplementation(async function (this: DdcLifecycle, lease) {
        const renewed = await actualHeartbeat.call(this, lease).catch((error: unknown) => {
          notifyHeartbeatFailure(error);
          throw error;
        });
        notifyStarted();
        await completion;
        return renewed;
      });
    const lifecycle = new DdcLifecycle(root, { leaseTtlMs: 100 });
    const candidate = await lifecycle.stagePublication(entry());
    try {
      const originalLease = candidate.lease;
      const heartbeatState = await Promise.race([
        started.then(() => ({ kind: 'completion-pending' as const })),
        heartbeatFailure.then((error) => ({ kind: 'rejected' as const, error })),
      ]);
      if (heartbeatState.kind === 'rejected') {
        throw new Error('real DDC heartbeat rejected before its completion was held', {
          cause: heartbeatState.error,
        });
      }
      await candidate.discard();
      resume();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(candidate.lease).toBe(originalLease);
      expect(heartbeat).toHaveBeenCalledTimes(1);
      await expect(candidate.commit()).rejects.toThrow('closed');
    } finally {
      resume();
      try {
        await candidate.discard();
      } finally {
        heartbeat.mockRestore();
        clock.mockRestore();
      }
    }
  });

  it('rejects a conflicting immutable entry before advancing the lifecycle head', async () => {
    await store.write(entry());
    const accepted = await lifecycle.begin(GUID, KEY);
    await lifecycle.commit(accepted, KEY);
    const candidate = await lifecycle.stagePublication({
      ...entry(),
      payload: { kind: 'fixture', key: 'conflicting' },
      receipt: {
        ...entry().receipt,
        outputDigest: ddcOutputDigest({
          ...entry(),
          payload: { kind: 'fixture', key: 'conflicting' },
        }),
      },
    });

    await expect(candidate.commit()).rejects.toMatchObject({
      code: 'ddc-entry-conflict',
    });
    await expect(lifecycle.inspect(GUID, KEY)).resolves.toMatchObject({
      state: 'failed',
      currentKey: KEY,
    });
    await candidate.discard();
  });

  it('does not let a stale rollback restore over a newer active lease', async () => {
    await store.write(entry());

    const first = new DdcLifecycle(root);
    const firstCandidate = await first.stagePublication(entry());
    const second = new DdcLifecycle(root);
    const secondCandidate = await second.stagePublication(entry());

    await expect(firstCandidate.commit()).resolves.toMatchObject({
      result: 'lease-lost',
    });
    await expect(firstCandidate.restore()).resolves.toMatchObject({
      result: 'not-owner',
    });

    await expect(secondCandidate.commit()).resolves.toMatchObject({
      result: 'current',
    });
    await expect(firstCandidate.restore()).resolves.toMatchObject({
      result: 'not-owner',
    });
    await expect(second.inspect(GUID, KEY)).resolves.toMatchObject({
      state: 'current',
      currentKey: KEY,
    });
    await firstCandidate.discard();
    await secondCandidate.discard();
  });

  it('restores an own active candidate without regressing revision or generation', async () => {
    const { lease, previousHead } = await lifecycle.beginWithSnapshot(GUID, KEY);

    expect('activeLease' in previousHead).toBe(false);
    await expect(lifecycle.restoreIfCurrent(previousHead, lease)).resolves.toMatchObject({
      result: 'restored',
      revision: 1,
      generation: lease.generation,
    });
    await expect(lifecycle.inspect(GUID, KEY)).resolves.toMatchObject({
      state: 'missing',
      revision: 1,
    });

    const next = await lifecycle.begin(GUID, KEY);
    expect(next.expectedRevision).toBe(1);
    expect(next.generation).toBeGreaterThan(lease.generation);
    await lifecycle.discard(next);
  });

  it('restores an own terminal mutation while preserving the accepted head', async () => {
    await store.write(entry(KEY));
    const accepted = await lifecycle.begin(GUID, KEY);
    await expect(lifecycle.commit(accepted, KEY)).resolves.toMatchObject({ result: 'current' });

    const { lease, previousHead } = await lifecycle.beginWithSnapshot(GUID, KEY_B);
    await store.write(entry(KEY_B));
    const committed = await lifecycle.commit(lease, KEY_B);
    expect(committed.result).toBe('current');
    if (committed.result !== 'current') return;
    expect(committed.restoreFence).toMatchObject({ outcome: 'current' });
    await expect(
      lifecycle.restoreIfCurrent(previousHead, lease, committed.restoreFence),
    ).resolves.toMatchObject({ result: 'restored' });
    await expect(lifecycle.inspect(GUID, KEY_B)).resolves.toMatchObject({
      state: 'stale',
      currentKey: KEY,
      revision: (committed.head.revision ?? 0) + 1,
      generation: lease.generation,
    });
  });

  it('rolls back a newer cooking candidate without reviving its superseded writer', async () => {
    await store.write(entry(KEY));
    const accepted = await lifecycle.begin(GUID, KEY);
    await lifecycle.commit(accepted, KEY);

    const first = new DdcLifecycle(root);
    const firstCandidate = await first.stagePublication(entry(KEY_B));
    const second = new DdcLifecycle(root);
    const secondCandidate = await second.stagePublication(entry(KEY_C));

    await expect(secondCandidate.restore()).resolves.toMatchObject({
      result: 'restored',
    });
    await expect(firstCandidate.restore()).resolves.toMatchObject({
      result: 'not-owner',
    });
    await expect(second.inspect(GUID, KEY_C)).resolves.toMatchObject({
      state: 'stale',
      currentKey: KEY,
    });
    await firstCandidate.discard();
    await secondCandidate.discard();
  });

  it('fences a failed terminal mutation before restoring accepted content', async () => {
    const { lease, previousHead } = await lifecycle.beginWithSnapshot(GUID, KEY);
    const failed = await lifecycle.fail(lease, { code: 'producer-failed', detail: 'fixture' });

    expect(failed).toMatchObject({ outcome: 'failed', revision: 1 });
    await expect(lifecycle.restoreIfCurrent(previousHead, lease, failed)).resolves.toMatchObject({
      result: 'restored',
      revision: 2,
    });
    await expect(lifecycle.inspect(GUID, KEY)).resolves.toMatchObject({
      state: 'missing',
      revision: 2,
    });
  });
});

it('rejects invalid entries and closes the attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-invalid-commit-'));
  const lifecycle = new DdcLifecycle(root);
  // Inject an unreadable entry at the lifecycle's validated-publication boundary.
  // Actual post-stage disk corruption is covered by the integration case above.
  const removeAfterPublish = vi
    .spyOn(DdcEntryStore.prototype, 'publishForCommit')
    .mockResolvedValue(null);
  let staged: Awaited<ReturnType<DdcLifecycle['stagePublication']>> | undefined;
  try {
    const lease = await lifecycle.begin(GUID, KEY);
    expect((await lifecycle.commit(lease, KEY)).result).toBe('invalid');
    staged = await lifecycle.stagePublication(entry());
    expect((await staged.commit()).result).toBe('invalid');
    await expect(staged.commit()).rejects.toThrow('closed');
  } finally {
    removeAfterPublish.mockRestore();
    await staged?.discard();
    await rm(root, { recursive: true, force: true });
  }
});

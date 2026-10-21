import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as canonical from '../canonical-json.js';
import { DdcEntryStore, ddcOutputDigest } from '../entry-store.js';
import { DdcStoreError } from '../errors.js';
import { DdcLifecycle } from '../lifecycle.js';

const GUID = '019e3969-1d48-7c3b-ac24-6d68f457065f';
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const KEY_C = 'c'.repeat(64);

async function snapshotFiles(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else {
        files[path.slice(root.length + 1)] = Buffer.from(await readFile(path)).toString('base64');
      }
    }
  }
  await visit(root);
  return files;
}

async function expectHeadConflict(
  operation: () => Promise<unknown>,
  actual: 'syntax-invalid' | 'schema-invalid',
): Promise<void> {
  let error: unknown;
  try {
    await operation();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(DdcStoreError);
  expect(error).toMatchObject({
    code: 'ddc-head-conflict',
    expected: 'a valid DDC head record',
    actual,
    detail: expect.any(String),
    hint: 'inspect the current head and retry with a fresh revision',
    owner: 'engine-ddc',
    rootKind: 'project-ddc',
    recoveryActions: [
      { kind: 'inspect', executable: true },
      { kind: 'retry', executable: true },
    ],
  });
  const structured = error as DdcStoreError;
  expect(structured.detail.length).toBeLessThanOrEqual(96);
  expect(JSON.stringify(structured)).not.toContain('/heads/');
  expect(JSON.stringify(structured)).not.toContain('SyntaxError');
}

async function writeEntry(root: string, key: string): Promise<void> {
  const base = {
    key,
    guid: GUID,
    payload: { key },
    refs: [],
    artifacts: {},
    receipt: {
      guid: GUID,
      key,
      producer: 'test',
      inputFingerprint: key,
      outputDigest: '',
    },
  } as const;
  await new DdcEntryStore(root).write({
    ...base,
    receipt: { ...base.receipt, outputDigest: ddcOutputDigest(base) },
  });
}

describe('DDC lifecycle head', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('moves missing to cooking and current only after validated commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-lifecycle-'));
    roots.push(root);
    const lifecycle = new DdcLifecycle(root);

    await expect(lifecycle.inspect(GUID, KEY_A)).resolves.toMatchObject({ state: 'missing' });
    const lease = await lifecycle.begin(GUID, KEY_A);
    await expect(lifecycle.inspect(GUID, KEY_A)).resolves.toMatchObject({ state: 'cooking' });
    await writeEntry(root, KEY_A);
    await expect(lifecycle.commit(lease, KEY_A)).resolves.toMatchObject({
      result: 'current',
      head: { currentKey: KEY_A, revision: 1, generation: lease.generation },
    });
    await expect(lifecycle.inspect(GUID, KEY_A)).resolves.toMatchObject({
      state: 'current',
      currentKey: KEY_A,
    });
  });

  it('returns the exact accepted head and LKG after one commit validation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-lifecycle-'));
    roots.push(root);
    const lifecycle = new DdcLifecycle(root);
    const first = await lifecycle.begin(GUID, KEY_A);
    await writeEntry(root, KEY_A);
    await lifecycle.commit(first, KEY_A);
    const lease = await lifecycle.begin(GUID, KEY_B);
    await writeEntry(root, KEY_B);
    const read = vi.spyOn(DdcEntryStore.prototype, 'read');
    const readChecked = vi.spyOn(DdcEntryStore.prototype, 'readChecked');
    try {
      const result = await lifecycle.commit(lease, KEY_B);
      expect(result).toEqual({
        result: 'current',
        head: {
          guid: GUID,
          desiredKey: KEY_B,
          state: 'current',
          currentKey: KEY_B,
          lastKnownGoodKey: KEY_A,
          revision: 2,
          generation: lease.generation,
        },
        restoreFence: {
          attempt: lease.attempt,
          generation: lease.generation,
          revision: 2,
          desiredKey: KEY_B,
          outcome: 'current',
          key: KEY_B,
          currentKey: KEY_B,
          lastKnownGoodKey: KEY_A,
        },
      });
      expect(read).toHaveBeenCalledExactlyOnceWith(KEY_B);
      expect(readChecked).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
      readChecked.mockRestore();
    }
  });

  it('reads the accepted entry together with its projected current head', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-lifecycle-'));
    roots.push(root);
    const lifecycle = new DdcLifecycle(root);
    const lease = await lifecycle.begin(GUID, KEY_A);
    await writeEntry(root, KEY_A);
    await lifecycle.commit(lease, KEY_A);

    await expect(lifecycle.readCurrentEntry(GUID)).resolves.toMatchObject({
      head: { state: 'current', desiredKey: KEY_A, currentKey: KEY_A },
      entry: { key: KEY_A, guid: GUID, payload: { key: KEY_A } },
    });
  });

  it('retains last-known-good when recook fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-lifecycle-'));
    roots.push(root);
    const lifecycle = new DdcLifecycle(root);
    const first = await lifecycle.begin(GUID, KEY_A);
    await writeEntry(root, KEY_A);
    await lifecycle.commit(first, KEY_A);
    const second = await lifecycle.begin(GUID, KEY_B);
    await lifecycle.fail(second, { code: 'producer-failed', detail: 'invalid source' });

    await expect(lifecycle.inspect(GUID, KEY_B)).resolves.toMatchObject({
      state: 'failed',
      lastKnownGoodKey: KEY_A,
      currentKey: KEY_A,
      failure: { code: 'producer-failed' },
    });
  });

  it('does not promote an old result after the desired key changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-lifecycle-'));
    roots.push(root);
    const lifecycle = new DdcLifecycle(root);
    const first = await lifecycle.begin(GUID, KEY_A);
    await writeEntry(root, KEY_A);
    await lifecycle.commit(first, KEY_A);
    const second = await lifecycle.begin(GUID, KEY_B);

    await expect(lifecycle.inspect(GUID, KEY_B)).resolves.toMatchObject({
      state: 'cooking',
      lastKnownGoodKey: KEY_A,
    });
    await expect(lifecycle.commit(second, KEY_A)).resolves.toEqual({
      result: 'stale',
      key: KEY_A,
      revision: 1,
    });
    await expect(lifecycle.inspect(GUID, KEY_B)).resolves.toMatchObject({
      state: 'stale',
      lastKnownGoodKey: KEY_A,
      currentKey: KEY_A,
    });
  });

  it('uses a persisted heartbeat expiry with an older lease token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-lifecycle-'));
    roots.push(root);
    const lifecycle = new DdcLifecycle(root, { leaseTtlMs: 100 });
    let now = 1_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const lease = await lifecycle.begin(GUID, KEY_A);
      await writeEntry(root, KEY_A);

      now = 1_050;
      await expect(lifecycle.heartbeat(lease)).resolves.toMatchObject({ expiresAt: 1_150 });

      // The original token has expired, but the persisted active lease for the
      // same attempt is still alive after the heartbeat refresh.
      now = 1_101;
      await expect(lifecycle.commit(lease, KEY_A)).resolves.toMatchObject({ result: 'current' });

      const newer = await lifecycle.begin(GUID, KEY_B);
      await expect(lifecycle.commit(lease, KEY_A)).resolves.toMatchObject({ result: 'lease-lost' });
      await lifecycle.close(newer);
    } finally {
      clock.mockRestore();
    }
  });

  it('fences expiry after immutable entry validation finishes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-lifecycle-'));
    roots.push(root);
    await writeEntry(root, KEY_A);
    const lifecycle = new DdcLifecycle(root, { leaseTtlMs: 100 });
    let now = 1_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const read = DdcEntryStore.prototype.read;
    try {
      const lease = await lifecycle.begin(GUID, KEY_A);
      const validation = vi
        .spyOn(DdcEntryStore.prototype, 'read')
        .mockImplementation(async function (this: DdcEntryStore, key) {
          const result = await read.call(this, key);
          now = 1_101;
          return result;
        });
      try {
        await expect(lifecycle.commit(lease, KEY_A)).rejects.toMatchObject({
          code: 'ddc-lease-expired',
        });
        expect(
          JSON.parse(await readFile(join(root, 'heads', `${GUID}.json`), 'utf8')).currentKey,
        ).toBeUndefined();
      } finally {
        validation.mockRestore();
      }
    } finally {
      clock.mockRestore();
    }
  });

  it('cannot revive an expired persisted lease with a heartbeat', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-lifecycle-'));
    roots.push(root);
    const lifecycle = new DdcLifecycle(root, { leaseTtlMs: 100 });
    let now = 1_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const lease = await lifecycle.begin(GUID, KEY_A);
      const before = await snapshotFiles(root);
      now = 1_101;
      await expect(lifecycle.heartbeat(lease)).rejects.toMatchObject({ code: 'ddc-lease-expired' });
      expect(await snapshotFiles(root)).toEqual(before);
    } finally {
      clock.mockRestore();
    }
  });

  it('rejects heartbeat tokens with a different expected revision or desired key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-lifecycle-'));
    roots.push(root);
    const lifecycle = new DdcLifecycle(root);
    const lease = await lifecycle.begin(GUID, KEY_A);
    const before = await snapshotFiles(root);
    for (const token of [
      { ...lease, expectedRevision: lease.expectedRevision + 1 },
      { ...lease, desiredKey: KEY_B },
    ]) {
      await expect(lifecycle.heartbeat(token)).rejects.toMatchObject({ code: 'ddc-lease-expired' });
      expect(await snapshotFiles(root)).toEqual(before);
    }
    await expect(lifecycle.heartbeat(lease)).resolves.toMatchObject({ attempt: lease.attempt });
  });

  it('permits an owner heartbeat while immutable entry validation is pending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-lifecycle-'));
    roots.push(root);
    await writeEntry(root, KEY_A);
    const lifecycle = new DdcLifecycle(root);
    const lease = await lifecycle.begin(GUID, KEY_A);
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = DdcEntryStore.prototype.read;
    const validation = vi.spyOn(DdcEntryStore.prototype, 'read').mockImplementation(async function (
      this: DdcEntryStore,
      key,
    ) {
      const result = await read.call(this, key);
      entered();
      await barrier;
      return result;
    });
    const committing = lifecycle.commit(lease, KEY_A);
    await reading;
    const heartbeat = lifecycle.heartbeat(lease);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const refreshed = await Promise.race([
        heartbeat.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 500);
        }),
      ]);
      expect(refreshed).toBe(true);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      release();
      await Promise.allSettled([committing, heartbeat]);
      validation.mockRestore();
    }
  });

  it('starts an owner heartbeat during numeric-payload integrity hashing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-lifecycle-'));
    roots.push(root);
    const value = {
      key: KEY_A,
      guid: GUID,
      payload: Array.from({ length: 1_000_000 }, (_, index) => index % 256),
      refs: [],
      artifacts: {},
    };
    await new DdcEntryStore(root).write({
      ...value,
      receipt: {
        key: KEY_A,
        guid: GUID,
        producer: 'test',
        inputFingerprint: KEY_A,
        outputDigest: ddcOutputDigest(value),
      },
    });
    const lifecycle = new DdcLifecycle(root);
    const lease = await lifecycle.begin(GUID, KEY_A);
    const digest = canonical.canonicalDdcReadbackDigests;
    let hashing = false;
    let startedWhileHashing = false;
    let heartbeat: Promise<unknown> | undefined;
    const validation = vi
      .spyOn(canonical, 'canonicalDdcReadbackDigests')
      .mockImplementation(async (input, json) => {
        hashing = true;
        if (heartbeat === undefined) {
          heartbeat = new Promise<void>((resolve, reject) => {
            setImmediate(() => {
              startedWhileHashing = hashing;
              lifecycle.heartbeat(lease).then(() => {
                resolve();
              }, reject);
            });
          });
        }
        // Observe the real hash interval, then finish the real heartbeat before
        // returning validation: commit may otherwise retire its lease first.
        const result = await digest(input, json).finally(() => {
          hashing = false;
        });
        await heartbeat;
        return result;
      });
    try {
      await expect(lifecycle.commit(lease, KEY_A)).resolves.toMatchObject({ result: 'current' });
      await heartbeat;
      expect(startedWhileHashing).toBe(true);
    } finally {
      await heartbeat;
      validation.mockRestore();
    }
  });

  it('rejects a lease superseded while its immutable entry was being validated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-lifecycle-'));
    roots.push(root);
    await writeEntry(root, KEY_A);
    const lifecycle = new DdcLifecycle(root);
    const lease = await lifecycle.begin(GUID, KEY_A);
    const read = DdcEntryStore.prototype.read;
    let successor: Awaited<ReturnType<DdcLifecycle['begin']>> | undefined;
    const validation = vi.spyOn(DdcEntryStore.prototype, 'read').mockImplementation(async function (
      this: DdcEntryStore,
      key,
    ) {
      const result = await read.call(this, key);
      successor = await lifecycle.begin(GUID, KEY_B);
      return result;
    });
    try {
      await expect(lifecycle.commit(lease, KEY_A)).resolves.toMatchObject({ result: 'stale' });
      const head = JSON.parse(await readFile(join(root, 'heads', `${GUID}.json`), 'utf8'));
      expect(head.active.attempt).toBe(successor?.attempt);
      expect(head.desiredKey).toBe(KEY_B);
      expect(head.currentKey).toBeUndefined();
    } finally {
      validation.mockRestore();
    }
  });

  it('keeps a first cook failure failed without inventing a current or LKG', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-lifecycle-'));
    roots.push(root);
    const lifecycle = new DdcLifecycle(root);
    const lease = await lifecycle.begin(GUID, KEY_A);
    await lifecycle.fail(lease, { code: 'producer-failed', detail: 'missing input' });

    await expect(lifecycle.inspect(GUID, KEY_A)).resolves.toMatchObject({
      state: 'failed',
      currentKey: undefined,
      lastKnownGoodKey: undefined,
    });
  });

  it('reports a corrupt current entry as failed with its identity preserved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-lifecycle-'));
    roots.push(root);
    const lifecycle = new DdcLifecycle(root);
    const store = new DdcEntryStore(root);
    const firstLease = await lifecycle.begin(GUID, KEY_A);
    await writeEntry(root, KEY_A);
    await expect(lifecycle.commit(firstLease, KEY_A)).resolves.toMatchObject({
      result: 'current',
      head: { currentKey: KEY_A },
    });
    const lease = await lifecycle.begin(GUID, KEY_B);
    await writeEntry(root, KEY_B);
    await expect(lifecycle.commit(lease, KEY_B)).resolves.toMatchObject({
      result: 'current',
      head: { currentKey: KEY_B },
    });

    const receiptPath = join(root, 'entries', KEY_B, 'receipt.json');
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as { outputDigest: string };
    await writeFile(
      receiptPath,
      JSON.stringify({ ...receipt, outputDigest: `sha256:${'0'.repeat(64)}` }),
    );

    await expect(store.readChecked(KEY_B)).resolves.toMatchObject({
      ok: false,
      error: { code: 'ddc-entry-invalid' },
    });
    await expect(lifecycle.inspect(GUID, KEY_B)).resolves.toMatchObject({
      state: 'failed',
      currentKey: KEY_B,
      lastKnownGoodKey: KEY_A,
      failure: { code: 'ddc-entry-invalid' },
    });
  });

  it.each([
    { label: 'syntax-invalid', bytes: Buffer.from('{'), actual: 'syntax-invalid' as const },
    {
      label: 'schema-invalid',
      bytes: Buffer.from(JSON.stringify({ guid: GUID, desiredKey: KEY_B, revision: 'bad' })),
      actual: 'schema-invalid' as const,
    },
  ])('refuses an existing $label head without mutation and recovers on same-lifecycle repair', async ({
    bytes,
    actual,
  }) => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-lifecycle-'));
    roots.push(root);
    const lifecycle = new DdcLifecycle(root);
    const store = new DdcEntryStore(root);
    const firstLease = await lifecycle.begin(GUID, KEY_A);
    await writeEntry(root, KEY_A);
    await expect(lifecycle.commit(firstLease, KEY_A)).resolves.toMatchObject({
      result: 'current',
      head: { currentKey: KEY_A },
    });
    const secondLease = await lifecycle.begin(GUID, KEY_B);
    await writeEntry(root, KEY_B);
    await expect(lifecycle.commit(secondLease, KEY_B)).resolves.toMatchObject({
      result: 'current',
      head: { currentKey: KEY_B },
    });

    const headPath = join(root, 'heads', `${encodeURIComponent(GUID)}.json`);
    const validHeadBytes = await readFile(headPath);
    const prior = await lifecycle.inspect(GUID, KEY_B);
    expect(prior).toMatchObject({
      state: 'current',
      currentKey: KEY_B,
      lastKnownGoodKey: KEY_A,
    });
    const entryBytes = await snapshotFiles(join(root, 'entries'));
    await writeFile(headPath, bytes);
    const malformedFiles = await snapshotFiles(root);

    await expectHeadConflict(() => lifecycle.inspect(GUID, KEY_B), actual);
    await expect(snapshotFiles(root)).resolves.toEqual(malformedFiles);
    await expect(store.read(KEY_A)).resolves.toMatchObject({ key: KEY_A, guid: GUID });
    await expect(store.read(KEY_B)).resolves.toMatchObject({ key: KEY_B, guid: GUID });

    await expectHeadConflict(() => lifecycle.begin(GUID, KEY_C), actual);
    await expect(snapshotFiles(root)).resolves.toEqual(malformedFiles);
    await expect(snapshotFiles(join(root, 'entries'))).resolves.toEqual(entryBytes);

    await writeFile(headPath, validHeadBytes);
    await expect(lifecycle.inspect(GUID, KEY_B)).resolves.toEqual(prior);
    await expect(lifecycle.inspect(GUID, KEY_B)).resolves.toEqual(prior);

    const nextLease = await lifecycle.begin(GUID, KEY_C);
    expect(nextLease.expectedRevision).toBe(prior.revision);
    expect(nextLease.generation).toBe((prior.generation ?? 0) + 1);
    await lifecycle.close(nextLease);
  });
});

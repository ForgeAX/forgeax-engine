import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DdcEntryStore, DdcLifecycle, DdcStoreError, ddcOutputDigest } from '@forgeax/engine-ddc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { temporaryDirectories } from '../../../../scripts/test/temporary-directories.mjs';
import {
  commitImportPublication,
  type ImportPublicationInput,
  readImportPublication,
  stageImportPublication,
} from '../source-package-publication.js';

const GUID = '019e3969-1d48-7c3b-ac24-6d68f457065f';
const KEY = 'a'.repeat(64);
const ARTIFACT_PATH = `${GUID}/body.bin`;
const ARTIFACT_BYTES = new Uint8Array([9, 8, 7]);
const ARTIFACT_DIGEST = `sha256:${createHash('sha256').update(ARTIFACT_BYTES).digest('hex')}`;

const validArtifact = {
  path: ARTIFACT_PATH,
  mediaType: 'application/octet-stream',
  bytes: ARTIFACT_BYTES,
};

const validDescriptor = {
  path: ARTIFACT_PATH,
  mediaType: validArtifact.mediaType,
  byteLength: ARTIFACT_BYTES.byteLength,
  integrity: { algorithm: 'sha256' as const, digest: ARTIFACT_DIGEST },
};

function closurePack(
  artifacts: Readonly<Record<string, unknown>> = { body: validDescriptor },
): Record<string, unknown> {
  return {
    schemaVersion: '2.0.0',
    kind: 'internal-text-package',
    assets: [
      {
        guid: GUID,
        kind: 'fixture',
        payload: { value: 'same' },
        refs: [],
        artifacts,
      },
    ],
  };
}

function input(root: string, desiredKey = KEY): ImportPublicationInput {
  return {
    root,
    guid: GUID,
    desiredKey,
    pack: {
      schemaVersion: '2.0.0',
      assets: [{ guid: GUID, kind: 'fixture', payload: { value: 'same' }, refs: [] }],
    },
    previousCatalog: [],
    nextCatalog: [],
    publishedGuids: [GUID],
  };
}

async function acceptedStage(publication: ImportPublicationInput) {
  const result = await stageImportPublication(publication);
  if (!result.ok) throw result.error;
  return result.candidate;
}

describe('source package publication concurrency', () => {
  const scratch = temporaryDirectories();

  afterEach(async () => {
    vi.restoreAllMocks();
    await scratch.clear();
  });

  it('restores an unchanged publication without a lease or staging', async () => {
    const root = await scratch.make('forgeax-source-publication-reuse-');
    const candidateBytes = new Uint8Array(ARTIFACT_BYTES);
    const pack = {
      ...closurePack(),
      scopeId: 'dev',
      generation: 1,
      digest: 'same-content',
      outputSetDigest: 'same-outputs',
    };
    const publicationInput = {
      ...input(root),
      pack,
      artifacts: [{ ...validArtifact, bytes: candidateBytes }],
    };
    const staged = await acceptedStage(publicationInput);
    const published = await commitImportPublication(staged);
    expect(published.ok).toBe(true);
    const before = await readFile(join(root, 'heads', `${GUID}.json`), 'utf8');
    const stage = vi.spyOn(DdcEntryStore.prototype, 'stage');
    const begin = vi.spyOn(DdcLifecycle.prototype, 'beginWithSnapshot');
    const checked = vi.spyOn(DdcEntryStore.prototype, 'readChecked');
    const readCurrent = DdcLifecycle.prototype.readCurrentEntry;
    vi.spyOn(DdcLifecycle.prototype, 'readCurrentEntry').mockImplementationOnce(async function (
      this: DdcLifecycle,
      guid,
    ) {
      const current = await readCurrent.call(this, guid);
      // A producer retaining its buffers cannot rewrite the restored route across an await.
      candidateBytes.fill(0);
      return current;
    });

    const restored = await readImportPublication({
      ...publicationInput,
      pack: { ...pack, generation: 9 },
    });

    expect(restored).toMatchObject({ key: KEY, head: { state: 'current', revision: 1 } });
    expect(restored?.pack).toEqual({ ...pack, generation: 9 });
    expect(restored?.artifacts[ARTIFACT_PATH]?.bytes).toEqual(ARTIFACT_BYTES);
    expect(stage).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    expect(checked).toHaveBeenCalledExactlyOnceWith(KEY);
    expect(await readFile(join(root, 'heads', `${GUID}.json`), 'utf8')).toBe(before);
    expect(await readdir(join(root, 'staging'))).toEqual([]);
  });

  it('keeps changed, corrupt and actively leased publications on the ordinary path', async () => {
    const root = await scratch.make('forgeax-source-publication-reuse-controls-');
    const pack = closurePack();
    const publicationInput = {
      ...input(root),
      pack,
      artifacts: [validArtifact],
    };
    const staged = await acceptedStage(publicationInput);
    expect(await commitImportPublication(staged)).toMatchObject({ ok: true });
    expect(
      await readImportPublication({ ...publicationInput, desiredKey: 'b'.repeat(64) }),
    ).toBeUndefined();
    expect(
      await readImportPublication({ ...publicationInput, pack: { ...pack, changed: true } }),
    ).toBeUndefined();
    expect(
      await readImportPublication({
        ...publicationInput,
        artifacts: [],
      }),
    ).toBeUndefined();
    const lifecycle = new DdcLifecycle(root);
    const lease = await lifecycle.begin(GUID, KEY);
    expect(await readImportPublication(publicationInput)).toBeUndefined();
    await lifecycle.discard(lease);
    const artifactFile = Buffer.from(ARTIFACT_PATH).toString('base64url');
    await writeFile(
      join(root, 'entries', KEY, 'artifacts', `${artifactFile}.bin`),
      new Uint8Array([0]),
    );
    expect(await readImportPublication(publicationInput)).toBeUndefined();
    expect(await lifecycle.inspect(GUID, KEY)).toMatchObject({ state: 'failed' });
  });

  it('enables publication timing only from an explicit host input', async () => {
    const root = await scratch.make('forgeax-source-timing-');
    const previous = process.env.FORGEAX_WORKSPACE_TIMING;
    process.env.FORGEAX_WORKSPACE_TIMING = '1';
    const writes = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const records = () =>
      writes.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.startsWith('[forgeax.meta-publication.timing]'));
    try {
      const quiet = await acceptedStage(input(root));
      await quiet.ddc.discard();
      expect(records()).toEqual([]);
      process.env.FORGEAX_WORKSPACE_TIMING = '0';
      const traced = await acceptedStage({ ...input(root), traceTiming: true });
      await traced.ddc.discard();
      expect(records().map((line) => JSON.parse(line.slice(line.indexOf('{'))).stage)).toEqual([
        'artifact-closure',
        'immutable-payload',
        'ddc-stage',
      ]);
    } finally {
      writes.mockRestore();
      if (previous === undefined) delete process.env.FORGEAX_WORKSPACE_TIMING;
      else process.env.FORGEAX_WORKSPACE_TIMING = previous;
    }
  });

  it('returns the accepted head without rereading the committed artifact closure', async () => {
    const root = await scratch.make('forgeax-source-publication-');
    const pack = closurePack();
    const staged = await acceptedStage({
      ...input(root),
      pack,
      artifacts: [validArtifact],
    });
    const read = vi.spyOn(DdcEntryStore.prototype, 'read');
    const readChecked = vi.spyOn(DdcEntryStore.prototype, 'readChecked');

    const result = await commitImportPublication(staged);

    expect(result).toMatchObject({
      ok: true,
      head: {
        guid: GUID,
        desiredKey: KEY,
        state: 'current',
        currentKey: KEY,
        revision: 1,
        generation: staged.ddc.lease.generation,
      },
      revision: { digest: KEY, rootId: root },
    });
    expect(read).not.toHaveBeenCalled();
    expect(readChecked).not.toHaveBeenCalled();
  });

  it('keeps a later writer out of the head and revision returned for this publication', async () => {
    const root = await scratch.make('forgeax-source-publication-');
    const staged = await acceptedStage({
      ...input(root),
      nextCatalog: [
        {
          guid: GUID,
          kind: 'fixture',
          sourcePath: 'fixture.meta.json',
          packageUrl: '/fixture.pack.json',
        },
      ],
    });
    const nextKey = 'b'.repeat(64);
    const commit = DdcLifecycle.prototype.commit;
    vi.spyOn(DdcLifecycle.prototype, 'commit').mockImplementation(async function (
      this: DdcLifecycle,
      lease,
      key,
      entry,
    ) {
      const result = await commit.call(this, lease, key, entry);
      if (result.result === 'current' && key === KEY) {
        // Another producer wins after this CAS, before Import receives its result.
        const next = await acceptedStage(input(root, nextKey));
        expect(await commitImportPublication(next)).toMatchObject({ ok: true });
      }
      return result;
    });

    const result = await commitImportPublication(staged);

    expect(result).toMatchObject({
      ok: true,
      head: {
        state: 'current',
        desiredKey: KEY,
        currentKey: KEY,
        revision: 1,
        generation: staged.ddc.lease.generation,
      },
      revision: { digest: KEY },
      catalog: [{ guid: GUID, revision: { digest: KEY } }],
    });
    await expect(new DdcLifecycle(root).inspect(GUID, nextKey)).resolves.toMatchObject({
      state: 'current',
      currentKey: nextKey,
      lastKnownGoodKey: KEY,
      revision: 2,
    });
  });

  it('waits for an equivalent newer owner when commit loses its lease', async () => {
    const root = await scratch.make('forgeax-source-publication-');
    const publicationInput = input(root);
    const first = await acceptedStage(publicationInput);
    const second = await acceptedStage(publicationInput);

    const winner = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return commitImportPublication(second);
    })();
    const loser = await commitImportPublication(first);
    const winnerResult = await winner;

    expect(loser).toMatchObject({ ok: true, head: { state: 'current', currentKey: KEY } });
    expect(winnerResult).toMatchObject({ ok: true, head: { state: 'current', currentKey: KEY } });
  });

  it('keeps a stale publication with a different desired key fail-closed', async () => {
    const root = await scratch.make('forgeax-source-publication-');
    const first = await acceptedStage(input(root, 'a'.repeat(64)));
    const second = await acceptedStage(input(root, 'b'.repeat(64)));

    const result = await commitImportPublication(first);
    await second.ddc.discard();

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'source-package-ddc-failed',
        detail: 'DDC lifecycle commit returned lease-lost',
      },
    });
    if (!result.ok) {
      expect(result.error.hint).toContain('retry');
      expect(result.error.hint).not.toContain('discard');
      expect(result.error.diagnostic.detail.ddcCommitResult).toBe('lease-lost');
      expect(result.error.diagnostic.detail.ddcError).toBeUndefined();
    }
  });

  it('retains the lease failure and retry guidance when the published entry is valid', async () => {
    const root = await scratch.make('forgeax-source-publication-');
    const staged = await acceptedStage(input(root));
    const expiredAt = staged.ddc.lease.expiresAt + 1;
    vi.spyOn(Date, 'now').mockReturnValue(expiredAt);

    const result = await commitImportPublication(staged);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'source-package-ddc-failed',
        hint: 'discard the stale commit and acquire a new lease',
        diagnostic: {
          detail: {
            reason: 'cook lease expired before commit fencing',
            ddcError: {
              code: 'ddc-lease-expired',
              lease: staged.ddc.lease.attempt,
              owner: 'engine-ddc',
              recoveryActions: [{ kind: 'release-lease' }, { kind: 'retry' }],
            },
          },
        },
      },
    });
    expect(await new DdcEntryStore(root).read(KEY)).not.toBeNull();
  });

  it('keeps an immutable conflict diagnostic and the verified existing entry', async () => {
    const root = await scratch.make('forgeax-source-publication-');
    const first = await acceptedStage(input(root));
    expect(await commitImportPublication(first)).toMatchObject({ ok: true });
    const existing = await new DdcEntryStore(root).read(KEY);
    const competing = await acceptedStage({
      ...input(root),
      pack: { schemaVersion: '2.0.0', assets: [{ guid: GUID, payload: { value: 'different' } }] },
    });

    const result = await commitImportPublication(competing);

    expect(result).toMatchObject({
      ok: false,
      error: {
        hint: 'keep the verified entry and reject the competing publication',
        diagnostic: { detail: { ddcError: { code: 'ddc-entry-conflict' } } },
      },
    });
    expect(await new DdcEntryStore(root).read(KEY)).toEqual(existing);
  });

  it('retains staging recovery evidence without exposing host-only targets', async () => {
    const root = await scratch.make('forgeax-source-publication-');
    const failure = new DdcStoreError({
      code: 'ddc-entry-invalid',
      detail: 'entry integrity mismatch',
      hostPath: '/private/cache/entry',
      recoveryActions: [
        { kind: 'cold-rebuild', executable: true, exactTarget: '/private/cache/entry' },
      ],
    });
    vi.spyOn(DdcEntryStore.prototype, 'stage').mockRejectedValueOnce(failure);

    const result = await stageImportPublication(input(root));

    expect(result).toMatchObject({
      ok: false,
      error: {
        hint: failure.hint,
        diagnostic: { detail: { reason: failure.detail, ddcError: failure.toBrowserProjection() } },
      },
    });
    expect(JSON.stringify(result)).not.toContain('/private/cache/entry');
  });

  it('commits concurrent equivalent DDC publications', async () => {
    const root = await scratch.make('forgeax-source-publication-');
    const staged = await Promise.all(
      Array.from({ length: 8 }, () => stageImportPublication(input(root))),
    );
    const results = await Promise.all(
      staged.map((item) => (item.ok ? commitImportPublication(item.candidate) : item)),
    );
    expect(results).toEqual(
      Array.from({ length: 8 }, () =>
        expect.objectContaining({
          ok: true,
          key: KEY,
          head: expect.objectContaining({ currentKey: KEY }),
        }),
      ),
    );
    expect(await new DdcEntryStore(root).listKeys()).toEqual([KEY]);
  });

  it.each([
    false,
    true,
  ])('stores the same immutable closure across publication generations (shared DDC=%s)', async (shared) => {
    const firstRoot = await scratch.make('forgeax-source-publication-');
    const secondRoot = shared ? firstRoot : await scratch.make('forgeax-source-publication-');
    const semantic = {
      ...closurePack(),
      digest: 'sha256:semantic',
      outputSetDigest: 'sha256:outputs',
    };
    const firstPack = { ...semantic, scopeId: 'first-scope', generation: 1114181571 };
    const secondPack = { ...semantic, scopeId: 'second-scope', generation: 2018541951 };

    const first = await acceptedStage({
      ...input(firstRoot),
      pack: firstPack,
      artifacts: [validArtifact],
    });
    const second = await acceptedStage({
      ...input(secondRoot),
      pack: secondPack,
      artifacts: [validArtifact],
    });
    // In one DDC, the newer lease wins and the older writer reuses its accepted closure.
    expect(await commitImportPublication(second)).toMatchObject({ ok: true });
    expect(await commitImportPublication(first)).toMatchObject({ ok: true });

    const firstEntry = await new DdcEntryStore(firstRoot).read(KEY);
    const secondEntry = await new DdcEntryStore(secondRoot).read(KEY);
    expect(firstEntry?.payload).toEqual(semantic);
    expect(secondEntry?.payload).toEqual(semantic);
    expect(firstEntry?.artifacts[ARTIFACT_PATH]).toMatchObject({
      mediaType: validArtifact.mediaType,
      bytes: validArtifact.bytes,
    });
    expect(secondEntry?.artifacts).toEqual(firstEntry?.artifacts);
    expect(firstEntry?.receipt.publicationGeneration).toBe(
      shared ? secondPack.generation : firstPack.generation,
    );
    expect(secondEntry?.receipt.publicationGeneration).toBe(secondPack.generation);
    expect(firstEntry?.receipt.outputDigest).toBe(secondEntry?.receipt.outputDigest);
  });

  it('reuses a legacy runtime payload when only its publication generation changes', async () => {
    const root = await scratch.make('forgeax-source-publication-');
    const oldPack = {
      ...(input(root).pack as {
        readonly assets: readonly unknown[];
        readonly schemaVersion: '2.0.0';
      }),
      kind: 'internal-text-package' as const,
      scopeId: 'old-scope',
      generation: 1114181571,
      digest: 'sha256:semantic',
      outputSetDigest: 'sha256:outputs',
    };
    await expect(
      new DdcEntryStore(root).write({
        key: KEY,
        guid: GUID,
        payload: oldPack,
        refs: [],
        artifacts: {},
        receipt: {
          guid: GUID,
          key: KEY,
          producer: 'engine-import/source-package-publication',
          inputFingerprint: KEY,
          outputDigest: ddcOutputDigest({
            guid: GUID,
            payload: oldPack,
            refs: [],
            artifacts: {},
          }),
        },
      }),
    ).resolves.toMatchObject({ result: 'published' });

    const nextPack = { ...oldPack, scopeId: 'new-scope', generation: 2018541951 };
    const second = await acceptedStage({ ...input(root), pack: nextPack });
    await expect(commitImportPublication(second)).resolves.toMatchObject({ ok: true });

    await expect(new DdcEntryStore(root).read(KEY)).resolves.toMatchObject({ payload: oldPack });
  });

  it.each([
    {
      label: 'missing body',
      pack: closurePack(),
      artifacts: [],
    },
    {
      label: 'media type mismatch',
      pack: closurePack(),
      artifacts: [{ ...validArtifact, mediaType: 'application/x-wrong' }],
    },
    {
      label: 'byte length mismatch',
      pack: closurePack(),
      artifacts: [{ ...validArtifact, bytes: new Uint8Array([9, 8]) }],
    },
    {
      label: 'sha256 mismatch',
      pack: closurePack({
        body: {
          ...validDescriptor,
          integrity: { algorithm: 'sha256' as const, digest: 'sha256:bad' },
        },
      }),
      artifacts: [validArtifact],
    },
    {
      label: 'duplicate transport path',
      pack: closurePack(),
      artifacts: [validArtifact, validArtifact],
    },
    {
      label: 'duplicate descriptor path',
      pack: closurePack({ body: validDescriptor, alias: { ...validDescriptor } }),
      artifacts: [validArtifact],
    },
    {
      label: 'unexpected transport body',
      pack: closurePack(),
      artifacts: [
        validArtifact,
        {
          path: `${GUID}/extra.bin`,
          mediaType: 'application/octet-stream',
          bytes: new Uint8Array([1]),
        },
      ],
    },
  ] as const)('rejects $label before advancing the DDC head', async ({ pack, artifacts }) => {
    for (const wire of [false, true]) {
      const publishedPack = wire
        ? { schemaVersion: 'pack-material-programs/2', pack, programs: [], abis: [] }
        : pack;
      const root = await scratch.make('forgeax-source-publication-');
      const publicationInput: ImportPublicationInput = {
        ...input(root),
        pack: publishedPack,
        artifacts,
      };

      const staged = await stageImportPublication(publicationInput);

      expect(staged).toMatchObject({
        ok: false,
        error: {
          code: 'source-package-publication-invalid',
        },
        head: { state: 'missing' },
      });
      expect(await new DdcEntryStore(root).listKeys()).toEqual([]);
    }
  });
});

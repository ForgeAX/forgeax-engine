import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DdcEntryStore, DdcLifecycle, ddcOutputDigest } from '@forgeax/engine-ddc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  commitImportPublication,
  discardImportPublication,
  type ImportPublicationInput,
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

describe('source package publication concurrency', () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('returns the accepted head without rereading the committed artifact closure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-source-publication-'));
    roots.push(root);
    const pack = closurePack();
    const staged = await stageImportPublication({
      ...input(root),
      pack,
      transport: {
        path: join(root, 'runtime', `${GUID}.pack.json`),
        body: JSON.stringify(pack),
        artifacts: [validArtifact],
      },
    });
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    const read = vi.spyOn(DdcEntryStore.prototype, 'read');
    const readChecked = vi.spyOn(DdcEntryStore.prototype, 'readChecked');

    const result = await commitImportPublication(staged.candidate);

    expect(result).toMatchObject({
      ok: true,
      head: {
        guid: GUID,
        desiredKey: KEY,
        state: 'current',
        currentKey: KEY,
        revision: 1,
        generation: staged.candidate.ddc.lease.generation,
      },
      revision: { digest: KEY, rootId: root },
      transportPersisted: true,
    });
    expect(read).toHaveBeenCalledExactlyOnceWith(KEY);
    expect(readChecked).not.toHaveBeenCalled();
    expect(await readFile(join(root, 'runtime', `${GUID}.pack.json`), 'utf8')).toBe(
      JSON.stringify(pack),
    );
  });

  it('keeps a later writer out of the head and revision returned for this publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-source-publication-'));
    roots.push(root);
    const staged = await stageImportPublication({
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
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    const nextKey = 'b'.repeat(64);
    const commit = DdcLifecycle.prototype.commit;
    vi.spyOn(DdcLifecycle.prototype, 'commit').mockImplementation(async function (
      this: DdcLifecycle,
      lease,
      key,
    ) {
      const result = await commit.call(this, lease, key);
      if (result.result === 'current' && key === KEY) {
        // Another producer wins after this CAS, before Import receives its result.
        const next = await stageImportPublication(input(root, nextKey));
        expect(next.ok).toBe(true);
        if (next.ok)
          expect(await commitImportPublication(next.candidate)).toMatchObject({ ok: true });
      }
      return result;
    });

    const result = await commitImportPublication(staged.candidate);

    expect(result).toMatchObject({
      ok: true,
      head: {
        state: 'current',
        desiredKey: KEY,
        currentKey: KEY,
        revision: 1,
        generation: staged.candidate.ddc.lease.generation,
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

  it('waits for an equivalent newer owner after a strict stale commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-source-publication-'));
    roots.push(root);
    const publicationInput = input(root);
    const first = await stageImportPublication(publicationInput);
    const second = await stageImportPublication(publicationInput);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const winner = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return commitImportPublication(second.candidate);
    })();
    const loser = await commitImportPublication(first.candidate);
    const winnerResult = await winner;

    expect(loser).toMatchObject({ ok: true, head: { state: 'current', currentKey: KEY } });
    expect(winnerResult).toMatchObject({ ok: true, head: { state: 'current', currentKey: KEY } });
  });

  it('keeps a stale publication with a different desired key fail-closed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-source-publication-'));
    roots.push(root);
    const first = await stageImportPublication(input(root, 'a'.repeat(64)));
    const second = await stageImportPublication(input(root, 'b'.repeat(64)));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const result = await commitImportPublication(first.candidate);
    await discardImportPublication(second.candidate);

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'source-package-ddc-failed', detail: 'DDC lifecycle commit returned stale' },
    });
  });

  it('persists concurrent equivalent transports without sharing a temporary path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-source-publication-'));
    roots.push(root);
    const transport = {
      path: join(root, 'runtime', `${GUID}.pack.json`),
      body: JSON.stringify({ guid: GUID, value: 'concurrent' }),
    };
    const staged = await Promise.all(
      Array.from({ length: 8 }, () => stageImportPublication({ ...input(root), transport })),
    );
    expect(staged.every((candidate) => candidate.ok)).toBe(true);
    if (staged.some((candidate) => !candidate.ok)) return;

    const results = await Promise.all(
      staged.map((candidate) =>
        candidate.ok ? commitImportPublication(candidate.candidate) : Promise.resolve(candidate),
      ),
    );
    expect(results, 'every equivalent publication must persist its transport').toEqual(
      Array.from({ length: staged.length }, () =>
        expect.objectContaining({ ok: true, transportPersisted: true }),
      ),
    );
    expect(await readFile(transport.path, 'utf8')).toBe(transport.body);
    expect((await readdir(join(root, 'runtime'))).some((name) => name.includes('.tmp'))).toBe(
      false,
    );
  });

  it('publishes the complete transport artifact closure into the DDC entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-source-publication-'));
    roots.push(root);
    const pack = closurePack();
    const publicationInput = {
      ...input(root),
      pack,
      transport: {
        path: join(root, 'runtime', `${GUID}.pack.json`),
        body: JSON.stringify(pack),
        artifacts: [validArtifact],
      },
    };

    const staged = await stageImportPublication(publicationInput);
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    await expect(commitImportPublication(staged.candidate)).resolves.toMatchObject({ ok: true });

    const entry = await new DdcEntryStore(root).read(KEY);
    expect(entry?.artifacts[ARTIFACT_PATH]).toMatchObject({
      mediaType: validArtifact.mediaType,
      bytes: validArtifact.bytes,
    });
  });

  it.skipIf(process.platform !== 'win32').each([true, false])(
    'admits a Windows EPERM destination only when bytes are equivalent: %s',
    async (equivalent) => {
      const root = await mkdtemp(join(tmpdir(), 'forgeax-source-publication-'));
      roots.push(root);
      const directory = join(root, 'runtime');
      await mkdir(directory);
      const destination = join(directory, `${GUID}.pack.json`);
      const body = JSON.stringify({ value: 'published' });
      const existing = equivalent ? body : JSON.stringify({ value: 'different' });
      await writeFile(destination, existing);
      await chmod(destination, 0o444);
      try {
        const probe = join(directory, 'probe.tmp');
        await writeFile(probe, body);
        await expect(rename(probe, destination)).rejects.toMatchObject({ code: 'EPERM' });
        await rm(probe);
        const staged = await stageImportPublication({
          ...input(root),
          transport: { path: destination, body },
        });
        expect(staged.ok).toBe(true);
        if (!staged.ok) return;
        const result = await commitImportPublication(staged.candidate);
        expect(result.ok).toBe(equivalent);
        if (result.ok) expect(result.transportPersisted).toBe(true);
        else {
          expect(result.error.code).toBe('source-package-publication-invalid');
          expect(result.head.state).toBe('missing');
        }
        expect(await readFile(destination, 'utf8')).toBe(existing);
        expect((await readdir(directory)).some((name) => name.includes('.tmp'))).toBe(false);
      } finally {
        await chmod(destination, 0o666);
      }
    },
  );

  it('reuses the runtime Pack body when its semantic output is unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-source-publication-'));
    roots.push(root);
    const pack = {
      ...(input(root).pack as {
        readonly assets: readonly unknown[];
        readonly schemaVersion: '2.0.0';
      }),
      kind: 'internal-text-package' as const,
      scopeId: 'editor-main',
      generation: 17,
      digest: 'sha256:semantic',
      outputSetDigest: 'sha256:outputs',
    };
    const staged = await stageImportPublication({ ...input(root), pack });
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    await expect(commitImportPublication(staged.candidate)).resolves.toMatchObject({ ok: true });

    const entry = await new DdcEntryStore(root).read(KEY);
    expect(entry?.payload).toEqual({
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: (pack as unknown as { readonly assets: unknown }).assets,
      digest: pack.digest,
      outputSetDigest: pack.outputSetDigest,
    });
    expect(entry?.receipt.publicationGeneration).toBe(pack.generation);
  });

  it('keeps fresh DDC payload bytes independent from publication generation', async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), 'forgeax-source-publication-'));
    const secondRoot = await mkdtemp(join(tmpdir(), 'forgeax-source-publication-'));
    roots.push(firstRoot, secondRoot);
    const basePack = input(firstRoot).pack as Record<string, unknown>;
    const firstPack = {
      ...basePack,
      kind: 'internal-text-package' as const,
      scopeId: 'first-scope',
      generation: 1114181571,
      digest: 'sha256:semantic',
      outputSetDigest: 'sha256:outputs',
    };
    const secondPack = { ...firstPack, scopeId: 'second-scope', generation: 2018541951 };

    const first = await stageImportPublication({ ...input(firstRoot), pack: firstPack });
    const second = await stageImportPublication({ ...input(secondRoot), pack: secondPack });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    await expect(commitImportPublication(first.candidate)).resolves.toMatchObject({ ok: true });
    await expect(commitImportPublication(second.candidate)).resolves.toMatchObject({ ok: true });

    const firstEntry = await new DdcEntryStore(firstRoot).read(KEY);
    const secondEntry = await new DdcEntryStore(secondRoot).read(KEY);
    expect(firstEntry?.payload).toEqual(secondEntry?.payload);
    expect(firstEntry?.payload).not.toHaveProperty('scopeId');
    expect(firstEntry?.payload).not.toHaveProperty('generation');
    expect(firstEntry?.receipt.publicationGeneration).toBe(firstPack.generation);
    expect(secondEntry?.receipt.publicationGeneration).toBe(secondPack.generation);
    expect(firstEntry?.receipt.outputDigest).toBe(secondEntry?.receipt.outputDigest);
  });

  it('accepts concurrent semantic candidates with different publication generations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-source-publication-'));
    roots.push(root);
    const basePack = input(root).pack as Record<string, unknown>;
    const firstPack = {
      ...basePack,
      kind: 'internal-text-package' as const,
      scopeId: 'first-scope',
      generation: 1114181571,
      digest: 'sha256:semantic',
      outputSetDigest: 'sha256:outputs',
    };
    const secondPack = { ...firstPack, scopeId: 'second-scope', generation: 2018541951 };
    const first = await stageImportPublication({ ...input(root), pack: firstPack });
    const second = await stageImportPublication({ ...input(root), pack: secondPack });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const winner = await commitImportPublication(second.candidate);
    const loser = await commitImportPublication(first.candidate);
    expect(winner).toMatchObject({ ok: true });
    expect(loser).toMatchObject({ ok: true });
    await expect(new DdcEntryStore(root).read(KEY)).resolves.toMatchObject({
      payload: expect.not.objectContaining({
        scopeId: expect.anything(),
        generation: expect.anything(),
      }),
    });
  });

  it('reuses a legacy runtime payload when only its publication generation changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-source-publication-'));
    roots.push(root);
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
    const second = await stageImportPublication({ ...input(root), pack: nextPack });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    await expect(commitImportPublication(second.candidate)).resolves.toMatchObject({ ok: true });

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
    {
      label: 'transport body mismatch',
      pack: closurePack(),
      body: JSON.stringify({ schemaVersion: '2.0.0', kind: 'internal-text-package', assets: [] }),
      artifacts: [validArtifact],
    },
  ] as const)('rejects $label before advancing the DDC head', async ({ pack, artifacts, body }) => {
    for (const wire of [false, true]) {
      const publishedPack = wire
        ? { schemaVersion: 'pack-material-programs/2', pack, programs: [], abis: [] }
        : pack;
      const root = await mkdtemp(join(tmpdir(), 'forgeax-source-publication-'));
      roots.push(root);
      const publicationInput: ImportPublicationInput = {
        ...input(root),
        pack: publishedPack,
        transport: {
          path: join(root, 'runtime', `${GUID}.pack.json`),
          body: body ?? JSON.stringify(publishedPack),
          artifacts,
        },
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

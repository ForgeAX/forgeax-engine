import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type DdcEntry, DdcEntryStore, ddcOutputDigest } from '../entry-store.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const native = await importOriginal<typeof import('node:fs/promises')>();
  return { ...native, rename: vi.fn(native.rename), readFile: vi.fn(native.readFile) };
});

const GUID = '019e3969-1d48-7c3b-ac24-6d68f457065f';
const KEY = 'a'.repeat(64);

const entry = (): DdcEntry => {
  const value = {
    key: KEY,
    guid: GUID,
    payload: { kind: 'texture', width: 2, height: 1 },
    refs: ['019e3969-1d48-7c3b-ac24-6d68f457065e'],
    artifacts: {
      payload: { mediaType: 'application/octet-stream', bytes: new Uint8Array([1, 2, 3]) },
    },
    receipt: {
      guid: GUID,
      key: KEY,
      producer: 'image-importer@4',
      inputFingerprint: 'input-a',
      outputDigest: '',
    },
  } satisfies DdcEntry;
  return { ...value, receipt: { ...value.receipt, outputDigest: ddcOutputDigest(value) } };
};

describe('immutable DDC entry store', () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.mocked(rename).mockReset();
    vi.mocked(readFile).mockReset();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('derives an omitted output digest from the captured publication', async () => {
    const root = join(tmpdir(), `forgeax-ddc-entry-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const expected = entry();
    const { outputDigest: _digest, ...receipt } = expected.receipt;
    const store = new DdcEntryStore(root);
    const staged = await store.stage({ ...expected, receipt });
    await store.publish(staged);
    await expect(store.read(KEY)).resolves.toEqual(expected);
  });

  it('derives the receipt from the captured bytes despite edits while hashing yields', async () => {
    const root = join(tmpdir(), `forgeax-ddc-entry-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const expected = entry();
    const { outputDigest: _digest, ...receipt } = expected.receipt;
    const input = {
      ...expected,
      receipt: { ...receipt } as typeof receipt & { outputDigest?: string },
    };
    const store = new DdcEntryStore(root);
    const staging = store.stage(input);
    input.receipt.outputDigest = 'changed-after-capture';
    const artifact = input.artifacts.payload;
    if (artifact === undefined) throw new Error('missing fixture artifact');
    artifact.bytes[0] = 99;
    const staged = await staging;
    await store.publish(staged);
    const actual = await store.read(KEY);
    expect(actual?.receipt.outputDigest).toBe(expected.receipt.outputDigest);
    expect(actual?.artifacts.payload?.bytes[0]).toBe(1);
  });

  it.each([
    'explicit',
    'derived',
  ] as const)('keeps noncanonical author callbacks off the capture fast path (%s digest)', async (mode) => {
    const root = join(tmpdir(), `forgeax-ddc-entry-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const value = { ...entry(), payload: { toJSON: () => ({ z: 1, a: 2 }) } };
    const { outputDigest: _digest, ...receipt } = value.receipt;
    const candidate = {
      ...value,
      receipt: mode === 'explicit' ? { ...receipt, outputDigest: ddcOutputDigest(value) } : receipt,
    };
    await expect(new DdcEntryStore(root).stage(candidate)).rejects.toMatchObject({
      code: 'ddc-entry-invalid',
    });
  });

  it('keeps staged data invisible until an atomic publish', async () => {
    const root = join(tmpdir(), `forgeax-ddc-entry-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const store = new DdcEntryStore(root);
    const staged = await store.stage(entry());

    expect(await store.read(KEY)).toBeNull();
    expect(await readdir(join(staged.path, 'artifacts'))).toEqual(['payload.bin']);
    expect(JSON.parse(await readFile(join(staged.path, 'refs.json'), 'utf8'))).toEqual([
      '019e3969-1d48-7c3b-ac24-6d68f457065e',
    ]);

    const published = await store.publish(staged);
    expect(published).toEqual({ result: 'published', key: KEY });
    await expect(store.read(KEY)).resolves.toEqual(entry());
  });

  it.each([
    3,
    512 * 1024,
  ])('returns isolated Uint8Array semantics for a %i-byte artifact', async (length) => {
    const root = join(tmpdir(), `forgeax-ddc-entry-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const value = entry();
    const candidate = {
      ...value,
      artifacts: {
        payload: { mediaType: 'application/octet-stream', bytes: new Uint8Array(length).fill(7) },
      },
    };
    const store = new DdcEntryStore(root);
    await store.publish(
      await store.stage({
        ...candidate,
        receipt: { ...candidate.receipt, outputDigest: ddcOutputDigest(candidate) },
      }),
    );
    const restored = await store.read(KEY);
    const bytes = restored?.artifacts.payload?.bytes;
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.isBuffer(bytes)).toBe(false);
    expect(bytes?.byteLength).toBe(length);
    expect(bytes?.buffer.byteLength).toBe(length);
    const copy = bytes?.slice();
    copy?.fill(0);
    expect(bytes?.every((byte) => byte === 7)).toBe(true);
    bytes?.fill(9);
    expect((await store.read(KEY))?.artifacts.payload?.bytes.every((byte) => byte === 7)).toBe(
      true,
    );
  });

  it('captures the complete caller entry before asynchronous integrity hashing', async () => {
    const root = join(tmpdir(), `forgeax-ddc-entry-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const store = new DdcEntryStore(root);
    const backing = new Uint8Array([99, 1, 2, 3, 99]);
    const source = {
      ...entry(),
      payload: { kind: 'texture', width: 2, height: 1 },
      refs: [...entry().refs],
      receipt: { ...entry().receipt },
      artifacts: {
        payload: { mediaType: 'application/octet-stream', bytes: backing.subarray(1, 4) },
      },
    };
    const expected = structuredClone(source);
    let capturing = true;
    Object.assign(source.payload, {
      toJSON: () => {
        if (!capturing) throw new Error('author callback escaped synchronous capture');
        return {
          height: expected.payload.height,
          kind: expected.payload.kind,
          width: expected.payload.width,
        };
      },
    });
    const staging = store.stage(source);
    capturing = false;
    source.key = 'b'.repeat(64);
    source.guid = 'changed';
    source.payload.width = 9;
    source.refs.push('changed');
    backing.fill(7);
    source.artifacts.payload.mediaType = 'changed';
    Object.assign(source.receipt, {
      key: source.key,
      guid: source.guid,
      producer: 'changed',
      outputDigest: `sha256:${'0'.repeat(64)}`,
    });

    const staged = await staging;
    expect(staged.key).toBe(KEY);
    await expect(store.publish(staged)).resolves.toMatchObject({ result: 'published', key: KEY });
    await expect(store.read(KEY)).resolves.toEqual(expected);
    await expect(store.read(source.key)).resolves.toBeNull();
  });

  it('cannot repair an invalid initial artifact after staging has started', async () => {
    const root = join(tmpdir(), `forgeax-ddc-entry-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const source = { ...entry(), receipt: { ...entry().receipt } };
    const replacement = {
      ...source,
      artifacts: {
        payload: { mediaType: 'application/octet-stream', bytes: new Uint8Array([7, 7, 7]) },
      },
    };
    source.receipt.outputDigest = ddcOutputDigest(replacement);
    const staging = new DdcEntryStore(root).stage(source);
    Object.assign(source.artifacts, replacement.artifacts);
    await expect(staging).rejects.toMatchObject({ code: 'ddc-entry-invalid' });
    await expect(readdir(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects key-dependent payload serialization before sealing a stage', async () => {
    const root = join(tmpdir(), `forgeax-ddc-entry-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const source = {
      ...entry(),
      payload: { toJSON: (key: string) => ({ key }) },
      receipt: { ...entry().receipt },
    };
    source.receipt.outputDigest = ddcOutputDigest(source);
    const store = new DdcEntryStore(root);
    await expect(store.stage(source)).rejects.toMatchObject({ code: 'ddc-entry-invalid' });
    await expect(store.read(KEY)).resolves.toBeNull();
  });

  it('validates the captured receipt identity after serialization callbacks', async () => {
    const root = join(tmpdir(), `forgeax-ddc-entry-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const source = entry();
    const receipt = { ...source.receipt };
    Object.assign(source.receipt, {
      toJSON: () => ({ ...receipt, key: 'b'.repeat(64) }),
    });
    const store = new DdcEntryStore(root);
    await expect(store.stage(source)).rejects.toMatchObject({ code: 'ddc-entry-invalid' });
    await expect(store.read(KEY)).resolves.toBeNull();
  });

  it('does not expose a partial entry when a required artifact is missing', async () => {
    const root = join(tmpdir(), `forgeax-ddc-entry-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const store = new DdcEntryStore(root);
    const staged = await store.stage(entry());
    await rm(join(staged.path, 'artifacts', 'payload.bin'));
    await expect(store.publish(staged)).rejects.toMatchObject({ code: 'ddc-entry-incomplete' });
    await expect(store.read(KEY)).resolves.toBeNull();
  });

  it('rejects a receipt or integrity mismatch on reread', async () => {
    const root = join(tmpdir(), `forgeax-ddc-entry-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const store = new DdcEntryStore(root);
    await store.write(entry());
    await writeFile(
      join(root, 'entries', KEY, 'receipt.json'),
      JSON.stringify({ ...entry().receipt, key: 'b'.repeat(64) }),
    );
    await expect(store.read(KEY)).resolves.toBeNull();
  });

  it('accepts equivalent noncanonical payload JSON without trusting its raw bytes', async () => {
    const root = join(tmpdir(), `forgeax-ddc-entry-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const store = new DdcEntryStore(root);
    await store.write(entry());
    await writeFile(
      join(root, 'entries', KEY, 'payload.json'),
      JSON.stringify(entry().payload, null, 2),
    );
    await expect(store.read(KEY)).resolves.toEqual(entry());
  });

  it.each([
    'payload.json',
    'refs.json',
    'receipt.json',
    'integrity.json',
  ])('rejects changed %s with a reusable canonical payload', async (file) => {
    const root = join(tmpdir(), `forgeax-ddc-entry-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const store = new DdcEntryStore(root);
    await store.write(entry());
    const path = join(root, 'entries', KEY, file);
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (file === 'payload.json') value.width++;
    else if (file === 'refs.json') value.push('changed');
    else if (file === 'receipt.json') value.producer = 'changed';
    else value.entry = '0'.repeat(64);
    await writeFile(path, JSON.stringify(value));
    await expect(store.readChecked(KEY)).resolves.toMatchObject({
      ok: false,
      error: { code: 'ddc-entry-invalid' },
    });
  });

  it('returns an existing immutable entry instead of replacing it', async () => {
    const root = join(tmpdir(), `forgeax-ddc-entry-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const store = new DdcEntryStore(root);
    await expect(store.write(entry())).resolves.toEqual({ result: 'published', key: KEY });
    await expect(store.write(entry())).resolves.toEqual({ result: 'existing', key: KEY });
  });

  it('reads only payload candidate metadata while leaving full artifact verification to publication', async () => {
    const root = join(tmpdir(), `forgeax-ddc-entry-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const store = new DdcEntryStore(root);
    await store.write(entry());
    await writeFile(join(root, 'entries', KEY, 'artifacts/payload.bin'), 'corrupt');
    vi.mocked(readFile).mockClear();
    await expect(store.readPayloadCandidate(KEY)).resolves.toEqual({
      guid: GUID,
      payload: entry().payload,
      receipt: entry().receipt,
    });
    expect(vi.mocked(readFile).mock.calls).toHaveLength(3);
    expect(
      vi.mocked(readFile).mock.calls.some(([path]) => String(path).includes('/artifacts/')),
    ).toBe(false);
    await expect(store.read(KEY)).resolves.toBeNull();
    const staged = await store.stage(entry());
    await expect(store.publish(staged)).rejects.toMatchObject({ code: 'ddc-entry-invalid' });
    await store.discard(staged);
  });

  it.each([
    'payload.json',
    'receipt.json',
    'integrity.json',
  ])('rejects changed payload candidate metadata in %s', async (file) => {
    const root = join(tmpdir(), `forgeax-ddc-entry-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const store = new DdcEntryStore(root);
    await store.write(entry());
    const path = join(root, 'entries', KEY, file);
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (file === 'payload.json') value.width++;
    else if (file === 'receipt.json') value.producer = 'changed';
    else value.payload = '0'.repeat(64);
    await writeFile(path, JSON.stringify(value));
    await expect(store.readPayloadCandidate(KEY)).resolves.toBeNull();
  });

  it('accepts equivalent noncanonical candidate payload text through semantic validation', async () => {
    const root = join(tmpdir(), `forgeax-ddc-entry-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const store = new DdcEntryStore(root);
    await store.write(entry());
    await writeFile(
      join(root, 'entries', KEY, 'payload.json'),
      JSON.stringify(entry().payload, null, 2),
    );
    await expect(store.readPayloadCandidate(KEY)).resolves.toEqual({
      guid: GUID,
      payload: entry().payload,
      receipt: entry().receipt,
    });
  });

  it('reuses matching content without staging another payload and never discards the accepted entry', async () => {
    const root = join(tmpdir(), `forgeax-ddc-entry-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const store = new DdcEntryStore(root);
    await store.write(entry());
    const original = entry();
    const value = { ...original, receipt: { ...original.receipt, publicationGeneration: 2 } };
    const staged = await store.stage(value);
    expect(await readdir(join(root, 'staging'))).toEqual([]);
    await expect(new DdcEntryStore(root).publish(staged)).resolves.toEqual({
      result: 'existing',
      key: KEY,
    });
    await store.discard(staged);
    await expect(store.read(KEY)).resolves.toEqual(entry());
  });

  it.each([
    'payload.json',
    'artifacts/payload.bin',
    'receipt.json',
    'integrity.json',
  ])('revalidates matching content when %s changes after staging', async (file) => {
    const root = join(tmpdir(), `forgeax-ddc-entry-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const store = new DdcEntryStore(root);
    await store.write(entry());
    const staged = await store.stage(entry());
    await writeFile(join(root, 'entries', KEY, file), 'corrupt');
    await expect(store.publish(staged)).rejects.toMatchObject({ code: 'ddc-entry-invalid' });
    await store.discard(staged);
    expect(await readdir(join(root, 'entries'))).toEqual([KEY]);
  });

  it('rejects a different valid destination that replaces a reusable entry before publish', async () => {
    const root = join(tmpdir(), `forgeax-ddc-entry-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const store = new DdcEntryStore(root);
    await store.write(entry());
    const staged = await store.stage(entry());
    const replacement = entry();
    Object.assign(replacement.payload as object, { width: 3 });
    Object.assign(replacement.receipt, { outputDigest: ddcOutputDigest(replacement) });
    const otherRoot = join(root, 'replacement');
    await new DdcEntryStore(otherRoot).write(replacement);
    await rm(join(root, 'entries', KEY), { recursive: true });
    await rename(join(otherRoot, 'entries', KEY), join(root, 'entries', KEY));
    await expect(store.publish(staged)).resolves.toEqual({ result: 'conflict', key: KEY });
    await store.discard(staged);
    await expect(store.read(KEY)).resolves.toEqual(replacement);
  });

  it('accepts concurrent publications of the same immutable entry', async () => {
    const root = join(tmpdir(), `forgeax-ddc-entry-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const store = new DdcEntryStore(root);
    const staged = await Promise.all(Array.from({ length: 8 }, () => store.stage(entry())));

    const publications = await Promise.allSettled(
      staged.map((candidate) => store.publish(candidate)),
    );
    const results = publications.map((publication) => {
      if (publication.status === 'rejected') throw publication.reason;
      return publication.value;
    });

    expect(results.filter(({ result }) => result === 'published')).toHaveLength(1);
    expect(results.filter(({ result }) => result === 'existing')).toHaveLength(7);
    await expect(store.read(KEY)).resolves.toEqual(entry());
    await expect(readdir(join(root, 'staging'))).resolves.toEqual([]);
  });

  it('keeps one immutable winner when concurrent publications supply conflicting bytes', async () => {
    const root = join(tmpdir(), `forgeax-ddc-entry-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const store = new DdcEntryStore(root);
    const candidates = Array.from({ length: 8 }, (_, index) => {
      const value = {
        ...entry(),
        artifacts: {
          payload: { mediaType: 'application/octet-stream', bytes: new Uint8Array([index]) },
        },
      };
      return { ...value, receipt: { ...value.receipt, outputDigest: ddcOutputDigest(value) } };
    });
    const staged = await Promise.all(candidates.map((candidate) => store.stage(candidate)));
    const publications = await Promise.allSettled(
      staged.map((candidate) => store.publish(candidate)),
    );
    const results = publications.map((publication) => {
      if (publication.status === 'rejected') throw publication.reason;
      return publication.value;
    });

    expect(results.filter(({ result }) => result === 'published')).toHaveLength(1);
    expect(results.filter(({ result }) => result === 'conflict')).toHaveLength(7);
    const winner = results.findIndex(({ result }) => result === 'published');
    await expect(store.read(KEY)).resolves.toEqual(candidates[winner]);
    await expect(readdir(join(root, 'staging'))).resolves.toEqual([]);
  });

  it.each([
    'missing',
    'file',
  ])('preserves rename permission failure when destination is %s', async (kind) => {
    const root = join(tmpdir(), `forgeax-ddc-entry-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const store = new DdcEntryStore(root);
    const staged = await store.stage(entry());
    const permission = Object.assign(new Error('permission denied'), { code: 'EPERM' });
    vi.mocked(rename).mockImplementationOnce(async () => {
      if (kind === 'file') await writeFile(join(root, 'entries', KEY), 'unrelated file');
      throw permission;
    });

    await expect(store.publish(staged)).rejects.toBe(permission);
    expect(await readdir(join(root, 'staging'))).toHaveLength(1);
    if (kind === 'file') {
      await expect(readFile(join(root, 'entries', KEY), 'utf8')).resolves.toBe('unrelated file');
    }
  });

  it('keeps the accepted entry when the same key supplies different artifact bytes', async () => {
    const root = join(tmpdir(), `forgeax-ddc-entry-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const store = new DdcEntryStore(root);
    const accepted = entry();
    const changed = {
      ...accepted,
      artifacts: {
        payload: { mediaType: 'application/octet-stream', bytes: new Uint8Array([1, 2, 4]) },
      },
    };
    const candidate = {
      ...changed,
      receipt: { ...changed.receipt, outputDigest: ddcOutputDigest(changed) },
    };
    await expect(store.write(accepted)).resolves.toEqual({ result: 'published', key: KEY });
    await expect(store.write(candidate)).resolves.toEqual({ result: 'conflict', key: KEY });
    await expect(store.read(KEY)).resolves.toEqual(accepted);
  });

  it('ignores publication generation metadata when comparing immutable content', async () => {
    const root = join(tmpdir(), `forgeax-ddc-entry-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const store = new DdcEntryStore(root);
    const first = entry();
    const second = {
      ...first,
      receipt: { ...first.receipt, publicationGeneration: 23 },
    } satisfies DdcEntry;
    const third = {
      ...first,
      receipt: { ...first.receipt, publicationGeneration: 47 },
    } satisfies DdcEntry;

    await expect(store.write(second)).resolves.toEqual({ result: 'published', key: KEY });
    await expect(store.write(third)).resolves.toEqual({ result: 'existing', key: KEY });
    await expect(store.read(KEY)).resolves.toEqual(second);
  });
});

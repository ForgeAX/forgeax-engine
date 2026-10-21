import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { EngineWorkspaceRuntime } from '@forgeax/engine-app';
import type { CatalogEntry } from '@forgeax/engine-types';
import { afterEach, expect, it, vi } from 'vitest';
import { createThumbnailCache, thumbnailKey } from '../workspace-thumbnail-cache.js';
import { createWorkspaceThumbnails } from '../workspace-thumbnails.js';

const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAABK0lEQVR4nO3SoQEAMBCEsNt/6e8YFUTEI9htR9d+B2AADIABMAAGwAAYAANgAAyAATAABsAAGAADYAAMgAEwAAbAABgAA2AADIABMAAGwAAYAANgAAyAATAABsAAGAADYAAMgAHiDBBngDgDxBkgzgBxBogzQJwB4gwQZ4A4A8QZIM4AcQaIM0CcAeIMEGeAOAPEGSDOAHEGiDNAnAHiDBBngDgDxBkgzgBxBogzQJwB4gwQZ4A4A8QZIM4AcQaIM0CcAeIMEGeAOAPEGSDOAHEGiDNAnAHiDBBngDgDxBkgzgBxBogzQJwB4gwQZ4A4A8QZIM4AcQaIM0CcAeIMEGeAOAPEGSDOAHEGiDNAnAHiDBBngDgDxBkgzgBxBogzQJwB4gwQZ4A4A8Q9VtGHcj7WUZsAAAAASUVORK5CYII=';
const roots: string[] = [];
const owners: ReturnType<typeof createWorkspaceThumbnails>[] = [];
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const row = (guid: string): CatalogEntry => ({
  guid,
  kind: 'mesh',
  lifecycle: 'current',
  packageUrl: '/pack',
  sourcePath: '/source',
  revision: { digest: guid, observedAt: 0, rootId: 'project' },
});
const image = { dataUrl: png, preparedMs: 1, totalMs: 2, submitted: 1, ready: 1 };
async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-thumbnails-'));
  roots.push(root);
  const runtime = {
    project: { project: { id: 'p', root }, target: { url: 'http://localhost:1234' } },
  } as Pick<EngineWorkspaceRuntime, 'project'>;
  const inputs = { producer: 'renderer-1', entries: [row('first'), row('second')] };
  const capture = vi.fn(
    async (_asset: { guid: string; kind: string }, _input: string, _signal: AbortSignal) => image,
  );
  const createBatch = vi.fn(() => ({ capture, close: vi.fn(async () => {}) }));
  const readInputs = vi.fn(async () => inputs);
  const changed = vi.fn();
  const make = () => {
    const owner = createWorkspaceThumbnails(runtime, changed, { createBatch, readInputs });
    owners.push(owner);
    return owner;
  };
  return { root, runtime, inputs, capture, createBatch, readInputs, changed, make };
}

it('returns immediately while rendering, publishes progressively and reuses one carrier', async () => {
  const f = await fixture();
  let finish: () => void = () => {};
  f.capture.mockImplementationOnce(async () => {
    await new Promise<void>((done) => {
      finish = done;
    });
    return image;
  });
  const owner = f.make();
  owner.refresh();
  await vi.waitFor(() => expect(f.capture).toHaveBeenCalledTimes(1));
  const pending = await owner.read(['first', 'second']);
  expect(pending.thumbnails.some((row) => row.state === 'ready')).toBe(false);
  expect(pending.thumbnails.map((row) => row.state)).toContain('cooking');
  let finishSecond: () => void = () => {};
  f.capture.mockImplementationOnce(async () => {
    await new Promise<void>((done) => {
      finishSecond = done;
    });
    return image;
  });
  finish();
  await vi.waitFor(async () =>
    expect((await owner.read(['first'])).thumbnails[0]?.state).toBe('ready'),
  );
  expect((await owner.read(['second'])).thumbnails[0]?.state).not.toBe('ready');
  finishSecond();
  await vi.waitFor(async () =>
    expect((await owner.read(['second'])).thumbnails[0]?.dataUrl).toBe(png),
  );
  expect(f.createBatch).toHaveBeenCalledTimes(1);
});

it('reopens entirely from verified DDC without launching a browser', async () => {
  const f = await fixture();
  const first = f.make();
  first.refresh();
  await vi.waitFor(async () =>
    expect(
      (await first.read(['first', 'second'])).thumbnails.every((row) => row.state === 'ready'),
    ).toBe(true),
  );
  await first.close();
  f.capture.mockClear();
  f.createBatch.mockClear();
  const reopened = f.make();
  reopened.refresh();
  await vi.waitFor(async () =>
    expect(
      (await reopened.read(['first', 'second'])).thumbnails.every(
        (row) => row.state === 'ready' && row.metrics?.cache === 'hit',
      ),
    ).toBe(true),
  );
  expect(f.createBatch).not.toHaveBeenCalled();
  expect(f.capture).not.toHaveBeenCalled();
});

it('never adopts a retired project capture and allows healthy siblings after a failure', async () => {
  const f = await fixture();
  let finish: () => void = () => {};
  f.capture.mockImplementationOnce(async () => {
    await new Promise<void>((done) => {
      finish = done;
    });
    return image;
  });
  const owner = f.make();
  owner.refresh();
  await vi.waitFor(() => expect(f.capture).toHaveBeenCalledTimes(1));
  Object.assign(f.runtime, { project: undefined });
  owner.refresh();
  finish();
  expect((await owner.read(['first'])).thumbnails[0]?.state).toBe('unsupported');
  expect(f.createBatch.mock.results[0]?.value.close).toHaveBeenCalled();
  const second = await fixture();
  second.capture.mockRejectedValueOnce(new Error('invalid material'));
  const retry = second.make();
  retry.refresh();
  await vi.waitFor(async () =>
    expect((await retry.read(['second'])).thumbnails[0]?.state).toBe('ready'),
  );
  expect((await retry.read(['first'])).thumbnails[0]?.state).toBe('failed');
});

it('detects corrupt cached bytes and regenerates only that exact immutable object', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-thumbnail-cache-'));
  roots.push(root);
  const cache = createThumbnailCache(root);
  const key = thumbnailKey('asset', 'renderer');
  await cache.write(key, 'guid', 'renderer', png);
  await writeFile(resolve(root, 'entries', key, 'artifacts', 'preview.png.bin'), 'corrupt');
  expect(await cache.read(key)).toBeUndefined();
  await cache.write(key, 'guid', 'renderer', png);
  expect(await cache.read(key)).toBe(png);
  expect(thumbnailKey('asset', 'changed-renderer')).not.toBe(key);
});

it('invalidates visible ready rows before async Catalog refresh and only recaptures changed inputs', async () => {
  const f = await fixture();
  const owner = f.make();
  owner.refresh();
  await vi.waitFor(async () =>
    expect(
      (await owner.read(['first', 'second'])).thumbnails.every((row) => row.state === 'ready'),
    ).toBe(true),
  );
  let publish: () => void = () => {};
  f.readInputs.mockImplementationOnce(async () => {
    await new Promise<void>((done) => {
      publish = done;
    });
    return f.inputs;
  });
  f.inputs.entries[0] = {
    ...row('first'),
    revision: { digest: 'changed', observedAt: 1, rootId: 'project' },
  };
  owner.refresh();
  expect((await owner.read(['first', 'second'])).thumbnails.map((row) => row.state)).toEqual([
    'queued',
    'queued',
  ]);
  publish();
  await vi.waitFor(async () =>
    expect(
      (await owner.read(['first', 'second'])).thumbnails.every((row) => row.state === 'ready'),
    ).toBe(true),
  );
  expect(f.capture).toHaveBeenCalledTimes(3);
  expect(f.capture.mock.calls.filter((call) => call[0].guid === 'second')).toHaveLength(1);
});

it('drops an in-flight image after Catalog replacement and recaptures its current publication', async () => {
  const f = await fixture();
  let finish: () => void = () => {};
  f.capture.mockImplementationOnce(async () => {
    await new Promise<void>((done) => {
      finish = done;
    });
    return image;
  });
  const owner = f.make();
  owner.refresh();
  await vi.waitFor(() => expect(f.capture).toHaveBeenCalledTimes(1));
  f.inputs.entries[0] = {
    ...row('first'),
    revision: { digest: 'new-publication', observedAt: 1, rootId: 'project' },
  };
  owner.refresh();
  finish();
  await vi.waitFor(async () =>
    expect(
      (await owner.read(['first', 'second'])).thumbnails.every((row) => row.state === 'ready'),
    ).toBe(true),
  );
  expect(f.capture).toHaveBeenCalledTimes(3);
});

it('retires a project while Catalog input is still pending', async () => {
  const f = await fixture();
  let publish: () => void = () => {};
  f.readInputs.mockImplementationOnce(async () => {
    await new Promise<void>((done) => {
      publish = done;
    });
    return f.inputs;
  });
  const owner = f.make();
  owner.refresh();
  expect((await owner.read(['first'])).thumbnails[0]?.state).toBe('queued');
  Object.assign(f.runtime, { project: undefined });
  owner.refresh();
  expect((await owner.read(['first'])).thumbnails[0]?.state).toBe('unsupported');
  publish();
  await Promise.resolve();
  expect(f.createBatch).not.toHaveBeenCalled();
});

it('admits only bounded unique GUID batches through the advertised tool schema', async () => {
  const f = await fixture();
  const parse = f.make().tool.descriptor.argsSchema.parse;
  const guids = Array.from({ length: 32 }, (_, index) => String(index));
  expect(parse({ projectId: 'p', guids }).ok).toBe(true);
  expect(parse({ projectId: 'p', guids: [] }).ok).toBe(false);
  expect(parse({ projectId: 'p', guids: [...guids, '32'] }).ok).toBe(false);
  expect(parse({ projectId: 'p', guids: ['first', 'first'] }).ok).toBe(false);
});

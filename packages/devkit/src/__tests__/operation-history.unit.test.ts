import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createOperationHistoryStore } from '../operation-history.js';

const cleanup: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-history-'));
  cleanup.push(root);
  return { root, directory: join(root, 'data') };
}
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
describe('Engine command history', () => {
  it('never exposes an incompletely published record to concurrent readers', async () => {
    const options = await fixture();
    const store = await createOperationHistoryStore(options.root, options.directory);
    let finished = false;
    const writes = Promise.all(
      Array.from({ length: 24 }, () =>
        store.track('project.check', {}, async () => ({
          outcome: 'succeeded',
          result: {},
          artifacts: [],
        })),
      ),
    ).finally(() => {
      finished = true;
    });
    while (!finished) await store.list({ limit: 100 });
    await writes;
    expect((await store.list({ limit: 100 })).items).toHaveLength(24);
  });
  it('persists the accepted operation and terminal without a View or running game', async () => {
    const options = await fixture();
    const store = await createOperationHistoryStore(options.root, options.directory);
    let release!: () => void;
    let acknowledge!: () => void;
    const started = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const pending = store.track(
      'asset.mesh.preview',
      {
        guid: 'mesh-guid',
        token: 'secret',
        url: 'http://localhost/?forgeaxWorkspaceToken=secret&asset=mesh-guid',
      },
      async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
          acknowledge();
        });
        return { outcome: 'succeeded' as const, result: { mesh: 'mesh-guid' }, artifacts: [] };
      },
    );
    await started;
    const live = await store.list({ limit: 10 });
    expect(live.items).toHaveLength(1);
    expect(live.items[0]?.state).toBe('running');
    const first = live.items[0];
    if (!first) throw new Error('Missing accepted history record');
    release();
    await pending;
    const reopened = await createOperationHistoryStore(options.root, options.directory);
    const item = await reopened.get(first.id);
    expect(item.state).toBe('succeeded');
    expect(item.args).toEqual({
      guid: 'mesh-guid',
      token: '[redacted]',
      url: 'http://localhost/?forgeaxWorkspaceToken=[redacted]&asset=mesh-guid',
    });
    expect(item.result).toEqual({ mesh: 'mesh-guid' });
    expect(item.durationMs).toBeGreaterThanOrEqual(0);
  });
  it('keeps captured bytes after the original output is replaced or removed', async () => {
    const options = await fixture();
    const store = await createOperationHistoryStore(options.root, options.directory);
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMZkAAAAASUVORK5CYII=',
      'base64',
    );
    const output = join(options.root, 'capture.png');
    await writeFile(output, png);
    const artifact = {
      kind: 'png' as const,
      uri: output,
      mediaType: 'image/png',
      digest: `sha256:${createHash('sha256').update(png).digest('hex')}`,
    };
    await store.track('asset.preview', { guid: 'mesh-guid' }, async () => ({
      outcome: 'failed',
      failure: {
        code: 'tool-run-cancelled',
        expected: 'active run',
        hint: 'retry',
        detail: { reason: 'cancelled' },
      },
      artifacts: [artifact],
    }));
    await rm(output);
    const [item] = (await store.list({})).items;
    if (!item) throw new Error('Missing capture history record');
    expect(item?.state).toBe('failed');
    expect((await store.get(item.id)).artifacts[0]?.available).toBe(true);
    expect((await store.readArtifact(item.id, 0)).data).toBe(png.toString('base64'));
    await expect(store.readArtifact('../capture', 0)).rejects.toThrow();
    await expect(store.readArtifact(item.id, 1)).rejects.toThrow();
    expect(await readFile(join(options.directory, item.id, 'artifacts', '0.png'))).toEqual(png);
  });
  it('paginates concurrent invocations without changing original outcomes', async () => {
    const options = await fixture();
    const first = await createOperationHistoryStore(options.root, options.directory);
    const second = await createOperationHistoryStore(options.root, options.directory);
    const terminal = { outcome: 'succeeded' as const, result: { ok: true }, artifacts: [] };
    await Promise.all(
      Array.from({ length: 9 }, (_, index) =>
        (index % 2 ? first : second).track('project.check', { index }, async () => terminal),
      ),
    );
    const page = await first.list({ limit: 4 });
    if (!page.nextCursor) throw new Error('Missing history continuation');
    const next = await second.list({ limit: 4, before: page.nextCursor });
    expect(page.items).toHaveLength(4);
    expect(next.items).toHaveLength(4);
    expect(new Set([...page.items, ...next.items].map((item) => item.id)).size).toBe(8);
    await expect(first.list({ limit: 1001 })).rejects.toThrow();
    const alias = join(options.root, 'alias');
    await symlink(options.root, alias);
    expect((await createOperationHistoryStore(alias, options.directory)).root).toBe(first.root);
  });
});

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createToolClient } from '../tools/client.js';
import { runUnifiedCli } from '../unified-cli.js';

it('records public CLI and SDK command calls while View and games are absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-cli-history-'));
  vi.stubEnv('FORGEAX_HISTORY_DIR', join(root, 'history'));
  let client: Awaited<ReturnType<typeof createToolClient>> | undefined;
  try {
    await writeFile(
      join(root, 'forge.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        id: 'history-proof',
        name: 'History proof',
        roots: {},
      }),
    );
    await writeFile(join(root, 'package.json'), '{}');
    const status = await runUnifiedCli(['dev', 'status', '--root', root, '--json']);
    expect(status.ok).toBe(true);
    client = await createToolClient({ projectRoot: root });
    const failed = await client.run('asset.preview', { kind: 'unavailable', guid: 'unknown' });
    expect(failed.outcome).toBe('failed');
    const listed = await runUnifiedCli(['engine', 'history', 'list', '--root', root, '--json']);
    expect(listed.ok).toBe(true);
    const page = listed.value as { items: { id: string; operation: string; state: string }[] };
    expect(page.items.map((item) => item.operation).sort()).toEqual([
      'asset.preview',
      'dev.status',
    ]);
    const record = page.items.find((item) => item.operation === 'asset.preview');
    if (!record) throw new Error('Missing SDK operation');
    const read = await client.run('engine.history.get', { id: record.id });
    expect(read.outcome).toBe('succeeded');
    expect(read.outcome === 'succeeded' && read.result).toMatchObject({
      state: 'failed',
      args: { kind: 'unavailable', guid: 'unknown' },
    });
    const again = await runUnifiedCli(['engine', 'history', 'list', '--root', root, '--json']);
    expect((again.value as { items: unknown[] }).items).toHaveLength(2);
  } finally {
    await client?.dispose?.();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

it('preserves the storage failure and recovery hint through the public CLI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-cli-history-failure-'));
  try {
    const blocked = join(root, 'blocked');
    await writeFile(blocked, 'not a directory');
    vi.stubEnv('FORGEAX_HISTORY_DIR', blocked);
    const result = await runUnifiedCli(['dev', 'status', '--root', root, '--json']);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'operation-history-write-failed',
        hint: expect.stringContaining('FORGEAX_HISTORY_DIR'),
        detail: { directory: expect.stringContaining(blocked) },
      },
    });
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

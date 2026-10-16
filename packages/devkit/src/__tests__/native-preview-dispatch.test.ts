// @perf-budget-skip: intentional filesystem-backed tool-composition integration gate.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const runNativePreviewTool = vi.hoisted(() => vi.fn());

vi.mock('../tools/native-preview.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tools/native-preview.js')>()),
  runNativePreviewTool,
}));

import { createToolRuntime } from '@forgeax/engine-tool-runtime';
import { createToolClient } from '../tools/client.js';
import { nativePreviewTools } from '../tools/preview-catalog.js';
import { createUnifiedCommandContributions } from '../tools/unified-contributions.js';

const roots: string[] = [];

afterEach(async () => {
  runNativePreviewTool.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('native resource preview dispatch', () => {
  it('forwards cancellation from the public asset.preview command to its browser owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-public-preview-cancel-'));
    roots.push(root);
    const caller = new AbortController();
    let retired = false;
    runNativePreviewTool.mockImplementation(async (_tool, _args, options) => {
      if (!options.signal)
        return { outcome: 'failed', failure: { code: 'missing-owner-signal' }, artifacts: [] };
      await new Promise<void>((resolve) =>
        options.signal.addEventListener(
          'abort',
          () => {
            retired = true;
            resolve();
          },
          { once: true },
        ),
      );
      return { outcome: 'failed', failure: { code: 'tool-run-cancelled' }, artifacts: [] };
    });
    const contribution = createUnifiedCommandContributions(root).find(
      (tool) => tool.descriptor.id === 'asset.preview',
    );
    if (!contribution) throw new Error('Missing public preview');
    const runtime = createToolRuntime([]);
    const run = runtime.run(
      contribution,
      { kind: 'mesh', guid: 'asset-guid' },
      { signal: caller.signal },
    );
    try {
      await vi.waitFor(() => expect(runNativePreviewTool).toHaveBeenCalled(), { timeout: 5000 });
      caller.abort('cancel preview');
      expect((await run.terminal).outcome).toBe('failed');
      await run.executorExited;
      expect(retired).toBe(true);
    } finally {
      caller.abort();
    }
  });

  it('routes a GUID request through the native preview owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-native-preview-dispatch-'));
    roots.push(root);
    await writeFile(
      join(root, 'forge.json'),
      JSON.stringify({ id: 'fixture', name: 'Fixture', schemaVersion: '1.0.0' }),
    );
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'fixture', type: 'module' }),
    );
    runNativePreviewTool.mockResolvedValue({
      outcome: 'succeeded',
      result: {
        subject: { kind: 'material', guid: 'asset-guid', digest: 'sha256:asset' },
        presentation: { kind: 'lit-asset' },
        recipe: { schemaVersion: '1.0.0', recipeDigest: 'sha256:recipe' },
        oracle: { status: 'passed' },
        artifacts: [],
      },
      artifacts: [
        { kind: 'rhi-tape', digest: 'sha256:tape', uri: 'memory:tape' },
        { kind: 'profile-capture', digest: 'sha256:profile', uri: 'memory:profile' },
        { kind: 'png', digest: 'sha256:png', uri: 'memory:png' },
      ],
    });

    const client = await createToolClient({
      projectRoot: root,
      baseContributions: nativePreviewTools,
      projectDiscovery: async () => [],
    });
    await expect(
      client.run('asset.material.preview', { guid: 'asset-guid', size: 512 }),
    ).resolves.toMatchObject({
      outcome: 'succeeded',
      result: { subject: { guid: 'asset-guid' } },
    });
    expect(runNativePreviewTool).toHaveBeenCalledWith(
      expect.objectContaining({
        descriptor: expect.objectContaining({ id: 'asset.material.preview' }),
      }),
      { guid: 'asset-guid', size: 512 },
      { signal: expect.any(AbortSignal) },
      root,
    );
  }, 15_000);
});

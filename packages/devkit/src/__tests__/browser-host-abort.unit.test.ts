import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const createViteConfig = vi.hoisted(() => vi.fn());
const createServer = vi.hoisted(() => vi.fn());

vi.mock('../host.js', () => ({ createViteConfig }));
vi.mock('vite', () => ({ createServer }));

import { runBrowserPreviewHost } from '../tools/browser-host.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  createViteConfig.mockReset();
  createServer.mockReset();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('Browser Host cancellation', () => {
  it('does not create a Vite server when cancellation arrives during project configuration', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-browser-host-abort-'));
    temporaryRoots.push(root);
    await writeFile(
      resolve(root, 'forge.json'),
      '{"id":"abort-fixture","name":"Abort Fixture","schemaVersion":"3.0.0","roots":{}}\n',
    );
    await writeFile(resolve(root, 'package.json'), '{"name":"abort-fixture","version":"0.0.0"}\n');
    let configurationStarted!: () => void;
    const configurationReady = new Promise<void>((resolve) => {
      configurationStarted = resolve;
    });
    createViteConfig.mockImplementation(async () => {
      configurationStarted();
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {};
    });
    const controller = new AbortController();
    const pending = runBrowserPreviewHost(
      root,
      {
        backend: 'webgpu',
        presentation: 'hidden',
        viewport: { width: 64, height: 64 },
        actions: [],
        deltaSeconds: 1 / 60,
        frames: 1,
      },
      { revision: 0, digest: 'sha256:abort' },
      'abort:run',
      controller.signal,
    );
    await configurationReady;
    controller.abort(new Error('test cancellation'));

    await expect(pending).rejects.toThrow('Browser Host aborted before server creation');
    expect(createServer).not.toHaveBeenCalled();
  });
});

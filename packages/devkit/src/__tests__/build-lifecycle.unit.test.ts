import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

const control = vi.hoisted(() => ({ build: vi.fn(), host: vi.fn() }));
vi.mock('vite', async (original) => ({
  ...(await original<typeof import('vite')>()),
  build: control.build,
}));
vi.mock('@forgeax/engine-host/backend', async (original) => {
  const actual = await original<typeof import('@forgeax/engine-host/backend')>();
  return {
    ...actual,
    createBackendHost: control.host.mockImplementation(
      (options: Parameters<typeof actual.createBackendHost>[0]) =>
        actual.createBackendHost({ ...options, startupTimeoutMs: 10 }),
    ),
  };
});

import { buildCommand } from '../commands.js';

describe('one-shot project build lifetime', () => {
  afterEach(() => vi.clearAllMocks());

  async function fixture(): Promise<string> {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-build-lifetime-')));
    await mkdir(resolve(root, 'assets'));
    await writeFile(resolve(root, 'package.json'), '{"name":"build-lifetime"}\n');
    await writeFile(
      resolve(root, 'forge.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        id: 'build-lifetime',
        name: 'Build lifetime',
        roots: {},
      }),
    );
    return root;
  }

  it('awaits the actual build instead of making it Host startup work', async () => {
    const root = await fixture();
    const before = process.cwd();
    let completed = false;
    control.build.mockImplementationOnce(async () => {
      await delay(40);
      expect(process.cwd()).toBe(root);
      const dist = resolve(root, 'dist');
      await mkdir(resolve(dist, 'shaders'), { recursive: true });
      await writeFile(resolve(dist, 'index.html'), '<html></html>');
      await writeFile(resolve(dist, 'pack-index.json'), '[]');
      await writeFile(resolve(dist, 'shaders/manifest.json'), '{}');
      completed = true;
    });
    try {
      const result = await buildCommand({ root, json: true });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(completed).toBe(true);
      expect(control.host).not.toHaveBeenCalled();
      expect(control.build).toHaveBeenCalledOnce();
      const manifest = JSON.parse(await readFile(resolve(root, 'dist/forgeax-dist.json'), 'utf8'));
      expect(manifest.artifacts.map((row: { path: string }) => row.path)).toEqual([
        'index.html',
        'pack-index.json',
        'shaders/manifest.json',
      ]);
      expect(process.cwd()).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retains a real build failure and restores the caller directory', async () => {
    const root = await fixture();
    const before = process.cwd();
    control.build.mockImplementationOnce(async () => {
      await delay(40);
      throw new Error('actual cooker failure');
    });
    try {
      const result = await buildCommand({ root, json: true });
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'game-build-failed', detail: { reason: 'actual cooker failure' } },
      });
      expect(control.host).not.toHaveBeenCalled();
      expect(process.cwd()).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

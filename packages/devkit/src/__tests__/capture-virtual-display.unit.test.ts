import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createBrowserCapture } from '../browser-capture.js';

const child = vi.hoisted(() => ({ started: vi.fn(), kill: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    spawn: (...args: Parameters<typeof original.spawn>) => {
      if (args[0] !== 'Xvfb') return original.spawn(...args);
      const subprocess = new EventEmitter();
      child.started();
      return Object.assign(subprocess, { exitCode: null, signalCode: null, kill: child.kill });
    },
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    access: (path: Parameters<typeof original.access>[0], mode?: number) =>
      /^\/tmp\/(?:\.X11-unix\/X\d+|\.X\d+-lock)$/.test(String(path))
        ? Promise.reject(Object.assign(new Error('No Xvfb socket'), { code: 'ENOENT' }))
        : original.access(path, mode),
  };
});

it('clears display polling after Xvfb times out before its socket appears', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-capture-display-'));
  const capture = createBrowserCapture(root);
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  if (platform === undefined) throw new Error('Missing test platform descriptor');
  try {
    await mkdir(join(root, 'assets'));
    await writeFile(
      join(root, 'forge.json'),
      JSON.stringify({ schemaVersion: '3.0.0', id: 'display', name: 'Display', roots: {} }),
    );
    await writeFile(join(root, 'package.json'), '{"name":"display","type":"module"}');
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    vi.stubEnv('DISPLAY', undefined);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const started = new Promise<void>((resolve) => {
      child.started.mockImplementation(resolve);
    });
    const outcome = capture
      .open({ port: 7310, backend: 'software', headless: false })
      .catch((error: unknown) => error);
    await started;
    await vi.advanceTimersByTimeAsync(7_000);
    expect(await outcome).toMatchObject({
      message: expect.stringContaining('Xvfb did not create'),
    });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    Object.defineProperty(process, 'platform', platform);
    await capture.close();
    await rm(root, { recursive: true, force: true });
  }
});

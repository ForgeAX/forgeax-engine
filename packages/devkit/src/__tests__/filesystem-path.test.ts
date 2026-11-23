import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  filesystemPathKey,
  filesystemPathRelative,
  filesystemPathSegments,
  isFilesystemPathWithin,
  writeFileAtomic,
} from '../filesystem-path.js';

it('keeps committed bytes private and removes staging when a replacement cannot be published', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-file-publication-'));
  try {
    const record = join(root, 'record.json');
    await writeFileAtomic(record, 'complete', { mode: 0o600, syncFile: true });
    expect(await readFile(record, 'utf8')).toBe('complete');
    if (process.platform !== 'win32') expect((await stat(record)).mode & 0o077).toBe(0);

    const controller = new AbortController();
    const reason = new Error('publication cancelled after staging');
    const check = controller.signal.throwIfAborted.bind(controller.signal);
    const checkpoint = vi
      .spyOn(controller.signal, 'throwIfAborted')
      .mockImplementationOnce(check)
      .mockImplementationOnce(() => {
        controller.abort(reason);
        check();
      });
    try {
      await expect(
        writeFileAtomic(record, 'cancelled', { signal: controller.signal }),
      ).rejects.toBe(reason);
      expect(await readFile(record, 'utf8')).toBe('complete');
    } finally {
      checkpoint.mockRestore();
    }

    const directory = join(root, 'occupied');
    await mkdir(directory);
    await writeFile(join(directory, 'owner'), 'original');
    await expect(writeFileAtomic(directory, 'replacement')).rejects.toThrow();
    expect(await readFile(join(directory, 'owner'), 'utf8')).toBe('original');
    expect((await readdir(root)).sort()).toEqual(['occupied', 'record.json']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('preserves native Windows fences with separator-independent comparison keys', () => {
  const root = 'C:\\games\\sample';
  const child = 'C:\\games\\sample\\assets\\hero.pack.json';

  expect(isFilesystemPathWithin(root, child, false, win32)).toBe(true);
  expect(isFilesystemPathWithin(root, root, false, win32)).toBe(false);
  expect(isFilesystemPathWithin(root, 'C:\\games\\sample2\\escape.ts', false, win32)).toBe(false);
  expect(isFilesystemPathWithin(root, 'D:\\outside\\escape.ts', false, win32)).toBe(false);
  expect(filesystemPathRelative(root, child, false, win32)).toBe('assets\\hero.pack.json');
  expect(filesystemPathSegments('assets\\node_modules\\helper.ts', win32)).toEqual([
    'assets',
    'node_modules',
    'helper.ts',
  ]);
  expect(filesystemPathKey(child)).toBe('C:/games/sample/assets/hero.pack.json');
  const main = 'C:/games/sample/assets/main.ts';
  expect([main, child].map(filesystemPathKey).sort()).toEqual([
    'C:/games/sample/assets/hero.pack.json',
    main,
  ]);
});

it('keeps case, parent segments and drive identity distinct', () => {
  expect(filesystemPathKey('C:\\Games\\Plugin.ts')).not.toBe(
    filesystemPathKey('c:/games/plugin.ts'),
  );
  expect(filesystemPathKey('C:/game/a/../plugin.ts')).not.toBe(
    filesystemPathKey('C:/game/plugin.ts'),
  );
  expect(filesystemPathKey('C:/game/plugin.ts')).not.toBe(filesystemPathKey('D:/game/plugin.ts'));
});

it('rejects parent paths, sibling prefixes and external roots on Windows and POSIX', () => {
  for (const [api, root] of [
    [win32, 'C:\\games\\sample'],
    [posix, '/games/sample'],
  ] as const) {
    expect(isFilesystemPathWithin(root, root, false, api)).toBe(false);
    expect(isFilesystemPathWithin(root, root, true, api)).toBe(true);
    for (const path of [
      api.resolve(root, '..', 'escape.ts'),
      `${root}2/escape.ts`,
      api.join(root, '../escape.ts'),
    ])
      expect(isFilesystemPathWithin(root, path, false, api)).toBe(false);
  }
  expect(
    isFilesystemPathWithin('C:\\games\\sample', 'D:\\games\\sample\\plugin.ts', false, win32),
  ).toBe(false);
  expect(
    isFilesystemPathWithin('C:\\games\\sample', '\\\\server\\share\\plugin.ts', false, win32),
  ).toBe(false);
});

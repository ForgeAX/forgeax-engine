import { posix, win32 } from 'node:path';
import { expect, it } from 'vitest';
import {
  filesystemPathKey,
  filesystemPathListKey,
  filesystemPathRelative,
  filesystemPathSegments,
  isFilesystemPathWithin,
} from '../filesystem-path.js';

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
  expect(filesystemPathListKey([child])).toBe(
    filesystemPathListKey(['C:/games/sample/assets/hero.pack.json']),
  );
  expect(filesystemPathListKey([child, 'C:/games/sample/assets/main.ts'])).toBe(
    filesystemPathListKey([
      'C:/games/sample/assets/main.ts',
      'C:/games/sample/assets/hero.pack.json',
    ]),
  );
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

import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureRequest } from '../tools';
import { confineToRoot } from '../tools/confine';

describe('confineToRoot', () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'confine-'));
    root = join(base, 'project');
    outside = join(base, 'outside');
    mkdirSync(join(root, 'out'), { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, join(root, 'link'));
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('accepts project-relative and in-root absolute paths, existing or not', () => {
    expect(confineToRoot(root, 'out/a.png')).toBe(join(root, 'out', 'a.png'));
    expect(confineToRoot(root, 'new/deep/a.png')).toBe(join(root, 'new', 'deep', 'a.png'));
    expect(confineToRoot(root, join(root, 'out'))).toBe(join(root, 'out'));
    expect(confineToRoot(root, '..hidden/a.png')).toBe(join(root, '..hidden', 'a.png'));
  });

  it('rejects lexical escapes', () => {
    expect(confineToRoot(root, '../outside/a.png')).toBeUndefined();
    expect(confineToRoot(root, join(outside, 'a.png'))).toBeUndefined();
    expect(confineToRoot(root, 'out/../../outside')).toBeUndefined();
  });

  it('rejects an escape through a symlink, including a not-yet-existing tail', () => {
    expect(confineToRoot(root, 'link/a.png')).toBeUndefined();
    expect(confineToRoot(root, 'link/new/dir/a.png')).toBeUndefined();
    expect(confineToRoot(root, 'link')).toBeUndefined();
  });

  it('keeps capture sources inside the root through a symlink', () => {
    for (const source of ['../outside/a.pack.ts', 'link/a.pack.ts']) {
      const request = captureRequest(root, { source });
      expect('ok' in request && request.ok === false).toBe(true);
    }
  });
});

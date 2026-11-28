import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { moduleDigest } from '../tools/build-identity';

const root = mkdtempSync(join(tmpdir(), 'module-digest-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function project(helper: string): string {
  mkdirSync(join(root, 'lib'), { recursive: true });
  writeFileSync(
    join(root, 'job.ts'),
    "import { SIZE } from './lib/size';\nexport const job = SIZE;\n",
  );
  writeFileSync(
    join(root, 'lib/size.ts'),
    `import { UNIT } from './unit';\nexport const SIZE = ${helper} * UNIT;\n`,
  );
  writeFileSync(join(root, 'lib/unit.ts'), 'export const UNIT = 1;\n');
  return join(root, 'job.ts');
}

describe('moduleDigest', () => {
  it('changes when a helper module the job imports changes (falsifier)', () => {
    const before = moduleDigest(project('1'));
    expect(moduleDigest(project('1'))).toBe(before);
    expect(moduleDigest(project('2'))).not.toBe(before);
  });

  it('follows nested imports and accepts an import.meta.url', () => {
    const entry = project('1');
    const before = moduleDigest(entry);
    writeFileSync(join(root, 'lib/unit.ts'), 'export const UNIT = 2;\n');
    expect(moduleDigest(pathToFileURL(entry).href)).not.toBe(before);
  });

  it('fails loudly on an import it cannot find', () => {
    const entry = project('1');
    writeFileSync(join(root, 'job.ts'), "import './missing';\n");
    expect(() => moduleDigest(entry)).toThrow(/missing/);
  });

  /** A tree of files under a fresh directory; returns the path of `job.ts`. */
  function tree(files: Record<string, string>, eol = '\n'): string {
    const dir = mkdtempSync(join(root, 'tree-'));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true });
      writeFileSync(join(dir, name), text.replace(/\n/g, eol));
    }
    return join(dir, 'job.ts');
  }
  const FILES = {
    'job.ts': "import './b';\nimport './a';\nexport const job = 1;\n",
    'a.ts': 'export const A = 1;\n',
    'b.ts': 'export const B = 2;\n',
  };

  it('depends on the content and relative layout only, not on where the tree lives (falsifier)', () => {
    const first = moduleDigest(tree(FILES));
    expect(moduleDigest(tree(FILES))).toBe(first);
    // Pinned: a changed hashing order, key form or normalisation invalidates every job key.
    expect(first).toBe('c7135f94d9a2a8e9');
    expect(moduleDigest(tree({ ...FILES, 'a.ts': 'export const A = 2;\n' }))).not.toBe(first);
  });

  it('reads a CRLF checkout as the same module (falsifier)', () => {
    expect(moduleDigest(tree(FILES, '\r\n'))).toBe(moduleDigest(tree(FILES)));
  });

  it('resolves a directory import to its index module (falsifier)', () => {
    const files = { 'job.ts': "import './lib';\n", 'lib/index.ts': 'export const X = 1;\n' };
    const before = moduleDigest(tree(files));
    expect(moduleDigest(tree({ ...files, 'lib/index.ts': 'export const X = 2;\n' }))).not.toBe(
      before,
    );
  });

  it('terminates on an import cycle (falsifier)', () => {
    const entry = tree({
      'job.ts': "import './a';\n",
      'a.ts': "import './b';\nexport const A = 1;\n",
      'b.ts': "import './a';\nexport const B = 1;\n",
    });
    const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
    // In a child process: a regression loops forever, and a hung test thread cannot time out.
    const out = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { moduleDigest } from '@forgeax/engine-modeling/tools'; console.log(moduleDigest(process.argv[1]));",
        entry,
      ],
      { cwd: packageRoot, timeout: 20_000, encoding: 'utf8' },
    );
    expect(out.trim()).toMatch(/^[0-9a-f]{16}$/);
  });
});

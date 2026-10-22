import { mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import {
  createScriptablePackSourceSnapshot,
  inventoryScriptablePackSource,
} from '../scriptable-pack-node.js';

vi.mock('typescript', async (original) => {
  const actual = await original<typeof import('typescript')>();
  return {
    ...actual,
    default: { ...actual.default, preProcessFile: vi.fn(actual.default.preProcessFile) },
  };
});

describe('ScriptablePack source inventory', () => {
  it('parses a data module larger than the syntax cache budget once across Pack roots', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeax-inventory-large-')));
    try {
      const data = join(root, 'geometry.ts');
      const payload = `export const geometry = '${'x'.repeat(17 * 1024 * 1024)}';`;
      await writeFile(data, payload);
      const snapshot = createScriptablePackSourceSnapshot();
      const closures = [];
      vi.mocked(ts.preProcessFile).mockClear();
      for (const name of ['left', 'middle', 'right']) {
        const source = join(root, `${name}.pack.ts`);
        await writeFile(source, `export { geometry } from './geometry.ts'; // ${name}`);
        closures.push(await inventoryScriptablePackSource(source, undefined, undefined, snapshot));
      }
      expect(closures.every((closure) => closure.some((entry) => entry.path === data))).toBe(true);
      expect(
        new Set(closures.map((closure) => closure.find((entry) => entry.path === data)?.digest))
          .size,
      ).toBe(1);
      expect(
        vi.mocked(ts.preProcessFile).mock.calls.filter(([text]) => text.length > 16 * 1024 * 1024),
      ).toHaveLength(1);
      expect((await snapshot.verify()).ok).toBe(true);
      // Equal-size writes with restored timestamps and immutable snapshots are
      // covered by scriptable-pack-source-snapshot.test.ts using small inputs.
    } finally {
      vi.mocked(ts.preProcessFile).mockClear();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not retain an oversized import string even when its source is smaller than the byte budget', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeax-inventory-import-text-')));
    try {
      const source = join(root, 'root.pack.ts');
      const text = `import '${'p'.repeat(9 * 1024 * 1024)}';`;
      await writeFile(source, text);
      const resolver = async () => undefined;
      const first = await inventoryScriptablePackSource(source, undefined, resolver);
      vi.mocked(ts.preProcessFile).mockClear();
      expect(await inventoryScriptablePackSource(source, undefined, resolver)).toEqual(first);
      expect(ts.preProcessFile).toHaveBeenCalledTimes(1);
    } finally {
      vi.mocked(ts.preProcessFile).mockClear();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves import code units when retaining the parsed names', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeax-inventory-import-unicode-')));
    try {
      const source = join(root, 'root.pack.ts');
      const specifier = '\u5305/🦊/\ud800/retained-import';
      await writeFile(source, `import ${JSON.stringify(specifier)};`);
      const resolver = vi.fn(async () => undefined);
      await inventoryScriptablePackSource(source, undefined, resolver);
      await inventoryScriptablePackSource(source, undefined, resolver);
      expect(resolver).toHaveBeenCalledTimes(2);
      for (const call of resolver.mock.calls) expect(call).toEqual([source, specifier]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reuses syntax while checking fresh contents and import resolution', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeax-inventory-')));
    try {
      const source = join(root, 'root.pack.ts');
      const dependency = join(root, 'shape.js');
      await writeFile(source, "export { shape } from './shape.js'; // inventory reuse fixture");
      await writeFile(dependency, 'export const shape = 41;');
      const first = await inventoryScriptablePackSource(source);
      vi.mocked(ts.preProcessFile).mockClear();
      expect(await inventoryScriptablePackSource(source)).toEqual(first);
      expect(ts.preProcessFile).not.toHaveBeenCalled();

      // An equal-size write with restored timestamps still changes the digest.
      const before = await stat(dependency);
      await writeFile(dependency, 'export const shape = 42;');
      await utimes(dependency, before.atime, before.mtime);
      const changed = await inventoryScriptablePackSource(source);
      expect(changed.find((entry) => entry.path === dependency)?.digest).not.toBe(
        first.find((entry) => entry.path === dependency)?.digest,
      );
      expect(ts.preProcessFile).toHaveBeenCalledTimes(1);

      // A newly created higher-priority .ts file must replace the old .js edge.
      const preferred = join(root, 'shape.ts');
      await writeFile(preferred, 'export const shape = 43;');
      const rebound = await inventoryScriptablePackSource(source);
      expect(rebound.map((entry) => entry.path)).toContain(await realpath(preferred));
      expect(rebound.map((entry) => entry.path)).not.toContain(await realpath(dependency));

      const initial = 'export const shape = 44; // supplied source text';
      const supplied = await inventoryScriptablePackSource(source, initial);
      expect(supplied).toHaveLength(1);
      expect(await inventoryScriptablePackSource(source)).toEqual(rebound);
      const nested = join(root, 'nested');
      await mkdir(nested);
      const nestedSource = join(nested, 'root.pack.ts');
      await writeFile(nestedSource, await readFile(source));
      await writeFile(join(nested, 'shape.js'), 'export const shape = 45;');
      const relative = await inventoryScriptablePackSource(nestedSource);
      expect(relative.map((entry) => entry.path)).toContain(join(nested, 'shape.js'));
      expect(relative.map((entry) => entry.path)).not.toContain(preferred);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps resolution relative to each importer and invokes custom resolvers again', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeax-inventory-resolver-')));
    try {
      const source = join(root, 'root.pack.ts');
      const left = join(root, 'left.ts');
      const right = join(root, 'right.ts');
      await writeFile(source, "export * from './chosen'; // custom resolution fixture");
      await writeFile(left, 'export const value = 51;');
      await writeFile(right, 'export const value = 52;');
      let selected = left;
      const resolver = vi.fn(async () => selected);
      const first = await inventoryScriptablePackSource(source, undefined, resolver);
      expect(first.map((entry) => entry.path)).toContain(left);
      selected = right;
      const next = await inventoryScriptablePackSource(source, undefined, resolver);
      expect(resolver).toHaveBeenCalledTimes(2);
      expect(next.map((entry) => entry.path)).toContain(right);
      expect(next.map((entry) => entry.path)).not.toContain(left);
      await rm(right);
      await expect(inventoryScriptablePackSource(source, undefined, resolver)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('bounds retained syntax across a long-lived editing session', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeax-inventory-bounded-')));
    try {
      const source = join(root, 'root.pack.ts');
      await writeFile(source, '// bounded source fixture');
      const text = await readFile(source, 'utf8');
      const first = await inventoryScriptablePackSource(source, text);
      for (let i = 0; i < 600; i++) await inventoryScriptablePackSource(source, `// edit ${i}`);
      vi.mocked(ts.preProcessFile).mockClear();
      expect(await inventoryScriptablePackSource(source, text)).toEqual(first);
      expect(ts.preProcessFile).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('omits erased type-only declarations but keeps every possibly executed import', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeax-inventory-type-only-')));
    try {
      const file = (name: string) => join(root, name);
      for (const name of ['types.ts', 'reexported.ts', 'star.ts', 'inline.ts', 'value.ts'])
        await writeFile(file(name), 'export type T = number; export const v = 1;');
      const source = file('root.pack.ts');
      await writeFile(
        source,
        [
          "import type { T } from './types.ts';",
          "export type { T as U } from './reexported.ts';",
          "export type * from './star.ts';",
          "import { type T as I } from './inline.ts';",
          "import type { T as V } from './value.ts';",
          "import { v } from './value.ts';",
          'export const read = (x: T | I | V) => v + x;',
        ].join('\n'),
      );
      const paths = (await inventoryScriptablePackSource(source)).map((entry) => entry.path);
      expect(paths).toContain(file('inline.ts'));
      expect(paths).toContain(file('value.ts'));
      for (const name of ['types.ts', 'reexported.ts', 'star.ts'])
        expect(paths).not.toContain(file(name));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

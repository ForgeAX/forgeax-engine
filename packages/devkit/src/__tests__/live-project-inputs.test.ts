import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { liveProjectReadyLogLine, readLiveProjectInputs } from '../live-project-inputs.js';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'live-inputs-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('names the actual input when a reference scan exceeds the filesystem read limit', async () => {
  const root = await fixture();
  const file = join(root, 'oversized-input');
  await writeFile(file, '');
  // Sparse metadata reproduces the real Node failure without allocating the payload.
  await truncate(file, 17_336_057_856);
  await expect(readLiveProjectInputs(root)).rejects.toMatchObject({
    message: expect.stringContaining(file),
    cause: {
      code: 'ERR_FS_FILE_TOO_LARGE',
      message: expect.stringContaining('17336057856'),
    },
  });
});

it('detects direct writes, atomic replacement, additions and removals without filesystem events', async () => {
  const root = await fixture();
  const file = join(root, 'forge.json');
  await writeFile(file, 'one');
  const first = await readLiveProjectInputs(root);
  expect(await readLiveProjectInputs(root)).toBe(first);
  const before = await stat(file);
  await writeFile(file, 'two');
  await utimes(file, before.atime, before.mtime);
  const second = await readLiveProjectInputs(root);
  expect(second).not.toBe(first);
  await writeFile(`${file}.tmp`, 'two');
  await rename(`${file}.tmp`, file);
  const replaced = await readLiveProjectInputs(root);
  expect(replaced).not.toBe(second);
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'assets', 'new.ts'), 'new');
  expect(await readLiveProjectInputs(root)).not.toBe(replaced);
  await rm(join(root, 'assets'), { recursive: true });
  expect(await readLiveProjectInputs(root)).toBe(replaced);
});

it('does not invalidate inputs for generated output or installed dependency activity', async () => {
  const root = await fixture();
  await writeFile(join(root, 'forge.json'), '{}');
  const before = await readLiveProjectInputs(root);
  for (const name of ['.forgeax', '.forgeax-debug', 'dist', 'artifacts', 'node_modules']) {
    await mkdir(join(root, name));
    await writeFile(join(root, name, 'generated'), 'output');
  }
  expect(await readLiveProjectInputs(root)).toBe(before);
});

// Closure tests change byte length so they do not depend on filesystem clock
// resolution. Same-size writes with restored mtime are covered separately above.
it('ignores document files but detects executable dependencies in evidence directories', async () => {
  const root = await fixture();
  await writeFile(join(root, 'forge.json'), '{}');
  await writeFile(join(root, 'main.ts'), 'export const value = 1;');
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'docs', 'capture.txt'), 'evidence');
  const before = await readLiveProjectInputs(root);
  await writeFile(join(root, 'README.md'), '# changed');
  expect(await readLiveProjectInputs(root)).toBe(before);
  await writeFile(join(root, 'docs', 'helper.ts'), 'export const value = 1;');
  const withHelper = await readLiveProjectInputs(root);
  expect(withHelper).not.toBe(before);
  await writeFile(join(root, 'docs', 'helper.ts'), 'export const value = 20;');
  expect(await readLiveProjectInputs(root)).not.toBe(withHelper);
  await writeFile(join(root, 'main.ts'), 'export const value = 20;');
  expect(await readLiveProjectInputs(root)).not.toBe(before);
});

it('does not widen the runtime closure from test-only filesystem probes', async () => {
  const root = await fixture();
  await writeFile(join(root, 'forge.json'), '{}');
  await mkdir(join(root, '__tests__'));
  await writeFile(
    join(root, '__tests__', 'fixture.test.ts'),
    [
      "import { readFile } from 'node:fs/promises';",
      "await readFile(new URL('../fixture.txt', import.meta.url), 'utf8');",
    ].join('\n'),
  );
  await writeFile(join(root, 'fixture.txt'), 'one');
  const before = await readLiveProjectInputs(root);
  await writeFile(join(root, 'README.md'), '# unrelated prose changed');
  expect(await readLiveProjectInputs(root)).toBe(before);
});

it('does not invalidate inputs for a document-only directory', async () => {
  const root = await fixture();
  await writeFile(join(root, 'forge.json'), '{}');
  const before = await readLiveProjectInputs(root);
  await mkdir(join(root, 'reports'));
  await writeFile(join(root, 'reports', 'report.md'), '# evidence');
  expect(await readLiveProjectInputs(root)).toBe(before);
});

it('tracks a text file referenced by authored code without tracking unrelated prose', async () => {
  const root = await fixture();
  await writeFile(join(root, 'forge.json'), '{}');
  await writeFile(
    join(root, 'main.ts'),
    "import text from './docs/data.txt?raw'; export { text };\n",
  );
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'docs', 'data.txt'), 'one');
  await writeFile(join(root, 'docs', 'notes.md'), 'one');
  const before = await readLiveProjectInputs(root);
  await writeFile(join(root, 'docs', 'data.txt'), 'updated');
  const referencedChanged = await readLiveProjectInputs(root);
  expect(referencedChanged).not.toBe(before);
  await writeFile(join(root, 'docs', 'notes.md'), 'updated');
  expect(await readLiveProjectInputs(root)).toBe(referencedChanged);
});

it('tracks literal dynamic imports and conservatively includes dynamic loaders', async () => {
  const root = await fixture();
  await writeFile(join(root, 'forge.json'), '{}');
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'docs', 'literal.txt'), 'one');
  await writeFile(join(root, 'docs', 'dynamic.md'), 'one');
  await writeFile(join(root, 'main.ts'), "await import('./docs/literal.txt');\n");
  const literal = await readLiveProjectInputs(root);
  await writeFile(join(root, 'docs', 'literal.txt'), 'updated');
  expect(await readLiveProjectInputs(root)).not.toBe(literal);
  await writeFile(join(root, 'main.ts'), "const path = './docs/dynamic.md'; await import(path);\n");
  const dynamic = await readLiveProjectInputs(root);
  await writeFile(join(root, 'docs', 'dynamic.md'), 'updated');
  expect(await readLiveProjectInputs(root)).not.toBe(dynamic);
});

it('resolves root-relative fetch paths within the project', async () => {
  const root = await fixture();
  await writeFile(join(root, 'forge.json'), '{}');
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'docs', 'data.txt'), 'one');
  await writeFile(join(root, 'main.ts'), "await fetch('/docs/data.txt');\n");
  const before = await readLiveProjectInputs(root);
  await writeFile(join(root, 'docs', 'data.txt'), 'updated');
  expect(await readLiveProjectInputs(root)).not.toBe(before);
});

it('resolves relative fetch paths from the project document root', async () => {
  const root = await fixture();
  await writeFile(join(root, 'forge.json'), '{}');
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'dialogue.txt'), 'one');
  await writeFile(join(root, 'src', 'game.ts'), "await fetch('dialogue.txt');\n");
  const before = await readLiveProjectInputs(root);
  await writeFile(join(root, 'dialogue.txt'), 'updated');
  expect(await readLiveProjectInputs(root)).not.toBe(before);
});

it('conservatively tracks relative readFile paths with an unknown process base', async () => {
  const root = await fixture();
  await writeFile(join(root, 'forge.json'), '{}');
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'dialogue.txt'), 'one');
  await writeFile(join(root, 'src', 'game.ts'), "await readFile('dialogue.txt');\n");
  const before = await readLiveProjectInputs(root);
  await writeFile(join(root, 'dialogue.txt'), 'updated');
  expect(await readLiveProjectInputs(root)).not.toBe(before);
});

it('tracks a module-relative readFile URL without tracking unrelated prose', async () => {
  const root = await fixture();
  await writeFile(join(root, 'forge.json'), '{}');
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'docs', 'data.txt'), 'one');
  await writeFile(
    join(root, 'main.ts'),
    [
      "import { readFile } from 'node:fs/promises';",
      "await readFile(new URL('./docs/data.txt', import.meta.url), 'utf8');",
    ].join('\n'),
  );
  const before = await readLiveProjectInputs(root);
  await writeFile(join(root, 'README.md'), '# unrelated prose changed');
  expect(await readLiveProjectInputs(root)).toBe(before);
  await writeFile(join(root, 'docs', 'data.txt'), 'updated');
  expect(await readLiveProjectInputs(root)).not.toBe(before);
});

it('conservatively tracks documents for aliased readFile imports', async () => {
  const root = await fixture();
  await writeFile(join(root, 'forge.json'), '{}');
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'docs', 'data.txt'), 'one');
  await writeFile(
    join(root, 'main.ts'),
    [
      "import { readFile as load } from 'node:fs/promises';",
      "const path = './docs/data.txt';",
      "await load(path, 'utf8');",
    ].join('\n'),
  );
  const before = await readLiveProjectInputs(root);
  await writeFile(join(root, 'docs', 'data.txt'), 'updated');
  expect(await readLiveProjectInputs(root)).not.toBe(before);
});

it('conservatively tracks documents for namespace readFile aliases', async () => {
  const root = await fixture();
  await writeFile(join(root, 'forge.json'), '{}');
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'docs', 'data.txt'), 'one');
  await writeFile(
    join(root, 'main.ts'),
    [
      "import fs from 'node:fs/promises';",
      'const load = fs.readFile;',
      "await load('./docs/data.txt', 'utf8');",
    ].join('\n'),
  );
  const before = await readLiveProjectInputs(root);
  await writeFile(join(root, 'docs', 'data.txt'), 'updated');
  expect(await readLiveProjectInputs(root)).not.toBe(before);
});

it('conservatively tracks documents passed through filesystem and fetch variables', async () => {
  const root = await fixture();
  await writeFile(join(root, 'forge.json'), '{}');
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'docs', 'read.txt'), 'one');
  await writeFile(join(root, 'docs', 'sync.txt'), 'one');
  await writeFile(join(root, 'docs', 'fetch.txt'), 'one');
  await writeFile(
    join(root, 'main.ts'),
    [
      "const readPath = './docs/read.txt';",
      "const syncPath = './docs/sync.txt';",
      "const fetchPath = './docs/fetch.txt';",
      "await fs.readFile(readPath, 'utf8');",
      "fs.readFileSync(syncPath, 'utf8');",
      'await fetch(fetchPath);',
    ].join('\n'),
  );
  const before = await readLiveProjectInputs(root);
  await writeFile(join(root, 'docs', 'read.txt'), 'updated');
  expect(await readLiveProjectInputs(root)).not.toBe(before);
  const afterRead = await readLiveProjectInputs(root);
  await writeFile(join(root, 'docs', 'sync.txt'), 'updated');
  expect(await readLiveProjectInputs(root)).not.toBe(afterRead);
  const afterSync = await readLiveProjectInputs(root);
  await writeFile(join(root, 'docs', 'fetch.txt'), 'updated');
  expect(await readLiveProjectInputs(root)).not.toBe(afterSync);
});

it('follows external author symlinks and refuses missing or cyclic inputs', async () => {
  const root = await fixture();
  const external = await fixture();
  const file = join(external, 'plugin.ts');
  await writeFile(file, 'one');
  await symlink(external, join(root, 'author'));
  const before = await readLiveProjectInputs(root);
  await writeFile(file, 'updated');
  expect(await readLiveProjectInputs(root)).not.toBe(before);
  await symlink(join(root, 'missing'), join(root, 'broken'));
  await expect(readLiveProjectInputs(root)).rejects.toMatchObject({ code: 'ENOENT' });
  await rm(join(root, 'broken'));
  await symlink(root, join(root, 'cycle'));
  await expect(readLiveProjectInputs(root)).rejects.toThrow('Cyclic project input');
});

it('uses accepted compiler scope without decoding source or observing unrelated host status', async () => {
  const root = await fixture();
  await mkdir(join(root, 'assets'));
  await mkdir(join(root, '.other-host'));
  const module = join(root, 'assets/main.ts');
  await writeFile(module, 'export const value = 1;');
  const paths = [module, join(root, 'package-lock.json')];
  const before = await readLiveProjectInputs(root, paths);
  await writeFile(join(root, '.other-host/status.json'), '{"heartbeat":1}');
  expect(await readLiveProjectInputs(root, paths)).toBe(before);
  await writeFile(join(root, 'package-lock.json'), '{}');
  expect(await readLiveProjectInputs(root, paths)).not.toBe(before);
});
it('observes explicit host dependencies and asset membership in the accepted compiler scope', async () => {
  const root = await fixture();
  await mkdir(join(root, 'assets'));
  await mkdir(join(root, '.other-host'));
  const file = join(root, '.other-host/data.json');
  await writeFile(file, '{"value":1}');
  const paths = [file];
  const before = await readLiveProjectInputs(root, paths);
  // This closure test needs an observable metadata change on coarse-clock filesystems.
  // Same-size writes with restored mtime retain their separate regression above.
  await writeFile(file, '{"value":20}');
  expect(await readLiveProjectInputs(root, paths)).not.toBe(before);
  const changed = await readLiveProjectInputs(root, paths);
  await writeFile(join(root, 'assets/new.png'), 'asset bytes');
  expect(await readLiveProjectInputs(root, paths)).not.toBe(changed);
});

it('ignores test sources outside the accepted compiler scope', async () => {
  const root = await fixture();
  await mkdir(join(root, 'assets/player/__tests__'), { recursive: true });
  const runtime = join(root, 'assets/player/player.ts');
  const suite = join(root, 'assets/player/__tests__/player.test.ts');
  const sibling = join(root, 'assets/player/player.spec.ts');
  await writeFile(runtime, 'export const speed = 1;');
  await writeFile(suite, "it('moves', () => {});");
  await writeFile(sibling, "it('stops', () => {});");
  const paths = [runtime];
  const before = await readLiveProjectInputs(root, paths);
  await writeFile(suite, "it('moves faster', () => {});");
  await writeFile(sibling, "it('stops sooner', () => {});");
  await writeFile(join(root, 'assets/player/__tests__/new.test.ts'), "it('new', () => {});");
  expect(await readLiveProjectInputs(root, paths)).toBe(before);
  await writeFile(runtime, 'export const speed = 20;');
  expect(await readLiveProjectInputs(root, paths)).not.toBe(before);
});

it('tracks a test-named file that the compiler read', async () => {
  const root = await fixture();
  await mkdir(join(root, 'assets/__tests__'), { recursive: true });
  const shared = join(root, 'assets/__tests__/fixture.ts');
  await writeFile(shared, 'export const value = 1;');
  const paths = [shared];
  const before = await readLiveProjectInputs(root, paths);
  await writeFile(shared, 'export const value = 20;');
  expect(await readLiveProjectInputs(root, paths)).not.toBe(before);
});

it('keeps test sources in the conservative scope before the compiler reports one', async () => {
  const root = await fixture();
  await mkdir(join(root, 'assets/__tests__'), { recursive: true });
  const suite = join(root, 'assets/__tests__/starter.test.ts');
  await writeFile(suite, "it('starts', () => {});");
  const before = await readLiveProjectInputs(root);
  await writeFile(suite, "it('starts later', () => {});");
  expect(await readLiveProjectInputs(root)).not.toBe(before);
});

it('rejects unreadable asset members after accepting the compiler scope', async () => {
  const root = await fixture();
  await mkdir(join(root, 'assets'));
  const before = await readLiveProjectInputs(root, []);
  const broken = join(root, 'assets/unreadable-input');
  await symlink(join(root, 'missing-input'), broken);
  await expect(readLiveProjectInputs(root, [])).rejects.toMatchObject({ code: 'ENOENT' });
  await rm(broken);
  expect(await readLiveProjectInputs(root, [])).toBe(before);
});

it('logs a ready line as an input count plus the paths changed since the last generation', () => {
  const root = '/game';
  const paths = Array.from({ length: 40 }, (_, index) => `${root}/assets/${index}.pack.ts`);
  const ready = { ready: true, generation: 2, url: 'http://127.0.0.1:1/', inputVersion: 'v2' };
  expect(
    JSON.parse(liveProjectReadyLogLine(root, { ...ready, inputPaths: paths }, undefined)),
  ).toEqual({ ...ready, inputPathCount: 40 });
  const next = [...paths.slice(1), `${root}/assets/new.pack.ts`];
  expect(JSON.parse(liveProjectReadyLogLine(root, { ...ready, inputPaths: next }, paths))).toEqual({
    ...ready,
    inputPathCount: 40,
    addedInputPaths: ['assets/new.pack.ts'],
    removedInputPaths: ['assets/0.pack.ts'],
  });
  const replaced = paths.map((path) => path.replace('.pack.ts', '.pack.json'));
  const bulk = JSON.parse(liveProjectReadyLogLine(root, { ...ready, inputPaths: replaced }, paths));
  expect(bulk.addedInputPaths).toHaveLength(16);
  expect(bulk.inputChangeCount).toBe(80);
});

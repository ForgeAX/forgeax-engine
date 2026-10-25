import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../../dist/cli.mjs', import.meta.url));
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-cli-presentation-'));
  roots.push(root);
  const { packageManager } = JSON.parse(
    await readFile(new URL('../../../../package.json', import.meta.url), 'utf8'),
  ) as { packageManager: string };
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'cli-presentation', type: 'module', packageManager })}\n`,
  );
  await writeFile(
    join(root, 'forge.json'),
    JSON.stringify({
      id: 'cli-presentation',
      name: 'CLI presentation',
      schemaVersion: '3.0.0',
      roots: {},
    }),
  );
  return root;
}

async function forgeax(root: string, ...args: string[]) {
  return promisify(execFile)(process.execPath, [cli, ...args, '--root', root], {
    cwd: root,
    env: {
      ...process.env,
      FORGEAX_RUNS_DIR: join(root, 'runs'),
      FORGEAX_DISABLE_UPDATE_CHECK: '1',
    },
    maxBuffer: 16 * 1024 * 1024,
  });
}

it('prints the compact tree from the forgeax process and the owner tree with --detail', async () => {
  const root = await project();
  const compact = JSON.parse((await forgeax(root, 'help', '--tree', '--json')).stdout);
  const detail = JSON.parse((await forgeax(root, 'help', '--tree', '--detail', '--json')).stdout);
  expect(compact.omitted).toEqual({
    fields: ['value.nodes[].path', 'value.nodes[].summary (groups)'],
    flag: '--detail',
  });
  expect(detail.omitted).toBeUndefined();
  expect(JSON.stringify(compact.value)).not.toContain('"path":"asset');
  expect(JSON.stringify(detail.value)).toContain('"path":"asset source create"');
  const summaries = JSON.stringify(compact.value);
  expect(summaries).toContain('"Verify Pack authoring."');
  expect(summaries).toContain('"Create Pack source with requestId and revision CAS semantics."');
}, 60_000);

it('marks only groups in a text tree for both --tree spellings', async () => {
  const root = await project();
  for (const flag of ['--tree', '--tree=true']) {
    const lines = (await forgeax(root, 'help', 'project', flag)).stdout.split('\n');
    expect(lines).toContain('  engine …');
    expect(lines.some((line) => line.startsWith('    use-local  '))).toBe(true);
    expect(lines.some((line) => line.startsWith('    use-local …'))).toBe(false);
  }
}, 60_000);

it('names summarized fields and --detail on stderr in text mode', async () => {
  const root = await project();
  const text = await forgeax(root, 'project', 'check');
  expect(JSON.parse(text.stdout)).toMatchObject({ uiAuthoringProfileVersion: '1' });
  expect(text.stderr).toContain(
    '[forgeax] summarized value.uiAuthoringProfile; rerun with --detail for the full value',
  );
  const detail = await forgeax(root, 'project', 'check', '--detail');
  expect(JSON.parse(detail.stdout)).toHaveProperty('uiAuthoringProfile.css.nativeProperties');
  expect(detail.stderr).not.toContain('[forgeax] summarized');
}, 60_000);

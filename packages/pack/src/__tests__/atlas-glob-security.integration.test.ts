import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, onTestFinished } from 'vitest';

it('rejects a nonmatching repeated extglob without blocking the public atlas CLI', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-glob-security-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, `${'a'.repeat(48)}b.png`), 'unmatched input');
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { runAtlas } from '@forgeax/engine-pack/cli-asset';
        process.exitCode = await runAtlas([
            '--input', process.argv[1], '--name', 'image', '--output', process.argv[2],
        ], { stdoutWrite: line => console.log(line), stderrWrite: line => console.error(line) });`,
      join(directory, '+(*a).png'),
      directory,
    ],
    {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      encoding: 'utf8',
      timeout: 4000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stderr.trim())).toMatchObject({ code: 'atlas-empty-input' });
}, 10_000);

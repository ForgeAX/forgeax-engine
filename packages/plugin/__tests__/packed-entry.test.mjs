import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, it } from 'vitest';

const execFileAsync = promisify(execFile);
const engineRoot = resolve(import.meta.dirname, '../../..');
const pluginRoot = resolve(engineRoot, 'packages/plugin');
const temporaryRoots = [];

function runPnpm(args) {
  return execFileAsync(
    process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'pnpm',
    process.platform === 'win32' ? ['/d', '/s', '/c', 'pnpm', ...args] : args,
    { cwd: engineRoot },
  );
}

async function packPackage(filter, archiveRoot, packageName) {
  await runPnpm(['--filter', filter, 'pack', '--pack-destination', archiveRoot]);
  const archives = (await readdir(archiveRoot)).filter(
    (name) => name.startsWith(packageName) && name.endsWith('.tgz'),
  );
  if (archives.length !== 1) {
    throw new Error(`expected one ${packageName} archive, got ${archives.length}`);
  }
  return join(archiveRoot, archives[0]);
}

async function extractPackage(archive, packageRoot) {
  await mkdir(packageRoot, { recursive: true });
  await execFileAsync('tar', ['-xzf', archive, '-C', packageRoot, '--strip-components=1']);
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('packed Engine plugin entrypoints', () => {
  it('exports registerTools from root and browser package conditions', async () => {
    const temporaryRoot = await mkdtemp(join(pluginRoot, '.packed-entry-'));
    temporaryRoots.push(temporaryRoot);
    const archiveRoot = join(temporaryRoot, 'archives');
    const packageRoot = join(temporaryRoot, 'node_modules', '@forgeax', 'engine-plugin');
    const toolRuntimeRoot = join(
      temporaryRoot,
      'node_modules',
      '@forgeax',
      'engine-tool-runtime',
    );
    await mkdir(archiveRoot, { recursive: true });
    await runPnpm(['--filter', '@forgeax/engine-tool-runtime', 'build']);
    await runPnpm(['--filter', '@forgeax/engine-plugin', 'build']);
    const toolRuntimeArchive = await packPackage(
      '@forgeax/engine-tool-runtime',
      archiveRoot,
      'forgeax-engine-tool-runtime-',
    );
    const pluginArchive = await packPackage(
      '@forgeax/engine-plugin',
      archiveRoot,
      'forgeax-engine-plugin-',
    );
    await extractPackage(toolRuntimeArchive, toolRuntimeRoot);
    await extractPackage(pluginArchive, packageRoot);
    const runner = join(temporaryRoot, 'verify-entry.mjs');
    await writeFile(
      runner,
      "const api = await import('@forgeax/engine-plugin');\n" +
        "if (typeof api.registerTools !== 'function') throw new Error('packed-register-tools-missing');\n",
    );
    await execFileAsync(process.execPath, [runner]);
    await execFileAsync(process.execPath, ['--conditions=browser', runner]);
  }, 30_000);
});

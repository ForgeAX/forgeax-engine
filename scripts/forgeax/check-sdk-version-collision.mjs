import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { releasePolicy } from './release-policy.mjs';
import { fetchWithRetry } from './sdk-lib.mjs';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function value(name) {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

async function packageName(path) {
  const { stdout } = await execFileAsync('tar', ['-xOf', path, 'package/package.json'], {
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout).name;
}

async function tagIsAbsent(version) {
  try {
    await execFileAsync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/sdk-v${version}`]);
    return false;
  } catch {
    return true;
  }
}

async function main() {
  const output = resolve(root, value('--output') ?? 'artifacts/sdk');
  const version = value('--version');
  if (version === undefined) throw new Error('sdk-version-collision-version-missing');
  releasePolicy(version);

  const buildResult = JSON.parse(await readFile(resolve(output, 'sdk-build-result.json'), 'utf8'));
  if (buildResult.ok !== true || buildResult.sdkVersion !== version) {
    throw new Error('sdk-version-collision-build-result-mismatch');
  }
  if (!(await tagIsAbsent(version))) throw new Error(`sdk-tag-conflict: sdk-v${version}`);

  const packageRoot = resolve(output, 'npm/packages');
  const packagePaths = (await readdir(packageRoot))
    .filter((name) => name.endsWith('.tgz'))
    .sort()
    .map((name) => resolve(packageRoot, name));
  const carrierPath = resolve(output, 'npm', `forgeax-engine-sdk-${version}.tgz`);
  const archives = [...packagePaths, carrierPath];
  if (archives.length === 1) throw new Error('sdk-version-collision-packages-missing');

  const names = await Promise.all(archives.map(packageName));
  for (const name of names) {
    const response = await fetchWithRetry(
      `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
      { headers: { accept: 'application/json', 'cache-control': 'no-cache' } },
    );
    if (response.status === 404) continue;
    if (response.ok) throw new Error(`sdk-npm-version-conflict: ${name}@${version}`);
    throw new Error(`sdk-npm-collision-probe-failed: ${name}@${version}: HTTP ${response.status}`);
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      status: 'passed',
      version,
      packageCount: names.length,
      tag: `sdk-v${version}`,
      tagAbsent: true,
      archives: archives.map((archive) => basename(archive)),
    })}\n`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((cause) => {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  });
}

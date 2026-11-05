import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  downloadAsset,
  extractTarball,
  getReleaseAsset,
  parseGitOrigin,
} from '../lib/fetch-wasm-lib.mjs';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('../../', import.meta.url));
const tag = 'wasm-artifacts';

function packageDirectory(root, dimension) {
  if (!['2d', '3d'].includes(dimension)) throw new Error('Expected Rapier dimension: 2d or 3d');
  return join(root, `packages/physics-rapier${dimension}/pkg`);
}

async function producer(root, dimension, mode) {
  packageDirectory(root, dimension);
  const { stdout } = await execute(
    process.execPath,
    ['scripts/forgeax/build-rapier-native.mjs', dimension, mode],
    { cwd: root, timeout: 30_000 },
  );
  return stdout.trim();
}

export async function rapierAssetName(dimension, root = repository) {
  const key = await producer(root, dimension, '--key');
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Rapier producer returned an invalid key');
  return `rapier-${dimension}-pkg-${key}.tar.gz`;
}

async function validateArchive(archive) {
  const { stdout: names } = await execute('tar', ['-tzf', basename(archive)], {
    cwd: dirname(archive),
    timeout: 30_000,
  });
  for (const name of names.trim().split('\n')) {
    if (name.startsWith('/') || name.includes('\\') || name.split('/').includes('..'))
      throw new Error('Rapier archive contains a path outside its payload');
  }
  const { stdout: entries } = await execute('tar', ['-tvzf', basename(archive)], {
    cwd: dirname(archive),
    timeout: 30_000,
  });
  if (
    entries
      .trim()
      .split('\n')
      .some((entry) => !/^[d-]/.test(entry))
  )
    throw new Error('Rapier archive contains a link or special file');
}

/** Admission calls the unchanged source producer; downloaded JavaScript is never executed. */
export async function installRapierPayload(dimension, input, root = repository) {
  const pkg = packageDirectory(root, dimension);
  await mkdir(dirname(pkg), { recursive: true });
  const stage = await mkdtemp(join(dirname(pkg), '.release-admission-'));
  const backup = join(stage, 'previous');
  let retained = false;
  let installed = false;
  let committed = false;
  try {
    await cp(input, join(stage, 'candidate'), { recursive: true });
    if (existsSync(pkg)) {
      await rename(pkg, backup);
      retained = true;
    }
    await rename(join(stage, 'candidate'), pkg);
    installed = true;
    await producer(root, dimension, '--verify');
    committed = true;
  } catch (cause) {
    if (installed) await rm(pkg, { recursive: true, force: true });
    if (retained) {
      await rename(backup, pkg);
      retained = false;
    }
    throw cause;
  } finally {
    // A failed rollback retains the previous bytes at the named staging path.
    if (committed || !retained) await rm(stage, { recursive: true, force: true });
  }
}

export async function installRapierArchive(dimension, archive, root = repository) {
  await validateArchive(archive);
  const pkg = packageDirectory(root, dimension);
  await mkdir(dirname(pkg), { recursive: true });
  const stage = await mkdtemp(join(dirname(pkg), '.release-extract-'));
  try {
    await extractTarball(archive, join(stage, 'pkg'));
    await installRapierPayload(dimension, join(stage, 'pkg'), root);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function hydrateRapierPayload(dimension, root = repository) {
  try {
    await producer(root, dimension, '--verify');
    return;
  } catch {}
  const assetName = await rapierAssetName(dimension, root);
  const { stdout: origin } = await execute('git', ['-C', root, 'remote', 'get-url', 'origin'], {
    timeout: 30_000,
  });
  const { owner, repo } = parseGitOrigin(origin.trim());
  const options = {
    owner,
    repo,
    tag,
    pkgLabel: `rapier-${dimension}`,
    buildHint: 'Keep the pinned Rapier source build fallback.',
  };
  const pkg = packageDirectory(root, dimension);
  await mkdir(dirname(pkg), { recursive: true });
  const stage = await mkdtemp(join(dirname(pkg), '.release-download-'));
  try {
    const asset = await getReleaseAsset(owner, repo, tag, assetName, options);
    const archive = join(stage, 'pkg.tar.gz');
    await downloadAsset(asset, archive, options);
    await installRapierArchive(dimension, archive, root);
    console.log(`[rapier-${dimension}] verified release ${assetName}`);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function packRapierPayload(dimension, input, output, root = repository) {
  await installRapierPayload(dimension, input, root);
  await mkdir(output, { recursive: true });
  const archive = join(output, await rapierAssetName(dimension, root));
  await execute(
    'tar',
    [
      '--no-xattrs',
      '-czf',
      basename(archive),
      '-C',
      packageDirectory(root, dimension).replaceAll('\\', '/'),
      '.',
    ],
    {
      cwd: dirname(archive),
      env: { ...process.env, COPYFILE_DISABLE: '1' },
      timeout: 30_000,
    },
  );
  return archive;
}

export async function main(args = process.argv.slice(2)) {
  const [mode, dimension, input, output] = args;
  if (mode === '--name' && args.length === 2) console.log(await rapierAssetName(dimension));
  else if (mode === '--hydrate' && args.length === 2) await hydrateRapierPayload(dimension);
  else if (mode === '--pack' && args.length === 4)
    console.log(await packRapierPayload(dimension, resolve(input), resolve(output)));
  else throw new Error('Expected --name DIM, --hydrate DIM, or --pack DIM INPUT OUTPUT');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((cause) => {
    console.error(`[rapier-release] ${cause.message}`);
    process.exitCode = 1;
  });

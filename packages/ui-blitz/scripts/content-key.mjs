import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const RELEASE_TAG = 'wasm-artifacts';
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function sourceFiles(directory) {
  const paths = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    if (['target', '.git', 'node_modules', 'pkg', 'dist', '__tests__'].includes(entry.name))
      continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await sourceFiles(path)));
    else if (entry.isFile()) paths.push(path);
    else throw new Error(`Unsupported UI source input: ${path}`);
  }
  return paths;
}

/** Content identity is identical in a Git checkout and expanded SDK source. */
export async function sourceInputs(root = PKG_ROOT) {
  const engine = resolve(root, '../..');
  const fork = join(engine, 'third_party/blitz');
  const paths = [
    join(engine, 'scripts/lib/rust-build-paths.mjs'),
    join(root, 'Cargo.toml'),
    join(root, 'Cargo.lock'),
    ...(await sourceFiles(join(root, 'rust'))),
    ...(await sourceFiles(join(root, 'scripts'))),
    ...(await sourceFiles(join(root, 'vendor'))),
    join(fork, 'Cargo.toml'),
    ...(await sourceFiles(join(fork, 'packages'))),
    ...(await sourceFiles(join(fork, 'vendor'))),
  ];
  return Object.fromEntries(
    await Promise.all(
      paths
        .sort()
        .map(async (path) => [
          relative(engine, path).split('\\').join('/'),
          sha256(await readFile(path)),
        ]),
    ),
  );
}

export async function resolveAsset(root = PKG_ROOT) {
  const inputs = await sourceInputs(root);
  const digest = sha256(JSON.stringify(inputs));
  return { sha256: digest, assetName: `ui-blitz-pkg-${digest}.tar.gz`, inputs };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const asset = await resolveAsset();
  process.stdout.write(`${asset.sha256}\n${asset.assetName}\n`);
}

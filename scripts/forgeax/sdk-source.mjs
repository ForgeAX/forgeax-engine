import { execFile } from 'node:child_process';
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  artifact,
  mapConcurrent,
  SDK_SOURCE_EXCLUDED_PATHS,
  SDK_SOURCE_GIT_DEPENDENCIES,
  SDK_SOURCE_ROOT,
  SDK_SOURCE_WASM,
} from './sdk-lib.mjs';

const execFileAsync = promisify(execFile);

/** Verify the editable source delivered by either transport before installing dependencies. */
export async function verifySdkSource(sdkRoot, manifest) {
  const source = manifest.source;
  if (source?.root !== SDK_SOURCE_ROOT) throw new Error('sdk-source-root');
  const entries = manifest.artifacts.filter(({ path }) => path.startsWith(`${source.root}/`));
  if (entries.length === 0 || entries.length !== source.fileCount)
    throw new Error('sdk-source-file-count');
  if (entries.reduce((sum, entry) => sum + entry.bytes, 0) !== source.byteCount)
    throw new Error('sdk-source-byte-count');
  assertSourceDependencyInventory(source, entries);
  const required = [
    '.forgeax-public-distribution',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'scripts/build.mjs',
    ...SDK_SOURCE_WASM.flatMap((entry) => entry.files.map((file) => `${entry.root}/${file}`)),
    ...manifest.packages
      .filter((entry) => entry.role === 'runtime')
      .map((entry) => `${entry.root}/package.json`),
  ];
  const paths = new Set(entries.map((entry) => entry.path));
  for (const path of required) {
    if (!paths.has(`${source.root}/${path}`)) throw new Error(`sdk-source-required-file: ${path}`);
  }
  for (const entry of entries) {
    if (entry.path.split('/').some((part) => part === '..' || part === ''))
      throw new Error(`sdk-source-path: ${entry.path}`);
  }
  await mapConcurrent(entries, async (expected) => {
    const actual = await artifact(sdkRoot, resolve(sdkRoot, expected.path));
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)
      throw new Error(`sdk-artifact-mismatch: ${expected.path}`);
  });
  return { root: source.root, fileCount: source.fileCount, byteCount: source.byteCount };
}

/** Seed editable packages with the release's builds so only changed owners need rebuilding. */
export async function seedSourcePackageBuilds({ repositoryRoot, sdkRoot, sourceRoot }) {
  for (const entry of await readdir(resolve(sourceRoot, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const target = resolve(sourceRoot, 'packages', entry.name);
    let manifest;
    try {
      manifest = JSON.parse(await readFile(resolve(target, 'package.json'), 'utf8'));
    } catch (cause) {
      if (cause.code === 'ENOENT') continue;
      throw cause;
    }
    if (!manifest.name?.startsWith('@forgeax/engine')) continue;
    // Public owners use the normalized package bytes also bundled into Engine.
    // Private native wrappers keep their ordinary JS build, without an addon.
    const builtRoot = manifest.private === true ? repositoryRoot : sdkRoot;
    const dist = resolve(builtRoot, 'packages', entry.name, 'dist');
    await cp(dist, resolve(target, 'dist'), {
      recursive: true,
      filter: (path) =>
        path !== resolve(dist, 'native') &&
        !path.endsWith('.tsbuildinfo') &&
        !/\.(node|dll|dylib|so)$/.test(path),
    });
  }
}

// Demo Packs reference the single Engine shader source through relative links.
// Materialize only those links from the archived tree so the SDK stays portable.
async function materializeArchivedDemoShaders(root, destination, commit) {
  const { stdout } = await execFileAsync('git', ['ls-tree', '-rz', commit, '--', 'apps/hello'], {
    cwd: root,
  });
  const base = await realpath(destination);
  const shaderRoot = resolve(base, 'packages/shader/src');
  for (const entry of stdout.split('\0')) {
    const match = /^120000 blob [a-f0-9]+\t(apps\/hello\/[^/]+\/src\/[^/]+\.wgsl)$/.exec(entry);
    if (!match) continue;
    const path = resolve(base, match[1]);
    const link = await readlink(path);
    const target = resolve(dirname(path), link);
    if (
      isAbsolute(link) ||
      !target.startsWith(shaderRoot + sep) ||
      (await realpath(target)) !== target ||
      !(await lstat(target)).isFile()
    )
      throw new Error(`sdk-source-demo-shader-link: ${match[1]}`);
    const shader = await readFile(target);
    await rm(path);
    await writeFile(path, shader, { flag: 'wx' });
  }
}

export async function archiveEngineSource({ root, destination, commit }) {
  const temporary = await mkdtemp(resolve(tmpdir(), 'forgeax-sdk-source-'));
  const archive = resolve(temporary, 'source.tar');
  try {
    await mkdir(destination, { recursive: true });
    await execFileAsync(
      'git',
      ['-c', 'core.autocrlf=false', 'archive', '--format=tar', `--output=${archive}`, commit],
      {
        cwd: root,
      },
    );
    await execFileAsync('tar', ['-xf', archive, '-C', destination]);
    await materializeArchivedDemoShaders(root, destination, commit);
    const sources = [];
    for (const path of SDK_SOURCE_GIT_DEPENDENCIES) {
      const { stdout } = await execFileAsync('git', ['ls-tree', '-z', commit, '--', path], {
        cwd: root,
      });
      const match = /^160000 commit ([a-f0-9]{40})\t([^\0]+)\0$/.exec(stdout);
      if (!match || match[2] !== path) throw new Error(`sdk-source-git-dependency-pin: ${path}`);
      const sourceCommit = match[1];
      const checkout = resolve(root, path);
      try {
        await access(resolve(checkout, '.git'));
        const tree = await execFileAsync('git', ['ls-tree', '-r', sourceCommit], { cwd: checkout });
        if (/^160000 /m.test(tree.stdout))
          throw new Error('nested gitlinks require an explicit source closure');
        await execFileAsync(
          'git',
          [
            '-c',
            'core.autocrlf=false',
            'archive',
            '--format=tar',
            `--output=${archive}`,
            sourceCommit,
          ],
          { cwd: checkout },
        );
      } catch (cause) {
        throw new Error(
          `sdk-source-git-dependency: ${path}@${sourceCommit}; initialize the pinned submodule before building`,
          { cause },
        );
      }
      const target = resolve(destination, path);
      await mkdir(target, { recursive: true });
      await execFileAsync('tar', ['-xf', archive, '-C', target]);
      sources.push({ root: path, commit: sourceCommit });
    }
    for (const path of SDK_SOURCE_EXCLUDED_PATHS) {
      await rm(resolve(destination, path), { recursive: true, force: true });
    }
    return sources;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Validate each expanded repository against its own public source contract. */
export function assertSourceDependencyInventory(source, artifacts) {
  for (const { path } of artifacts) {
    const relative = path.slice(source.root.length + 1);
    if (
      SDK_SOURCE_EXCLUDED_PATHS.some(
        (excluded) => relative === excluded || relative.startsWith(`${excluded}/`),
      )
    )
      throw new Error(`sdk-source-excluded-path: ${relative}`);
  }
  if (
    JSON.stringify(source.gitDependencies.map((entry) => entry.root)) !==
    JSON.stringify(SDK_SOURCE_GIT_DEPENDENCIES)
  )
    throw new Error('sdk-source-git-dependencies');
  // The pinned Rust source has its own crate/license closure. View is checked
  // against its source entry points and subsequently built with the Engine.
  for (const [dependencyRoot, requiredPaths] of [
    [
      'third_party/wgpu',
      [
        'Cargo.toml',
        'LICENSE.MIT',
        'LICENSE.APACHE',
        'wgpu/Cargo.toml',
        'wgpu/src/lib.rs',
        'naga/Cargo.toml',
        'wgpu-hal/src/gles/queue.rs',
      ],
    ],
    [
      'third_party/blitz',
      [
        'Cargo.toml',
        'LICENSE-APACHE',
        'LICENSE-MIT',
        'FORGEAX.md',
        'packages/blitz-dom/src/lib.rs',
        'packages/blitz-html/src/lib.rs',
        'packages/blitz-paint/src/lib.rs',
      ],
    ],
    ['tools/view', ['package.json', 'LICENSE', 'host.pack.json', 'scripts/build-tool.mjs']],
    ['packages/modeling', ['package.json', 'LICENSE', 'README.md', 'src/index.ts']],
  ]) {
    for (const path of requiredPaths) {
      if (!artifacts.some((entry) => entry.path === `${source.root}/${dependencyRoot}/${path}`))
        throw new Error(`sdk-source-git-dependency-incomplete: ${dependencyRoot}/${path}`);
    }
  }
}

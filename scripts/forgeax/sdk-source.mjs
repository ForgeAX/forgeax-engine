import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { SDK_SOURCE_EXCLUDED_PATHS, SDK_SOURCE_GIT_DEPENDENCIES } from './sdk-lib.mjs';

const execFileAsync = promisify(execFile);

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
  ]) {
    for (const path of requiredPaths) {
      if (!artifacts.some((entry) => entry.path === `${source.root}/${dependencyRoot}/${path}`))
        throw new Error(`sdk-source-git-dependency-incomplete: ${dependencyRoot}/${path}`);
    }
  }
}

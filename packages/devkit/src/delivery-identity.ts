import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export type DeliverySource =
  | { readonly kind: 'unversioned' }
  | {
      readonly kind: 'git';
      readonly repository: string;
      readonly commit: string;
      readonly tree: string;
      readonly dirty: boolean;
      readonly workingTreeSha256: string;
      readonly submodules: readonly {
        readonly path: string;
        readonly commit: string;
        readonly source: DeliverySource | { readonly kind: 'uninitialized' };
      }[];
    };

/** A dirty commit alone never attests the bytes used by a package build. */
export async function readDeliverySource(root: string): Promise<DeliverySource> {
  const git = async (...args: string[]) =>
    (await exec('git', ['-C', root, ...args], { maxBuffer: 64 * 1024 * 1024 })).stdout;
  let repository: string;
  let commit: string;
  let tree: string;
  try {
    repository = (await git('rev-parse', '--show-toplevel')).trim();
    commit = (await git('rev-parse', 'HEAD')).trim();
    tree = (await git('rev-parse', 'HEAD^{tree}')).trim();
  } catch {
    return { kind: 'unversioned' as const };
  }
  const ignored = await git('check-ignore', '-q', '.').then(
    () => true,
    () => false,
  );
  if (ignored) return { kind: 'unversioned' as const };
  const paths = ['--', '.', ':!.forgeax', ':!dist'];
  const status = await git('status', '--porcelain=v1', '-z', '--untracked-files=all', ...paths);
  const diff = await git('diff', '--binary', 'HEAD', ...paths);
  const untracked = (await git('ls-files', '--others', '--exclude-standard', '-z', ...paths))
    .split('\0')
    .filter(Boolean)
    .sort();
  const digest = createHash('sha256').update(commit).update('\0').update(status).update(diff);
  for (const path of untracked) {
    digest.update('\0').update(path).update('\0');
    digest.update(await readFile(resolve(root, path)));
  }
  // A parent diff only says "-dirty" for a submodule. Hash its source too so
  // two different dirty module contents cannot masquerade as the same build.
  const submodules = [];
  for (const entry of (await git('ls-files', '--stage', '-z', ...paths)).split('\0')) {
    const match = /^160000 ([a-f0-9]+) \d\t(.+)$/.exec(entry);
    if (match === null) continue;
    const path = match[2];
    if (path === undefined) continue;
    const moduleRoot = resolve(root, path);
    const initialized = await access(resolve(moduleRoot, '.git')).then(
      () => true,
      () => false,
    );
    submodules.push({
      path,
      commit: match[1] ?? '',
      source: initialized
        ? await readDeliverySource(moduleRoot)
        : { kind: 'uninitialized' as const },
    });
  }
  digest.update(JSON.stringify(submodules));
  return {
    kind: 'git' as const,
    repository,
    commit,
    tree,
    dirty: status.length > 0,
    workingTreeSha256: digest.digest('hex'),
    submodules,
  };
}

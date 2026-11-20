import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const sha = /^[0-9a-f]{40}$/;

export function comparedCiInputs(root, environment = process.env) {
  if (!['pull_request', 'push'].includes(environment.GITHUB_EVENT_NAME)) return undefined;
  try {
    const event = JSON.parse(readFileSync(environment.GITHUB_EVENT_PATH, 'utf8'));
    const { GITHUB_REPOSITORY: repository, GITHUB_EVENT_NAME: kind } = environment;
    if (
      (kind === 'pull_request' &&
        (event.pull_request?.base?.ref !== 'main' ||
          event.pull_request.base.repo.full_name !== repository)) ||
      (kind === 'push' && event.ref !== 'refs/heads/main')
    )
      return undefined;

    const git = ciInputGit(root);
    const target = git('rev-parse', 'HEAD').trim();
    const base = kind === 'pull_request' ? event.pull_request.base.sha : event.before;
    const head = kind === 'pull_request' ? event.pull_request.head.sha : event.after;
    if (!sha.test(base) || !sha.test(head) || /^0+$/.test(base) || head !== target)
      return undefined;
    const files = changedCiInputs(root, base, target);
    return files && { base, target, files };
  } catch {
    return undefined;
  }
}

function ciInputGit(root) {
  return (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    });
}

export function changedCiInputs(root, base, target) {
  if (!sha.test(base) || !sha.test(target)) return undefined;
  const git = ciInputGit(root);
  try {
    try {
      git('cat-file', '-e', `${base}^{commit}`);
    } catch {
      git('fetch', '--no-tags', '--depth=1', 'origin', base);
    }
    const fields = git('diff', '--no-renames', '--name-status', '-z', base, target)
      .split('\0')
      .slice(0, -1);
    if (fields.length % 2 !== 0) return undefined;
    const files = [];
    for (let index = 0; index < fields.length; index += 2)
      files.push({ status: fields[index], path: fields[index + 1] });
    return files;
  } catch {
    return undefined;
  }
}

// Runtime implementation edits can use dependency-based validation. A new
// path, test, generated input, or unknown root invalidates the narrow route.
export function internalSourceOwners(files) {
  const owners = new Set();
  for (const file of files) {
    if (/^(?:skills\/.+|(?:packages\/[^/]+\/)?README(?:\.[^.]+)?)\.md$/.test(file.path)) continue;
    const owner = /^packages\/([^/]+)\/src\/(.+\.tsx?)$/.exec(file.path);
    if (file.status !== 'M' || !owner || /(?:^|\/)__tests__\/|\.test\.[^.]+$/.test(owner[2]))
      return undefined;
    owners.add(owner[1]);
  }
  return owners;
}

export function engineWithoutViewRequired(comparison) {
  return (
    !comparison ||
    comparison.files.some(
      ({ path }) =>
        !/^(?:tools\/view$|skills\/.*\.md$|(?:packages\/[^/]+\/)?README(?:\.[^.]+)?\.md$)/.test(
          path,
        ),
    )
  );
}

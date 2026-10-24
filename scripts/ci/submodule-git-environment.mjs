import { spawnSync } from 'node:child_process';
import { gitHttpEnvironment } from '../lib/git-http-environment.mjs';

// Carry the parent checkout's existing HTTP authorization into its submodule Git.
export function submoduleGitEnvironment(root, path) {
  const run = (args) =>
    spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
  const environment = { ...process.env };
  const source = run(['config', '--file', '.gitmodules', '--get', `submodule.${path}.url`]);
  if (source.status !== 0) return environment;
  let url;
  try {
    const location = source.stdout.trim();
    if (location.startsWith('./') || location.startsWith('../')) {
      const remote = run(['remote', 'get-url', 'origin']);
      if (remote.status !== 0) return environment;
      // Git resolves relative submodule URLs with the repository as a directory.
      const parent = remote.stdout.trim().replace(/\/$/, '');
      url = new URL(location, `${parent}/`);
    } else {
      url = new URL(location);
    }
  } catch {
    return environment;
  }
  return gitHttpEnvironment(root, url.href);
}

import { spawnSync } from 'node:child_process';

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
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return environment;
  const authorization = run(['config', '--get-urlmatch', 'http.extraheader', url.href]);
  if (authorization.status === 0 && authorization.stdout.trim()) {
    const index = Number(environment.GIT_CONFIG_COUNT ?? 0);
    // extraheader is multivalued: clear headers retained by a child checkout
    // before supplying the parent's current credential exactly once.
    environment.GIT_CONFIG_COUNT = String(index + 2);
    environment[`GIT_CONFIG_KEY_${index}`] = `http.${url.origin}/.extraheader`;
    environment[`GIT_CONFIG_VALUE_${index}`] = '';
    environment[`GIT_CONFIG_KEY_${index + 1}`] = `http.${url.origin}/.extraheader`;
    environment[`GIT_CONFIG_VALUE_${index + 1}`] = authorization.stdout.trim();
  }
  return environment;
}

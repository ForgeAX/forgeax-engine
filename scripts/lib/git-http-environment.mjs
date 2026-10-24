import { spawnSync } from 'node:child_process';

// Child repositories do not inherit the parent checkout's local Git config.
export function gitHttpEnvironment(root, sourceUrl) {
  const environment = { ...process.env };
  const url = new URL(sourceUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return environment;
  const authorization = spawnSync(
    'git',
    ['-C', root, 'config', '--get-urlmatch', 'http.extraheader', url.href],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 },
  );
  if (authorization.status !== 0 || !authorization.stdout.trim()) return environment;
  const index = Number(environment.GIT_CONFIG_COUNT ?? 0);
  // Reset this multivalued setting before carrying the current header once.
  environment.GIT_CONFIG_COUNT = String(index + 2);
  environment[`GIT_CONFIG_KEY_${index}`] = `http.${url.origin}/.extraheader`;
  environment[`GIT_CONFIG_VALUE_${index}`] = '';
  environment[`GIT_CONFIG_KEY_${index + 1}`] = `http.${url.origin}/.extraheader`;
  environment[`GIT_CONFIG_VALUE_${index + 1}`] = authorization.stdout.trim();
  return environment;
}

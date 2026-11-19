import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const header = '# forgeax-ci-bash-sources: ';

function sourcesFor(environment, bootstrap) {
  const previous = environment.BASH_ENV;
  if (previous !== bootstrap) return previous ? [previous] : [];
  if (!existsSync(bootstrap)) return [];
  const first = readFileSync(bootstrap, 'utf8').split('\n', 1)[0];
  if (!first.startsWith(header)) throw new Error('Invalid managed CI Bash environment');
  const sources = JSON.parse(first.slice(header.length));
  if (
    !Array.isArray(sources) ||
    sources.some((source) => typeof source !== 'string' || source === bootstrap)
  )
    throw new Error('Invalid CI Bash environment sources');
  return sources;
}

function sourceCommand(path) {
  // BASH_ENV does not search PATH. Preserve that behavior for a relative file.
  const file = isAbsolute(path) || path.includes('/') ? path : `./${path}`;
  const quoted = `'${file.replaceAll("'", "'\\''")}'`;
  return `if [ -f ${quoted} ]; then . ${quoted}; fi`;
}

/** Compose policies instead of letting one setup action replace another. */
export function registerBashEnvironment(
  fragment,
  { environment = process.env, platform = process.platform } = {},
) {
  if (platform !== 'linux') return { active: false };
  if (!environment.RUNNER_TEMP || !environment.GITHUB_ENV)
    throw new Error('CI Bash environment requires RUNNER_TEMP and GITHUB_ENV');
  const bootstrap = resolve(environment.RUNNER_TEMP, 'forgeax-ci-bash-environment.sh');
  const source = resolve(fragment);
  if (source === bootstrap || !statSync(source).isFile())
    throw new Error('CI Bash fragment must be a separate regular file');
  if (/[\r\n]/.test(bootstrap))
    throw new Error('CI environment path must fit one runner environment line');
  const sources = [...new Set([...sourcesFor(environment, bootstrap), source])];
  mkdirSync(environment.RUNNER_TEMP, { recursive: true });
  writeFileSync(
    bootstrap,
    `${header + JSON.stringify(sources)}\n${sources.map(sourceCommand).join('\n')}\n`,
    { mode: 0o600 },
  );
  appendFileSync(environment.GITHUB_ENV, `BASH_ENV=${bootstrap}\n`);
  return { active: true, bootstrap, sources };
}

/** Every Linux workflow using the shared toolchain gets the native policy. */
export function prepareCiEnvironment({
  environment = process.env,
  platform = process.platform,
} = {}) {
  if (platform !== 'linux') return { active: false };
  if (!environment.RUNNER_TEMP) throw new Error('CI process policy requires RUNNER_TEMP');
  mkdirSync(environment.RUNNER_TEMP, { recursive: true });
  const fragment = join(environment.RUNNER_TEMP, 'forgeax-ci-native-process.env');
  writeFileSync(fragment, 'ulimit -c 0\nexport FORGEAX_CI_CPU_TIME_DIAGNOSTICS=1\n', {
    mode: 0o600,
  });
  return registerBashEnvironment(fragment, { environment, platform });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const index = process.argv.indexOf('--fragment');
  const result =
    index < 0 ? prepareCiEnvironment() : registerBashEnvironment(process.argv[index + 1]);
  console.log(
    '[ci-environment] ' +
      (result.active ? 'composed Linux native process policy' : 'platform policy unchanged'),
  );
}

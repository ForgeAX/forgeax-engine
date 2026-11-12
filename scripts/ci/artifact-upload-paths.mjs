import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, realpathSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Literal source/test roots come from tracked owners, without traversing dependencies. */
export function artifactUploadPaths(input, trackedFiles) {
  const paths = String(input.path ?? '');
  if (input.includeBrowserScreenshots !== true && input.includeBrowserScreenshots !== 'true')
    return paths;
  const tracked =
    trackedFiles ??
    execFileSync('git', ['ls-files', '-z', '--', 'packages', 'apps'], {
      encoding: 'utf8',
    }).split('\0');
  const roots = new Set();
  const browserDirectories = new Set();
  for (const file of tracked) {
    if (file.split('/').includes('node_modules')) continue;
    const owned =
      /^(packages\/[^/]+\/(?:src|bench|__tests__)|apps\/(?:[^/]+\/){1,4}?(?:src|__tests__))\//u.exec(
        file,
      )?.[1];
    if (owned !== undefined) roots.add(owned);
    if (/^(?:packages|apps)\/.+\.browser(?:-no-webgpu)?\.test\.ts$/u.test(file))
      browserDirectories.add(posix.dirname(file));
  }
  for (const directory of browserDirectories)
    if (![...roots].some((root) => directory === root || directory.startsWith(`${root}/`)))
      roots.add(directory);
  const screenshots = [...roots].sort().map((directory) => {
    if (/[\r\n]/u.test(directory)) throw new Error('Browser screenshot roots must occupy one line');
    const literal = directory
      .replace(/\[/gu, '[[]')
      .replace(/[?*]/gu, (character) => `[${character}]`);
    return `${literal}/**/__screenshots__/**/*.png`;
  });
  return [paths.trimEnd(), ...screenshots].filter(Boolean).join('\n');
}

if (
  process.argv[1] &&
  realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
) {
  const paths = artifactUploadPaths({
    path: process.env.FORGEAX_ARTIFACT_PATH,
    includeBrowserScreenshots: process.env.FORGEAX_INCLUDE_BROWSER_SCREENSHOTS,
  });
  if (process.env.GITHUB_OUTPUT) {
    const delimiter = `artifact_paths_${randomUUID()}`;
    appendFileSync(process.env.GITHUB_OUTPUT, `paths<<${delimiter}\n${paths}\n${delimiter}\n`);
  } else process.stdout.write(`${paths}\n`);
}

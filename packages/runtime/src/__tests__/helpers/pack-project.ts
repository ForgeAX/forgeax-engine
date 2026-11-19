import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Install only the dependencies imported by the fixture's authored Pack sources. */
export async function installPackProject(
  root: string,
  packages: readonly ('pack' | 'types' | 'geometry' | 'vfx-compiler')[],
): Promise<void> {
  const scope = join(root, 'node_modules/@forgeax');
  await mkdir(scope, { recursive: true });
  await Promise.all(
    packages.map((name) =>
      symlink(
        fileURLToPath(new URL(`../../../../${name}/`, import.meta.url)),
        join(scope, `engine-${name}`),
        'junction',
      ),
    ),
  );
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies: Object.fromEntries(
        packages.map((name) => [`@forgeax/engine-${name}`, 'workspace:*']),
      ),
    }),
  );
}

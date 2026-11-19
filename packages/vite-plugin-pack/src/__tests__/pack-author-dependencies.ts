import { existsSync } from 'node:fs';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** These temporary projects own the imports in their authored Pack modules. */
export async function installPackAuthorDependencies(root: string): Promise<void> {
  const manifestPath = join(root, 'package.json');
  const manifest = existsSync(manifestPath)
    ? JSON.parse(await readFile(manifestPath, 'utf8'))
    : { private: true, type: 'module' };
  const scope = join(root, 'node_modules/@forgeax');
  await mkdir(scope, { recursive: true });
  for (const name of ['pack', 'types']) {
    await symlink(
      fileURLToPath(new URL(`../../../${name}/`, import.meta.url)),
      join(scope, `engine-${name}`),
      'junction',
    );
  }
  await writeFile(
    manifestPath,
    JSON.stringify({
      ...manifest,
      dependencies: {
        ...manifest.dependencies,
        '@forgeax/engine-pack': 'workspace:*',
        '@forgeax/engine-types': 'workspace:*',
      },
    }),
  );
}

import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A real consumer owns its Pack source dependencies; the Worker never borrows them. */
export async function installPackProjectDependencies(root: string, engine = false): Promise<void> {
  const modules = join(root, 'node_modules/@forgeax');
  await mkdir(modules, { recursive: true });
  const owner = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  if (engine) await symlink(resolve(owner, '../engine'), join(modules, 'engine'), 'junction');
  await symlink(owner, join(modules, 'engine-pack'), 'junction');
  await symlink(resolve(owner, '../types'), join(modules, 'engine-types'), 'junction');
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'pack-fixture-project',
      private: true,
      type: 'module',
      dependencies: {
        ...(engine ? { '@forgeax/engine': 'workspace:*' } : {}),
        '@forgeax/engine-pack': 'workspace:*',
        '@forgeax/engine-types': 'workspace:*',
      },
    }),
  );
}

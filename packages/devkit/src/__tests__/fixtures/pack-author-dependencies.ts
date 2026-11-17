import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Install the real declared package owners beside a temporary Pack author. */
export async function installPackAuthorDependencies(
  root: string,
  packages: readonly string[],
): Promise<void> {
  const manifestPath = resolve(root, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.dependencies ??= {};
  await mkdir(resolve(root, 'node_modules', '@forgeax'), { recursive: true });
  for (const name of packages) {
    const owner = await realpath(resolve(import.meta.dirname, '../../../../', name));
    const dependency = JSON.parse(await readFile(resolve(owner, 'package.json'), 'utf8'));
    manifest.dependencies[dependency.name] = dependency.version;
    await symlink(owner, resolve(root, 'node_modules', dependency.name), 'junction');
  }
  await writeFile(manifestPath, JSON.stringify(manifest));
}

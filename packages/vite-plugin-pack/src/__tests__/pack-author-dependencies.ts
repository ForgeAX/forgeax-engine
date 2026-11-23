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

export async function writeFilterPack(assets: string, packageId: string, instanceId: string) {
  await writeFile(
    join(assets, 'filter.pack.ts'),
    `import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';

export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('${packageId}'),
  parameters: [{ name: 'filter', type: 'enum', values: ['linear', 'nearest'], default: 'linear' }],
  build({ values }) {
    return ok({ 'sampler/main': { kind: 'sampler', magFilter: values.filter } });
  },
});
`,
  );
  await writeFilterInstance(assets, instanceId, packageId, 'nearest');
}

export function writeFilterInstance(
  assets: string,
  packageId: string,
  parent: string,
  filter: 'linear' | 'nearest',
) {
  return writeFile(
    join(assets, 'nearest.pack.json'),
    JSON.stringify({ schemaVersion: '3.0.0', packageId, parent, values: { filter } }),
  );
}

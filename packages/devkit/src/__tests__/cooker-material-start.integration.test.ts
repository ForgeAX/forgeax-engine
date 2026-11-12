import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import { materialContribution } from '@forgeax/engine-render';
import { afterEach, expect, it } from 'vitest';
import { buildProject } from '../host.js';

const buildRoot = '019fb7ce-4300-7000-8000-000000000000';
const paintPack = '019fb7ce-4301-7000-8000-000000000000';
const guidOf = (packageId: string, key: string) => {
  const parsed = PackageId.parse(packageId);
  if (!parsed.ok) throw parsed.error;
  return AssetGuid.format(AssetGuid.derive(parsed.value, key));
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * A passing build must start. A native cooker returns car paint (a Standard material
 * with the clearcoat static switch); the build must give it the same static
 * specialization cook as a Pack-declared material, so loading the built Catalog
 * admits both instead of failing startup with material-specialization-not-cooked.
 */
it('builds a project whose cooker returns a clearcoat material, then loads it from dist', {
  timeout: 600_000,
}, async () => {
  const root = await mkdtemp(resolve(import.meta.dirname, '../../..', '.build-fixture-'));
  roots.push(root);
  await mkdir(resolve(root, 'assets'), { recursive: true });
  await writeFile(resolve(root, 'package.json'), JSON.stringify({ type: 'module' }));
  const buildGuid = guidOf(buildRoot, 'plugin/build');
  await writeFile(
    resolve(root, 'forge.json'),
    JSON.stringify({
      id: 'fixture',
      name: 'Fixture',
      schemaVersion: '3.0.0',
      roots: { build: buildGuid },
    }),
  );
  await writeFile(
    resolve(root, 'assets/build.pack.json'),
    JSON.stringify({
      schemaVersion: '3.0.0',
      packageId: buildRoot,
      assets: {
        'plugin/build': { kind: 'plugin', payload: { module: { specifier: './build.ts' } } },
      },
    }),
  );
  const paint =
    'Materials.standard({ baseColor: [0.6, 0.05, 0.04, 1], roughness: 0.3, clearcoat: 1, staticSwitches: { clearcoat: true } })';
  await writeFile(
    resolve(root, 'assets/build.ts'),
    `import { Materials } from '@forgeax/engine-render';
export default { inject: ['nativeCookers'], apply(ctx) {
  ctx.effect(() => ctx.nativeCookers.register({ key: 'test-paint',
    cook(input) { return { guid: input.guid, payload: ${paint}, refs: [], artifacts: {}, inputFingerprint: 'paint' }; }
  }));
} };`,
  );
  await writeFile(
    resolve(root, 'assets/paint.pack.ts'),
    `import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { Materials } from '@forgeax/engine-render';
import { ok } from '@forgeax/engine-types';
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('${paintPack}'),
  build: () => ok({
    'material/declared': ${paint},
    'material/baked': { kind: 'test-paint', execution: 'cooked', source: { tone: 1 } },
  }),
});`,
  );
  const built = await buildProject({ root });
  expect(built).toMatchObject({ ok: true });
  // Start: read the built dist the way the player does and load each material.
  const dist = resolve(root, 'dist');
  const fetch = async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'https://fixture.invalid/').pathname;
    try {
      return new Response(await readFile(resolve(dist, `.${path}`)));
    } catch {
      return new Response('missing', { status: 404 });
    }
  };
  const registry = new AssetRegistry({
    catalog: createCatalogSource({ url: 'https://fixture.invalid/pack-index.json', fetch }),
    fetcher: fetch,
  });
  const lease = registry.installDecoder(materialContribution.kind, materialContribution.decoder);
  try {
    for (const key of ['material/declared', 'material/baked']) {
      const loaded = await registry.load(guidOf(paintPack, key), 'material');
      if (!loaded.ok) console.log(key, JSON.stringify(loaded.error).slice(0, 800));
      expect(loaded, key).toMatchObject({ ok: true });
    }
  } finally {
    lease.dispose();
    registry.dispose();
  }
});

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import { Materials, withClipping } from '@forgeax/engine-render';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { createServer } from 'vite';
import { installPackProject } from './helpers/pack-project';

export async function startClippingPlanesServer(mode: 'local' | 'view' = 'local') {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-clipping-'));
  await installPackProject(root, ['pack', 'types']);
  const assets = join(root, 'assets');
  await mkdir(assets);
  const packageId = '019a0000-0000-7000-8000-000000000170';
  const result = PackageId.parse(packageId);
  if (!result.ok) throw result.error;
  const parsed = result.value;
  const options = [
    { planes: [] },
    {
      planes: [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [1, 0, 0, 0],
        [0, 1, 0, 0],
      ],
      clipShadows: true,
    },
    {
      planes: [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [1, 0, 0, 0],
        [0, 1, 0, 0],
      ],
      intersection: true,
      clipShadows: true,
    },
    { planes: [[1, 0, 0, 0]], clipShadows: false },
    { planes: [] },
  ] as const;
  const guids = options.map((_, index) =>
    AssetGuid.format(AssetGuid.derive(parsed, `material/case-${index}`)),
  );
  const objects = Object.fromEntries(
    (mode === 'local' ? options : []).map((option, index) => [
      `material/case-${index}`,
      withClipping(
        Materials.standard({
          baseColor: [0.8, 0.1, 0.1, 1],
          emissive: [1, 0, 0],
          emissiveIntensity: 1,
        }),
        option,
      ),
    ]),
  );
  const viewMaterialKey = 'material/view-only';
  const viewMaterialGuid = AssetGuid.format(AssetGuid.derive(parsed, viewMaterialKey));
  if (mode === 'view')
    objects[viewMaterialKey] = {
      ...Materials.standard({
        baseColor: [0.8, 0.1, 0.1, 1],
        emissive: [1, 0, 0],
        emissiveIntensity: 1,
      }),
      staticSwitches: { alphaClipping: false, alphaHash: false },
    };
  await writeFile(
    join(assets, 'clipping.pack.ts'),
    `import { definePack, definePackageId } from '@forgeax/engine-pack/source';\nimport { ok } from '@forgeax/engine-types';\nexport default definePack({ schemaVersion: '2.0.0', packageId: definePackageId('${packageId}'), build() { return ok(${JSON.stringify(objects)}); } });\n`,
  );
  const binding = createStandaloneRuntimeAssetBinding('clipping-planes-test');
  const cooker = createMaterialPackCooker([assets]);
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [
      pluginPack({
        roots: [assets],
        runtimeBinding: binding,
        producerReadiness: 'before-consume',
        // The view case inspects the entire compiled family. The local case
        // still exercises the ordinary Scriptable Pack template route.
        cookers: [
          mode === 'view'
            ? {
                ...cooker,
                cook: (input: unknown) =>
                  cooker.cook({ ...(input as object), publication: undefined }),
              }
            : cooker,
        ],
        ddc: { projectDdcRoot: join(root, '.ddc') },
      }),
    ],
    server: { host: '127.0.0.1', port: 0, cors: true },
  });
  await server.listen();
  const base = server.resolvedUrls?.local[0];
  if (!base) throw new Error('missing clipping fixture server');
  return {
    binding: {
      ...binding,
      catalogUrl: new URL(binding.catalogUrl, base).href,
      importUrlBase: new URL(binding.importUrlBase, base).href,
    },
    guids,
    viewMaterialGuid,
    async close() {
      await server.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

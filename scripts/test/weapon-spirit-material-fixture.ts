import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { finalizePackageTransportSource } from '@forgeax/engine-pack/build';
import { definePackageId } from '@forgeax/engine-pack/source';
import { type MaterialAsset, ok } from '@forgeax/engine-types';
import type { Plugin } from 'vite';
import { projectImportProductForBuild } from '../../packages/import/src/pack-projection';
import { buildScriptablePack } from '../../packages/import/src/scriptable-pack-build';
import { createStandardAssetOutputProducerRegistry } from '../../packages/import/src/standard-output-producers';
import { createMaterialPackCooker } from '../../packages/shader-compiler/src/material/pack-cooker';

const rootGuid = '4846fa5b-8f80-57c0-9cdc-e345102fdb6b';
const childGuid = '4846fa5b-8f80-57c0-9cdc-e345102fdb6c';

/** Serve a real cooked publication through JSON for the consumer regression. */
export function weaponSpiritMaterialFixture(engineShadow = false): Plugin {
  const prefix = engineShadow ? '/__weapon-spirit-engine-shadow/' : '/__weapon-spirit/';
  return {
    name: `weapon-spirit-material-regression${engineShadow ? '-engine-shadow' : ''}`,
    configureServer(server) {
      const build = async () => {
        const root = fileURLToPath(
          new URL(
            '../../packages/render/src/__tests__/fixtures/ai-weapon-spirit/',
            import.meta.url,
          ),
        );
        let material = JSON.parse(await readFile(`${root}/material.json`, 'utf8')) as MaterialAsset;
        if (engineShadow) {
          if (material.parent !== undefined) throw new Error('frozen material must be a root');
          const forward = material.passes?.find((pass) => pass.name === 'Forward');
          if (forward === undefined) throw new Error('frozen Forward pass missing');
          material = {
            ...material,
            passes: [
              forward,
              {
                name: 'ShadowCaster',
                program: { module: 'forgeax::default-shadow-caster' },
                renderState: { tags: { LightMode: 'ShadowCaster' } },
              },
            ],
          };
        }
        const product = (
          await buildScriptablePack({
            definition: {
              schemaVersion: '2.0.0',
              packageId: definePackageId('60c43972-662b-509e-ac19-14dbe6445339'),
              build: () => ok({ material }),
            },
            sourcePath: `${root}/material.pack.ts`,
            outputs: createStandardAssetOutputProducerRegistry(),
            cookers: [createMaterialPackCooker([root])],
          })
        ).unwrap();
        const cooked = product.product.assets[0];
        if (cooked?.guid !== rootGuid) throw new Error('frozen Toon source identity changed');
        const artifacts = new Map<string, Uint8Array>();
        const finalized = await finalizePackageTransportSource(
          projectImportProductForBuild(product.product),
          {
            base: prefix,
            packagePath: 'materials.pack.json',
            artifactPath: (guid, key) => `${guid}/${key}`,
            sink: (path, bytes) => {
              artifacts.set(path, bytes);
            },
          },
        );
        const pack = JSON.stringify(
          {
            schemaVersion: '2.0.0',
            kind: 'internal-text-package',
            assets: [
              ...finalized.pack.assets,
              {
                guid: childGuid,
                kind: 'material',
                payload: {
                  kind: 'material',
                  parent: 0,
                  values: {
                    emissionStrength: 0,
                    pigmentStrength: 0,
                    surfaceMetallic: 0,
                    sideShade: 0.84,
                  },
                },
                refs: [rootGuid],
                artifacts: {},
              },
            ],
          },
          (_key, value) => (value instanceof Uint8Array ? [...value] : value),
        );
        return { pack, artifacts };
      };
      let publication: ReturnType<typeof build> | undefined;
      server.middlewares.use(async (request, response, next) => {
        if (!request.url?.startsWith(prefix)) return next();
        response.setHeader('content-type', 'application/json');
        try {
          if (request.url === `${prefix}pack-index.json`) {
            response.end(
              JSON.stringify(
                [rootGuid, childGuid].map((guid) => ({
                  guid,
                  kind: 'material',
                  packageUrl: `${prefix}materials.pack.json`,
                  sourcePath: guid,
                })),
              ),
            );
          } else if (request.url === `${prefix}materials.pack.json`) {
            publication ??= build();
            response.end((await publication).pack);
          } else {
            publication ??= build();
            const bytes = (await publication).artifacts.get(request.url.slice(prefix.length));
            if (bytes === undefined) {
              response.statusCode = 404;
              response.end('{}');
            } else {
              response.setHeader('content-type', 'text/wgsl');
              response.end(bytes);
            }
          }
        } catch (error) {
          response.statusCode = 500;
          response.end(
            JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
          );
        }
      });
    },
  };
}

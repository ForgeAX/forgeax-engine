import { fileURLToPath } from 'node:url';
import type { MaterialAsset } from '@forgeax/engine-types';
import type { Plugin } from 'vite';
import { createMaterialPackCooker } from '../../packages/shader-compiler/src/material/pack-cooker';

export const EXTERNAL_TEXTURE_MATERIAL_GUID = '4b9e0c51-2f63-4d8a-9a57-6c1e2d7f0a31';
const prefix = '/__external-texture-material/';

export function externalTextureMaterialFixture(): Plugin {
  let publication: Promise<string> | undefined;
  const build = async () => {
    const root = fileURLToPath(
      new URL('../../packages/runtime/src/__tests__/fixtures/external-texture/', import.meta.url),
    );
    const material: MaterialAsset = {
      kind: 'material',
      colorSpace: 'linear',
      parameters: [{ name: 'videoTexture', type: 'texture_external' }],
      passes: [
        {
          name: 'Forward',
          program: {
            module: 'regression::external_unlit',
            vertexEntry: 'vs_main',
            fragmentEntry: 'fs_main',
          },
          renderState: { tags: { LightMode: 'Forward' }, cullMode: 'none' },
        },
      ],
    };
    const guid = EXTERNAL_TEXTURE_MATERIAL_GUID;
    const cooked = await createMaterialPackCooker([root]).cook({ guid, source: material });
    return JSON.stringify(
      {
        schemaVersion: '2.0.0',
        kind: 'internal-text-package',
        assets: [{ guid, kind: 'material', payload: cooked.payload, refs: [], artifacts: {} }],
      },
      (_key, value) => (value instanceof Uint8Array ? [...value] : value),
    );
  };
  return {
    name: 'external-texture-material-fixture',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (!request.url?.startsWith(prefix)) return next();
        response.setHeader('content-type', 'application/json');
        try {
          if (request.url === `${prefix}pack-index.json`) {
            response.end(
              JSON.stringify([
                {
                  guid: EXTERNAL_TEXTURE_MATERIAL_GUID,
                  kind: 'material',
                  packageUrl: `${prefix}material.pack.json`,
                  sourcePath: EXTERNAL_TEXTURE_MATERIAL_GUID,
                },
              ]),
            );
          } else if (request.url === `${prefix}material.pack.json`) {
            publication ??= build();
            response.end(await publication);
          } else {
            response.statusCode = 404;
            response.end('{}');
          }
        } catch (error) {
          response.statusCode = 500;
          response.end(JSON.stringify({ error: String(error) }));
        }
      });
    },
  };
}

import { fileURLToPath } from 'node:url';
import type { MaterialAsset } from '@forgeax/engine-types';
import type { Plugin } from 'vite';
import { createMaterialPackCooker } from '../../packages/shader-compiler/src/material/pack-cooker';

const guid = '8f50ae65-6e0a-40b4-8949-b47006edab90';

export function materialProgramFixture(mixed = false, allTransparent = false): Plugin {
  const prefix = allTransparent
    ? '/__material-programs-transparent/'
    : mixed
      ? '/__material-programs-mixed/'
      : '/__material-programs/';
  const blend: GPUBlendState = {
    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  };
  let publication: Promise<string> | undefined;
  const build = async () => {
    const root = fileURLToPath(
      new URL('../../packages/runtime/src/__tests__/fixtures/material-programs/', import.meta.url),
    );
    const material: MaterialAsset = {
      kind: 'material',
      colorSpace: 'linear',
      parameters: [{ name: 'strength', type: 'f32', default: 1 }],
      passes: [
        {
          name: 'Left',
          program: { module: 'regression::left', vertexEntry: 'vs_main', fragmentEntry: 'fs_main' },
          renderState: {
            tags: { LightMode: 'Forward' },
            cullMode: 'none',
            ...(mixed ? { blend, depthWriteEnabled: false, queue: 3000 } : {}),
          },
        },
        {
          name: 'Center',
          program: {
            module: 'regression::center_right',
            vertexEntry: 'vs_main',
            fragmentEntry: 'fs_main',
          },
          renderState: {
            tags: { LightMode: 'Forward' },
            cullMode: 'none',
            ...(allTransparent ? { blend, depthWriteEnabled: false, queue: 3000 } : {}),
          },
        },
        {
          name: 'Right',
          program: {
            module: 'regression::center_right',
            vertexEntry: 'vs_right',
            fragmentEntry: 'fs_blue',
          },
          renderState: {
            tags: { LightMode: 'Forward' },
            cullMode: 'none',
            ...(mixed ? { blend, depthWriteEnabled: false, queue: 3000 } : {}),
          },
        },
      ],
    };
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
    name: mixed ? 'material-program-mixed-regression' : 'material-program-regression',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (!request.url?.startsWith(prefix)) return next();
        response.setHeader('content-type', 'application/json');
        try {
          if (request.url === `${prefix}pack-index.json`)
            response.end(
              JSON.stringify([
                {
                  guid,
                  kind: 'material',
                  packageUrl: `${prefix}material.pack.json`,
                  sourcePath: guid,
                },
              ]),
            );
          else if (request.url === `${prefix}material.pack.json`) {
            publication ??= build();
            response.end(await publication);
          } else {
            response.statusCode = 404;
            response.end('{}');
          }
        } catch (error) {
          response.statusCode = 500;
          response.end(JSON.stringify({ error }));
        }
      });
    },
  };
}

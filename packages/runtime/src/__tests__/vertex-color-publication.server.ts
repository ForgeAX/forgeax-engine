import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  serializeCookedMaterialRecord,
  validateCookedMaterialRecord,
} from '@forgeax/engine-pack/material-cook';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { standardSurfaceParameters } from '@forgeax/engine-types';

/** Exercise the real cooker and JSON/fetch boundary without runtime compilation. */
export async function startVertexColorPublicationServer() {
  const root = await mkdtemp(join(tmpdir(), 'vertex-color-publication-'));
  const guid = '019f0000-0000-7000-8000-0000000007c1';
  try {
    await writeFile(
      join(root, 'surface.wgsl'),
      `#define_import_path test::vertex_color
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
fn evaluate_surface(input: SurfaceInput) -> SurfaceData {
  return SurfaceData(vec3f(0.0), input.geometricNormalWS, 0.0, 0.5, input.vertexColor.rgb, 1.0, 1.0, 0.0);
}`,
    );
    const draft = await createMaterialPackCooker([root]).cook({
      guid,
      source: {
        kind: 'material',
        parameters: standardSurfaceParameters([]),
        passes: [
          {
            name: 'forward',
            program: {
              module: 'forgeax_material::standard',
              moduleSlots: { surface: 'test::vertex_color' },
            },
          },
        ],
      },
    });
    const payload = JSON.stringify({
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid,
          kind: 'material',
          payload: {
            ...(draft.payload as Record<string, unknown>),
            cooked: JSON.parse(
              serializeCookedMaterialRecord(
                validateCookedMaterialRecord(
                  (draft.payload as { cooked: unknown }).cooked,
                ).unwrap(),
              ),
            ),
          },
          refs: draft.refs,
          artifacts: {},
        },
      ],
    });
    const server = createServer((request, response) => {
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Content-Type', 'application/json');
      response.end(
        request.url === '/pack-index.json'
          ? JSON.stringify([{ guid, kind: 'material', packageUrl: '/material.pack.json' }])
          : payload,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing HTTP port');
    return {
      guid,
      url: `http://127.0.0.1:${address.port}/pack-index.json`,
      async close() {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

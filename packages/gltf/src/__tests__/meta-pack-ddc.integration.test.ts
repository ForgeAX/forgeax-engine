import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPackBuildProductCache,
  ImporterRegistry,
  produceSourcePackage,
} from '@forgeax/engine-import';
import { expect, it } from 'vitest';
import {
  captureMaterialSourceSnapshot,
  createMaterialPackCooker,
} from '../../../shader-compiler/src/material/pack-cooker.js';
import { gltfImporter } from '../gltf-importer.js';

function materialGlb(baseColor: readonly number[]): Uint8Array {
  const json = new TextEncoder().encode(
    JSON.stringify({
      asset: { version: '2.0' },
      extensionsUsed: ['KHR_materials_unlit'],
      materials: [
        {
          pbrMetallicRoughness: { baseColorFactor: baseColor },
          extensions: { KHR_materials_unlit: {} },
        },
      ],
      meshes: [],
      nodes: [],
      scenes: [],
    }),
  );
  const length = Math.ceil(json.length / 4) * 4;
  const bytes = new Uint8Array(20 + length);
  const header = new DataView(bytes.buffer);
  header.setUint32(0, 0x46546c67, true);
  header.setUint32(4, 2, true);
  header.setUint32(8, bytes.length, true);
  header.setUint32(12, length, true);
  header.setUint32(16, 0x4e4f534a, true);
  bytes.fill(32, 20);
  bytes.set(json, 20);
  return bytes;
}

it('restores a real GLB material from Pack DDC without repeating its importer or native Cook', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-glb-pack-ddc-'));
  try {
    const source = join(root, 'material.glb');
    await writeFile(source, materialGlb([0.8, 0.6, 0.4, 1]));
    const counts = { imports: 0, cooks: 0 };
    const registry = new ImporterRegistry();
    registry.register({
      ...gltfImporter,
      import(context) {
        counts.imports++;
        return gltfImporter.import(context);
      },
    });
    const native = createMaterialPackCooker([root], {
      profile: 'webgpu-storage',
      sourceSnapshot: await captureMaterialSourceSnapshot([root]),
    });
    const cookers = [
      {
        ...native,
        cook(input: Parameters<typeof native.cook>[0]) {
          counts.cooks++;
          return native.cook(input);
        },
      },
    ];
    const produce = async () => {
      const products = await createPackBuildProductCache({
        root: join(root, 'ddc'),
        identityRoot: root,
        outputVersions: { meta: '1' },
        cookers,
      });
      const result = await produceSourcePackage({
        meta: {
          importer: 'gltf',
          source,
          subAssets: [
            {
              guid: '01900000-0000-7000-8000-0000000000f2',
              sourceIndex: 0,
              sourceKey: 'material/demo',
              kind: 'material',
            },
          ],
        },
        registry,
        cookers,
        fs: {
          readSource: async (path) => ({ ok: true, value: new Uint8Array(await readFile(path)) }),
        },
        ddc: {
          products,
          identityRoot: root,
          producerIdentity: `sealed-gltf:${products.producerIdentity}`,
        },
      });
      if (!result.ok) throw result.error;
      return result.value;
    };
    const first = await produce();
    const warm = await produce();
    expect(warm).toEqual(first);
    expect(counts).toEqual({ imports: 1, cooks: 1 });
    await writeFile(source, materialGlb([0.2, 0.4, 0.8, 1]));
    const changed = await produce();
    expect(changed.product).not.toEqual(first.product);
    expect(counts).toEqual({ imports: 2, cooks: 2 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

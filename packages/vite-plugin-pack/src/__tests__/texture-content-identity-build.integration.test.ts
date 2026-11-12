// @perf-budget-skip: this single integration assertion includes a cold Vite build setup.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gltfImporter, parseGltf, toAssetPack } from '@forgeax/engine-gltf';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { encodePng } from '@forgeax/engine-image/png';
import { decodeCatalogWire } from '@forgeax/engine-pack';
import { build as viteBuild } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { pluginPack } from '../index.js';

const REPEAT = 10497;
const CLAMP = 33071;

/** One material: `color` as sRGB base colour, `data` as the linear normal map. */
function document(color: string, data: string, wrap: number) {
  return {
    asset: { version: '2.0' },
    images: [
      { name: 'color', uri: color, mimeType: 'image/png' },
      { name: 'data', uri: data, mimeType: 'image/png' },
    ],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: wrap, wrapT: wrap }],
    textures: [
      { name: 'color', source: 0, sampler: 0 },
      { name: 'data', source: 1, sampler: 0 },
    ],
    materials: [
      { pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, normalTexture: { index: 1 } },
    ],
  };
}

const solid = (r: number, g: number, b: number) =>
  encodePng(
    2,
    2,
    Uint8Array.from({ length: 16 }, (_, i) => [r, g, b, 255][i % 4] ?? 255),
  );

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeGltf(
  assets: string,
  name: string,
  json: ReturnType<typeof document>,
  files: Record<string, Uint8Array>,
) {
  const parsed = await parseGltf(
    json,
    async (uri) => (files[uri] ?? new Uint8Array()).slice().buffer,
    join(assets, name),
  );
  const pack = toAssetPack(
    parsed.unwrap(),
    { subAssets: [], importSettings: { textureIdentity: 'content' } } as never,
    name,
  ).unwrap();
  await writeFile(join(assets, name), JSON.stringify(json));
  await writeFile(join(assets, `${name}.meta.json`), JSON.stringify(pack.meta));
  return pack.meta.subAssets;
}

describe('content-identified textures in a production build', () => {
  it('publishes one row for shared bytes and keeps colour and data uses apart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-vpp-texture-content-'));
    roots.push(root);
    const assets = join(root, 'assets');
    const dist = join(root, 'dist');
    await mkdir(assets, { recursive: true });
    await writeFile(join(root, 'main.js'), 'console.log("texture content");\n');
    const brick = solid(200, 80, 40);
    const files = { 'brick.png': brick, 'brick-data.png': brick, 'mask.png': solid(128, 128, 255) };
    for (const [name, bytes] of Object.entries(files)) await writeFile(join(assets, name), bytes);

    // `a` reads brick as colour and mask as normal data; `b` reads brick as
    // colour on a clamped sampler and the same bytes (another file) as normal data.
    const subsA = await writeGltf(
      assets,
      'a.gltf',
      document('brick.png', 'mask.png', REPEAT),
      files,
    );
    const subsB = await writeGltf(
      assets,
      'b.gltf',
      document('brick.png', 'brick-data.png', CLAMP),
      files,
    );
    const guid = (subs: typeof subsA, kind: string, index: number) =>
      subs.find((sub) => sub.kind === kind && sub.sourceIndex === index)?.guid.toLowerCase();
    const sharedColor = guid(subsA, 'texture', 0);
    expect(guid(subsB, 'texture', 0)).toBe(sharedColor);
    expect(guid(subsB, 'texture', 1)).not.toBe(sharedColor);

    await viteBuild({
      root,
      configFile: false,
      logLevel: 'silent',
      build: { outDir: dist, emptyOutDir: true, rollupOptions: { input: { main: 'main.js' } } },
      plugins: [pluginPack({ roots: [assets], importers: [gltfImporter, imageImporter] })],
    });

    const catalog = decodeCatalogWire(
      JSON.parse(await readFile(join(dist, 'pack-index.json'), 'utf8')),
    ).unwrap();
    const rows = (target: string | undefined) =>
      catalog.filter((entry) => entry.guid.toLowerCase() === target);
    expect(rows(sharedColor)).toHaveLength(1);
    for (const target of [
      guid(subsA, 'texture', 1),
      guid(subsB, 'texture', 1),
      guid(subsA, 'sampler', 0),
      guid(subsB, 'sampler', 0),
    ])
      expect(rows(target)).toHaveLength(1);
    expect(new Set(catalog.map((entry) => entry.guid.toLowerCase())).size).toBe(catalog.length);
  });
});

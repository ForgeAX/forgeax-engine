import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import type { ImportContext, MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { exportMeshes, importMeshFile, objImporter, parseObjPackage } from '../index';

const OBJ =
  'mtllib paint.mtl\no Card\nv 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 0 1\nusemtl Paint\nf 1/1 2/2 3/3\n';
const MTL =
  'newmtl Paint\nKd 0.5 0.25 1\nKe 0.1 0 0\nPm 0.2\nPr 0.7\nd 0.8\nmap_Kd -s 2 3 1 -o 0.1 0.2 0 tex/color.png\nnorm tex/normal.png\n';
const encode = (text: string) => new TextEncoder().encode(text);
describe('OBJ source material and dependency closure', () => {
  it('preserves named groups, linear colors, scalars, map transforms and color domains', async () => {
    const requested: string[] = [];
    const result = (
      await parseObjPackage(OBJ, async (path) => {
        requested.push(path);
        return path === 'paint.mtl' ? encode(MTL) : new Uint8Array([1, 2, 3]);
      })
    ).unwrap();
    expect(result.meshes[0]?.mesh.materialSlots[0]?.slotName).toBe('Paint');
    expect(result.materials[0]?.material.values).toMatchObject({
      metallic: 0.2,
      roughness: 0.7,
      baseColor: [expect.closeTo(0.214041, 5), expect.closeTo(0.050876, 5), 1, 0.8],
    });
    expect(result.materials[0]?.textures[0]).toMatchObject({
      slot: 'baseColorTexture',
      scale: [2, 3],
      offset: [0.1, 0.2],
    });
    expect(result.textures.map((row) => row.colorSpace)).toEqual(['srgb', 'linear']);
    expect(requested).toEqual(['paint.mtl', 'tex/color.png', 'tex/normal.png']);
  });
  it('rejects missing libraries/images and unsupported map semantics instead of flattening', async () => {
    expect(
      (
        await parseObjPackage(OBJ, async () => {
          throw new Error('missing');
        })
      ).ok,
    ).toBe(false);
    expect(
      (await parseObjPackage(OBJ.replace('mtllib paint.mtl\n', ''), async () => encode(MTL))).ok,
    ).toBe(false);
    for (const key of ['map_d', 'map_Ks', 'map_Pr', 'map_Pm', 'map_Tr', 'map_Ka', 'map_custom'])
      expect(
        (await parseObjPackage(OBJ, async () => encode(`newmtl Paint\n${key} unsupported.png`))).ok,
      ).toBe(false);
  });
  it('rejects textured faces without source UVs', async () => {
    const result = await parseObjPackage(OBJ.replace('f 1/1 2/2 3/3', 'f 1 2 3'), async (path) =>
      path === 'paint.mtl' ? encode(MTL) : new Uint8Array([1, 2, 3]),
    );
    expect(result.ok).toBe(false);
  });
  it('resolves material names used by faces, without demanding an unused declaration', async () => {
    const result = await parseObjPackage(`${OBJ}usemtl Unused\n`, async (path) =>
      path === 'paint.mtl' ? encode(MTL) : new Uint8Array([1, 2, 3]),
    );
    expect(result.ok).toBe(true);
  });
  it('admission and importer preserve mesh/material/texture GUIDs and reference edges on reimport', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obj-closure-'));
    try {
      const path = join(root, 'card.obj');
      await writeFile(path, OBJ);
      await writeFile(join(root, 'paint.mtl'), MTL);
      await mkdir(join(root, 'tex'));
      for (const name of ['color', 'normal'])
        await writeFile(join(root, 'tex', `${name}.png`), new Uint8Array([1, 2, 3]));
      const first = (await importMeshFile(path)).unwrap(),
        second = (await importMeshFile(path)).unwrap();
      expect(second.subAssets).toEqual(first.subAssets);
      expect(first.subAssets.map((row) => row.kind)).toEqual([
        'mesh',
        'material',
        'texture',
        'texture',
      ]);
      const decoded: unknown[] = [];
      const ctx = {
        source: 'card.obj',
        subAssets: first.subAssets,
        importSettings: {},
        readSource: async () => ({ ok: true, value: await readFile(path) }),
        readSibling: async (uri) => ({ ok: true, value: await readFile(join(root, uri)) }),
        decodeImage: async (_bytes, _mime, settings) => {
          decoded.push(settings);
          return {
            ok: true,
            value: {
              texture: {
                kind: 'texture',
                shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
                format: 'rgba8unorm',
                colorSpace: settings.colorSpace as 'srgb' | 'linear',
                data: new Uint8Array([255, 255, 255, 255]),
                mips: { kind: 'none' },
              },
              bytes: new Uint8Array([255, 255, 255, 255]),
              mediaType: 'application/octet-stream',
            },
          };
        },
      } satisfies ImportContext;
      const result = await objImporter.import(ctx);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const mesh = requireValue(result.value.assets.find((row) => row.kind === 'mesh'));
      const material = requireValue(result.value.assets.find((row) => row.kind === 'material'));
      expect((mesh.payload as MeshAsset).materialSlots[0]?.defaultMaterial).toBeDefined();
      expect(mesh.refs[0]?.guid).toBe(material.guid);
      expect(material.refs).toHaveLength(2);
      expect((material.payload as MaterialAsset).values?.baseColorTexture).toMatchObject({
        texture: 0,
        coordinates: { set: 0, transform: { scale: [2, -3], offset: [0.1, 0.8] } },
      });
      expect(decoded).toEqual([{ colorSpace: 'srgb' }, { colorSpace: 'linear' }]);
      expect(result.value.sourceDependencies).toEqual([
        'paint.mtl',
        'tex/color.png',
        'tex/normal.png',
      ]);
      expect(
        (
          await objImporter.import({
            ...ctx,
            subAssets: first.subAssets.filter((row) => row.kind !== 'texture'),
          })
        ).ok,
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each([
    'obj',
    'stl',
  ] as const)('rejects material loss in geometry-only %s byte export', async (format) => {
    expect(
      (
        await exportMeshes(
          [
            {
              name: 'Card',
              mesh: createBoxGeometry(1, 1, 1).unwrap(),
              materials: [{ color: [1, 0, 0] }],
            },
          ],
          format,
        )
      ).ok,
    ).toBe(false);
  });
});

function requireValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing fixture value');
  return value;
}

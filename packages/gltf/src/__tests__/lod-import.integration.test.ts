import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseGltfLodExtension } from '../lod/parse-lod.js';

async function fixture(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(new URL(`./fixtures/lod/${name}`, import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
}

describe('glTF MSFT_lod producer contract', () => {
  it('adopts node-level ids in author order and suppresses lower nodes', async () => {
    const json = await fixture('msft-lod.gltf');
    const result = parseGltfLodExtension(json);
    expect(result).toMatchObject({
      ok: true,
      value: { rootNode: 0, lodNodeIds: [1, 2], screenCoverages: [0.5, 0.2] },
    });
  });

  it('adopts the official node extras coverage array and drops its terminal discard hint', async () => {
    const json = await fixture('msft-lod-node-extras.gltf');
    const result = parseGltfLodExtension(json);
    expect(result).toMatchObject({
      ok: true,
      value: {
        rootNode: 0,
        lodNodeIds: [1, 2],
        screenCoverages: [0.5, 0.2],
        groups: [{ rootNode: 0, lodNodeIds: [1, 2], screenCoverages: [0.5, 0.2] }],
      },
    });
  });

  it('rejects an official node extras array whose root/level count is incomplete', () => {
    expect(
      parseGltfLodExtension({
        meshes: [{ primitives: [{}] }, { primitives: [{}] }, { primitives: [{}] }],
        nodes: [
          {
            extensions: { MSFT_lod: { ids: [1, 2] } },
            extras: { MSFT_screencoverage: [0.5, 0.2] },
          },
          {},
          {},
        ],
      }),
    ).toMatchObject({ ok: false, error: { code: 'gltf-lod-invalid' } });
  });

  it('fails closed when a required MSFT_lod extension has no normalizable group', () => {
    expect(
      parseGltfLodExtension({ extensionsRequired: ['MSFT_lod'], nodes: [{ mesh: 0 }] }),
    ).toMatchObject({ ok: false, error: { code: 'gltf-lod-invalid' } });
  });

  it('requires every referenced node to resolve a mesh sub-asset', () => {
    expect(
      parseGltfLodExtension({
        nodes: [{ mesh: 0, extensions: { MSFT_lod: { ids: [1] } } }, {}],
      }),
    ).toMatchObject({ ok: false, error: { code: 'gltf-lod-invalid' } });
  });

  it('rejects a referenced mesh index outside the source mesh table', () => {
    expect(
      parseGltfLodExtension({
        meshes: [{}],
        nodes: [{ mesh: 0, extensions: { MSFT_lod: { ids: [1] } } }, { mesh: 2 }],
      }),
    ).toMatchObject({ ok: false, error: { code: 'gltf-lod-invalid' } });
  });

  it('rejects a referenced mesh with no primitives before publication', () => {
    expect(
      parseGltfLodExtension({
        meshes: [{ primitives: [] }, { primitives: [{}] }],
        nodes: [{ mesh: 0, extensions: { MSFT_lod: { ids: [1] } } }, { mesh: 1 }],
      }),
    ).toMatchObject({ ok: false, error: { code: 'gltf-lod-invalid' } });
  });

  it('rejects malformed required extension instead of loading only LOD0', async () => {
    const json = await fixture('msft-lod-malformed.gltf');
    expect(parseGltfLodExtension(json)).toMatchObject({
      ok: false,
      error: { code: 'gltf-lod-invalid' },
    });
  });

  it('retains every node-level relation for multi-root scenes', async () => {
    const json = await fixture('msft-lod-multi-root.gltf');
    const result = parseGltfLodExtension(json);
    expect(result).toMatchObject({
      ok: true,
      value: {
        rootNode: 0,
        lodNodeIds: [1, 2],
        groups: [
          { rootNode: 0, lodNodeIds: [1, 2] },
          { rootNode: 3, lodNodeIds: [4, 5] },
        ],
      },
    });
  });
});

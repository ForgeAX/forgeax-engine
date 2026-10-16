import { ImporterRegistry, type RunImportMeta, runImport } from '@forgeax/engine-import';
import type { ImportContext } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { imageImporter } from '../image-importer.js';
import { makePng } from './make-fixture.js';

const PNG_GUID = '019e3969-1d43-7610-8810-e80dbd491d90';
const SECOND_GUID = '019e3969-1d43-7610-8810-e80dbd491d91';

function imageRegistry(): ImporterRegistry {
  const registry = new ImporterRegistry();
  registry.register(imageImporter);
  return registry;
}

function imageMeta(
  source: string,
  subAssets: RunImportMeta['subAssets'],
  importSettings: Readonly<Record<string, unknown>> = {},
): RunImportMeta {
  return { importer: 'image', source, subAssets, importSettings };
}

function readSourceFor(bytes: Uint8Array): ImportContext['readSource'] {
  return async () => ({ ok: true as const, value: bytes });
}

describe('image importer required output topology', () => {
  it('reserves .cube sources for the ordinary texture producer topology', async () => {
    const registry = imageRegistry();
    const result = await runImport(
      imageMeta('grading.cube', [
        { guid: PNG_GUID, sourceIndex: 0, sourceKey: 'grading/lut', kind: 'texture' },
      ]),
      registry,
      { readSource: readSourceFor(new TextEncoder().encode(cubeFixture(16))) },
    );
    expect(result.ok).toBe(true);
    if (!result.ok || 'skipped' in result.value) return;
    expect(result.value.product.assets[0]).toMatchObject({
      guid: PNG_GUID,
      kind: 'texture',
      payload: { kind: 'texture', shape: { viewDimension: '3d' } },
    });
  });

  it.each([
    { source: 'texture.png', label: 'PNG' },
    { source: 'texture.jpeg', label: 'JPEG' },
    { source: 'texture.basis', label: 'Basis' },
    { source: 'texture.ktx2', label: 'KTX2' },
  ])('$label rejects every invalid texture topology after the runner probe', async ({ source }) => {
    const invalidTopologies: ReadonlyArray<{
      readonly name: string;
      readonly subAssets: RunImportMeta['subAssets'];
      readonly actual: string;
    }> = [
      { name: 'zero outputs', subAssets: [], actual: 'subAssets[] is empty' },
      {
        name: 'foreign output',
        subAssets: [{ guid: PNG_GUID, sourceIndex: 0, sourceKey: 'foreign:mesh', kind: 'mesh' }],
        actual: `subAssets[0]=mesh:${PNG_GUID}:sourceIndex=0`,
      },
      {
        name: 'duplicate outputs',
        subAssets: [
          { guid: PNG_GUID, sourceIndex: 0, sourceKey: 'image:first', kind: 'texture' },
          { guid: SECOND_GUID, sourceIndex: 0, sourceKey: 'image:second', kind: 'texture' },
        ],
        actual: `subAssets[0]=texture:${PNG_GUID}:sourceIndex=0, subAssets[1]=texture:${SECOND_GUID}:sourceIndex=0`,
      },
      {
        name: 'wrong sourceIndex',
        subAssets: [
          { guid: PNG_GUID, sourceIndex: 1, sourceKey: 'image:texture', kind: 'texture' },
        ],
        actual: `subAssets[0]=texture:${PNG_GUID}:sourceIndex=1`,
      },
      {
        name: 'equirect output',
        subAssets: [
          { guid: PNG_GUID, sourceIndex: 0, sourceKey: 'foreign:equirect', kind: 'equirect' },
        ],
        actual: `subAssets[0]=equirect:${PNG_GUID}:sourceIndex=0`,
      },
    ];

    for (const topology of invalidTopologies) {
      const readSource = vi.fn<ImportContext['readSource']>(readSourceFor(new Uint8Array([0])));
      const result = await runImport(imageMeta(source, topology.subAssets), imageRegistry(), {
        readSource,
      });

      expect(result.ok, `${source} ${topology.name} unexpectedly succeeded`).toBe(false);
      expect(readSource).toHaveBeenCalledTimes(1);
      if (result.ok) continue;
      expect(result.error.code).toBe('source-validation-failed');
      expect(result.error.detail).toMatchObject({
        diagnostics: [
          expect.objectContaining({
            code: 'image-subasset-topology',
            rule: 'image-required-single-output',
            expected: 'exactly one subAssets[] entry with kind "texture" and sourceIndex 0',
            actual: topology.actual,
          }),
        ],
      });
    }
  });

  it.each([
    { name: 'zero outputs', subAssets: [], actual: 'subAssets[] is empty' },
    {
      name: 'texture output',
      subAssets: [
        { guid: PNG_GUID, sourceIndex: 0, sourceKey: 'foreign:texture', kind: 'texture' },
      ],
      actual: `subAssets[0]=texture:${PNG_GUID}:sourceIndex=0`,
    },
    {
      name: 'duplicate outputs',
      subAssets: [
        { guid: PNG_GUID, sourceIndex: 0, sourceKey: 'image:first', kind: 'equirect' },
        { guid: SECOND_GUID, sourceIndex: 0, sourceKey: 'image:second', kind: 'equirect' },
      ],
      actual: `subAssets[0]=equirect:${PNG_GUID}:sourceIndex=0, subAssets[1]=equirect:${SECOND_GUID}:sourceIndex=0`,
    },
    {
      name: 'wrong sourceIndex',
      subAssets: [
        { guid: PNG_GUID, sourceIndex: 1, sourceKey: 'image:equirect', kind: 'equirect' },
      ],
      actual: `subAssets[0]=equirect:${PNG_GUID}:sourceIndex=1`,
    },
  ])('HDR rejects $name after the runner probe', async ({ subAssets, actual }) => {
    const readSource = vi.fn<ImportContext['readSource']>(readSourceFor(new Uint8Array([0])));
    const result = await runImport(imageMeta('environment.hdr', subAssets), imageRegistry(), {
      readSource,
    });

    expect(result.ok).toBe(false);
    expect(readSource).toHaveBeenCalledTimes(1);
    if (result.ok) return;
    expect(result.error.code).toBe('source-validation-failed');
    expect(result.error.detail).toMatchObject({
      diagnostics: [
        expect.objectContaining({
          code: 'image-subasset-topology',
          rule: 'image-required-single-output',
          expected: 'exactly one subAssets[] entry with kind "equirect" and sourceIndex 0',
          actual,
        }),
      ],
    });
  });

  it('retries corrected Meta through the same registry and preserves the stable Pack artifact', async () => {
    const registry = imageRegistry();
    const readSource = vi.fn<ImportContext['readSource']>(
      readSourceFor(makePng(1, 1, [10, 20, 30, 255])),
    );
    const subAssets: RunImportMeta['subAssets'][number][] = [];
    const meta: RunImportMeta = imageMeta('tile.png', subAssets, {
      colorSpace: 'srgb',
      mipmap: 'none',
    });

    const rejected = await runImport(meta, registry, { readSource });
    expect(rejected.ok).toBe(false);
    expect(readSource).toHaveBeenCalledTimes(1);
    if (!rejected.ok) expect(rejected.error.code).toBe('source-validation-failed');

    subAssets.push({
      guid: PNG_GUID,
      sourceIndex: 0,
      sourceKey: 'image:texture',
      kind: 'texture',
    });
    const repaired = await runImport(meta, registry, { readSource });

    expect(repaired.ok).toBe(true);
    expect(readSource).toHaveBeenCalledTimes(3);
    if (!repaired.ok || 'skipped' in repaired.value) return;
    expect(repaired.value.product.sourceDependencies).toEqual(['tile.png']);
    expect(repaired.value.pack.assets).toHaveLength(1);
    expect(repaired.value.pack.assets[0]).toMatchObject({
      guid: PNG_GUID,
      kind: 'texture',
      sourceKey: 'image:texture',
      sourceIndex: 0,
      payload: {
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
        format: 'rgba8unorm-srgb',
        colorSpace: 'srgb',
        mips: { kind: 'none' },
      },
      artifacts: {
        body: {
          mediaType: 'application/x-forgeax-rgba8',
          assetCodec: { name: 'rgba8', version: '1' },
        },
      },
    });
    expect(Array.from(repaired.value.pack.assets[0]?.artifacts.body?.bytes ?? [])).toEqual(
      repaired.value.pack.assets[0]?.payload.data,
    );

    const repeated = await runImport(meta, registry, { readSource });
    expect(repeated.ok).toBe(true);
    expect(readSource).toHaveBeenCalledTimes(5);
    if (!repeated.ok || 'skipped' in repeated.value) return;
    expect(repeated.value.product.sourceDependencies).toEqual(
      repaired.value.product.sourceDependencies,
    );
    expect(repeated.value.pack.assets[0]).toMatchObject({
      guid: PNG_GUID,
      kind: 'texture',
      sourceKey: 'image:texture',
      sourceIndex: 0,
      payload: repaired.value.pack.assets[0]?.payload,
    });
    expect(repeated.value.pack.assets[0]?.artifacts).toEqual(
      repaired.value.pack.assets[0]?.artifacts,
    );
  });
});

function cubeFixture(size: number): string {
  return [
    `LUT_3D_SIZE ${size}`,
    'DOMAIN_MIN 0 0 0',
    'DOMAIN_MAX 1 1 1',
    ...Array.from({ length: size ** 3 }, () => '0 0 0'),
  ].join('\n');
}

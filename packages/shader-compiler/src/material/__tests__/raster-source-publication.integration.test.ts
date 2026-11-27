import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeMaterialProgramWire } from '@forgeax/engine-pack';
import { finalizePackageTransportSource } from '@forgeax/engine-pack/build';
import {
  validateCookedMaterialRecord,
  validateSourceCookedMaterialRecord,
} from '@forgeax/engine-pack/material-cook';
import { type MaterialAsset, sha256 } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import {
  MATERIAL_RASTER_SOURCES_PATH,
  type MaterialRasterSourcePublication,
  prepareShaderCompiler,
  rebuildMaterialSourcePrograms,
  selectMaterialRasterSources,
} from '../../program.js';
import { createMaterialPackCooker } from '../pack-cooker.js';

const source = `#define_import_path test::raster_source
#import forgeax_material::parameters::{material}
@vertex fn vs_main() -> @builtin(position) vec4f { return vec4f(0, 0, 0, 1); }
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(material.roughness); }
`;

it('publishes source-only raster programs in a native Pack and reproduces the selected bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-raster-source-'));
  try {
    await writeFile(join(root, 'raster-source.wgsl'), source);
    const guid = '019fc692-1000-7000-8000-000000000010';
    const material: MaterialAsset = {
      kind: 'material',
      parameters: [{ name: 'roughness', type: 'f32', default: 0.25 }],
      passes: [{ name: 'forward', program: { module: 'test::raster_source' } }],
    };
    const ordinary = createMaterialPackCooker([root], { profile: 'webgpu-storage' });
    const sourceCooker = createMaterialPackCooker([root], {
      profile: 'webgpu-storage',
      rasterSourceDigests: [],
    });
    const byteDraft = await ordinary.cook({ guid, source: material });
    const draft = await sourceCooker.cook({ guid, source: material });
    expect(byteDraft.artifacts[MATERIAL_RASTER_SOURCES_PATH]).toBeUndefined();
    expect(draft.inputFingerprint).not.toBe(byteDraft.inputFingerprint);
    expect(draft.payload).toEqual(byteDraft.payload);

    const compiled = validateCookedMaterialRecord(
      (byteDraft.payload as { cooked: unknown }).cooked,
    ).unwrap();
    const sourceAsset = {
      guid,
      kind: 'material',
      payload: {
        ...(draft.payload as Readonly<Record<string, unknown>>),
        cooked: {
          ...compiled,
          programs: compiled.programs.map(({ artifact, ...program }) => {
            const { bytes: _bytes, ...identity } = artifact;
            return { ...program, artifact: identity };
          }),
        },
      },
      refs: draft.refs,
      artifacts: draft.artifacts,
    };
    const output = new Map<string, Uint8Array>();
    await finalizePackageTransportSource(
      { assets: [sourceAsset] },
      {
        base: '/assets',
        packagePath: 'material.pack.json',
        materialProgramTransport: 'raster-source',
        artifactPath: (asset, key) => `${asset}/${key}`,
        sink: (path, bytes) => {
          output.set(path, bytes);
        },
      },
    );
    const decoder = new TextDecoder();
    const pack = decodeMaterialProgramWire(
      JSON.parse(decoder.decode(output.get('material.pack.json'))),
    ).unwrap() as {
      assets: [
        {
          payload: { cooked: unknown };
          artifacts: Record<string, { path: string; integrity: { digest: string } }>;
        },
      ];
    };
    const entry = pack.assets[0];
    const descriptor = entry.artifacts[MATERIAL_RASTER_SOURCES_PATH];
    if (descriptor === undefined) throw new Error('Missing published raster source');
    const sourceBytes = output.get(descriptor.path);
    if (sourceBytes === undefined) throw new Error('Missing raster source artifact body');
    expect(descriptor.integrity.digest).toBe(`sha256:${sha256(sourceBytes)}`);
    const publication = JSON.parse(decoder.decode(sourceBytes)) as MaterialRasterSourcePublication;
    expect(publication.modules.modules).toEqual([
      { kind: 'project', module: 'test::raster_source', digest: sha256(source), source },
    ]);

    expect(validateCookedMaterialRecord(entry.payload.cooked).ok).toBe(false);
    const record = validateSourceCookedMaterialRecord(entry.payload.cooked).unwrap();
    expect(record.receipt).toEqual(compiled.receipt);
    expect(record.programs).toHaveLength(compiled.programs.length);
    expect([...output.keys()].sort()).toEqual(['material.pack.json', descriptor.path].sort());
    expect(Object.keys(entry.artifacts)).toEqual([MATERIAL_RASTER_SOURCES_PATH]);
    for (const { artifact } of record.programs) {
      expect(artifact).toMatchObject({ backing: 'raster-source' });
      expect(artifact).not.toHaveProperty('bytes');
    }
    const program = compiled.programs[0];
    if (program === undefined) throw new Error('Missing cooked program');
    const keys = [program.specializationKey];
    const selections = selectMaterialRasterSources(publication, record, keys).unwrap();
    expect(
      selectMaterialRasterSources({ ...publication, programSetDigest: 'stale' }, record, keys),
    ).toMatchObject({ ok: false, error: { code: 'shader-compile-failed' } });
    const compiler = (await prepareShaderCompiler()).unwrap();
    const rebuilt = rebuildMaterialSourcePrograms(compiler, {
      modules: publication.modules,
      engine: { sources: {} },
      materials: { [guid]: material },
      selections,
    }).unwrap();
    expect(rebuilt.map(({ wgsl }) => wgsl)).toEqual([decoder.decode(program.artifact.bytes)]);
    expect(rebuilt[0]?.reflection.entryPoints).toEqual(program.selections[0]?.abi?.entryPoints);

    const path = program.artifact.path;
    await expect(
      finalizePackageTransportSource(
        {
          assets: [
            {
              ...sourceAsset,
              artifacts: {
                ...draft.artifacts,
                [path]: { mediaType: 'text/wgsl', bytes: new TextEncoder().encode('wrong WGSL') },
              },
            },
          ],
        },
        {
          base: '/assets',
          packagePath: 'invalid.pack.json',
          materialProgramTransport: 'raster-source',
          artifactPath: (asset, key) => `${asset}/${key}`,
        },
      ),
    ).rejects.toMatchObject({
      code: 'invalid-material-source',
      expected: 'a valid cook at programs[0].artifact',
    });

    await expect(
      finalizePackageTransportSource(
        {
          assets: [
            {
              guid,
              kind: 'material',
              payload: byteDraft.payload as Readonly<Record<string, unknown>>,
              refs: byteDraft.refs,
              artifacts: byteDraft.artifacts,
            },
          ],
        },
        {
          base: '/assets',
          packagePath: 'missing.pack.json',
          materialProgramTransport: 'raster-source',
          artifactPath: (asset, key) => `${asset}/${key}`,
          sink: () => {
            throw new Error('Incomplete source publication reached the sink');
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'invalid-material-source' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

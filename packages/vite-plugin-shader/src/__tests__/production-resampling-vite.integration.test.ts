import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeDocumentText } from '@forgeax/engine-codec';
import {
  admitShaderTemplateManifest,
  findVariantByDefines,
  LIGHT_TEXTURE_RESAMPLE_COMPUTE_IDENTIFIER,
  LIGHT_TEXTURE_RESAMPLE_FRAGMENT_IDENTIFIER,
  ShaderRegistry,
} from '@forgeax/engine-shader';
import { MATERIAL_WGSL_PROFILE } from '@forgeax/engine-shader-compiler';
import { prepareShaderProgramCompiler } from '@forgeax/engine-shader-compiler/program';
import { build } from 'vite';
import { afterEach, expect, it, vi } from 'vitest';
import { forgeaxShader } from '../index.js';
import { publishShaderManifest } from '../manifest-publication.js';
import { SHADER_MANIFEST_TEST_TIMEOUT_MS } from './shader-manifest.fixture.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it(
  'emits production templates through Vite and admits the selected resampling and Standard programs',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'production-resampling-vite-'));
    try {
      await writeFile(join(root, 'entry.js'), 'export {}\n');
      vi.stubEnv('FORGEAX_ENGINE_SHADER_SOURCE_BUILD', undefined);
      vi.stubEnv('FORGEAX_SHARED_APP_INPUTS_MANIFEST', undefined);
      const output = await build({
        configFile: false,
        logLevel: 'silent',
        root,
        plugins: [forgeaxShader()],
        build: {
          write: false,
          reportCompressedSize: false,
          rollupOptions: { input: join(root, 'entry.js') },
        },
      });
      if (!Array.isArray(output) && !('output' in output)) {
        throw new Error('Vite returned a watcher instead of a completed build output');
      }
      const manifestAsset = (Array.isArray(output) ? output : [output])
        .flatMap((bundle) => bundle.output)
        .find((item) => item.type === 'asset' && item.fileName === 'shaders/manifest.json');
      if (manifestAsset?.type !== 'asset' || typeof manifestAsset.source === 'string') {
        throw new Error('Vite did not emit a compressed shader manifest');
      }
      const wireBytes = new Uint8Array(manifestAsset.source);
      const decoded = await decodeDocumentText(wireBytes);
      if (!decoded.ok) throw new Error('emitted template manifest did not decode');
      const wire = admitShaderTemplateManifest(JSON.parse(decoded.value)).unwrap().wire;
      vi.stubGlobal('fetch', async () => new Response(wireBytes));
      const registry = new ShaderRegistry({
        manifestUrl: 'https://production-resampling.invalid/shaders/manifest.json',
        prepareProgramCompiler: prepareShaderProgramCompiler,
      });
      (await registry.loadManifest()).unwrap();
      expect(registry.programTemplateInspection().selections).toBe(0);
      const entries = [...registry.entries()];

      for (const [identifier, expectedEntryPoints, colorTargets] of [
        [
          LIGHT_TEXTURE_RESAMPLE_COMPUTE_IDENTIFIER,
          [
            ['light_texture_resample', 'compute'],
            ['light_texture_reduce', 'compute'],
          ],
          [],
        ],
        [
          LIGHT_TEXTURE_RESAMPLE_FRAGMENT_IDENTIFIER,
          [
            ['light_texture_fullscreen', 'vertex'],
            ['light_texture_resample_fragment', 'fragment'],
          ],
          [
            { location: 0, format: 'rgba32float', numericType: 'float' },
            { location: 1, format: 'rgba8unorm', numericType: 'float' },
          ],
        ],
      ] as const) {
        const directRows = wire.entries.filter((entry) => entry.identifier === identifier);
        const materialRows = wire.materialShaders.filter(
          (entry) => entry.identifier === identifier,
        );
        expect(directRows).toHaveLength(1);
        expect(materialRows).toHaveLength(1);
        const [direct] = directRows;
        const [material] = materialRows;
        if (direct === undefined || material === undefined) throw new Error(identifier);
        expect(material.program).toBe(direct.program);
        expect(material.selection).toEqual(direct.selection);
        expect(direct.programContract?.colorTargets).toEqual(colorTargets);

        const selected = registry.resolveProgramTemplate(direct.program, direct.selection).unwrap();
        const runtimeEntry = entries.find((entry) => entry.identifier === identifier);
        const runtimeMaterial = registry.materialShaderManifestEntry(identifier);
        expect(runtimeEntry?.hash).toBe(direct.hash);
        expect(runtimeEntry?.sourceDigest).toBe(selected.program.sourceReference.identity);
        expect(runtimeMaterial?.sourceDigest).toBe(selected.program.sourceReference.identity);
        expect(runtimeEntry?.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(runtimeMaterial?.compilerProfile).toEqual(MATERIAL_WGSL_PROFILE);
        expect(runtimeEntry?.reflection).toEqual(selected.manifestEntry.reflection);
        expect(runtimeMaterial?.reflection).toEqual(selected.manifestEntry.reflection);
        expect(runtimeEntry?.programContract?.colorTargets).toEqual(colorTargets);
        for (const [name, stage] of expectedEntryPoints) {
          expect(runtimeEntry?.entryPoints).toContainEqual(
            expect.objectContaining({ name, stage }),
          );
          expect(runtimeMaterial?.entryPoints).toContainEqual(
            expect.objectContaining({ name, stage }),
          );
        }
      }

      const standardId = 'forgeax::default-standard-pbr';
      const standard = registry.materialShaderManifestEntry(standardId);
      const standardEntry = entries.find((entry) => entry.identifier === standardId);
      const direct = wire.entries.find((entry) => entry.identifier === standardId);
      const material = wire.materialShaders.find((entry) => entry.identifier === standardId);
      if (!standard || !standardEntry || !direct || !material)
        throw new Error('missing Standard source or admitted entry');
      expect(material.program).toBe(direct.program);
      const primary = registry
        .resolveProgramTemplate(material.program, material.selection)
        .unwrap();
      const selected = registry.resolveProgramTemplate(direct.program, direct.selection).unwrap();
      expect(standard.sourceDigest).toBe(primary.program.sourceReference.identity);
      expect(standard.reflection).toEqual(primary.manifestEntry.reflection);
      expect(standardEntry.sourceDigest).toBe(selected.program.sourceReference.identity);
      expect(standardEntry.reflection).toEqual(selected.manifestEntry.reflection);
      expect(standardEntry.defines).toMatchObject(direct.selection);

      for (const storage of [true, false]) {
        const constraints = {
          CLUSTER_FORWARD_AVAILABLE: true,
          STORAGE_BUFFER_AVAILABLE: storage,
        };
        const variant = findVariantByDefines(standard, constraints);
        if (variant === undefined) throw new Error(`missing Standard storage=${storage}`);
        const compiled = registry
          .resolveProgramTemplate(material.program, variant.defines)
          .unwrap();
        expect(variant.defines).toMatchObject(constraints);
        expect(variant.hash).toBe(compiled.manifestEntry.hash);
        expect(variant.sourceDigest).toBe(compiled.program.sourceReference.identity);
        expect(variant.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(variant.compilerProfile).toEqual(MATERIAL_WGSL_PROFILE);
        expect(variant.entryPoints).toEqual(compiled.manifestEntry.entryPoints);
        expect(variant.reflection).toEqual(compiled.manifestEntry.reflection);
        expect(variant.reflection?.boundGlobals).toContainEqual(
          expect.objectContaining({
            group: 0,
            binding: 30,
            resourceKind: storage ? 'storage-buffer' : 'texture',
            ...(storage ? { addressSpace: 'storage' } : {}),
          }),
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  SHADER_MANIFEST_TEST_TIMEOUT_MS,
);

it('keeps generic registry admission usable for custom manifests without engine resampling entries', async () => {
  const previousFetch = globalThis.fetch;
  try {
    const wireText = JSON.stringify(
      publishShaderManifest([{ hash: 'custom-entry', wgsl: 'fn custom() {}', bindings: '[]' }], []),
    );
    globalThis.fetch = async () => new Response(wireText);
    const registry = new ShaderRegistry({
      manifestUrl: 'https://custom-shader.invalid/shaders/manifest.json',
    });
    const admitted = await registry.loadManifest();
    expect(admitted.ok, admitted.ok ? '' : JSON.stringify(admitted.error)).toBe(true);
    expect([...registry.entries()].map(({ hash }) => hash)).toEqual(['custom-entry']);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

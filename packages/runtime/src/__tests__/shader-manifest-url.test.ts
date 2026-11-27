import {
  admitShaderTemplateManifest,
  readShaderManifestPublication,
  SHADER_MANIFEST_PUBLICATION_VERSION,
  SHADER_PROJECT_MANIFEST_VERSION,
} from '@forgeax/engine-shader';
import {
  buildEngineShaderTemplateManifest,
  publishShaderManifest,
} from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { waterInfoShaderFixture } from '../../../render/src/__tests__/shader-manifest-fixture';
import { rewriteShaderTemplateSources, shaderManifestUrl } from './shader-manifest-url.fixture';

it('fetches every shader variant and binding through a verified shared-source publication', async () => {
  const common = 'fn shared() {}\n\n';
  const first = `${common}fn first() {}\n`;
  const second = `${common}fn second() { shared(); }`;
  const manifest: Parameters<typeof shaderManifestUrl>[0] = {
    schemaVersion: '1.0.0',
    entries: [
      ...waterInfoShaderFixture.entries,
      { hash: 'first', wgsl: first, glsl: '', bindings: '[{"group":0,"binding":1}]' },
      { hash: 'second', wgsl: second, glsl: '', bindings: '[]' },
    ],
    materialShaders: [
      ...waterInfoShaderFixture.materialShaders,
      {
        identifier: 'fixture::material',
        sourcePath: 'fixture/material.wgsl',
        composedWgsl: first,
        paramSchema: '{"roughness":{"type":"f32"}}',
        variants: [
          { definesKey: 'MODE=false', defines: { MODE: false }, composedWgsl: second },
          { definesKey: 'MODE=true', defines: { MODE: true }, composedWgsl: first },
        ],
      },
    ],
  };
  const publication = await (await fetch(shaderManifestUrl(manifest))).json();
  expect(publication.schemaVersion).toBe(SHADER_MANIFEST_PUBLICATION_VERSION);
  expect(await readShaderManifestPublication(publication)).toEqual({
    entries: manifest.entries.map((entry, index) => ({
      ...entry,
      sourceDigest: publication.entries[index].sourceDigest,
    })),
    materialShaders: manifest.materialShaders.map((entry, index) => ({
      ...entry,
      sourceDigest: publication.materialShaders[index].sourceDigest,
      variants: entry.variants.map((variant, variantIndex) => ({
        ...variant,
        sourceDigest: publication.materialShaders[index].variants[variantIndex].sourceDigest,
      })),
    })),
  });

  const missingSource = { ...publication, sources: { ...publication.sources } };
  delete missingSource.sources[publication.entries[0].sourceDigest];
  await expect(readShaderManifestPublication(missingSource)).rejects.toThrow();

  const corruptSource = { ...publication, fragments: [...publication.fragments] };
  corruptSource.fragments[0] += '// modified source';
  await expect(readShaderManifestPublication(corruptSource)).rejects.toThrow();

  Object.defineProperty(manifest, 'toJSON', { value: () => publication });
  Object.defineProperty(manifest, 'materialShaders', {
    get() {
      throw new Error('prepared publication must not expand material variants again');
    },
  });
  expect(await (await fetch(shaderManifestUrl(manifest))).json()).toEqual(publication);
});

it('transports template and mixed publications with a republished source control', async () => {
  const original = await buildEngineShaderTemplateManifest();
  const authored = 'return EnvironmentScattering(single, multi, ems);';
  const replacement = 'return EnvironmentScattering(single, vec3<f32>(0.0), ems);';
  const control = rewriteShaderTemplateSources(original, (source) =>
    source.replace(authored, replacement),
  );
  expect(control.patched).toBe(1);
  const result = await (await fetch(shaderManifestUrl(control.manifest))).json();
  const { wire } = admitShaderTemplateManifest(result).unwrap();
  expect(wire.entries).toEqual(original.entries);
  expect(wire.materialShaders).toEqual(original.materialShaders);
  expect(Object.values(wire.library.sources).some((source) => source.includes(replacement))).toBe(
    true,
  );
  expect(Object.values(wire.library.sources).some((source) => source.includes(authored))).toBe(
    false,
  );
  const mixed = {
    schemaVersion: SHADER_PROJECT_MANIFEST_VERSION,
    templates: control.manifest,
    cooked: publishShaderManifest([], []),
  };
  expect(await (await fetch(shaderManifestUrl(mixed))).json()).toEqual(mixed);
});

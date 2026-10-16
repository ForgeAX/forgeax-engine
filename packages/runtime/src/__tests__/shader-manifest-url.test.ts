import {
  readShaderManifestPublication,
  SHADER_MANIFEST_PUBLICATION_VERSION,
} from '@forgeax/engine-shader';
import { expect, it } from 'vitest';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

it('fetches every shader variant and binding through a verified shared-source publication', async () => {
  const common = 'fn shared() {}\n\n';
  const first = `${common}fn first() {}\n`;
  const second = `${common}fn second() { shared(); }`;
  const manifest: Parameters<typeof shaderManifestUrl>[0] = {
    schemaVersion: '1.0.0',
    entries: [
      { hash: 'first', wgsl: first, glsl: '', bindings: '[{"group":0,"binding":1}]' },
      { hash: 'second', wgsl: second, glsl: '', bindings: '[]' },
    ],
    materialShaders: [
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
    entries: manifest.entries,
    materialShaders: manifest.materialShaders,
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

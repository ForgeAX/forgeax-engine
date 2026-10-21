import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  readShaderManifestPublication,
  SHADER_MANIFEST_PUBLICATION_VERSION,
  shaderSourceDigestInput,
} from '@forgeax/engine/shader';
import { createMusicFixtureShaderManifest } from '../shader-manifest.mjs';

function publication(schemaVersion = SHADER_MANIFEST_PUBLICATION_VERSION) {
  const source = 'fn vs_main() -> @builtin(position) vec4f { return vec4f(0.0); }';
  const fragments = [source.slice(0, 20), source.slice(20)];
  const digest = createHash('sha256')
    .update(shaderSourceDigestInput(fragments.map((part) => createHash('sha256').update(part).digest())))
    .digest('hex');
  return {
    schemaVersion,
    receipts: [{ id: 'unused-0' }, { id: 'unused-1' }, { id: 'pbr' }, { id: 'variant' }],
    entryPoints: [[{ name: 'skin', stage: 'vertex', bindings: [] }], [{ name: 'vs_main', stage: 'vertex', bindings: [] }], []],
    fragments,
    sources: { [digest]: [0, 1] },
    entries: [{ identifier: 'vs_main', sourceDigest: digest, entryPointsIndex: 1 }],
    materialShaders: [
      {
        identifier: 'forgeax::default-standard-pbr',
        sourceDigest: digest,
        receiptIndex: 2,
        entryPointsIndex: 1,
        variants: [{ sourceDigest: digest, receiptIndex: 3, entryPointsIndex: 2 }],
      },
      {
        identifier: 'forgeax::default-unlit',
        sourceDigest: digest,
        variants: [{ sourceDigest: digest }],
      },
      {
        identifier: 'forgeax::pbr-skin',
        sourceDigest: digest,
        receiptIndex: 0,
        entryPointsIndex: 0,
        variants: [{ sourceDigest: digest, receiptIndex: 1 }],
      },
    ],
  };
}

describe('Music fixture shader manifest projection', () => {
  it('remaps retained receipt and entry-read facts without changing any variant', async () => {
    const fixture = createMusicFixtureShaderManifest(publication());

    expect(fixture.schemaVersion).toBe(SHADER_MANIFEST_PUBLICATION_VERSION);
    expect(fixture.receipts).toEqual([{ id: 'pbr' }, { id: 'variant' }]);
    expect(fixture.entryPoints).toEqual([[{ name: 'vs_main', stage: 'vertex', bindings: [] }], []]);
    expect(fixture.entries[0].entryPointsIndex).toBe(0);
    expect(fixture.materialShaders[0].entryPointsIndex).toBe(0);
    expect(fixture.materialShaders[0].variants[0].entryPointsIndex).toBe(1);
    expect(Object.hasOwn(fixture.materialShaders[1], 'entryPointsIndex')).toBe(false);
    expect(fixture.materialShaders.map((row) => row.identifier)).toEqual([
      'forgeax::default-standard-pbr',
      'forgeax::default-unlit',
    ]);
    expect(fixture.materialShaders[0]?.receiptIndex).toBe(0);
    expect(fixture.materialShaders[0]?.variants[0]?.receiptIndex).toBe(1);
    await expect(readShaderManifestPublication(fixture)).resolves.toMatchObject({
      entries: [{ identifier: 'vs_main' }],
      materialShaders: [
        { identifier: 'forgeax::default-standard-pbr', entryPoints: [{ name: 'vs_main', stage: 'vertex', bindings: [] }], variants: [{ entryPoints: [] }] },
        { identifier: 'forgeax::default-unlit' },
      ],
    });
  });

  it.each([-1, 0.5, 99, undefined])('rejects an invalid retained entry-read index %s', (index) => {
    const value = publication();
    value.materialShaders[0].variants[0].entryPointsIndex = index;
    expect(() => createMusicFixtureShaderManifest(value)).toThrow(
      'music fixture shader entry points reference is invalid',
    );
  });

  it('rejects a stale manifest schema version', () => {
    expect(() => createMusicFixtureShaderManifest(publication('2.0.0'))).toThrow(
      'music fixture requires the published Engine shader manifest',
    );
  });

  it('rejects changed fragment contents or order through the published digest contract', () => {
    for (const change of ['contents', 'order']) {
      const value = publication();
      if (change === 'contents') value.fragments[0] += '// changed';
      else Object.values(value.sources)[0].reverse();
      expect(() => createMusicFixtureShaderManifest(value)).toThrow(
        'music fixture Engine source digest mismatch',
      );
    }
  });
});

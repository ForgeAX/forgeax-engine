import { ShaderSource } from '@forgeax/engine-types';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { expect, it, vi } from 'vitest';
import { materialShaderSource, ShaderRegistry } from '../index.js';

const references = [
  { identifier: 'game::plain', defines: { CLIPPING_PLANES: false } },
  { identifier: 'game::clipped', defines: { CLIPPING_PLANES: true } },
];
function entry(clipped: boolean) {
  const bytes = new TextEncoder().encode(
    `@fragment fn fs_main() -> @location(0) vec4f { ${clipped ? 'discard;' : ''} return vec4f(1); }`,
  );
  return {
    bytes,
    digest: `sha256:${bytesToHex(sha256(bytes))}`,
    paramSchema: [],
    entryPoints: [
      {
        name: 'fs_main',
        stage: 'fragment' as const,
        bindings: [],
        effects: {
          mayDiscard: clipped,
          writesDepth: false,
          writesSampleMask: false,
          writesStorage: false,
        },
      },
    ],
  };
}
function install(registry: ShaderRegistry) {
  registry.installMaterialArtifactBytes('game::plain', {
    ...entry(false),
    variantReferences: references,
  });
  registry.installMaterialArtifactBytes('game::clipped', entry(true));
}

it('projects complete immutable families without decoding unselected sources', () => {
  const registry = new ShaderRegistry({ manifestUrl: undefined });
  install(registry);
  const decode = vi.spyOn(TextDecoder.prototype, 'decode');
  try {
    const family = registry.materialShaderManifestEntry('game::plain');
    expect(family).toBe(registry.materialShaderManifestEntry('game::plain'));
    expect(family?.variants).toHaveLength(2);
    expect(decode).not.toHaveBeenCalled();
    const plain = family?.variants.find((row) => row.defines.CLIPPING_PLANES === false);
    const clipped = family?.variants.find((row) => row.defines.CLIPPING_PLANES === true);
    if (plain === undefined || clipped === undefined) throw Error('Missing family');
    expect(plain.entryPoints?.[0]?.effects?.mayDiscard).toBe(false);
    expect(clipped.entryPoints?.[0]?.effects?.mayDiscard).toBe(true);
    expect(materialShaderSource(plain)).toBeInstanceOf(ShaderSource);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(materialShaderSource(plain)).toBe(
      registry.findMaterialArtifact('game::plain').unwrap().program.sourceReference,
    );
    expect(decode).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(plain.defines)).toBe(true);
    expect(Object.isFrozen(clipped.entryPoints?.[0]?.effects)).toBe(true);
  } finally {
    decode.mockRestore();
  }
});

it('preserves pending families through atomic registry adoption and rejects incomplete subsets', () => {
  const source = new ShaderRegistry({ manifestUrl: undefined });
  const target = new ShaderRegistry({ manifestUrl: undefined });
  install(source);
  expect(() => target.installMaterialArtifactsFrom(source, ['game::plain'])).toThrow(
    'missing material variant program',
  );
  expect([...target.materialShaderIdentifiers()]).toEqual([]);
  target.installMaterialArtifactsFrom(source);
  const family = target.materialShaderManifestEntry('game::plain');
  expect(family?.variants.map((row) => row.defines)).toEqual([
    { CLIPPING_PLANES: false },
    { CLIPPING_PLANES: true },
  ]);
  expect(source.sourceInspection().programs).toBe(0);
  const prepared = target.findMaterialArtifact('game::plain').unwrap();
  expect(prepared.variantReferences).toEqual(references);
  expect(target.materialArtifactDeclaration('game::plain')?.kind).toBe('ready');
  expect(target.materialShaderManifestEntry('game::plain')).toBe(family);
});

it('rejects malformed, conflicting and missing variant relationships', () => {
  const registry = new ShaderRegistry({ manifestUrl: undefined });
  const first = references[0];
  if (first === undefined) throw Error('Missing reference');
  expect(() =>
    registry.installMaterialArtifactBytes('game::invalid', {
      ...entry(false),
      variantReferences: [first, first],
    }),
  ).toThrow('duplicate');
  expect([...registry.materialShaderIdentifiers()]).toEqual([]);
  registry.installMaterialArtifactBytes('game::plain', {
    ...entry(false),
    variantReferences: references,
  });
  expect(() => registry.materialShaderManifestEntry('game::plain')).toThrow(
    'missing material variant program',
  );
  expect(
    registry.validateMaterialArtifactBytes('game::plain', {
      ...entry(false),
      variantReferences: [{ identifier: 'game::plain', defines: { CLIPPING_PLANES: false } }],
    }),
  ).toMatchObject({ ok: false, error: { code: 'material-artifact-conflict' } });
  registry.installMaterialArtifactBytes('game::clipped', entry(true));
  expect(registry.materialShaderManifestEntry('game::plain')?.variants).toHaveLength(2);
});

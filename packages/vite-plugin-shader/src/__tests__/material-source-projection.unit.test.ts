import type { MaterialShaderManifestEntry } from '@forgeax/engine-shader';
import { describe, expect, it } from 'vitest';
import { inlineMaterialShaderComposedWgsl } from '../material-source-projection.js';

const sourcePath = '/packages/shader/src/default-standard-pbr.wgsl';
const identifier = 'forgeax::default-standard-pbr';
const primaryVariant: MaterialShaderManifestEntry['variants'][number] = {
  definesKey: '',
  defines: { CLUSTER_FORWARD_AVAILABLE: true },
  hash: 'primary01',
  sourceDigest: 'a'.repeat(64),
  composedWgsl: './primary01.composed.wgsl',
};

function materialRow(): MaterialShaderManifestEntry {
  return {
    identifier,
    sourcePath,
    hash: 'primary01',
    sourceDigest: 'a'.repeat(64),
    composedWgsl: './primary01.composed.wgsl',
    paramSchema: '[]',
    variants: [
      primaryVariant,
      {
        definesKey: 'CLUSTER_FORWARD_AVAILABLE=false',
        defines: { CLUSTER_FORWARD_AVAILABLE: false },
        hash: 'direct002',
        sourceDigest: 'b'.repeat(64),
        composedWgsl: './direct002.composed.wgsl',
      },
    ],
  };
}

describe('material source projection', () => {
  it('keeps root and direct WGSL aligned with their own compiled artifact identities', () => {
    const direct = { wgsl: 'direct capability WGSL' };
    const entries = new Map([[sourcePath, direct]]);
    const variantWgsl = new Map([
      [`${identifier}#`, 'all-true primary WGSL'],
      [`${identifier}#CLUSTER_FORWARD_AVAILABLE=false`, direct.wgsl],
    ]);

    const [projected] = inlineMaterialShaderComposedWgsl([materialRow()], entries, variantWgsl);

    expect(projected?.composedWgsl).toBe('all-true primary WGSL');
    expect(projected?.hash).toBe('primary01');
    expect(projected?.sourceDigest).toBe('a'.repeat(64));
    expect(projected?.variants[0]?.composedWgsl).toBe('all-true primary WGSL');
    expect(projected?.variants[1]?.composedWgsl).toBe('direct capability WGSL');
    expect(entries.get(sourcePath)?.wgsl).toBe('direct capability WGSL');
  });

  it('uses the compiled hash when the source digest is assigned during publication', () => {
    const row = materialRow();
    const { sourceDigest, ...rowWithoutDigest } = row;
    void sourceDigest;
    const variantsWithoutDigest = row.variants.map((variant) => {
      const { sourceDigest: variantSourceDigest, ...variantWithoutDigest } = variant;
      void variantSourceDigest;
      return variantWithoutDigest;
    });
    const withoutCompilerDigest = { ...rowWithoutDigest, variants: variantsWithoutDigest };
    const sources = new Map([
      [`${identifier}#`, 'all-true primary WGSL'],
      [`${identifier}#CLUSTER_FORWARD_AVAILABLE=false`, 'direct capability WGSL'],
    ]);

    expect(
      inlineMaterialShaderComposedWgsl([withoutCompilerDigest], new Map(), sources)[0]
        ?.composedWgsl,
    ).toBe('all-true primary WGSL');
  });

  it('allows repeated primary identities only when they resolve to the same source', () => {
    const row = materialRow();
    const duplicated = {
      ...row,
      variants: [primaryVariant, { ...primaryVariant, definesKey: 'duplicate=true' }],
    };
    const source = 'all-true primary WGSL';
    const sources = new Map([
      [`${identifier}#`, source],
      [`${identifier}#duplicate=true`, source],
    ]);

    expect(
      inlineMaterialShaderComposedWgsl([duplicated], new Map(), sources)[0]?.composedWgsl,
    ).toBe(source);
  });

  it('fails closed when the same primary identity resolves to different variant sources', () => {
    const row = materialRow();
    const duplicated = {
      ...row,
      variants: [primaryVariant, { ...primaryVariant, definesKey: 'duplicate=true' }],
    };
    const sources = new Map([
      [`${identifier}#`, 'all-true primary WGSL'],
      [`${identifier}#duplicate=true`, 'different WGSL'],
    ]);

    expect(() => inlineMaterialShaderComposedWgsl([duplicated], new Map(), sources)).toThrow(
      `material primary source is missing or ambiguous for ${identifier}`,
    );
  });
});

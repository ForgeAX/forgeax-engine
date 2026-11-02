import type { ShaderRegistry } from '@forgeax/engine-shader';
import type { MaterialAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { resolveForwardGtaoMaterialLineage } from './helpers/forward-gtao-material-lineage';

const material: MaterialAsset = {
  kind: 'material',
  passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
};

function registryWith(
  variants: readonly unknown[],
  source = 'default-source',
  facts: Record<string, unknown> = {},
) {
  const publication = {
    ...facts,
    identifier: 'forgeax::default-standard-pbr',
    sourcePath: 'packages/shader/src/default-standard-pbr.wgsl',
    composedWgsl: source,
    paramSchema: '[]',
    variants,
  };
  return {
    findMaterialArtifact: () => ({ ok: true as const, value: {} }),
    materialShaderManifestEntry: (identifier: string) =>
      identifier === publication.identifier ? publication : undefined,
  } as unknown as Pick<ShaderRegistry, 'findMaterialArtifact' | 'materialShaderManifestEntry'>;
}

it('resolves the authored forward module to the uniquely captured admitted variant', () => {
  const registry = registryWith([
    { definesKey: 'AO=false', defines: { AO: false }, composedWgsl: 'variant-no-ao' },
    {
      definesKey: 'AO=true',
      defines: { AO: true },
      composedWgsl: 'captured-ao-source',
      hash: 'captured-hash',
      sourceDigest: 'captured-digest',
      compilerProfile: { profile: 'browser-webgpu' },
      receipt: { entryPoints: ['fs_main'] },
      entryPoints: [{ name: 'fs_main', stage: 'fragment' }],
      reflection: { version: 'shader-reflection/3' },
    },
  ]);

  expect(resolveForwardGtaoMaterialLineage(registry, material, 'captured-ao-source')).toMatchObject(
    {
      shaderIdentifier: 'forgeax::default-standard-pbr',
      passName: 'forward',
      module: 'forgeax_material::standard',
      variantDefinesKey: 'AO=true',
      defines: { AO: true },
      hash: 'captured-hash',
      sourceDigest: 'captured-digest',
      compilerProfile: { profile: 'browser-webgpu' },
    },
  );
});

it('rejects a source that is not in the authored module publication', () => {
  expect(() =>
    resolveForwardGtaoMaterialLineage(registryWith([]), material, 'unrelated-source'),
  ).toThrow('captured forward shader source must match exactly one admitted variant');
});

it('uses complete direct publication facts when the admitted material has no variants', () => {
  const registry = registryWith([], 'captured-no-variant', {
    hash: 'direct-hash',
    sourceDigest: 'direct-digest',
    compilerProfile: { profile: 'browser-webgpu' },
    receipt: { entryPoints: ['fs_main'] },
    entryPoints: [{ name: 'fs_main', stage: 'fragment' }],
    reflection: { version: 'shader-reflection/3' },
  });
  expect(
    resolveForwardGtaoMaterialLineage(registry, material, 'captured-no-variant'),
  ).toMatchObject({
    variantDefinesKey: '',
    defines: {},
    hash: 'direct-hash',
    sourceDigest: 'direct-digest',
    compilerProfile: { profile: 'browser-webgpu' },
    reflection: { version: 'shader-reflection/3' },
  });
});

it('rejects ambiguous identical variant sources instead of choosing an arbitrary row', () => {
  const duplicate = { definesKey: 'MODE=one', defines: { MODE: true }, composedWgsl: 'same' };
  const registry = registryWith([
    duplicate,
    { ...duplicate, definesKey: 'MODE=two', defines: { MODE: false } },
  ]);
  expect(() => resolveForwardGtaoMaterialLineage(registry, material, 'same')).toThrow('matches=2');
});

it('fails closed when the selected publication omits compiler or reflection identity', () => {
  const registry = registryWith([
    { definesKey: '', defines: {}, composedWgsl: 'captured-source', hash: 'hash' },
  ]);
  expect(() => resolveForwardGtaoMaterialLineage(registry, material, 'captured-source')).toThrow(
    'publication identity is incomplete',
  );
});

it('preserves ShaderRegistry admission errors without reading a publication row', () => {
  const failure = new Error('material admission failed');
  const registry = {
    findMaterialArtifact: () => ({ ok: false as const, error: failure }),
    materialShaderManifestEntry: () => {
      throw new Error('publication must not be queried after failed admission');
    },
  } as unknown as Pick<ShaderRegistry, 'findMaterialArtifact' | 'materialShaderManifestEntry'>;
  expect(() => resolveForwardGtaoMaterialLineage(registry, material, 'captured-source')).toThrow(
    failure,
  );
});

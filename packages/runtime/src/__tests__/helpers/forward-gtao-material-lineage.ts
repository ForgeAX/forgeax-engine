import { runtimeMaterialShaderId } from '@forgeax/engine-assets-runtime';
import type { ShaderRegistry } from '@forgeax/engine-shader';
import type { MaterialAsset } from '@forgeax/engine-types';

type MaterialShaderRegistry = Pick<
  ShaderRegistry,
  'findMaterialArtifact' | 'materialShaderManifestEntry'
>;

export interface ForwardGtaoMaterialLineage {
  readonly shaderIdentifier: string;
  readonly passName: string;
  readonly module: string;
  readonly variantDefinesKey: string;
  readonly defines: Readonly<Record<string, boolean>>;
  readonly hash: string;
  readonly sourceDigest: string;
  readonly compilerProfile: unknown;
  readonly receipt: unknown;
  readonly entryPoints: unknown;
  readonly reflection: unknown;
}

type MaterialPublication = NonNullable<
  ReturnType<MaterialShaderRegistry['materialShaderManifestEntry']>
>;

type SelectedProgramFacts = Omit<
  ForwardGtaoMaterialLineage,
  'shaderIdentifier' | 'passName' | 'module'
>;

/** Match a published material variant to source captured from a real pipeline work. */
export function resolveForwardGtaoMaterialLineage(
  registry: MaterialShaderRegistry,
  material: MaterialAsset,
  capturedSource: string,
): ForwardGtaoMaterialLineage {
  const pass = material.passes?.find((candidate) => candidate.name === 'forward');
  if (pass === undefined) throw new Error('captured Standard material has no forward pass');
  const shaderIdentifier = runtimeMaterialShaderId(pass.program.module, pass.name);
  if (shaderIdentifier === undefined) {
    throw new Error(
      `forward material module has no runtime shader identifier: ${pass.program.module}`,
    );
  }
  const admitted = registry.findMaterialArtifact(shaderIdentifier);
  if (!admitted.ok) throw admitted.error;
  const publication = registry.materialShaderManifestEntry(shaderIdentifier);
  if (publication === undefined) {
    throw new Error(`runtime ShaderRegistry has no publication row for ${shaderIdentifier}`);
  }
  return {
    shaderIdentifier,
    passName: pass.name,
    module: pass.program.module,
    ...selectedProgramFacts(publication, capturedSource, shaderIdentifier),
  };
}

function selectedProgramFacts(
  publication: MaterialPublication,
  capturedSource: string,
  shaderIdentifier: string,
): SelectedProgramFacts {
  const variants = publication.variants;
  const matches =
    variants.length === 0
      ? publication.composedWgsl === capturedSource
        ? [undefined]
        : []
      : variants.filter((variant) => variant.composedWgsl === capturedSource);
  if (matches.length !== 1) {
    throw new Error(
      `captured forward shader source must match exactly one admitted variant for ${shaderIdentifier}; matches=${matches.length}, variants=${variants.map((variant) => variant.definesKey).join(',')}`,
    );
  }
  const selected = matches[0];
  const hash = selected?.hash ?? publication.hash;
  const sourceDigest = selected?.sourceDigest ?? publication.sourceDigest;
  const compilerProfile = selected?.compilerProfile ?? publication.compilerProfile;
  const receipt = selected?.receipt ?? publication.receipt;
  const entryPoints = selected?.entryPoints ?? publication.entryPoints;
  const reflection = selected?.reflection ?? publication.reflection;
  if (
    hash === undefined ||
    sourceDigest === undefined ||
    compilerProfile === undefined ||
    receipt === undefined ||
    entryPoints === undefined ||
    reflection === undefined
  ) {
    throw new Error(
      `captured forward shader publication identity is incomplete for ${shaderIdentifier} variant ${selected?.definesKey ?? ''}`,
    );
  }
  return {
    variantDefinesKey: selected?.definesKey ?? '',
    defines: selected?.defines ?? {},
    hash,
    sourceDigest,
    compilerProfile,
    receipt,
    entryPoints,
    reflection,
  };
}

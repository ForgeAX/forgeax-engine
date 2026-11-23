import { runtimeMaterialShaderId } from '@forgeax/engine-assets-runtime';
import type { FrameModel } from '@forgeax/engine-rhi-debug';
import {
  isShaderTemplateManifestRow,
  type MaterialShaderManifestEntry,
  materialShaderAxes,
  materialShaderPreparedSourceRows,
  type ShaderRegistry,
} from '@forgeax/engine-shader';
import { canonicalJson, type MaterialAsset } from '@forgeax/engine-types';

type MaterialShaderRegistry = Pick<
  ShaderRegistry,
  'findMaterialArtifact' | 'materialShaderManifestEntry'
> &
  Partial<Pick<ShaderRegistry, 'preparedSurfaceSourceRows'>>;

export interface ForwardGtaoMaterialLineage {
  readonly shaderIdentifier: string;
  readonly passName: string;
  readonly module: string;
  readonly capturedFragmentEntryPoints: readonly string[];
  readonly variantSelection:
    | {
        readonly kind: 'single';
        readonly definesKey: string;
        readonly defines: Readonly<Record<string, boolean>>;
      }
    | {
        readonly kind: 'shared-program';
        readonly aliases: readonly {
          readonly definesKey: string;
          readonly defines: Readonly<Record<string, boolean>>;
        }[];
      };
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
  'shaderIdentifier' | 'passName' | 'module' | 'capturedFragmentEntryPoints'
>;
type ProgramFacts = Omit<SelectedProgramFacts, 'variantSelection'>;

/** Match captured work to one admitted program, retaining the equivalent admitted shader rows. */
export function resolveForwardGtaoMaterialLineage(
  registry: MaterialShaderRegistry,
  material: MaterialAsset,
  capturedSource: string,
  capturedFragmentEntryPoints: readonly string[],
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
    capturedFragmentEntryPoints,
    ...selectedProgramFacts(
      publication,
      registry,
      capturedSource,
      shaderIdentifier,
      capturedFragmentEntryPoints,
    ),
  };
}

function selectedProgramFacts(
  publication: MaterialPublication,
  registry: MaterialShaderRegistry,
  capturedSource: string,
  shaderIdentifier: string,
  capturedFragmentEntryPoints: readonly string[],
): SelectedProgramFacts {
  // Only prepared native recipes could have supplied a captured module. Cooked
  // publications already contain their complete artifact roster.
  const native = isShaderTemplateManifestRow(publication);
  const variants = native
    ? materialShaderPreparedSourceRows(publication).filter((row) => 'definesKey' in row)
    : publication.variants;
  const singleProgram = native
    ? materialShaderAxes(publication).length === 0
    : variants.length === 0;
  const admittedMatches = singleProgram
    ? publication.composedWgsl === capturedSource
      ? [undefined]
      : []
    : variants.filter((variant) => variant.composedWgsl === capturedSource);
  const matches =
    admittedMatches.length === 0 && native
      ? (registry.preparedSurfaceSourceRows?.(shaderIdentifier, capturedSource) ?? [])
      : admittedMatches;
  if (matches.length === 0) {
    throw new Error(
      `captured forward shader source must match exactly one admitted variant or shared program for ${shaderIdentifier}; matches=0`,
    );
  }
  const programs = new Map<string, ProgramFacts>();
  for (const selected of matches) {
    const facts = completeProgramFacts(publication, selected, shaderIdentifier);
    programs.set(canonicalJson(facts), facts);
  }
  if (programs.size !== 1) {
    throw new Error(
      `captured forward source matches ${programs.size} distinct admitted programs for ${shaderIdentifier}`,
    );
  }
  const [facts] = programs.values();
  if (facts === undefined) throw new Error('captured forward program facts are missing');
  assertCapturedFragmentEntryPoints(facts, capturedFragmentEntryPoints, shaderIdentifier);
  const aliases = matches.map((selected) => ({
    definesKey: selected?.definesKey ?? '',
    defines: selected?.defines ?? {},
  }));
  const [single] = aliases;
  if (single === undefined) throw new Error('captured forward program variant is missing');
  return {
    ...facts,
    variantSelection:
      aliases.length === 1 ? { kind: 'single', ...single } : { kind: 'shared-program', aliases },
  };
}

function assertCapturedFragmentEntryPoints(
  facts: ProgramFacts,
  names: readonly string[],
  shaderIdentifier: string,
): void {
  const reflection = facts.reflection as NonNullable<MaterialShaderManifestEntry['reflection']>;
  const entries = facts.entryPoints as NonNullable<MaterialShaderManifestEntry['entryPoints']>;
  if (
    names.length === 0 ||
    !names.every(
      (name) =>
        entries.some((entry) => entry.name === name && entry.stage === 'fragment') &&
        reflection.entryPoints?.some((entry) => entry.name === name && entry.stage === 'fragment'),
    )
  ) {
    throw new Error(
      `captured fragment entry points do not match admitted program ${shaderIdentifier}`,
    );
  }
}

/** Read entry-point identity from actual Standard main work, preserving same-source aliases. */
export function recordedForwardGtaoFragmentEntryPoints(
  model: FrameModel,
  source: string,
): readonly string[] {
  const names = new Set(
    model.works.flatMap((work) =>
      work.pipeline.shaders.flatMap((shader) =>
        shader.stage === 'fragment' &&
        shader.source === source &&
        shader.entryPoint !== null &&
        ['fs_main', 'fs_opaque', 'fs_transparent'].includes(shader.entryPoint)
          ? [shader.entryPoint]
          : [],
      ),
    ),
  );
  if (names.size === 0) throw new Error('captured Standard main fragment entry points are missing');
  return [...names];
}

function completeProgramFacts(
  publication: MaterialPublication,
  selected: MaterialPublication['variants'][number] | undefined,
  shaderIdentifier: string,
): ProgramFacts {
  const row = selected ?? publication;
  const { hash, sourceDigest, compilerProfile, receipt, entryPoints, reflection } = row;
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
    hash,
    sourceDigest,
    compilerProfile,
    receipt,
    entryPoints,
    reflection,
  };
}

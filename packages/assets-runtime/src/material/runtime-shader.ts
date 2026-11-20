import type {
  CookedMaterialRecord,
  MaterialCookProgramContext,
  MaterialTemplatePublication,
  MaterialTemplateSources,
} from '@forgeax/engine-pack/material-cook';
import {
  createMaterialArtifactDigest,
  materialProgramContextKey,
} from '@forgeax/engine-pack/material-cook';
import {
  type MaterialArtifactConflictError,
  type MaterialArtifactRegistry,
  type MaterialRuntimeArtifact,
  type MaterialShaderSelectionResult,
  type MaterialShaderTemplateProgram,
  type MaterialShaderVariantReference,
  materialArtifactConflict,
  type PreparedMaterialShaderTemplate,
  retainMaterialRuntimeArtifact,
  type ShaderRegistry,
  STANDARD_SURFACE_DISCARD_CLIPPING_AXIS,
  STANDARD_SURFACE_DISCARD_LOD_AXIS,
} from '@forgeax/engine-shader';
import type {
  MaterialParameter,
  MaterialPass,
  MaterialProgramAbi,
  MaterialProgramAddress,
  MaterialStaticSwitches,
  MaterialSurfaceDeclaration,
  MaterialValue,
  ParamSchemaEntry,
} from '@forgeax/engine-types';
import {
  canonicalJson,
  createMaterialError,
  projectMaterialParameterSchema,
} from '@forgeax/engine-types';
import type { MaterialLoadError, MaterialReady } from './loader';

export interface MaterialRenderPassProjection {
  readonly name: string;
  readonly module: string;
  readonly outputs?: import('@forgeax/engine-types').MaterialPass['outputs'];
  readonly vertexEntry?: string;
  readonly fragmentEntry?: string;
  readonly moduleSlots?: Readonly<Record<string, string>>;
  readonly renderState?: Readonly<Record<string, unknown>>;
  readonly programs: readonly {
    readonly context: MaterialCookProgramContext;
    readonly specializationKey: string;
    readonly artifactHash: string;
    readonly address?: MaterialProgramAddress;
    readonly entry?: string;
    readonly abi?: MaterialProgramAbi;
  }[];
}

export interface MaterialRenderProjection {
  readonly materialGuid: string;
  readonly publicationGeneration: number;
  readonly specializationKey: string;
  readonly artifactHash: string;
  readonly passes: readonly MaterialRenderPassProjection[];
  readonly runtimeValues: Readonly<Record<string, MaterialValue | null>>;
  /** Root-published Surface model; Render owns preparation and admission. */
  readonly surface?: MaterialSurfaceDeclaration;
  readonly staticSelection: readonly string[];
  readonly sourceTemplate?: DecodedMaterialTemplate;
}

export interface DecodedMaterialTemplate {
  readonly publication: MaterialTemplatePublication;
  readonly sources: MaterialTemplateSources;
}

type ProgramSelection = MaterialRenderPassProjection['programs'][number];
type ResolveTemplate = (
  pass: string,
  context: MaterialCookProgramContext,
  address: MaterialProgramAddress,
  vertexColorAvailable: boolean,
) => ProgramSelection | undefined;
const materialTemplateResolvers = new WeakMap<
  MaterialRenderProjection,
  {
    readonly select: ResolveTemplate;
    readonly owns: (pass: string, key: string) => boolean;
  }
>();
type TemplatePrograms = {
  readonly direct?: ProgramSelection;
  readonly sceneIndex?: ProgramSelection;
};
const materialTemplatePrograms = new WeakMap<
  MaterialArtifactRegistry,
  Map<string, TemplatePrograms>
>();

/** Static author choices require their exact admitted publication, including children. */
export function assertMaterialStaticSelection(
  switches: MaterialStaticSwitches | undefined,
  projection: MaterialRenderProjection | undefined,
  material = '<unpublished-static-material>',
): void {
  if (switches === undefined) return;
  const names = Object.keys(switches) as (keyof MaterialStaticSwitches)[];
  if (
    names.length === 0 ||
    (projection !== undefined &&
      names.every((name) =>
        projection.staticSelection.includes(`static-switch:${name}=${switches[name]}`),
      ))
  )
    return;
  const error = createMaterialError('material-specialization-not-cooked', {
    code: 'material-specialization-not-cooked',
    material,
    staticSelection: names.sort().map((name) => `static-switch:${name}`),
  });
  throw Object.assign(new Error(error.message), error);
}

/** Standard parameters whose resources and shading exist only in a cooked program. */
const COOKED_ONLY_PARAMETERS: ReadonlySet<string> = new Set(['planarReflection']);

/** A code-created material cannot select a cooked-only capability: the default program lacks it. */
export function assertMaterialCookedParameters(
  parameters: readonly { readonly name: string }[] | undefined,
  projection: MaterialRenderProjection | undefined,
  material = '<runtime-material>',
): void {
  if (projection !== undefined) return;
  const selection = (parameters ?? [])
    .filter((parameter) => COOKED_ONLY_PARAMETERS.has(parameter.name))
    .map((parameter) => `parameter:${parameter.name}`);
  if (selection.length === 0) return;
  const error = createMaterialError('material-specialization-not-cooked', {
    code: 'material-specialization-not-cooked',
    material,
    staticSelection: selection.sort(),
  });
  throw Object.assign(new Error(error.message), error);
}

export function sameMaterialContext(
  left: MaterialCookProgramContext,
  right: MaterialCookProgramContext,
): boolean {
  if (left === right) return true;
  // Reject other renderer variants before walking the complete closed context.
  if (
    left.backend !== right.backend ||
    left.capability !== right.capability ||
    left.pipeline !== right.pipeline ||
    left.geometry !== right.geometry ||
    left.pass !== right.pass
  )
    return false;
  // Context axes are validated primitive values. Compare their current own
  // fields directly; Cook's canonical ordering is only needed for identities.
  const a = left as unknown as Readonly<Record<string, unknown>>;
  const b = right as unknown as Readonly<Record<string, unknown>>;
  for (const field in a)
    if (Object.hasOwn(a, field) && a[field] !== (Object.hasOwn(b, field) ? b[field] : undefined))
      return false;
  for (const field in b)
    if (Object.hasOwn(b, field) && b[field] !== undefined && !Object.hasOwn(a, field)) return false;
  return true;
}

/** Exact Pass/context lookup; the renderer supplies all domain-owned axes. */
export function selectMaterialPassProgram(
  projection: MaterialRenderProjection,
  passName: string,
  context: MaterialCookProgramContext,
  address: MaterialProgramAddress = 'direct',
  vertexColorAvailable = false,
): MaterialRenderPassProjection['programs'][number] {
  const selected = findMaterialPassProgram(
    projection,
    passName,
    context,
    address,
    vertexColorAvailable,
  );
  if (selected === undefined)
    throw materialProgramSelectionError(
      projection,
      passName,
      context,
      address,
      vertexColorAvailable,
      0,
    );
  return selected;
}

/** Prove the accepted pass owns the selected program, without compiling a program. */
export function materialPassOwnsProgram(
  projection: MaterialRenderProjection,
  passName: string,
  key: string,
): boolean {
  const template = materialTemplateResolvers.get(projection);
  return (
    template?.owns(passName, key) ??
    projection.passes.some(
      (pass) =>
        pass.name === passName &&
        pass.programs.some((program) => program.specializationKey === key),
    )
  );
}

/** Optional exact lookup. Ambiguous publications retain the strict selection error. */
export function findMaterialPassProgram(
  projection: MaterialRenderProjection,
  passName: string,
  context: MaterialCookProgramContext,
  address: MaterialProgramAddress = 'direct',
  vertexColorAvailable = false,
): MaterialRenderPassProjection['programs'][number] | undefined {
  const template = materialTemplateResolvers.get(projection);
  if (template !== undefined)
    return template.select(passName, context, address, vertexColorAvailable);
  const modernPublication = projection.passes.some((pass) =>
    pass.programs.some(
      (program) =>
        program.context.pipeline !== 'ray' &&
        (program.address !== undefined || program.entry !== undefined || program.abi !== undefined),
    ),
  );
  let selected: MaterialRenderPassProjection['programs'][number] | undefined;
  let matches = 0;
  let selectedColor = false;
  for (const pass of projection.passes) {
    if (pass.name !== passName) continue;
    for (const program of pass.programs) {
      if (
        !(context.pipeline === 'ray'
          ? address === 'direct'
          : modernPublication
            ? program.address === address
            : (program.address ?? 'direct') === address) ||
        !sameMaterialContext(program.context, context)
      )
        continue;
      const hasColor =
        program.abi?.vertexInputs.some((input) => input.semantic === 'color') === true;
      if (hasColor && !vertexColorAvailable) continue;
      // Prefer the color ABI if published, independently of program order.
      if (hasColor && !selectedColor) {
        selectedColor = true;
        matches = 0;
      }
      if (hasColor !== selectedColor) continue;
      selected = program;
      matches++;
    }
  }
  if (matches === 0) return undefined;
  if (matches !== 1 || selected === undefined)
    throw materialProgramSelectionError(
      projection,
      passName,
      context,
      address,
      vertexColorAvailable,
      matches,
    );
  return selected;
}

function materialProgramSelectionError(
  projection: MaterialRenderProjection,
  passName: string,
  context: MaterialCookProgramContext,
  address: MaterialProgramAddress,
  vertexColorAvailable: boolean,
  matches: number,
): Error {
  const key = materialProgramContextKey(context);
  return Object.assign(
    new Error(
      `Material ${projection.materialGuid} has no unique published program for ${passName} in ${key}`,
    ),
    {
      code: 'material-specialization-not-cooked',
      expected: 'exactly one program for the selected Pass and renderer context',
      hint: 'cook the required context before rendering this material',
      retryable: false,
      recoveryActions: ['recook-material-publication'],
      detail: {
        guid: projection.materialGuid,
        specializationKey: projection.specializationKey,
        pass: passName,
        context,
        address,
        vertexColorAvailable,
        matches,
      },
    } satisfies MaterialLoadError['error'],
  );
}

/** Project authored MaterialAsset parameters into the runtime shader schema. */
export function materialParametersToParamSchema(
  parameters: readonly MaterialParameter[],
  material = '<runtime>',
): readonly ParamSchemaEntry[] {
  const schema = projectMaterialParameterSchema(parameters, material, 'runtime');
  if (!schema.ok) throw Object.assign(new Error(schema.error.message), schema.error);
  return schema.value;
}

/** Project authored pass module ids onto the renderer's canonical ids. */
export function runtimeMaterialShaderId(
  module: string | undefined,
  passName?: string,
): string | undefined {
  if (
    passName === 'shadow-caster' &&
    (module === 'forgeax_material::standard' || module === 'forgeax::default-standard-pbr')
  ) {
    return 'forgeax::default-shadow-caster';
  }
  switch (module) {
    case 'forgeax_material::standard':
      return 'forgeax::default-standard-pbr';
    case 'forgeax_material::unlit':
      return 'forgeax::default-unlit';
    case 'forgeax_material::sprite':
      return 'forgeax::sprite';
    case 'forgeax_material::sprite-lit':
      return 'forgeax::sprite-lit';
    default:
      return module;
  }
}

function projectMaterialPass(pass: MaterialPass): Omit<MaterialRenderPassProjection, 'programs'> {
  return {
    name: pass.name,
    module: pass.program.module,
    ...(pass.outputs === undefined ? {} : { outputs: pass.outputs }),
    ...(pass.program.vertexEntry === undefined ? {} : { vertexEntry: pass.program.vertexEntry }),
    ...(pass.program.fragmentEntry === undefined
      ? {}
      : { fragmentEntry: pass.program.fragmentEntry }),
    ...(pass.program.moduleSlots === undefined ? {} : { moduleSlots: pass.program.moduleSlots }),
    ...(pass.renderState === undefined ? {} : { renderState: pass.renderState }),
  };
}

export function projectMaterialRecord(record: CookedMaterialRecord): MaterialRenderProjection {
  return {
    materialGuid: record.materialGuid ?? record.guid,
    publicationGeneration: record.publicationGeneration ?? record.receipt.identity.cookGeneration,
    specializationKey: record.specializationKey ?? record.receipt.identity.artifactDigest,
    artifactHash: record.receipt.identity.artifactDigest,
    passes: record.resolved.passes.map((pass) => ({
      ...projectMaterialPass(pass),
      programs: record.programs.flatMap((program) =>
        program.selections
          .filter((selection) => selection.pass === pass.name)
          .map((selection) => ({
            context: selection.context,
            specializationKey: program.specializationKey,
            artifactHash: program.artifact.digest,
            ...(selection.address === undefined ? {} : { address: selection.address }),
            ...(selection.entry === undefined ? {} : { entry: selection.entry }),
            ...(selection.abi === undefined ? {} : { abi: selection.abi }),
          })),
      ),
    })),
    runtimeValues: record.resolved.values,
    ...(record.resolved.surface === undefined ? {} : { surface: record.resolved.surface }),
    staticSelection: Object.entries(record.resolved.staticSwitches ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, enabled]) => `static-switch:${name}=${enabled}`),
  };
}

/** Admit a template without constructing any target programs. */
export function projectMaterialTemplate(
  sourceTemplate: DecodedMaterialTemplate,
  generation: number,
  prepared: PreparedMaterialShaderTemplate,
  shaderRegistry: ShaderRegistry,
  artifactRegistry: MaterialArtifactRegistry,
): MaterialRenderProjection {
  const { publication: template } = sourceTemplate;
  const material = template.resolved;
  const { values, ...contract } = material;
  const identity = createMaterialArtifactDigest(
    new TextEncoder().encode(canonicalJson([template.sourceArtifact.digest, contract])),
  );
  const passes = (material.passes ?? []).map((pass) => ({
    ...projectMaterialPass(pass),
    programs: [],
  }));
  const projection: MaterialRenderProjection = {
    materialGuid: template.guid,
    publicationGeneration: generation,
    specializationKey: identity,
    artifactHash: template.sourceArtifact.digest,
    passes,
    runtimeValues: values ?? {},
    sourceTemplate,
    ...(material.surface === undefined ? {} : { surface: material.surface }),
    staticSelection: Object.entries(material.staticSwitches ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, enabled]) => `static-switch:${name}=${enabled}`),
  };
  bindMaterialTemplateProjection(projection, prepared, shaderRegistry, artifactRegistry);
  return projection;
}

function bindTemplateRasterCoverage(
  shaderRegistry: ShaderRegistry,
  program: ProgramSelection,
  coverage: MaterialShaderSelectionResult['rasterCoverage'],
  select: (context: MaterialCookProgramContext) => ProgramSelection | undefined,
): void {
  const context = program.context;
  if (
    coverage === undefined ||
    context.pipeline === 'ray' ||
    context.viewClipping === true ||
    context.lodCoverage === true
  )
    return;
  const lod = coverage === 'clipping-and-lod';
  const masks = lod ? [0, 1, 2, 3] : [0, 2];
  shaderRegistry.installMaterialTemplateVariants(
    program.specializationKey,
    masks.map((mask) => {
      const viewClipping = (mask & 2) !== 0;
      const lodCoverage = (mask & 1) !== 0;
      return {
        defines: {
          [STANDARD_SURFACE_DISCARD_CLIPPING_AXIS]: viewClipping,
          ...(lod ? { [STANDARD_SURFACE_DISCARD_LOD_AXIS]: lodCoverage } : {}),
        },
        select: () => {
          if (mask === 0) return program.specializationKey;
          const selected = select({
            ...context,
            ...(viewClipping ? { viewClipping: true } : {}),
            ...(lodCoverage ? { lodCoverage: true } : {}),
          });
          if (selected === undefined) throw new Error('Material coverage program unavailable');
          return selected.specializationKey;
        },
      };
    }),
  );
}

/** The transported metadata is immutable while each realm owns its selected programs. */
export function bindMaterialTemplateProjection(
  projection: MaterialRenderProjection,
  initial: PreparedMaterialShaderTemplate | undefined,
  shaderRegistry: ShaderRegistry,
  artifactRegistry: MaterialArtifactRegistry,
): void {
  if (materialTemplateResolvers.has(projection)) return;
  const template = projection.sourceTemplate;
  if (template === undefined) return;
  const { guid, resolved: material } = template.publication;
  const { passes, specializationKey: identity } = projection;
  let prepared = initial;
  const schema = materialParametersToParamSchema(material.parameters ?? [], guid).map((entry) => {
    if (!('default' in entry)) return entry;
    const { default: _, ...parameter } = entry;
    return parameter;
  });
  let accepted = materialTemplatePrograms.get(artifactRegistry);
  if (accepted === undefined) {
    accepted = new Map();
    materialTemplatePrograms.set(artifactRegistry, accepted);
  }
  const install = (
    pass: MaterialRenderPassProjection,
    context: MaterialCookProgramContext,
    address: MaterialProgramAddress,
    program: MaterialShaderTemplateProgram,
  ): ProgramSelection => {
    const bytes = new TextEncoder().encode(program.wgsl);
    const digest = createMaterialArtifactDigest(bytes);
    const key = createMaterialArtifactDigest(
      new TextEncoder().encode(
        canonicalJson([
          identity,
          pass.name,
          pass.module,
          materialProgramContextKey(context),
          address,
          digest,
          program.abi,
        ]),
      ),
    );
    const metadata = {
      module: pass.module,
      templateIdentity: identity,
      templatePass: pass.name,
      paramSchema: schema,
      ...(program.abi === undefined ? {} : { abi: program.abi, receipt: program.abi }),
    };
    const artifact =
      artifactRegistry.get(key) ??
      artifactRegistry
        .register(retainMaterialRuntimeArtifact({ key, bytes, digest, metadata }))
        .unwrap();
    if (shaderRegistry.materialArtifactDeclaration(key) === undefined)
      shaderRegistry.installMaterialArtifactBytes(key, {
        bytes: artifact.bytes,
        digest,
        paramSchema: schema,
        ...(program.abi === undefined ? {} : { receipt: program.abi }),
      });
    return {
      context,
      specializationKey: key,
      artifactHash: digest,
      address,
      ...(program.entry === undefined ? {} : { entry: program.entry }),
      ...(program.abi === undefined ? {} : { abi: program.abi }),
    };
  };
  const select: ResolveTemplate = (passName, context, address, vertexColorAvailable) => {
    const pass = passes.find(({ name }) => name === passName);
    if (pass === undefined) return undefined;
    const selection = JSON.stringify([
      identity,
      passName,
      materialProgramContextKey(context),
      vertexColorAvailable,
    ]);
    let known = accepted.get(selection);
    if (known === undefined) {
      prepared ??= shaderRegistry
        .prepareMaterialTemplateFromInitializedCompiler({
          guid,
          material,
          sources: template.sources,
        })
        .unwrap();
      const compiled = prepared.select({ pass: passName, context, vertexColorAvailable }).unwrap();
      known =
        compiled === undefined
          ? {}
          : {
              direct: install(pass, context, 'direct', compiled.direct),
              ...(compiled.sceneIndex === undefined
                ? {}
                : {
                    sceneIndex: install(pass, context, 'scene-index', compiled.sceneIndex),
                  }),
            };
      accepted.set(selection, known);
      if (compiled?.rasterCoverage !== undefined) {
        if (known.direct !== undefined)
          bindTemplateRasterCoverage(
            shaderRegistry,
            known.direct,
            compiled.rasterCoverage,
            (next) => select(passName, next, 'direct', vertexColorAvailable),
          );
        if (known.sceneIndex !== undefined)
          bindTemplateRasterCoverage(
            shaderRegistry,
            known.sceneIndex,
            compiled.rasterCoverage,
            (next) => select(passName, next, 'scene-index', vertexColorAvailable),
          );
      }
    }
    return address === 'direct' ? known.direct : known.sceneIndex;
  };
  materialTemplateResolvers.set(projection, {
    select,
    owns(pass, key) {
      const metadata = artifactRegistry.get(key)?.metadata;
      return metadata?.templateIdentity === identity && metadata.templatePass === pass;
    },
  });
}

function conflictError(error: MaterialArtifactConflictError): Error {
  return Object.assign(new Error(`${error.code}: ${error.detail.key}`), error);
}

/** Group coverage contexts with identical pass, output, address and vertex-color ABI. */
function materialSurfaceCoverageFamilies(
  record: CookedMaterialRecord,
): ReadonlyMap<string, readonly MaterialShaderVariantReference[]> {
  const groups = new Map<string, Map<number, string>>();
  for (const program of record.programs)
    for (const selection of program.selections) {
      if (selection.context.pipeline === 'ray') continue;
      const { viewClipping, lodCoverage, ...context } = selection.context;
      const key = JSON.stringify([
        selection.pass,
        materialProgramContextKey(context),
        selection.address ?? 'direct',
        selection.entry,
        selection.abi?.vertexInputs.some((input) => input.semantic === 'color') === true,
      ]);
      let group = groups.get(key);
      if (group === undefined) {
        group = new Map();
        groups.set(key, group);
      }
      const mask = Number(lodCoverage === true) | (Number(viewClipping === true) << 1);
      const previous = group.get(mask);
      if (previous !== undefined && previous !== program.specializationKey)
        throw new Error('MaterialReady contains ambiguous surface-coverage programs');
      group.set(mask, program.specializationKey);
    }
  const families = new Map<string, readonly MaterialShaderVariantReference[]>();
  for (const group of groups.values()) {
    const plain = group.get(0);
    if (plain === undefined || group.size < 2) continue;
    const hasLod = [...group.keys()].some((mask) => (mask & 1) !== 0);
    const hasClipping = [...group.keys()].some((mask) => (mask & 2) !== 0);
    const references = [...group]
      .sort(([a], [b]) => a - b)
      .map(([mask, identifier]) => ({
        identifier,
        defines: {
          ...(hasClipping ? { CLIPPING_PLANES: (mask & 2) !== 0 } : {}),
          ...(hasLod ? { LOD_DITHER: (mask & 1) !== 0 } : {}),
        },
      }));
    const previous = families.get(plain);
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(references))
      throw new Error('MaterialReady contains conflicting surface-coverage families');
    families.set(plain, references);
  }
  return families;
}

/** Preflight the complete set before mutating either runtime registry. */
export function installMaterialReadyShaders(
  shaderRegistry: ShaderRegistry,
  readiness: MaterialReady,
  artifactRegistry: MaterialArtifactRegistry,
): MaterialRenderProjection {
  // Defaults belong to the root value contract, not an immutable shared program.
  const paramSchema = materialParametersToParamSchema(
    readiness.record.parameterContract.parameters,
    readiness.record.guid,
  ).map((entry) => {
    if (!('default' in entry)) return entry;
    const { default: _default, ...parameter } = entry;
    return parameter;
  });
  // A program key names its content: a key this admission already registered
  // (its metadata names the owning module) is the same program and needs no
  // further admission. Keys registered elsewhere and new keys are preflighted
  // before either registry is mutated.
  const pending = new Map<string, MaterialRuntimeArtifact>();
  const programs = readiness.record.programs.filter(
    (program) => artifactRegistry.get(program.specializationKey)?.metadata?.module === undefined,
  );
  const families = materialSurfaceCoverageFamilies(readiness.record);
  const admissions = programs.map((program) => {
    if (program.artifact.bytes.byteLength === 0)
      throw new Error(`MaterialReady ${readiness.record.guid} contains an empty shader program`);
    const pass = readiness.record.resolved.passes.find((pass) =>
      program.selections.some((selection) => selection.pass === pass.name),
    );
    const abi = program.selections.find((selection) => selection.abi !== undefined)?.abi;
    const metadata = Object.freeze({
      module: pass?.program.module,
      paramSchema,
      ...(abi === undefined ? {} : { abi, receipt: abi }),
    });
    const key = program.specializationKey;
    const digest = program.artifact.digest;
    const previous = pending.get(key) ?? artifactRegistry.get(key);
    const candidate = { key, bytes: program.artifact.bytes, digest, metadata };
    if (previous !== undefined) {
      const conflict = materialArtifactConflict(previous, candidate);
      if (conflict !== undefined) throw conflictError(conflict);
    }
    // Resident program bytes are immutable; the registry shares them.
    const artifact: MaterialRuntimeArtifact =
      previous === undefined ? retainMaterialRuntimeArtifact(candidate) : previous;
    if (previous === undefined) pending.set(key, artifact);
    const variantReferences = families.get(key);
    const input = {
      ...(variantReferences === undefined ? {} : { variantReferences }),
      bytes: artifact.bytes,
      digest,
      paramSchema,
      ...(abi === undefined ? {} : { receipt: abi }),
    };
    const accepted = shaderRegistry.validateMaterialArtifactBytes(key, input);
    if (!accepted.ok) throw conflictError(accepted.error);
    return { artifact, input, newArtifact: previous === undefined, newProgram: !accepted.value };
  });
  for (const { artifact, input, newArtifact, newProgram } of admissions) {
    if (newArtifact) artifactRegistry.register(artifact).unwrap();
    if (newProgram) shaderRegistry.installMaterialArtifactBytes(artifact.key, input);
  }
  return projectMaterialRecord(readiness.record);
}

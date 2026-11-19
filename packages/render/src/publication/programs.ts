import { type AssetRegistry, runtimeMaterialShaderId } from '@forgeax/engine-assets-runtime';
import {
  materialProgramContextKey,
  validateMaterialCookProgramContext,
} from '@forgeax/engine-pack/material-cook';
import {
  type MaterialRuntimeArtifact,
  type MaterialShaderEntry,
  materialArtifactConflict,
  ShaderRegistry,
} from '@forgeax/engine-shader';
import {
  getAdmittedParamSchemaInterface,
  isMaterialProgramAbi,
  type MaterialAsset,
  type ParamSchemaEntry,
} from '@forgeax/engine-types';
import {
  isOwnedRenderFeatureProgramData,
  ownRenderFeatureProgramData,
  ownRenderFeatureProgramDataWith,
} from '../features/prepared-gpu-work';
import { type MaterialProgramInputs, materialProgramInputs } from '../material-program-inputs';
import type { MaterialSnapshot } from '../render-system-extract';
import { type RenderPublication, RenderPublicationError } from './contract';
import type { PreparedRenderPublication } from './receiver';

type PublishedMaterialProjection = NonNullable<
  RenderPublication['assets'][number]['materialProjection']
>;
type PublishedMaterialProjectionProgram =
  PublishedMaterialProjection['passes'][number]['programs'][number];

/** Content-independent program row facts: compiler context, address and ABI. */
function validPublicationProjectionProgram(
  program: unknown,
): program is PublishedMaterialProjectionProgram {
  if (program === null || typeof program !== 'object') return false;
  const row = program as Record<string, unknown>;
  return (
    typeof row.specializationKey === 'string' &&
    typeof row.artifactHash === 'string' &&
    validateMaterialCookProgramContext(row.context).ok &&
    (row.address === undefined || row.address === 'direct' || row.address === 'scene-index') &&
    (row.entry === undefined || typeof row.entry === 'string') &&
    (row.abi === undefined || isMaterialProgramAbi(row.abi))
  );
}

/** Structural projection validity, independent of any receiver state or material. */
function validPublicationProjectionShape(
  input: unknown,
  validProgram: (program: unknown) => boolean,
): input is PublishedMaterialProjection {
  if (input === null || typeof input !== 'object') return false;
  const value = input as Record<string, unknown>;
  if (
    typeof value.materialGuid !== 'string' ||
    typeof value.specializationKey !== 'string' ||
    typeof value.artifactHash !== 'string' ||
    !Number.isSafeInteger(value.publicationGeneration) ||
    Number(value.publicationGeneration) < 0 ||
    !Array.isArray(value.staticSelection) ||
    !value.staticSelection.every((item) => typeof item === 'string') ||
    !Array.isArray(value.passes) ||
    value.runtimeValues === null ||
    typeof value.runtimeValues !== 'object'
  )
    return false;
  const names = new Set<string>();
  for (const pass of value.passes) {
    if (
      pass === null ||
      typeof pass !== 'object' ||
      typeof pass.name !== 'string' ||
      typeof pass.module !== 'string' ||
      !Array.isArray(pass.programs) ||
      names.has(pass.name)
    )
      return false;
    names.add(pass.name);
    for (const program of pass.programs) if (!validProgram(program)) return false;
  }
  return true;
}

/** The receiver-state and material checks every admission repeats, even for interned content. */
function publicationProjectionServesMaterial(
  projection: PublishedMaterialProjection,
  material: MaterialAsset,
  available: (key: string) => boolean,
): boolean {
  for (const pass of projection.passes)
    for (const program of pass.programs) if (!available(program.specializationKey)) return false;
  const authored = material.passes ?? [];
  for (const pass of authored) {
    let module: string | undefined;
    for (const candidate of projection.passes)
      if (candidate.name === pass.name) {
        module = candidate.module;
        break;
      }
    if (module !== pass.program.module) return false;
  }
  return true;
}

/**
 * One cooked program serves several selections (direct and scene-index) under the
 * same specialization key and digest. The full compiler context and vertex
 * selection identify the row independently of its shared artifact bytes.
 */
function programId(value: PublishedMaterialProjectionProgram): string {
  return JSON.stringify([
    value.specializationKey,
    value.artifactHash,
    materialProgramContextKey(value.context),
    value.address ?? null,
    value.entry ?? null,
  ]);
}

/**
 * The receiver's program table. A cooked program is identified by its
 * specialization key, artifact digest and complete selection context. The publisher sends each program
 * row's content under that identity; the receiver validates and owns a row the
 * first time it sees the id, and every projection after that references the
 * table entry. Projections themselves carry per-material values, so each is
 * validated for shape and owned once per publication; nothing is interned or
 * compared structurally.
 */
export class PublicationMaterialProjectionAdmission {
  readonly #programs = new Map<string, PublishedMaterialProjectionProgram>();

  /** Program table entry count, for diagnostics and tests. */
  get size(): { readonly programs: number } {
    return { programs: this.#programs.size };
  }

  /** Validate and own one received projection; undefined when it is invalid. */
  admit(
    input: unknown,
    material: MaterialAsset,
    available: (key: string) => boolean,
  ): PublishedMaterialProjection | undefined {
    if (input === null || typeof input !== 'object') return undefined;
    const reused = new Map<object, PublishedMaterialProjectionProgram>();
    const validProgram = (program: unknown): boolean => {
      if (!validPublicationProjectionProgram(program)) return false;
      const row = program;
      const id = programId(row);
      const known = this.#programs.get(id);
      if (known !== undefined) {
        reused.set(program, known);
        return true;
      }
      const owned = ownRenderFeatureProgramData(row);
      if (isOwnedRenderFeatureProgramData(owned)) this.#programs.set(id, owned);
      reused.set(program, owned);
      return true;
    };
    if (!validPublicationProjectionShape(input, validProgram)) return undefined;
    const owned = ownRenderFeatureProgramDataWith(input as PublishedMaterialProjection, (node) =>
      reused.get(node),
    );
    if (!isOwnedRenderFeatureProgramData(owned)) return undefined;
    return publicationProjectionServesMaterial(owned, material, available) ? owned : undefined;
  }

  clear(): void {
    this.#programs.clear();
  }
}

/** The same complete program closure feeds scene publication and candidate preparation. */
export function publicationMaterialProgramKeys(material: MaterialSnapshot): ReadonlySet<string> {
  return new Set([
    ...Object.values(material.materialProgramKeys ?? {}),
    ...Object.values(material.materialSurfacePrograms ?? {}).map((program) => program.programKey),
    ...Object.values(material.materialSceneIndexProgramKeys ?? {}).map(
      (program) => program.specializationKey,
    ),
    ...(material.materialShaderId === undefined || material.materialShaderId.startsWith('forgeax::')
      ? []
      : [material.materialShaderId]),
  ]);
}

function sameSchemaValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object')
    return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right) && left.length !== right.length) return false;
  // Schema values are plain records and numeric arrays. An unsupported legacy
  // default retains its received schema rather than losing data through JSON.
  if (
    !Array.isArray(left) &&
    (Object.getPrototypeOf(left) !== Object.prototype ||
      Object.getPrototypeOf(right) !== Object.prototype)
  )
    return false;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every(
    (key) =>
      Object.hasOwn(right, key) &&
      sameSchemaValue(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
      ),
  );
}

/** Native clones regain schema admission through their selected immutable program. */
export function publicationMaterialSchemaRebinder(registry: ShaderRegistry) {
  const materials = new Map<MaterialSnapshot, MaterialSnapshot>();
  let observedSchema: readonly ParamSchemaEntry[] | undefined;
  let canonicalSchema: readonly ParamSchemaEntry[] | undefined;
  let schemaEqual = false;
  const matchesSchema = (
    material: MaterialSnapshot,
    canonical: readonly ParamSchemaEntry[],
  ): boolean => {
    const schema = material.materialParamSchema;
    if (schema === undefined) return false;
    if (material.immutableValues !== true) return sameSchemaValue(schema, canonical);
    if (observedSchema === schema && canonicalSchema === canonical) return schemaEqual;
    const equal = sameSchemaValue(schema, canonical);
    // Only producer-owned values and an admitted immutable program can recur safely.
    if (getAdmittedParamSchemaInterface(canonical) !== undefined) {
      observedSchema = schema;
      canonicalSchema = canonical;
      schemaEqual = equal;
    }
    return equal;
  };
  const rebind = (material: MaterialSnapshot): MaterialSnapshot => {
    const known = materials.get(material);
    if (known !== undefined) return known;
    const schema = material.materialParamSchema;
    // Misses are ordinary here (built-in and other-realm programs); the optional
    // lookup avoids building a not-found diagnostic for every material update.
    const shader =
      material.materialShaderId === undefined
        ? undefined
        : registry.materialArtifact(material.materialShaderId);
    // Full content includes defaults and author metadata. A merged schema or
    // another Pass's ABI must not be replaced merely because field types match.
    let rebound =
      schema !== undefined &&
      shader !== undefined &&
      schema !== shader.paramSchema &&
      matchesSchema(material, shader.paramSchema)
        ? { ...material, materialParamSchema: shader.paramSchema }
        : material;
    const programInputs = Object.fromEntries(
      material.passes.flatMap((pass) => {
        const key =
          material.materialProgramKeys?.[pass.name] ??
          runtimeMaterialShaderId(pass.program.module, pass.name);
        if (key === undefined) return [];
        const artifact = registry.materialArtifact(key);
        const inputs = artifact === undefined ? undefined : materialProgramInputs(artifact);
        return inputs === undefined ? [] : [[pass.name, inputs]];
      }),
    );
    // A re-published material that already carries these exact program reads
    // keeps its identity; a fresh object would invalidate every material cache.
    if (
      Object.keys(programInputs).length > 0 &&
      !sameProgramInputs(rebound.materialProgramInputs, programInputs)
    )
      rebound = { ...rebound, materialProgramInputs: Object.freeze(programInputs) };
    if (rebound !== material) rebound = Object.freeze(rebound);
    materials.set(material, rebound);
    return rebound;
  };
  return rebind;
}

function sameProgramInputs(
  current: MaterialSnapshot['materialProgramInputs'],
  next: Readonly<Record<string, MaterialProgramInputs>>,
): boolean {
  if (current === undefined) return false;
  const keys = Object.keys(next);
  if (Object.keys(current).length !== keys.length) return false;
  for (const key of keys) {
    if (
      current[key]?.entryPoints !== next[key]?.entryPoints ||
      current[key]?.systemInputs !== next[key]?.systemInputs ||
      current[key]?.forwardFog !== next[key]?.forwardFog
    )
      return false;
  }
  return true;
}

export function rebindPublicationMaterialSchemas(
  registry: ShaderRegistry,
  input: PreparedRenderPublication,
): PreparedRenderPublication {
  if (input.materialUpdates.length === 0) return input;
  const rebind = publicationMaterialSchemaRebinder(registry);
  for (const resource of input.materialUpdates) {
    const rebound = rebind(resource.snapshot);
    if (rebound !== resource.snapshot) resource.adoptProgramSnapshot(rebound, true);
  }
  return input;
}

/** Capture one immutable program from its native declaration; callers traverse its family closure. */
export function capturePublicationProgram(
  assets: AssetRegistry,
  key: string,
): RenderPublication['programs'][number] {
  const declaration = assets.shaderRegistry.materialArtifactDeclaration(key);
  const artifact = assets.getMaterialArtifact(key);
  if (declaration?.kind === 'bytes' && artifact?.digest !== undefined) {
    const { kind: _kind, ...metadata } = declaration;
    assets.shaderRegistry
      .validateMaterialArtifactBytes(key, {
        ...metadata,
        bytes: artifact.bytes,
        digest: artifact.digest,
      })
      .unwrap();
    return { key, shader: { sourceEncoding: 'utf8', ...metadata }, artifact };
  }
  const entry = assets.shaderRegistry.findMaterialArtifact(key).unwrap();
  return {
    key,
    shader: {
      // A local candidate can keep its source lazy until publication actually serializes it.
      get source() {
        return entry.source;
      },
      ...(entry.variantReferences === undefined
        ? {}
        : { variantReferences: entry.variantReferences }),
      ...(entry.program.entryPoints === undefined
        ? {}
        : { entryPoints: entry.program.entryPoints }),
      paramSchema: entry.paramSchema,
      ...(entry.receipt === undefined ? {} : { receipt: entry.receipt }),
    },
    ...(artifact === undefined ? {} : { artifact }),
  };
}

/** Validate direct-source publication without changing its eager admission route. */
function publicationSourceEntry(
  registry: ShaderRegistry,
  key: string,
  shader: MaterialShaderEntry,
): MaterialShaderEntry | undefined {
  const previous = registry.findMaterialArtifact(key);
  if (
    previous.ok &&
    (previous.value.source !== shader.source ||
      !sameSchemaValue(previous.value.paramSchema, shader.paramSchema) ||
      !sameSchemaValue(previous.value.variantReferences, shader.variantReferences) ||
      !sameSchemaValue(previous.value.receipt, shader.receipt) ||
      !sameSchemaValue(
        previous.value.program.entryPoints,
        shader.entryPoints ?? shader.receipt?.entryPoints,
      ))
  ) {
    throw new RenderPublicationError({
      reason: 'shape',
      subject: `conflicting immutable shader ${key}`,
    });
  }
  return previous.ok ? undefined : shader;
}

/** Admit immutable producer artifacts before the full Renderer prepares their pipelines. */
export function installPublicationPrograms(
  assets: AssetRegistry,
  programs: RenderPublication['programs'],
): void {
  if (programs.length === 0) return;
  const added: MaterialRuntimeArtifact[] = [];
  let shaders: ShaderRegistry | undefined;
  const keys = new Set<string>();
  for (const row of programs) {
    if (keys.has(row.key) || (row.artifact !== undefined && row.artifact.key !== row.key))
      throw new RenderPublicationError({
        reason: 'shape',
        subject: 'duplicate or mismatched program key',
      });
    keys.add(row.key);
    if (row.artifact !== undefined) {
      // Keys are unique within a publication, so only the held artifact can conflict.
      const existing = assets.getMaterialArtifact(row.key);
      if (existing === undefined) added.push(row.artifact);
      else {
        const conflict = materialArtifactConflict(existing, row.artifact);
        if (conflict !== undefined) throw conflict;
      }
    }
    if ('sourceEncoding' in row.shader) {
      if (row.shader.sourceEncoding !== 'utf8' || row.artifact?.digest === undefined)
        throw new RenderPublicationError({
          reason: 'shape',
          subject: 'byte shader publication requires its complete artifact',
        });
      const evidence = { bytes: row.artifact.bytes, digest: row.artifact.digest };
      // Validation only reads the row; canonical ABI facts are built for a new program alone.
      const accepted = assets.shaderRegistry.validateMaterialArtifactBytes(row.key, {
        ...row.shader,
        ...evidence,
      });
      if (!accepted.ok)
        throw new RenderPublicationError({
          reason: 'shape',
          subject: `conflicting immutable shader ${row.key}`,
        });
      if (!accepted.value) {
        shaders ??= new ShaderRegistry({ manifestUrl: undefined });
        shaders.installMaterialArtifactBytes(row.key, {
          ...row.shader,
          ...evidence,
        });
      }
    } else {
      const source = publicationSourceEntry(assets.shaderRegistry, row.key, row.shader);
      if (source !== undefined) {
        shaders ??= new ShaderRegistry({ manifestUrl: undefined });
        shaders.installMaterialArtifact(row.key, source, assets.shaderRegistry);
      }
    }
  }
  if (shaders !== undefined) assets.shaderRegistry.installMaterialArtifactsFrom(shaders);
  for (const artifact of added) assets.materialArtifactRegistry.register(artifact).unwrap();
}

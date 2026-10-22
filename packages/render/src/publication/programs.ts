import { type AssetRegistry, runtimeMaterialShaderId } from '@forgeax/engine-assets-runtime';
import { validateMaterialCookProgramContext } from '@forgeax/engine-pack/material-cook';
import { MaterialArtifactRegistry, ShaderRegistry } from '@forgeax/engine-shader';
import {
  getAdmittedParamSchemaInterface,
  isMaterialProgramAbi,
  type MaterialAsset,
  type ParamSchemaEntry,
} from '@forgeax/engine-types';
import {
  equalDescriptorValue,
  isOwnedRenderFeatureProgramData,
  ownRenderFeatureProgramData,
  ownRenderFeatureProgramDataWith,
} from '../features/prepared-gpu-work';
import type { MaterialSnapshot } from '../render-system-extract';
import { type RenderPublication, RenderPublicationError } from './contract';
import type { PreparedRenderPublication } from './receiver';

type PublishedMaterialProjection = NonNullable<
  RenderPublication['assets'][number]['materialProjection']
>;
type PublishedMaterialProjectionProgram =
  PublishedMaterialProjection['passes'][number]['programs'][number];

/** Content-independent program row facts: compiler context, address and ABI. */
function validPublicationProjectionProgram(program: unknown): boolean {
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

/** Validate the fixed context table against its source and already admitted program closure. */
export function validPublicationMaterialProjection(
  input: unknown,
  material: MaterialAsset,
  available: (key: string) => boolean,
): input is PublishedMaterialProjection {
  return (
    validPublicationProjectionShape(input, validPublicationProjectionProgram) &&
    publicationProjectionServesMaterial(input, material, available)
  );
}

function projectionInternKey(value: PublishedMaterialProjection): string {
  return `${value.materialGuid}\u0000${value.specializationKey}\u0000${value.artifactHash}\u0000${value.publicationGeneration}`;
}

function programInternKey(value: PublishedMaterialProjectionProgram): string {
  return `${value.specializationKey}\u0000${value.artifactHash}`;
}

/**
 * Digest-keyed buckets of owned content. A value stays alive only while an
 * admitted row holds it; a key is a candidate selector, never proof of content.
 */
class InternTable<T extends object> {
  static readonly BUCKET = 4;
  readonly #slots = new Map<string, WeakRef<T>[]>();
  readonly #collected = new FinalizationRegistry<string>((key) => {
    const live = this.#slots.get(key)?.filter((slot) => slot.deref() !== undefined);
    if (live === undefined) return;
    if (live.length === 0) this.#slots.delete(key);
    else this.#slots.set(key, live);
  });
  /** The first owned value under this key that the comparison proves equal to the input. */
  find(key: string, equal: (value: T) => boolean): T | undefined {
    for (const slot of this.#slots.get(key) ?? []) {
      const value = slot.deref();
      if (value !== undefined && equal(value)) return value;
    }
    return undefined;
  }
  add(key: string, value: T): void {
    const bucket = (this.#slots.get(key) ?? []).filter((slot) => slot.deref() !== undefined);
    bucket.unshift(new WeakRef(value));
    this.#slots.set(key, bucket.slice(0, InternTable.BUCKET));
    this.#collected.register(value, key);
  }
  get size(): number {
    let size = 0;
    for (const bucket of this.#slots.values())
      for (const slot of bucket) if (slot.deref() !== undefined) size += 1;
    return size;
  }
  clear(): void {
    this.#slots.clear();
  }
}

/**
 * Receiver-owned admission of Worker-cloned material projections. Every Worker
 * packet carries private copies, but materials published from one cooked root
 * (copies, damage variants) share identical projections and program rows.
 *
 * The digest fields only select a candidate: a received row reuses owned
 * content only after a structural comparison proves it equal to content that
 * already passed full validation. A mismatch, a non-JSON row or an unseen
 * digest takes the complete validation and copy. Receiver state and material
 * checks are repeated for every row. Reused content is deeply frozen.
 */
export class PublicationMaterialProjectionAdmission {
  readonly #projections = new InternTable<PublishedMaterialProjection>();
  readonly #programs = new InternTable<PublishedMaterialProjectionProgram>();
  /** Owned projections that passed shape validation in this realm. */
  readonly #validated = new WeakSet<object>();

  /** Interned slot counts, for diagnostics and tests. */
  get size(): { readonly projections: number; readonly programs: number } {
    return { projections: this.#projections.size, programs: this.#programs.size };
  }

  /**
   * Validate and own one received projection. `aliases` maps a received object
   * to its owned result within one packet, where structured clone preserves
   * sharing between rows. Returns undefined for an invalid projection.
   */
  admit(
    input: unknown,
    material: MaterialAsset,
    available: (key: string) => boolean,
    aliases?: Map<object, PublishedMaterialProjection>,
  ): PublishedMaterialProjection | undefined {
    if (input === null || typeof input !== 'object') return undefined;
    let owned =
      aliases?.get(input) ??
      (this.#validated.has(input) ? (input as PublishedMaterialProjection) : undefined);
    if (owned === undefined) {
      owned = this.#intern(input);
      if (owned === undefined) return undefined;
      aliases?.set(input, owned);
    }
    return publicationProjectionServesMaterial(owned, material, available) ? owned : undefined;
  }

  clear(): void {
    this.#projections.clear();
    this.#programs.clear();
  }

  #intern(input: object): PublishedMaterialProjection | undefined {
    const candidate = input as PublishedMaterialProjection;
    const key = projectionKeyOf(candidate);
    const known =
      key === undefined
        ? undefined
        : this.#projections.find(key, (value) => equalDescriptorValue(value, input));
    if (known !== undefined) return known;
    // Unseen content: validate each program row once per digest, then own the
    // projection while sharing every already owned, equal program row.
    const reused = new Map<object, PublishedMaterialProjectionProgram>();
    const validProgram = (program: unknown): boolean => {
      if (program === null || typeof program !== 'object') return false;
      const row = program as PublishedMaterialProjectionProgram;
      const programKey =
        typeof row.specializationKey === 'string' && typeof row.artifactHash === 'string'
          ? programInternKey(row)
          : undefined;
      const prior =
        programKey === undefined
          ? undefined
          : this.#programs.find(programKey, (value) => equalDescriptorValue(value, program));
      if (prior !== undefined) {
        reused.set(program, prior);
        return true;
      }
      if (!validPublicationProjectionProgram(program)) return false;
      const ownedProgram = ownRenderFeatureProgramData(row);
      if (programKey !== undefined && isOwnedRenderFeatureProgramData(ownedProgram))
        this.#programs.add(programKey, ownedProgram);
      reused.set(program, ownedProgram);
      return true;
    };
    if (!validPublicationProjectionShape(input, validProgram)) return undefined;
    const owned = ownRenderFeatureProgramDataWith(candidate, (node) => reused.get(node));
    if (!isOwnedRenderFeatureProgramData(owned)) return owned;
    this.#validated.add(owned);
    if (key !== undefined) this.#projections.add(key, owned);
    return owned;
  }
}

function projectionKeyOf(value: PublishedMaterialProjection): string | undefined {
  return typeof value.materialGuid === 'string' &&
    typeof value.specializationKey === 'string' &&
    typeof value.artifactHash === 'string' &&
    Number.isSafeInteger(value.publicationGeneration)
    ? projectionInternKey(value)
    : undefined;
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
    const shader =
      material.materialShaderId === undefined
        ? undefined
        : registry.findMaterialArtifact(material.materialShaderId);
    // Full content includes defaults and author metadata. A merged schema or
    // another Pass's ABI must not be replaced merely because field types match.
    let rebound =
      schema !== undefined &&
      shader?.ok === true &&
      schema !== shader.value.paramSchema &&
      matchesSchema(material, shader.value.paramSchema)
        ? { ...material, materialParamSchema: shader.value.paramSchema }
        : material;
    const entryPoints = Object.fromEntries(
      material.passes.flatMap((pass) => {
        const key =
          material.materialProgramKeys?.[pass.name] ??
          runtimeMaterialShaderId(pass.program.module, pass.name);
        if (key === undefined) return [];
        const program = registry.findMaterialArtifact(key);
        const reads = program.ok ? program.value.program.entryPoints : undefined;
        return reads === undefined ? [] : [[pass.name, reads]];
      }),
    );
    // A re-published material that already carries these exact program reads
    // keeps its identity; a fresh object would invalidate every material cache.
    if (
      Object.keys(entryPoints).length > 0 &&
      !sameEntryPoints(rebound.materialEntryPoints, entryPoints)
    )
      rebound = { ...rebound, materialEntryPoints: entryPoints };
    materials.set(material, rebound);
    return rebound;
  };
  return rebind;
}

function sameEntryPoints(
  current: MaterialSnapshot['materialEntryPoints'],
  next: Readonly<Record<string, unknown>>,
): boolean {
  if (current === undefined) return false;
  const keys = Object.keys(next);
  if (Object.keys(current).length !== keys.length) return false;
  for (const key of keys)
    if ((current as Readonly<Record<string, unknown>>)[key] !== next[key]) return false;
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
    if (rebound !== resource.snapshot) resource.adopt(rebound);
  }
  return input;
}

/** Admit immutable producer artifacts before the full Renderer prepares their pipelines. */
export function installPublicationPrograms(
  assets: AssetRegistry,
  programs: RenderPublication['programs'],
): void {
  if (programs.length === 0) return;
  const validation = new MaterialArtifactRegistry();
  let shaders: ShaderRegistry | undefined;
  const keys = new Set<string>();
  for (const row of programs) {
    if (keys.has(row.key) || (row.artifact !== undefined && row.artifact.key !== row.key))
      throw new RenderPublicationError({
        reason: 'shape',
        subject: 'duplicate or mismatched program key',
      });
    keys.add(row.key);
    const previous = assets.shaderRegistry.findMaterialArtifact(row.key);
    // The installed schema and program already own their immutable derivation.
    // A Worker clone still compares all published content; its key alone is
    // not evidence. The registry also owns the complete immutable receipt.
    if (
      previous.ok &&
      (previous.value.source !== row.shader.source ||
        !sameSchemaValue(previous.value.paramSchema, row.shader.paramSchema) ||
        !sameSchemaValue(previous.value.receipt, row.shader.receipt) ||
        !sameSchemaValue(
          previous.value.program.entryPoints,
          row.shader.entryPoints ?? row.shader.receipt?.entryPoints,
        ))
    ) {
      throw new RenderPublicationError({
        reason: 'shape',
        subject: `conflicting immutable shader ${row.key}`,
      });
    }
    if (!previous.ok) {
      shaders ??= new ShaderRegistry({ manifestUrl: undefined });
      shaders.installMaterialArtifact(row.key, row.shader, assets.shaderRegistry);
    }
    if (row.artifact !== undefined) {
      const existing = assets.getMaterialArtifact(row.key);
      if (existing !== undefined) validation.register(existing).unwrap();
      validation.register(row.artifact).unwrap();
    }
  }
  if (shaders !== undefined) assets.shaderRegistry.installMaterialArtifactsFrom(shaders);
  for (const row of programs) {
    if (row.artifact !== undefined) assets.materialArtifactRegistry.register(row.artifact).unwrap();
  }
}

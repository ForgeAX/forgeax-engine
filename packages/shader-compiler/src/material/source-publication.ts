import {
  type CookedMaterialRecord,
  MATERIAL_RASTER_SOURCES_SCHEMA,
  type MaterialRasterSourcePublication,
  type MaterialSourcePublication,
  materialRasterSourceSelection,
  type SourceCookedMaterialRecord,
  validateMaterialRasterSourcePublication,
} from '@forgeax/engine-pack/material-cook';
import type { ShaderTemplateLibrary } from '@forgeax/engine-shader';
import {
  err,
  type MaterialRasterSourceInputs,
  type MaterialRasterSourceSelection,
  ok,
  type Result,
  sha256,
} from '@forgeax/engine-types';
import type { CompileResult, PreparedShaderCompiler } from '../compile.js';
import { ShaderError } from '../errors.js';
import { shaderModuleId } from '../module-path.js';
import {
  type MaterialCookError,
  type MaterialCookedPass,
  rebuildMaterialRasterProgram,
} from './cook.js';
import {
  buildMaterialSourceCatalog,
  type MaterialSourceCatalog,
  type MaterialSourceInput,
} from './source-catalog.js';

const SCHEMA = 'material-source-modules/1';

export {
  MATERIAL_RASTER_SOURCES_PATH,
  type MaterialRasterSourcePublication,
  type MaterialSourcePublication,
} from '@forgeax/engine-pack/material-cook';

type EngineSources = Pick<ShaderTemplateLibrary, 'sources'>;

type ModuleReference = MaterialSourcePublication['modules'][number];

function invalid(reason: string): Result<never, ShaderError> {
  return err(
    new ShaderError({
      code: 'shader-compile-failed',
      expected: 'a verified material source closure and its Engine shader template library',
      message: reason,
      hint: 'prepare the named material modules and rebuild both publications together',
    }),
  );
}

/** Publish original source modules before parameter, Surface and address lowering. */
export function publishMaterialSourceModules(
  catalog: MaterialSourceCatalog,
  modules: readonly string[],
  engine: EngineSources | ReadonlySet<string>,
): Result<MaterialSourcePublication, MaterialCookError> {
  const references: ModuleReference[] = [];
  for (const module of [...new Set(modules)].sort()) {
    const found = catalog.get(module);
    if (!found.ok) return found;
    const { provenance, source } = found.value;
    const digest = sha256(source);
    if (provenance === 'engine') {
      const present =
        'sources' in engine
          ? Object.hasOwn(engine.sources, digest) && engine.sources[digest] === source
          : engine.has(digest);
      if (!present)
        return invalid(`Engine source module '${module}' is absent from the paired shader library`);
      references.push({ kind: 'engine', module, digest });
    } else references.push({ kind: 'project', module, digest, source });
  }
  if (references.length === 0) return invalid('Material source closure is empty');
  return ok({ schemaVersion: SCHEMA, modules: references });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readModule(
  value: unknown,
  engine: EngineSources,
): Result<
  { readonly kind: ModuleReference['kind']; readonly entry: MaterialSourceInput },
  ShaderError
> {
  if (
    !isRecord(value) ||
    typeof value.module !== 'string' ||
    typeof value.digest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.digest)
  )
    return invalid('Invalid material source module declaration');
  const { kind, module, digest } = value;
  if (
    (kind !== 'engine' && kind !== 'project') ||
    Object.keys(value).some(
      (key) =>
        key !== 'kind' &&
        key !== 'module' &&
        key !== 'digest' &&
        !(kind === 'project' && key === 'source'),
    )
  )
    return invalid(`Invalid source fields for material module '${module}'`);
  const text =
    kind === 'project'
      ? value.source
      : Object.hasOwn(engine.sources, digest)
        ? engine.sources[digest]
        : undefined;
  if (typeof text !== 'string' || sha256(text) !== digest || shaderModuleId(text) !== module)
    return invalid(`Source identity mismatch for material module '${module}'`);
  return ok({ kind, entry: { path: module, source: text } });
}

/** Admit the complete referenced source closure before a material can select any program. */
export function readMaterialSourceModules(
  input: unknown,
  engine: EngineSources,
): Result<MaterialSourceCatalog, MaterialCookError> {
  if (
    !isRecord(input) ||
    input.schemaVersion !== SCHEMA ||
    Object.keys(input).some((key) => key !== 'schemaVersion' && key !== 'modules') ||
    !Array.isArray(input.modules) ||
    input.modules.length === 0
  )
    return invalid('Invalid material source publication');
  const sources = { engine: [] as MaterialSourceInput[], project: [] as MaterialSourceInput[] };
  for (const reference of input.modules) {
    const read = readModule(reference, engine);
    if (!read.ok) return read;
    sources[read.value.kind].push(read.value.entry);
  }
  return buildMaterialSourceCatalog(sources);
}

/** Publish the original inputs of the actual raster producer, before ray derivatives. */
export function publishMaterialRasterSources(
  catalog: MaterialSourceCatalog,
  passes: readonly MaterialCookedPass[],
  record: CookedMaterialRecord,
  vertexColorOverrides: ReadonlyMap<string, boolean>,
  engineSourceDigests: ReadonlySet<string>,
): Result<MaterialRasterSourcePublication, MaterialCookError> {
  const originals = new Set<string>();
  for (const pass of passes) {
    for (const module of pass.sourceClosure) {
      // A successful pass composition also lists its generated parameter,
      // deformation and page ABIs. Only catalog-owned modules have raw inputs.
      if (catalog.get(module).ok) originals.add(module);
    }
  }
  const modules = publishMaterialSourceModules(catalog, [...originals], engineSourceDigests);
  if (!modules.ok) return modules;
  return ok({
    schemaVersion: MATERIAL_RASTER_SOURCES_SCHEMA,
    programSetDigest: record.receipt.identity.artifactDigest,
    modules: modules.value,
    vertexColorOverrides: Object.fromEntries(vertexColorOverrides),
  });
}

/** Project the demand from the exact Cook rows, without resolving unrelated programs. */
export function selectMaterialRasterSources(
  source: unknown,
  record: CookedMaterialRecord | SourceCookedMaterialRecord,
  keys: readonly string[],
): Result<MaterialSourceProgramRequest['selections'], ShaderError> {
  const publication = validateMaterialRasterSourcePublication(source, record);
  if (!publication.ok)
    return invalid(
      `Raster source publication does not match its cooked program set: ${publication.error.detail.field}`,
    );
  const programs = new Map(record.programs.map((program) => [program.specializationKey, program]));
  const selections: MaterialRasterSourceSelection[] = [];
  for (const key of keys) {
    const program = programs.get(key);
    const selection =
      program === undefined
        ? undefined
        : materialRasterSourceSelection(record.guid, publication.value, program);
    if (selection === undefined)
      return invalid(`Program '${key}' does not publish a reproducible raster selection`);
    selections.push(selection);
  }
  return ok(selections);
}

export type { MaterialRasterSourceSelection } from '@forgeax/engine-types';

/** One demand group shares the original module closure across selected assets. */
export interface MaterialSourceProgramRequest extends MaterialRasterSourceInputs {
  readonly engine: EngineSources;
  readonly selections: readonly MaterialRasterSourceSelection[];
}

/** Compile exactly the requested programs, using the Pack producer's lowering. */
export function rebuildMaterialSourcePrograms(
  compiler: Pick<PreparedShaderCompiler, 'compile'>,
  request: MaterialSourceProgramRequest,
): Result<readonly CompileResult[], MaterialCookError> {
  const sources = readMaterialSourceModules(request.modules, request.engine);
  if (!sources.ok) return sources;
  const surfaces = { sources: sources.value, entries: new Map() };
  const rebuilt: CompileResult[] = [];
  for (const selection of request.selections) {
    const { material, context, vertexColorAvailable } = selection;
    const result = rebuildMaterialRasterProgram(
      compiler,
      {
        material,
        table: request.materials,
        sources: sources.value,
        context,
        ...(vertexColorAvailable === undefined ? {} : { vertexColorAvailable }),
      },
      selection,
      surfaces,
    );
    if (!result.ok) return result;
    rebuilt.push(result.value);
  }
  return ok(rebuilt);
}

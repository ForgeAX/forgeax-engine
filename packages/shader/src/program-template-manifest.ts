import {
  isShaderBuiltinRole,
  isShaderProgramContract,
  type ManifestEntry,
  type ShaderBuiltinRole,
  type ShaderProgramContract,
  type ShaderSource,
} from '@forgeax/engine-types';
import { err, manifestMalformed, ok, type Result, type ShaderError } from './errors.js';
import {
  bindManifestShaderSource,
  boundManifestShaderSource,
  manifestShaderSourcePrepared,
} from './manifest-publication.js';
import {
  type AdmittedShaderProgramTemplate,
  readShaderProgramTemplates,
  type ShaderProgramCompilation,
  type ShaderTemplateLibrary,
  selectShaderProgramDefines,
} from './program-template.js';
import { ShaderVariantDomain, type VariantPreference } from './supported-variant-defines.js';
import type { MaterialShaderManifestEntry, MaterialShaderManifestVariant } from './types.js';

export const SHADER_TEMPLATE_MANIFEST_VERSION = '7.0.0' as const;
export const SHADER_PROJECT_MANIFEST_VERSION = '8.0.0' as const;

export interface ShaderTemplateManifest {
  readonly schemaVersion: typeof SHADER_TEMPLATE_MANIFEST_VERSION;
  readonly library: ShaderTemplateLibrary;
  readonly entries: readonly {
    readonly hash: string;
    readonly role?: ShaderBuiltinRole;
    readonly identifier: string;
    readonly program: string;
    readonly selection: Readonly<Record<string, boolean>>;
    readonly programContract?: ShaderProgramContract;
  }[];
  readonly materialShaders: readonly {
    readonly identifier: string;
    readonly sourcePath: string;
    readonly paramSchema?: string;
    readonly program: string;
    readonly selection: Readonly<Record<string, boolean>>;
  }[];
}

export interface AdmittedShaderTemplateManifest {
  readonly wire: ShaderTemplateManifest;
  readonly programs: ReadonlyMap<string, AdmittedShaderProgramTemplate>;
}

type CompiledProgram = ShaderProgramCompilation & {
  readonly program: { readonly sourceReference: ShaderSource };
};
type Resolve = (
  program: string,
  selection: Readonly<Record<string, boolean>>,
) => Result<CompiledProgram, ShaderError>;
type Prepare = (
  program: string,
  selection: Readonly<Record<string, boolean>>,
) => Result<boolean, ShaderError>;
const nativeRows = new WeakSet<object>();
const preparedRows = new WeakSet<object>();
const variantReaders = new WeakMap<
  object,
  { readonly read: () => CompiledProgram; readonly prepare?: () => Result<boolean, ShaderError> }
>();
const familyReaders = new WeakMap<
  object,
  {
    readonly axes: readonly string[];
    readonly domain: () => ShaderVariantDomain;
    readonly variant: (defines: Readonly<Record<string, boolean>>) => MaterialShaderManifestVariant;
    readonly select: (key: string) => MaterialShaderManifestVariant | undefined;
    readonly match: (
      constraints: Readonly<Record<string, boolean>>,
    ) => MaterialShaderManifestVariant | undefined;
    readonly prepared: () => readonly MaterialShaderManifestVariant[];
  }
>();

export function isShaderTemplateManifestRow(row: object): boolean {
  return nativeRows.has(row);
}
export function templateManifestAxes(row: object): readonly string[] | undefined {
  return familyReaders.get(row)?.axes;
}
export function templateManifestVariant(
  row: object,
  key: string,
): MaterialShaderManifestVariant | undefined {
  return familyReaders.get(row)?.select(key);
}
export function templateManifestVariantByDefines(
  row: object,
  constraints: Readonly<Record<string, boolean>>,
): MaterialShaderManifestVariant | undefined {
  return familyReaders.get(row)?.match(constraints);
}

/** Rank legal template rows by nonnegative weights on distinct axes. Ties follow canonical key order. */
export function preferredMaterialShaderTemplateVariant(
  entry: MaterialShaderManifestEntry,
  constraints: Readonly<Record<string, boolean>>,
  preferences: readonly VariantPreference[],
): MaterialShaderManifestVariant | undefined {
  const family = familyReaders.get(entry);
  if (
    family === undefined ||
    Object.keys(constraints).some((axis) => constraints[axis] && !family.axes.includes(axis))
  )
    return undefined;
  const selected = family.domain().preferred(constraints, preferences);
  return selected === undefined ? undefined : family.variant(selected);
}

/** Visit variants which explicitly declare this axis value, in publication order. */
export function* materialShaderVariantsWithAxis(
  entry: MaterialShaderManifestEntry,
  axis: string,
  value: boolean,
): Generator<MaterialShaderManifestVariant, undefined> {
  const family = familyReaders.get(entry);
  if (family === undefined) {
    for (const row of entry.variants) if (row.defines[axis] === value) yield row;
  } else if (family.axes.includes(axis)) {
    for (const defines of family.domain().rows({ [axis]: value })) yield family.variant(defines);
  }
}

/** Request CPU preparation for this selected row. Compiled publications are already ready. */
export function prepareMaterialShaderTemplateVariant(
  variant: MaterialShaderManifestVariant,
): Result<boolean, ShaderError> {
  return variantReaders.get(variant)?.prepare?.() ?? ok(true);
}

/** Preserve the selected source/reflection owner without reading the primary program. */
export function shaderTemplateVariantEntry(
  entry: ManifestEntry,
  variant: MaterialShaderManifestVariant,
): ManifestEntry | undefined {
  const read = variantReaders.get(variant)?.read;
  if (!nativeRows.has(entry) || read === undefined) return undefined;
  const row = Object.freeze({
    ...(entry.identifier === undefined ? {} : { identifier: entry.identifier }),
    ...(entry.role === undefined ? {} : { role: entry.role }),
    ...(entry.programContract === undefined ? {} : { programContract: entry.programContract }),
    defines: variant.defines,
    get hash() {
      return read().manifestEntry.hash;
    },
    get wgsl() {
      return read().program.sourceReference.read();
    },
    get glsl() {
      return read().manifestEntry.glsl;
    },
    get bindings() {
      return read().manifestEntry.bindings;
    },
    get reflection() {
      return read().manifestEntry.reflection;
    },
    get compilerProfile() {
      return read().manifestEntry.compilerProfile;
    },
    get entryPoints() {
      return read().manifestEntry.entryPoints;
    },
  }) as ManifestEntry;
  nativeRows.add(row);
  bindManifestShaderSource(row, () => read().program.sourceReference);
  return row;
}

function malformed(reason: string): Result<never, ShaderError> {
  return err(
    manifestMalformed({
      message: 'Invalid shader template manifest',
      reason,
      hint: 'rebuild the source-template publication with the matching producer',
    }),
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keyOf(defines: Readonly<Record<string, boolean>>): string {
  const fields = Object.entries(defines).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return fields.every(([, value]) => value)
    ? ''
    : fields.map(([axis, value]) => `${axis}=${value}`).join('+');
}

function validMaterialParameterDeclaration(
  row: Record<string, unknown>,
  engineSchema: boolean,
): boolean {
  // Engine recipes own the schema; a row cannot override it.
  if (engineSchema) return row.paramSchema === undefined;
  if (typeof row.paramSchema !== 'string') return false;
  try {
    return Array.isArray(JSON.parse(row.paramSchema));
  } catch {
    return false;
  }
}

/** Source and all references are admitted before any compiler or device work. */
export function admitShaderTemplateManifest(
  input: unknown,
): Result<AdmittedShaderTemplateManifest, ShaderError> {
  if (
    !record(input) ||
    input.schemaVersion !== SHADER_TEMPLATE_MANIFEST_VERSION ||
    !Array.isArray(input.entries) ||
    !Array.isArray(input.materialShaders)
  )
    return malformed('invalid version or row arrays');
  const programs = readShaderProgramTemplates(input.library);
  if (!programs.ok) return programs;
  const names = new Set<string>();
  const hashes = new Set<string>();
  const validate = (row: unknown, material: boolean): boolean => {
    if (
      !record(row) ||
      typeof row.identifier !== 'string' ||
      !row.identifier ||
      typeof row.program !== 'string' ||
      !record(row.selection)
    )
      return false;
    const program = programs.value.get(row.program);
    if (
      program === undefined ||
      !selectShaderProgramDefines(program, row.selection as Record<string, boolean>).ok
    )
      return false;
    if (material) {
      if (typeof row.sourcePath !== 'string' || names.has(row.identifier)) return false;
      if (!validMaterialParameterDeclaration(row, program.template.engine !== undefined))
        return false;
      names.add(row.identifier);
    } else {
      if (
        (row.role !== undefined && !isShaderBuiltinRole(row.role)) ||
        typeof row.hash !== 'string' ||
        !row.hash ||
        hashes.has(row.hash) ||
        (row.programContract !== undefined && !isShaderProgramContract(row.programContract))
      )
        return false;
      hashes.add(row.hash);
    }
    return true;
  };
  if (
    !input.entries.every((row) => validate(row, false)) ||
    !input.materialShaders.every((row) => validate(row, true))
  )
    return malformed('missing, conflicting or illegal program selection');
  const wire = structuredClone(input) as unknown as ShaderTemplateManifest;
  freeze(wire);
  return ok({ wire, programs: programs.value });
}
function freeze(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.values(value).forEach(freeze);
  Object.freeze(value);
}

function variantRow(
  program: string,
  definesKey: string,
  defines: Readonly<Record<string, boolean>>,
  resolve: Resolve,
  prepare: Prepare | undefined,
): MaterialShaderManifestVariant {
  let compiled: CompiledProgram | undefined;
  const read = (): CompiledProgram => {
    if (compiled === undefined) {
      compiled = resolve(program, defines).unwrap();
      preparedRows.add(row);
    }
    return compiled;
  };
  const row = Object.freeze({
    definesKey,
    defines: Object.freeze({ ...defines }),
    get hash() {
      return read().manifestEntry.hash;
    },
    get composedWgsl() {
      return read().program.sourceReference.read();
    },
    get sourceDigest() {
      return read().program.sourceReference.identity;
    },
    get compilerProfile() {
      return read().manifestEntry.compilerProfile;
    },
    get reflection() {
      return read().manifestEntry.reflection;
    },
    get entryPoints() {
      return read().manifestEntry.entryPoints;
    },
    get receipt() {
      return read().receipt;
    },
    get forwardFog() {
      return read().forwardFog;
    },
    get uvSetCount() {
      return read().uvSetCount;
    },
  }) as MaterialShaderManifestVariant;
  nativeRows.add(row);
  variantReaders.set(row, {
    read,
    ...(prepare === undefined
      ? {}
      : { prepare: () => (compiled === undefined ? prepare(program, defines) : ok(true)) }),
  });
  bindManifestShaderSource(row, () => read().program.sourceReference);
  return row;
}

/** Native program cursors expose selected source facts; only explicitly selected rows compile. */
export function materializeShaderTemplateManifest(
  admitted: AdmittedShaderTemplateManifest,
  resolve: Resolve,
  prepare?: Prepare,
): {
  readonly entries: readonly ManifestEntry[];
  readonly materialShaders: readonly MaterialShaderManifestEntry[];
} {
  const entries = admitted.wire.entries.map((declaration): ManifestEntry => {
    let compiled: CompiledProgram | undefined;
    const read = (): CompiledProgram =>
      (compiled ??= resolve(declaration.program, declaration.selection).unwrap());
    const row = Object.freeze({
      hash: declaration.hash,
      identifier: declaration.identifier,
      ...(declaration.role === undefined ? {} : { role: declaration.role }),
      defines: declaration.selection,
      ...(declaration.programContract === undefined
        ? {}
        : { programContract: declaration.programContract }),
      get wgsl() {
        return read().program.sourceReference.read();
      },
      get sourceDigest() {
        return read().program.sourceReference.identity;
      },
      get glsl() {
        return read().manifestEntry.glsl;
      },
      get bindings() {
        return read().manifestEntry.bindings;
      },
      get reflection() {
        return read().manifestEntry.reflection;
      },
      get compilerProfile() {
        return read().manifestEntry.compilerProfile;
      },
      get entryPoints() {
        return read().manifestEntry.entryPoints;
      },
    }) as ManifestEntry;
    nativeRows.add(row);
    bindManifestShaderSource(row, () => read().program.sourceReference);
    return row;
  });
  const materialShaders = admitted.wire.materialShaders.map(
    (declaration): MaterialShaderManifestEntry => {
      const program = admitted.programs.get(declaration.program);
      if (program === undefined) throw new Error('Admitted template program is missing');
      const paramSchema =
        program.template.engine === undefined
          ? declaration.paramSchema
          : JSON.stringify(program.template.engine.paramSchema);
      if (paramSchema === undefined) throw new Error('Admitted material schema is missing');
      const axes = program.template.axes;
      let choicesDomain: ShaderVariantDomain | undefined;
      const domain = () => (choicesDomain ??= new ShaderVariantDomain(axes));
      const choices = new Map<string, MaterialShaderManifestVariant>();
      const variant = (
        defines: Readonly<Record<string, boolean>>,
      ): MaterialShaderManifestVariant => {
        const key = keyOf(defines);
        let selected = choices.get(key);
        if (selected === undefined) {
          selected = variantRow(declaration.program, key, defines, resolve, prepare);
          choices.set(key, selected);
        }
        return selected;
      };
      const select = (defines: Readonly<Record<string, boolean>>) =>
        selectShaderProgramDefines(program, defines).ok ? variant(defines) : undefined;
      const base = select(declaration.selection);
      if (base === undefined) throw new Error('Admitted template default selection is missing');
      let variants: readonly MaterialShaderManifestVariant[] | undefined;
      const row = Object.freeze({
        identifier: declaration.identifier,
        sourcePath: declaration.sourcePath,
        paramSchema,
        get composedWgsl() {
          return base.composedWgsl;
        },
        get sourceDigest() {
          return base.sourceDigest;
        },
        get hash() {
          return base.hash;
        },
        get compilerProfile() {
          return base.compilerProfile;
        },
        get reflection() {
          return base.reflection;
        },
        get entryPoints() {
          return base.entryPoints;
        },
        get receipt() {
          return base.receipt;
        },
        get forwardFog() {
          return base.forwardFog;
        },
        get uvSetCount() {
          return base.uvSetCount;
        },
        get variants() {
          // Legacy publication inspection enumerates declarations, never program bodies.
          // Native axis/key selection below does not enter this path.
          if (variants !== undefined) return variants;
          if (axes.length === 0) {
            variants = Object.freeze([]);
            return variants;
          }
          variants = Object.freeze(Array.from(domain().rows(), variant));
          return variants;
        },
      }) as MaterialShaderManifestEntry;
      nativeRows.add(row);
      bindManifestShaderSource(row, () => boundManifestShaderSource(base) as ShaderSource);
      familyReaders.set(row, {
        axes,
        domain,
        variant,
        prepared: () => [...choices.values()].filter((choice) => preparedRows.has(choice)),
        match(constraints) {
          if (Object.entries(constraints).some(([axis, value]) => !axes.includes(axis) && value))
            return undefined;
          const first = domain().first(constraints);
          return first === undefined ? undefined : variant(first);
        },
        select(key) {
          // Every published row was admitted by the program or its legal domain.
          const published = choices.get(key);
          if (published !== undefined) return published;
          const defines: Record<string, boolean> = {};
          if (key === '')
            axes.forEach((axis) => {
              defines[axis] = true;
            });
          else
            for (const field of key.split('+')) {
              const match = /^([A-Za-z_]\w*)=(true|false)$/.exec(field);
              if (match === null || match[1] === undefined || Object.hasOwn(defines, match[1]))
                return undefined;
              defines[match[1]] = match[2] === 'true';
            }
          return keyOf(defines) === key ? select(defines) : undefined;
        },
      });
      return row;
    },
  );
  return { entries, materialShaders };
}

/** Prepared native rows only: inspection and aliasing cannot cause permutation compilation. */
export function materialShaderPreparedSourceRows(
  entry: MaterialShaderManifestEntry,
): readonly (MaterialShaderManifestEntry | MaterialShaderManifestVariant)[] {
  return (
    familyReaders.get(entry)?.prepared() ??
    [entry, ...entry.variants].filter(manifestShaderSourcePrepared)
  );
}

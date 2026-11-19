import {
  isShaderBuiltinRole,
  isShaderProgramContract,
  type ManifestEntry,
  type ShaderBuiltinRole,
  type ShaderProgramContract,
  type ShaderSource,
} from '@forgeax/engine-types';
import { err, manifestMalformed, ok, type Result, type ShaderError } from './errors.js';
import { bindManifestShaderSource, boundManifestShaderSource } from './manifest-publication.js';
import {
  type AdmittedShaderProgramTemplate,
  readShaderProgramTemplates,
  type ShaderProgramCompilation,
  type ShaderTemplateLibrary,
  selectShaderProgramDefines,
} from './program-template.js';
import type { MaterialShaderManifestEntry, MaterialShaderManifestVariant } from './types.js';

export const SHADER_TEMPLATE_MANIFEST_VERSION = '7.0.0' as const;

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
const nativeRows = new WeakSet<object>();
const preparedRows = new WeakSet<object>();
const variantReaders = new WeakMap<object, () => CompiledProgram>();
const familyReaders = new WeakMap<
  object,
  {
    readonly axes: readonly string[];
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

/** Preserve the selected source/reflection owner without reading the primary program. */
export function shaderTemplateVariantEntry(
  entry: ManifestEntry,
  variant: MaterialShaderManifestVariant,
): ManifestEntry | undefined {
  const read = variantReaders.get(variant);
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
  defines: Readonly<Record<string, boolean>>,
  resolve: Resolve,
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
    definesKey: keyOf(defines),
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
  variantReaders.set(row, read);
  bindManifestShaderSource(row, () => read().program.sourceReference);
  return row;
}

/** Native program cursors expose selected source facts; only explicitly selected rows compile. */
export function materializeShaderTemplateManifest(
  admitted: AdmittedShaderTemplateManifest,
  resolve: Resolve,
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
      const choices = new Map<string, MaterialShaderManifestVariant>();
      const select = (
        defines: Readonly<Record<string, boolean>>,
      ): MaterialShaderManifestVariant | undefined => {
        if (!selectShaderProgramDefines(program, defines).ok) return undefined;
        const key = keyOf(defines);
        let selected = choices.get(key);
        if (selected === undefined) {
          selected = variantRow(declaration.program, defines, resolve);
          choices.set(key, selected);
        }
        return selected;
      };
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
          const rows: MaterialShaderManifestVariant[] = [];
          const visit = (index: number, selection: Record<string, boolean>): void => {
            const axis = axes[index];
            if (axis === undefined) {
              const selected = select(selection);
              if (selected !== undefined) rows.push(selected);
              return;
            }
            visit(index + 1, { ...selection, [axis]: true });
            visit(index + 1, { ...selection, [axis]: false });
          };
          visit(0, {});
          variants = Object.freeze(rows);
          return variants;
        },
      }) as MaterialShaderManifestEntry;
      nativeRows.add(row);
      bindManifestShaderSource(row, () => boundManifestShaderSource(base) as ShaderSource);
      familyReaders.set(row, {
        axes,
        prepared: () => [...choices.values()].filter((choice) => preparedRows.has(choice)),
        match(constraints) {
          if (Object.entries(constraints).some(([axis, value]) => !axes.includes(axis) && value))
            return undefined;
          // Follow the publication's true-first order, stopping at the first legal
          // selection. Partial lookup must not allocate the complete Cartesian table.
          const selection: Record<string, boolean> = {};
          const visit = (index: number): MaterialShaderManifestVariant | undefined => {
            const axis = axes[index];
            if (axis === undefined) return select(selection);
            if (Object.hasOwn(constraints, axis)) {
              selection[axis] = constraints[axis] as boolean;
              return visit(index + 1);
            }
            selection[axis] = true;
            const selected = visit(index + 1);
            if (selected !== undefined) return selected;
            selection[axis] = false;
            return visit(index + 1);
          };
          return visit(0);
        },
        select(key) {
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
  return familyReaders.get(entry)?.prepared() ?? [entry, ...entry.variants];
}

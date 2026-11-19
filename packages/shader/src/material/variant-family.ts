import type {
  MaterialProgramAbi,
  ParamSchemaEntry,
  ShaderEntryPointReads,
  ShaderSource,
} from '@forgeax/engine-types';
import { bindManifestShaderSource } from '../manifest-publication.js';
import type { MaterialShaderManifestEntry, MaterialShaderManifestVariant } from '../types.js';

/** References to already cooked programs, never another source or compiler recipe. */
export interface MaterialShaderVariantReference {
  readonly identifier: string;
  readonly defines: Readonly<Record<string, boolean>>;
}

export function ownMaterialVariantReferences(
  input: readonly MaterialShaderVariantReference[],
): readonly MaterialShaderVariantReference[];
export function ownMaterialVariantReferences(
  input: readonly MaterialShaderVariantReference[] | undefined,
): readonly MaterialShaderVariantReference[] | undefined;
export function ownMaterialVariantReferences(
  input: readonly MaterialShaderVariantReference[] | undefined,
): readonly MaterialShaderVariantReference[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length === 0)
    throw new Error('ShaderRegistry: empty material variant family');
  const seen = new Set<string>();
  let axes: string | undefined;
  const rows = input.map((row: MaterialShaderVariantReference) => {
    if (
      row === null ||
      typeof row !== 'object' ||
      typeof row.identifier !== 'string' ||
      row.identifier.length === 0 ||
      row.defines === null ||
      typeof row.defines !== 'object' ||
      Array.isArray(row.defines)
    )
      throw new Error('ShaderRegistry: invalid material variant reference');
    const entries = Object.entries(row.defines).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (
      entries.length === 0 ||
      entries.some(([axis, value]) => !/^[A-Z][A-Z0-9_]*$/.test(axis) || typeof value !== 'boolean')
    )
      throw new Error('ShaderRegistry: invalid material variant axes');
    const names = JSON.stringify(entries.map(([name]) => name));
    axes ??= names;
    const key = JSON.stringify(entries);
    if (names !== axes || seen.has(key))
      throw new Error('ShaderRegistry: inconsistent or duplicate material variant axes');
    seen.add(key);
    return Object.freeze({
      identifier: row.identifier,
      defines: Object.freeze(Object.fromEntries(entries)),
    });
  });
  return Object.freeze(
    rows.sort((a, b) => JSON.stringify(a.defines).localeCompare(JSON.stringify(b.defines))),
  );
}

export interface MaterialVariantSource {
  readonly forwardFog?: 'height-vertex/1';
  readonly read: () => ShaderSource;
  readonly paramSchema: readonly ParamSchemaEntry[];
  readonly receipt?: MaterialProgramAbi;
  readonly entryPoints?: readonly ShaderEntryPointReads[];
}

/** Project immutable program owners into the existing manifest selection contract. */
export function materialVariantFamily(
  identifier: string,
  references: readonly MaterialShaderVariantReference[],
  source: (identifier: string) => MaterialVariantSource,
): MaterialShaderManifestEntry {
  let schema: string | undefined;
  const variants = references.map((reference): MaterialShaderManifestVariant => {
    const program = source(reference.identifier);
    const currentSchema = JSON.stringify(program.paramSchema);
    schema ??= currentSchema;
    if (schema !== currentSchema)
      throw new Error('ShaderRegistry: material variant family has conflicting parameter schemas');
    const entries = Object.entries(reference.defines);
    const definesKey = entries.every(([, value]) => value)
      ? ''
      : entries.map(([axis, value]) => `${axis}=${value}`).join('+');
    const row = {
      ...(program.forwardFog === undefined ? {} : { forwardFog: program.forwardFog }),
      definesKey,
      defines: reference.defines,
      get composedWgsl() {
        return program.read().read();
      },
      ...(program.receipt === undefined ? {} : { receipt: program.receipt }),
      ...(program.entryPoints === undefined ? {} : { entryPoints: program.entryPoints }),
    };
    bindManifestShaderSource(row, program.read);
    return Object.freeze(row);
  });
  const primary = variants.find((row) => row.definesKey === '') ?? variants[0];
  if (primary === undefined) throw new Error('ShaderRegistry: empty material variant family');
  const entry = {
    identifier,
    sourcePath: identifier,
    paramSchema: schema ?? '[]',
    get composedWgsl() {
      return primary.composedWgsl;
    },
    variants: Object.freeze(variants),
  };
  return Object.freeze(entry);
}

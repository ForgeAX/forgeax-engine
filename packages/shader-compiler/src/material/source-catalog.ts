import type { MaterialError, Result } from '@forgeax/engine-types';
import { createMaterialError, err, ok } from '@forgeax/engine-types';
import { shaderModuleId } from '../module-path.js';

export interface MaterialSourceInput {
  readonly source: string;
  readonly path: string;
  readonly virtual?: boolean;
}

export interface MaterialSourceRecord extends MaterialSourceInput {
  readonly moduleId: string;
  readonly provenance: 'engine' | 'project';
  readonly slots: readonly string[];
}

export interface MaterialSourceCatalogInput {
  readonly roots?: readonly string[];
  readonly engine: readonly MaterialSourceInput[];
  readonly project: readonly MaterialSourceInput[];
}

const SLOT_RE = /^\s*#pragma\s+material_slot\s+([A-Za-z0-9_-]+)\s*$/gm;

function moduleIdOf(source: MaterialSourceInput): string | undefined {
  return shaderModuleId(source.source);
}

function slotsOf(source: MaterialSourceInput): readonly string[] {
  return [...source.source.matchAll(SLOT_RE)]
    .map((match) => match[1])
    .filter((slot): slot is string => slot !== undefined)
    .sort();
}

function slotError(source: string, slot: string, module: string): MaterialError {
  return createMaterialError('shader-module-not-found', {
    code: 'shader-module-not-found',
    module: `${source}::${slot}=${module}`,
    source,
  });
}

function namespaceOf(moduleId: string): string {
  return moduleId.split('::')[0] ?? moduleId;
}

function missingModule(
  moduleId: string,
  source: string,
): Result<MaterialSourceRecord, MaterialError> {
  return err(
    createMaterialError('shader-module-not-found', {
      code: 'shader-module-not-found',
      module: moduleId,
      source,
    }),
  );
}

function duplicateModule(moduleId: string, sources: readonly string[]): MaterialError {
  return createMaterialError('shader-module-id-duplicate', {
    code: 'shader-module-id-duplicate',
    module: moduleId,
    sources,
  });
}

function moduleIdError(
  code: 'shader-module-id-missing' | 'shader-module-namespace-reserved',
  source: MaterialSourceInput,
  moduleId?: string,
): MaterialError {
  if (code === 'shader-module-id-missing') {
    return createMaterialError(code, { code, source: source.path });
  }
  const namespace = namespaceOf(moduleId ?? '');
  return createMaterialError(code, { code, module: moduleId ?? '', namespace });
}

export class MaterialSourceCatalog {
  readonly #modules: ReadonlyMap<string, MaterialSourceRecord>;
  readonly roots: readonly string[];

  constructor(records: readonly MaterialSourceRecord[], roots: readonly string[] = []) {
    this.#modules = new Map(records.map((record) => [record.moduleId, record]));
    this.roots = [...roots];
  }

  get(moduleId: string): Result<MaterialSourceRecord, MaterialError> {
    const record = this.#modules.get(moduleId);
    if (record !== undefined) return ok(record);
    return missingModule(moduleId, moduleId);
  }

  resolve(moduleId: string, source: string): Result<MaterialSourceRecord, MaterialError> {
    const record = this.#modules.get(moduleId);
    if (record !== undefined) return ok(record);
    return missingModule(moduleId, source);
  }

  resolveSlot(
    sourceModuleId: string,
    slotName: string,
    moduleId: string,
  ): Result<MaterialSourceRecord, MaterialError> {
    const source = this.#modules.get(sourceModuleId);
    if (source === undefined) return missingModule(sourceModuleId, sourceModuleId);
    if (!source.slots.includes(slotName)) {
      return err(slotError(sourceModuleId, slotName, moduleId));
    }
    const selected = this.#modules.get(moduleId);
    if (selected === undefined) return missingModule(moduleId, sourceModuleId);
    if (!source.source.includes(`forgeax_material::slot::${slotName}`)) {
      return err(slotError(sourceModuleId, slotName, moduleId));
    }
    return ok(selected);
  }

  resolveSurfaceSlot(
    material: string,
    pass: string,
    sourceModuleId: string,
    moduleId: string | undefined,
  ): Result<MaterialSourceRecord, MaterialError> {
    const source = this.#modules.get(sourceModuleId);
    if (source === undefined || !source.slots.includes('surface')) {
      return err(
        createMaterialError('material-surface-slot-missing', {
          code: 'material-surface-slot-missing',
          material,
          pass,
          source: source?.path ?? sourceModuleId,
          slot: 'surface',
          action: 'add-surface-slot',
        }),
      );
    }
    const selectedId =
      moduleId ??
      (sourceModuleId === 'forgeax::default-shadow-caster'
        ? 'forgeax_material::opaque_surface'
        : sourceModuleId === 'forgeax::single-layer-medium'
          ? 'forgeax_material::default_single_layer_medium_surface'
          : 'forgeax_material::default_standard_surface');
    const selected = this.#modules.get(selectedId);
    if (selected === undefined) {
      return err(
        createMaterialError('material-surface-slot-missing', {
          code: 'material-surface-slot-missing',
          material,
          pass,
          source: selectedId,
          slot: 'surface',
          action: 'add-surface-slot',
        }),
      );
    }
    if (!source.source.includes('forgeax_material::slot::surface')) {
      return err(
        createMaterialError('material-surface-slot-missing', {
          code: 'material-surface-slot-missing',
          material,
          pass,
          source: source.path,
          slot: 'surface',
          action: 'add-surface-slot',
        }),
      );
    }
    return ok(selected);
  }

  entries(): readonly MaterialSourceRecord[] {
    return [...this.#modules.values()];
  }
}

export function buildMaterialSourceCatalog(
  input: MaterialSourceCatalogInput,
): Result<MaterialSourceCatalog, MaterialError> {
  const records: MaterialSourceRecord[] = [];
  const seen = new Map<string, string[]>();
  for (const [provenance, sources] of [
    ['engine', input.engine],
    ['project', input.project],
  ] as const) {
    for (const source of sources) {
      const moduleId = moduleIdOf(source);
      if (moduleId === undefined) return err(moduleIdError('shader-module-id-missing', source));
      if (provenance === 'project' && namespaceOf(moduleId).startsWith('forgeax_')) {
        return err(moduleIdError('shader-module-namespace-reserved', source, moduleId));
      }
      const locations = seen.get(moduleId) ?? [];
      locations.push(source.path);
      seen.set(moduleId, locations);
      records.push({ ...source, moduleId, provenance, slots: slotsOf(source) });
    }
  }
  for (const [moduleId, sources] of seen) {
    if (sources.length > 1) return err(duplicateModule(moduleId, sources));
  }
  return ok(new MaterialSourceCatalog(records, input.roots));
}

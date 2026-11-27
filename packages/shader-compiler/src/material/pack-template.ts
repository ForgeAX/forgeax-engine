import {
  collectMaterialCookRefs,
  createMaterialArtifactDigest,
  MATERIAL_TEMPLATE_SOURCES_MEDIA_TYPE,
  type MaterialTemplatePublication,
} from '@forgeax/engine-pack/material-cook';
import type { NativeCookDraft } from '@forgeax/engine-pack/native-cooker';
import { admitRayMaterial } from '@forgeax/engine-shader';
import {
  canonicalJson,
  derive,
  deriveMaterialDynamicInputLayout,
  type MaterialAsset,
  type MaterialRootAsset,
  type MaterialTable,
  resolveMaterialAsset,
  selectMaterialStaticContract,
} from '@forgeax/engine-types';
import { shaderImportClosure } from '../compile.js';
import { composeSurfaceSource } from './compose.js';
import { materialLightingSources } from './lighting-inputs.js';
import type { MaterialSourceCatalog } from './source-catalog.js';
import { deriveSurfaceShadowPasses } from './surface-shadow.js';
import { terrainProgramSource } from './terrain-program.js';

function materialSourceRecords(
  guid: string,
  material: MaterialRootAsset,
  catalog: MaterialSourceCatalog,
) {
  const moduleRoots = new Set<string>();
  // Lighting is regenerated from the selected parameter layout. Its import
  // edges are independent of that layout and belong in the source closure.
  const dependencyCatalog = material.passes?.some(
    (pass) => pass.program.bindings === 'render-lit-material-and-scene-depth',
  )
    ? materialLightingSources(catalog, derive([])).unwrap()
    : catalog;
  const sources = Object.fromEntries(
    dependencyCatalog.entries().map(({ moduleId, source }) => [moduleId, source]),
  );
  for (const pass of material.passes ?? []) {
    const terrain = terrainProgramSource(pass.program.module);
    const module = terrain?.module ?? pass.program.module;
    const source = catalog.get(module).unwrap();
    moduleRoots.add(module);
    for (const slot of Object.values(pass.program.moduleSlots ?? {})) {
      catalog.get(slot).unwrap();
      moduleRoots.add(slot);
    }
    if (!source.slots.includes('surface')) continue;
    const surface = material.surface;
    const dynamicInput =
      surface?.dynamicInput === undefined
        ? undefined
        : deriveMaterialDynamicInputLayout(surface.dynamicInput).unwrap();
    const choice = pass.program.moduleSlots?.surface ?? terrain?.surface ?? surface?.module;
    const closure = composeSurfaceSource({
      material: guid,
      pass: pass.name,
      templateModule: module,
      sources: catalog,
      ...(choice === undefined ? {} : { surfaceModule: choice }),
      ...(surface?.model === undefined ? {} : { surfaceModel: surface.model }),
      ...(surface?.abiVersion === undefined ? {} : { surfaceAbiVersion: surface.abiVersion }),
      ...(surface?.deformation === undefined ? {} : { deformation: surface.deformation }),
      ...(dynamicInput === undefined ? {} : { dynamicInput }),
      ...(pass.program.sceneDepth === 'before-pass' ? { sceneDepth: 'before-pass' } : {}),
    }).unwrap();
    for (const imported of closure.sourceClosure) moduleRoots.add(imported);
  }
  if (
    (['ray-hit', 'card-capture'] as const).some(
      (context) => admitRayMaterial(material, guid, context).ok,
    )
  ) {
    moduleRoots.add('forgeax_material::ray_surface');
    moduleRoots.add('forgeax_material::default_standard_surface');
  }
  const declarations = Object.keys(
    shaderImportClosure(
      Array.from(moduleRoots, (module) => `#import ${module}`).join('\n'),
      sources,
    ),
  ).sort();
  return declarations.flatMap((moduleId) => {
    const record = catalog.get(moduleId);
    return record.ok && record.value.virtual !== true ? [record.value] : [];
  });
}

export function createMaterialTemplateDraft(
  input: {
    readonly guid: string;
    readonly source: MaterialAsset;
    readonly table: MaterialTable;
    readonly sourcePath?: string;
    readonly refs?: readonly string[];
  },
  catalog: MaterialSourceCatalog,
): NativeCookDraft {
  const authored = resolveMaterialAsset(input.guid, input.table).unwrap().asset;
  const resolved = deriveSurfaceShadowPasses(selectMaterialStaticContract(authored));
  if (resolved.parent !== undefined || resolved.passes === undefined)
    throw new Error('Material template requires a root with passes');
  const records = materialSourceRecords(input.guid, resolved, catalog);
  const inputs = {
    engine: Object.fromEntries(
      records
        .filter((record) => record.provenance === 'engine')
        .map((row) => [row.moduleId, row.source]),
    ),
    project: Object.fromEntries(
      records
        .filter((record) => record.provenance === 'project')
        .map((row) => [row.moduleId, row.source]),
    ),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(inputs));
  const digest = createMaterialArtifactDigest(bytes);
  const path = `material-sources/${digest.slice(7)}.json`;
  const resolvedRefs = collectMaterialCookRefs(resolved);
  const authoredRefs = collectMaterialCookRefs(input.source);
  const allRefs = collectMaterialCookRefs(authored);
  const activeResources = new Set([...resolvedRefs.textures, ...resolvedRefs.samplers]);
  const inactiveResources = new Set(
    resolved.staticSwitches === undefined
      ? []
      : [...allRefs.textures, ...allRefs.samplers].filter((ref) => !activeResources.has(ref)),
  );
  const template: MaterialTemplatePublication = {
    schemaVersion: 'material-template/1',
    guid: input.guid,
    resolved,
    refs: { ...resolvedRefs, parent: authoredRefs.parent },
    sourceArtifact: { path, digest },
  };
  const refs = new Set([
    ...(input.refs ?? []).filter((ref) => !inactiveResources.has(ref)),
    ...template.refs.parent,
    ...template.refs.textures,
    ...template.refs.samplers,
  ]);
  return {
    guid: input.guid,
    payload: { ...input.source, template },
    refs: [...refs],
    artifacts: { [path]: { mediaType: MATERIAL_TEMPLATE_SOURCES_MEDIA_TYPE, bytes } },
    inputFingerprint: createMaterialArtifactDigest(
      new TextEncoder().encode(canonicalJson(template)),
    ),
    sourceDependencies: [
      ...new Set([
        ...(input.sourcePath === undefined ? [] : [input.sourcePath]),
        ...records.map((record) => record.path),
      ]),
    ],
  };
}

import { type AssetRegistry, installMaterialReadyShaders } from '@forgeax/engine-assets-runtime';
import {
  completeEmbeddedMaterial,
  projectMaterialTemplate,
} from '@forgeax/engine-assets-runtime/internal';
import { prepareRetainedZstdDecoder } from '@forgeax/engine-codec';
import type { CookedMaterialRecord } from '@forgeax/engine-pack';
import {
  readMaterialTemplateSources,
  validateMaterialTemplatePublication,
} from '@forgeax/engine-pack/material-cook';
import type { MaterialAsset } from '@forgeax/engine-types';
import { ThreeCompatibilityError } from './errors';
import { TEXTURE_SLOTS } from './material';
import { clearSurfaceProgramSelection, surfaceProgram } from './node-surface';
import { readMaterialPublication } from './program-publication';

function publicationBytes(text: string): Uint8Array {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function installProgram(assets: AssetRegistry, record: CookedMaterialRecord) {
  const ready = completeEmbeddedMaterial(record);
  if (ready.status !== 'Ready') throw ready.error;
  const program: MaterialAsset = {
    kind: 'material',
    ...record.resolved,
    passes: record.resolved.passes as NonNullable<MaterialAsset['passes']>,
    parameters: ready.record.parameterContract.parameters,
    values: Object.fromEntries(
      Object.entries(record.resolved.values).filter(
        ([, value]) => value === null || typeof value !== 'object' || !('texture' in value),
      ),
    ),
  };
  return {
    program,
    names: new Set(program.parameters?.map((parameter) => parameter.name)),
    projection: installMaterialReadyShaders(
      assets.shaderRegistry,
      ready,
      assets.materialArtifactRegistry,
    ),
  };
}

function physicalSelector(assets: AssetRegistry, bytes: Uint8Array) {
  const { sources: sourceText, recipes } = JSON.parse(new TextDecoder().decode(bytes)) as {
    sources: string;
    recipes: Record<string, unknown>;
  };
  const plain = validateMaterialTemplatePublication(recipes['']).unwrap();
  const mapped = validateMaterialTemplatePublication(recipes.baseColorTexture).unwrap();
  const digest = plain.sourceArtifact.digest;
  if (mapped.sourceArtifact.digest !== digest)
    throw new Error('Physical templates must reference the same verified source');
  const sources = readMaterialTemplateSources(
    new TextEncoder().encode(sourceText),
    digest,
  ).unwrap();
  return (key: '' | 'baseColorTexture'): ReturnType<typeof installProgram> => {
    const publication = key === '' ? plain : mapped;
    const material = publication.resolved;
    const compiled = assets.shaderRegistry
      .prepareMaterialTemplateFromInitializedCompiler({ guid: publication.guid, material, sources })
      .unwrap();
    const projection = projectMaterialTemplate(
      { publication, sources },
      0,
      compiled,
      assets.shaderRegistry,
      assets.materialArtifactRegistry,
    );
    const program: MaterialAsset = {
      ...material,
      values: Object.fromEntries(
        Object.entries(material.values ?? {}).filter(
          ([, value]) => value === null || typeof value !== 'object' || !('texture' in value),
        ),
      ),
    };
    return {
      program,
      projection,
      names: new Set(program.parameters?.map(({ name }) => name)),
    };
  };
}

function readPrograms(assets: AssetRegistry, decoded: Uint8Array) {
  return readMaterialPublication(decoded).map((record) => installProgram(assets, record));
}

async function packagedPrograms(assets: AssetRegistry) {
  const [{ materialPrograms }, { physicalTemplates }, decode, compiler] = await Promise.all([
    import('./generated/materials.mjs'),
    import('./generated/physical.mjs'),
    prepareRetainedZstdDecoder(),
    assets.shaderRegistry.initializeMaterialTemplateCompiler(() =>
      import('@forgeax/engine-shader-compiler/program').then(({ prepareShaderProgramCompiler }) =>
        prepareShaderProgramCompiler(),
      ),
    ),
  ]);
  compiler.unwrap();
  const unpack = (publication: string) => {
    const result = decode(publicationBytes(publication));
    if (!result.ok) throw result.error;
    return result.value;
  };
  const read = (publication: string) => readPrograms(assets, unpack(publication));
  type Selection = {
    sources: readonly string[];
    programs: WeakRef<ReturnType<typeof readPrograms>>;
  };
  let selections: WeakMap<readonly string[], Selection> | undefined;
  let skin: ReturnType<typeof readPrograms> | undefined;
  let selectPhysical: ReturnType<typeof physicalSelector> | undefined;
  const physical = new Map<'' | 'baseColorTexture', ReturnType<typeof installProgram>>();
  return {
    additional(sources: readonly string[]) {
      const cached = selections?.get(sources);
      if (
        cached &&
        cached.sources.length === sources.length &&
        cached.sources.every((value, i) => value === sources[i])
      ) {
        // Validated selections need no setup until a draw requests them. Only
        // a live projection pins the installed descriptors between submissions.
        let active = cached.programs.deref();
        return () => {
          active ??= cached.programs.deref();
          if (!active) {
            active = cached.sources.flatMap(read);
            cached.programs = new WeakRef(active);
          }
          return active;
        };
      }
      const programs = sources.flatMap(read);
      if (typeof WeakRef === 'function' && sources.length) {
        selections ??= new WeakMap();
        selections.set(sources, { sources: [...sources], programs: new WeakRef(programs) });
      }
      return () => programs;
    },
    skin: () => (skin ??= read(materialPrograms)),
    physical(key: string) {
      if (key !== '' && key !== 'baseColorTexture') return undefined;
      const admitted = physical.get(key);
      if (admitted !== undefined) return admitted;
      selectPhysical ??= physicalSelector(assets, unpack(physicalTemplates));
      const selected = selectPhysical(key);
      physical.set(key, selected);
      return selected;
    },
  };
}

const packaged = new WeakMap<AssetRegistry, ReturnType<typeof packagedPrograms>>();

/** Prepare compiler and publication readers before synchronous scene projection. */
export async function prepareMaterialPrograms(
  assets: AssetRegistry,
  additional: readonly string[] = [],
): Promise<(material: MaterialAsset, skinned?: boolean) => MaterialAsset> {
  let prepared = packaged.get(assets);
  if (!prepared) {
    prepared = packagedPrograms(assets).catch((error) => {
      packaged.delete(assets);
      throw error;
    });
    packaged.set(assets, prepared);
  }
  const bundled = await prepared;
  const additionalPrograms = bundled.additional(additional);
  return (material, skinned = false) => {
    const recipe = surfaceProgram(material);
    if (recipe !== undefined && skinned)
      throw new ThreeCompatibilityError(
        'three-unsupported',
        'Skinned surface expression recipe',
        'Skinning needs separate stage acceptance.',
      );
    const family =
      recipe !== undefined
        ? 'surface'
        : material.staticSwitches?.clearcoat === true
          ? 'physical'
          : skinned
            ? 'skinned-unlit'
            : undefined;
    if (family === undefined) return material;
    const extra = additionalPrograms();
    const required = Object.keys(material.values ?? {}).filter((name) => {
      const value = material.values?.[name];
      return (
        value !== null && typeof value === 'object' && ('texture' in value || 'source' in value)
      );
    });
    const programs =
      family === 'skinned-unlit'
        ? extra.length
          ? [...bundled.skin(), ...extra]
          : bundled.skin()
        : extra;
    const key = family === 'physical' ? required.slice().sort().join('-') : undefined;
    const entry =
      (key === undefined ? undefined : bundled.physical(key)) ??
      programs.find(
        ({ projection, program }) =>
          (recipe === undefined
            ? projection.materialGuid.startsWith(`forgeax-three-${family}`)
            : projection.materialGuid === recipe.programGuid &&
              program.passes?.every(
                (pass) =>
                  pass.program.moduleSlots?.surface === `forgeax_three::surface_${recipe.graphKey}`,
              ) === true) &&
          (family !== 'physical' ||
            program.parameters?.filter((parameter) => parameter.type.startsWith('texture'))
              .length === required.length) &&
          required.every((name) =>
            program.parameters?.some((parameter) => parameter.name === name),
          ),
      );
    if (entry === undefined) {
      if (recipe !== undefined)
        throw new ThreeCompatibilityError(
          'three-migration-required',
          'Missing cooked Three surface program',
          'Pass the publication returned by cookThreeSurface through forgeax.materialPrograms.',
        );
      if (family !== 'physical')
        throw new ThreeCompatibilityError(
          'three-owner-failed',
          `Missing packaged ${family} material program`,
          'Rebuild or repair the packaged Three material publication; this is not a Physical texture recipe request.',
        );
      const slots = Object.entries(TEXTURE_SLOTS)
        .filter(([slot, parameter]) => slot !== 'matcap' && required.includes(parameter))
        .map(([slot]) => slot)
        .sort();
      throw new ThreeCompatibilityError(
        'three-unsupported',
        `Physical texture variant [${required.join(', ')}] needs build-time cookPhysicalMaterials()`,
        `Cook the exact source slots with cookPhysicalMaterials([${JSON.stringify(slots)}]) and pass its publication through forgeax.materialPrograms. Include the exact set for each add/remove transition; no broader recipe or dropped map is accepted.`,
      );
    }
    const { program, projection, names } = entry;
    const values = Object.fromEntries(
      Object.entries({ ...program.values, ...material.values }).filter(([name]) => names.has(name)),
    );
    const projected = { ...material, parameters: program.parameters, values } as MaterialAsset;
    clearSurfaceProgramSelection(projected);
    const passProjection = {
      ...projection,
      passes: (projected.passes ?? []).map((pass) => {
        const source = projection.passes.find(
          (entry) =>
            entry.name ===
            (pass.name === 'forward-back' || pass.name === 'transmission-back'
              ? 'forward'
              : pass.name),
        );
        if (source === undefined) throw new Error(`Missing cooked material pass ${pass.name}`);
        return {
          ...source,
          name: pass.name,
          ...(projection.sourceTemplate !== undefined && source.name !== pass.name
            ? { templatePass: source.name }
            : {}),
          ...(pass.renderState === undefined ? {} : { renderState: pass.renderState }),
        };
      }),
    };
    assets.bindReceivedMaterialTemplate(passProjection);
    assets.materialPayloadProjections.set(projected, passProjection);
    return projected;
  };
}

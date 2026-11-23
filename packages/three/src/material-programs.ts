import { type AssetRegistry, installMaterialReadyShaders } from '@forgeax/engine-assets-runtime';
import { completeEmbeddedMaterial } from '@forgeax/engine-assets-runtime/internal';
import { prepareRetainedZstdDecoder } from '@forgeax/engine-codec';
import type { CookedMaterialRecord } from '@forgeax/engine-pack';
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

function readPrograms(assets: AssetRegistry, decoded: Uint8Array) {
  return readMaterialPublication(decoded).map((record) => installProgram(assets, record));
}

async function packagedPrograms(assets: AssetRegistry) {
  const [{ materialPrograms }, { physicalIndex }, decode] = await Promise.all([
    import('./generated/materials.mjs'),
    import('./generated/physical.mjs'),
    prepareRetainedZstdDecoder(),
  ]);
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
  const cache = new Map<string, ReturnType<typeof installProgram>>();
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
    physical(guid: string) {
      const installed = cache.get(guid);
      if (installed) return installed;
      const encoded = physicalIndex[guid];
      if (!encoded) return undefined;
      const records = readMaterialPublication(unpack(encoded), true);
      const cooked = records[0];
      if (records.length !== 1 || cooked?.guid !== guid)
        throw new Error('Packaged Physical material identity mismatch');
      const result = installProgram(assets, cooked);
      cache.set(guid, result);
      return result;
    },
  };
}

const packaged = new WeakMap<AssetRegistry, ReturnType<typeof packagedPrograms>>();

/** Preserve synchronous edits while decoding only the exact Physical recipe a draw uses. */
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
      (key === undefined
        ? undefined
        : bundled.physical(key ? `forgeax-three-physical-${key}` : 'forgeax-three-physical')) ??
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
          ...(pass.renderState === undefined ? {} : { renderState: pass.renderState }),
        };
      }),
    };
    assets.materialPayloadProjections.set(projected, passProjection);
    return projected;
  };
}

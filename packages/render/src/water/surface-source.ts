import { err, ok, type Result } from '@forgeax/engine-types';
import { type WaterGerstnerSurfaceSource, waterBodyOwnerKey } from '@forgeax/engine-water';
import { type RenderError, RenderFeaturePreparationFailedError } from '../errors/render';
import type {
  RenderFeatureMaterialShaderContract,
  RenderFeatureResourceDeclaration,
} from '../features/plan';
import type { RenderFeatureWaterMaterialInput } from '../features/prepared-graphics';
import type { RenderableSnapshot } from '../render-system-extract';
import type { WaterInfoFramePublication } from './water-info-publication-work';

/** A bounded projection of the accepted visible geometry branch, not wave state. */
export function fixedGerstnerSurfaceBodyKeys(
  renderables: Iterable<RenderableSnapshot>,
  viewIdentity: string,
): ReadonlySet<string> {
  const supported = new Set<string>();
  const rejected = new Set<string>();
  for (const row of renderables) {
    if (row.authorVisible === false) continue;
    const owner = row.waterOwner ?? row.waterMeshSource;
    if (owner === undefined) continue;
    const key = waterBodyOwnerKey(
      owner.worldIdentity,
      owner.guid,
      owner.generation,
      owner.zoneGeneration,
    );
    const materials =
      row.waterMeshSource === undefined
        ? row.materials
        : (row.waterMeshSource.views
            .find((view) => view.viewIdentity === viewIdentity)
            ?.draws.map((draw) => row.materials[draw.materialIndex]) ?? []);
    for (const entry of materials) {
      const material = entry?.snapshot;
      if (material === undefined) continue;
      const switches = material.staticSwitches;
      // A fixed upload uses the Body height/depth even when the material keeps
      // WaterInfo enabled. Flat bodies also make height remapping a no-op, so
      // their ordinary LOD material can retain waterVertexMapping=false.
      const matches =
        material.waterDeformation?.module === 'forgeax_material::water_deformation_default' &&
        switches?.waterWaves === true &&
        switches.waterBakedSimulation !== true &&
        switches.waterShallowSimulation !== true &&
        switches.waterOceanPatch !== true &&
        switches.waterOceanDisplacement !== true &&
        switches.waterTransitionLake !== true &&
        switches.waterTransitionOcean !== true;
      if (matches) supported.add(key);
      else rejected.add(key);
    }
  }
  for (const key of rejected) supported.delete(key);
  return supported;
}

/** Qualify the receiving frame's real upload, never a second source snapshot. */
export function waterGerstnerSurfacePublicationMatches(
  publication: WaterInfoFramePublication,
  selected: RenderFeatureWaterMaterialInput,
): boolean {
  const requested = selected.surfaceSource;
  if (requested === undefined) return true;
  if (requested.model !== 'gerstner-fixed/1') return false;
  const index = publication.waveUploadPlan.bodyIndices.get(selected.bodyKey);
  const row = index === undefined ? undefined : publication.waveUploadPlan.bodyData[index];
  if (row === undefined || row.heightSource.kind !== 'fixed' || (row.flags & 2) === 0) return false;
  const source = publication.waveBodies.find(
    (body) =>
      waterBodyOwnerKey(
        body.worldIdentity,
        body.bodyGuid,
        body.bodyGeneration,
        body.zoneGeneration,
      ) === selected.bodyKey,
  );
  return (
    source !== undefined &&
    source.waveSet.inputDigest === requested.waveSetDigest &&
    source.bodyGeneration === selected.bodyGeneration &&
    source.zoneGeneration === selected.zoneGeneration &&
    source.heightSource.kind === 'fixed' &&
    source.usesFlatSurfaceHeight &&
    source.timeSeconds === row.timeSeconds &&
    source.previousTimeSeconds === row.previousTimeSeconds
  );
}

/** Public declarative binding: the receiver supplies current resources and time. */
export function waterGerstnerSurfaceBindings(options: {
  readonly name: string;
  readonly program: string;
  readonly viewIdentity: string;
  readonly source: WaterGerstnerSurfaceSource;
  readonly contract: RenderFeatureMaterialShaderContract;
}): Result<Extract<RenderFeatureResourceDeclaration, { kind: 'graphics-bindings' }>, RenderError> {
  const { source, contract } = options;
  if (
    !options.viewIdentity ||
    contract.systemInputs?.water !== 'water-frame/3' ||
    contract.entryPoints === undefined ||
    contract.entryPoints.some((point) =>
      point.bindings.some((read) => read.group === 2 && read.binding < 16),
    )
  )
    return err(
      new RenderFeaturePreparationFailedError(
        'water-surface-source',
        -1,
        'bind-surface',
        'bindings',
        options.name,
        'a cooked water-frame/3 program with certified resource reads and no scene geometry in group 2',
        'next-frame',
      ),
    );
  return ok({
    kind: 'graphics-bindings',
    name: options.name,
    program: options.program,
    values: {
      group: 2,
      waterMaterial: {
        bodyKey: source.bodyKey,
        bodyGeneration: source.bodyGeneration,
        zoneGeneration: source.zoneGeneration,
        viewIdentity: options.viewIdentity,
        surfaceSource: { model: source.model, waveSetDigest: source.waveSetDigest },
        programInputs: {
          systemInputs: { water: 'water-frame/3' },
          entryPoints: contract.entryPoints.map((point) => ({
            ...point,
            bindings: point.bindings.map((binding) => ({ ...binding })),
          })),
        },
      },
    },
  });
}

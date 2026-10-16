import { err, ok, type Result } from '@forgeax/engine-types';

export interface MeshLodMetaEntry {
  readonly sourceKey: string;
  readonly meshGuid: string;
  readonly screenCoverage?: number;
}

export interface MeshLodContractInput {
  readonly lods: readonly Readonly<{ meshGuid: string; screenCoverage: number }>[];
  readonly lodHysteresis?: number;
  readonly rootMeshGuid?: string;
  readonly refs?: readonly string[];
  readonly generation?: number;
  readonly rootBounds?: MeshLodBounds;
  readonly lodBounds?: readonly MeshLodBounds[];
  readonly rootMaterialSlots?: readonly MeshLodMaterialSlot[];
  readonly lodMaterialSlots?: readonly (readonly MeshLodMaterialSlot[])[];
  readonly relations?: readonly MeshLodRelation[];
}

export interface MeshLodBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export interface MeshLodMaterialSlot {
  readonly sourceKey: string;
}

export interface MeshLodRelation {
  readonly from: string;
  readonly to: string;
}

export type MeshLodContractError =
  | { readonly code: 'mesh-lod-contract-invalid'; readonly reason: string }
  | {
      readonly code: 'mesh-lod-topology-change';
      readonly reason: string;
      readonly previousIndices: readonly number[];
      readonly nextIndices: readonly number[];
    }
  | { readonly code: 'mesh-lod-authority-conflict'; readonly reason: string };

export interface ReconciledMeshLodMeta {
  readonly lods: readonly (MeshLodMetaEntry & { readonly screenCoverage: number })[];
}

/** Generate the shared first-import screen coverage defaults, including LOD0. */
export function deriveDefaultLodScreenCoverages(levelCount: number): readonly number[] {
  if (!Number.isInteger(levelCount) || levelCount < 1 || levelCount > 8) {
    throw new RangeError('levelCount must be an integer in [1, 8]');
  }
  return Array.from(
    { length: levelCount - 1 },
    (_, index) => Math.round(0.5 * 0.4 ** index * 1_000_000) / 1_000_000,
  );
}

export function validateMeshLodContract(
  input: MeshLodContractInput,
): Result<
  Readonly<{ lods: readonly Readonly<{ meshGuid: string; screenCoverage: number }>[] }>,
  MeshLodContractError
> {
  if (input.lods.length > 7) {
    return err({
      code: 'mesh-lod-contract-invalid',
      reason: 'at most seven lower-detail levels are supported',
    });
  }
  if (
    input.lodHysteresis !== undefined &&
    (!Number.isFinite(input.lodHysteresis) || input.lodHysteresis < 0 || input.lodHysteresis >= 1)
  ) {
    return err({
      code: 'mesh-lod-contract-invalid',
      reason: 'lodHysteresis must be finite and in [0, 1)',
    });
  }
  if (
    input.generation !== undefined &&
    (!Number.isSafeInteger(input.generation) || input.generation < 0)
  ) {
    return err({
      code: 'mesh-lod-contract-invalid',
      reason: 'generation must be a non-negative safe integer',
    });
  }
  const guids = new Set<string>();
  let previous = 1;
  for (const level of input.lods) {
    if (level.meshGuid.trim() === '' || guids.has(level.meshGuid)) {
      return err({
        code: 'mesh-lod-contract-invalid',
        reason: 'LOD mesh GUIDs must be unique and non-empty',
      });
    }
    if (
      !Number.isFinite(level.screenCoverage) ||
      level.screenCoverage <= 0 ||
      level.screenCoverage > 1
    ) {
      return err({
        code: 'mesh-lod-contract-invalid',
        reason: 'screenCoverage must be finite and in (0, 1]',
      });
    }
    if (level.screenCoverage >= previous) {
      return err({
        code: 'mesh-lod-contract-invalid',
        reason: 'screenCoverage must strictly decrease by level',
      });
    }
    guids.add(level.meshGuid);
    previous = level.screenCoverage;
  }
  if (input.refs !== undefined) {
    const refs = new Set(input.refs);
    for (const level of input.lods) {
      if (!refs.has(level.meshGuid)) {
        return err({
          code: 'mesh-lod-contract-invalid',
          reason: 'every lower-detail mesh GUID must be enclosed by root refs',
        });
      }
    }
  }
  if (
    input.rootMeshGuid !== undefined &&
    input.refs !== undefined &&
    !input.refs.includes(input.rootMeshGuid)
  ) {
    return err({
      code: 'mesh-lod-contract-invalid',
      reason: 'root mesh GUID must be included in refs',
    });
  }
  if (input.rootBounds !== undefined) {
    if (!validBounds(input.rootBounds)) {
      return err({
        code: 'mesh-lod-contract-invalid',
        reason: 'root bounds must be finite and ordered',
      });
    }
    for (const bounds of input.lodBounds ?? []) {
      if (!validBounds(bounds) || !encloses(input.rootBounds, bounds)) {
        return err({
          code: 'mesh-lod-contract-invalid',
          reason: 'root bounds must enclose every lower-detail bounds',
        });
      }
    }
  }
  if (input.lodBounds !== undefined && input.lodBounds.length !== input.lods.length) {
    return err({
      code: 'mesh-lod-contract-invalid',
      reason: 'lod bounds must cover every lower level',
    });
  }
  if (input.rootMaterialSlots !== undefined || input.lodMaterialSlots !== undefined) {
    const rootSlots = input.rootMaterialSlots ?? [];
    const lowerSlots = input.lodMaterialSlots ?? [];
    if (
      lowerSlots.length !== input.lods.length ||
      lowerSlots.some((slots) => !sameSlots(rootSlots, slots))
    ) {
      return err({
        code: 'mesh-lod-contract-invalid',
        reason: 'lower-detail material slots must preserve root sourceKey order',
      });
    }
  }
  if (input.relations !== undefined && hasCycle(input.relations)) {
    return err({ code: 'mesh-lod-contract-invalid', reason: 'LOD relations must be acyclic' });
  }
  return ok({ lods: input.lods });
}

function validBounds(bounds: MeshLodBounds): boolean {
  const [minX, minY, minZ] = bounds.min;
  const [maxX, maxY, maxZ] = bounds.max;
  return (
    [minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite) &&
    minX <= maxX &&
    minY <= maxY &&
    minZ <= maxZ
  );
}

function encloses(root: MeshLodBounds, child: MeshLodBounds): boolean {
  return (
    child.min[0] >= root.min[0] &&
    child.min[1] >= root.min[1] &&
    child.min[2] >= root.min[2] &&
    child.max[0] <= root.max[0] &&
    child.max[1] <= root.max[1] &&
    child.max[2] <= root.max[2]
  );
}

function sameSlots(
  root: readonly MeshLodMaterialSlot[],
  child: readonly MeshLodMaterialSlot[],
): boolean {
  return (
    root.length === child.length &&
    root.every((slot, index) => slot.sourceKey === child[index]?.sourceKey)
  );
}

function hasCycle(relations: readonly MeshLodRelation[]): boolean {
  const edges = new Map<string, string[]>();
  for (const relation of relations)
    edges.set(relation.from, [...(edges.get(relation.from) ?? []), relation.to]);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const next of edges.get(node) ?? []) if (visit(next)) return true;
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  return [...edges.keys()].some(visit);
}

/** Preserve sidecar facts by sourceKey while permitting only suffix changes. */
export function reconcileMeshLodMeta(
  previous: readonly MeshLodMetaEntry[],
  next: readonly MeshLodMetaEntry[],
): Result<ReconciledMeshLodMeta, MeshLodContractError> {
  const overlap = Math.min(previous.length, next.length);
  for (let index = 0; index < overlap; index++) {
    const oldEntry = previous[index];
    const nextEntry = next[index];
    if (oldEntry?.sourceKey !== nextEntry?.sourceKey) {
      return err({
        code: 'mesh-lod-topology-change',
        reason: 'existing LOD source keys must remain prefix-stable',
        previousIndices: [index],
        nextIndices: [index],
      });
    }
    if (oldEntry?.meshGuid !== nextEntry?.meshGuid) {
      return err({
        code: 'mesh-lod-authority-conflict',
        reason: `sourceKey ${nextEntry?.sourceKey ?? '<missing>'} changed mesh GUID`,
      });
    }
  }
  const defaults = deriveDefaultLodScreenCoverages(next.length + 1);
  const lods = next.map((entry, index) => ({
    ...entry,
    screenCoverage: previous[index]?.screenCoverage ?? entry.screenCoverage ?? defaults[index] ?? 0,
  }));
  const valid = validateMeshLodContract({
    lods: lods.map(({ meshGuid, screenCoverage }) => ({ meshGuid, screenCoverage })),
  });
  if (!valid.ok) return valid;
  return ok({ lods });
}

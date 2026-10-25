import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { AssetHandle, MeshAsset } from '@forgeax/engine-types';
import { buildGpuDrivenDraws } from '../extract/gpu-driven';
import type { InstanceProjectionStore } from '../instances';
import type {
  GpuDrivenDrawSnapshot,
  MaterialSnapshot,
  RenderableSnapshot,
} from '../render-system-extract';
import type { extractFrames } from '../render-system-extract-tail';
import { RenderPublicationError } from './contract';
import type { PreparedRenderPublication } from './receiver';
import { renderAsset } from './resource-scope';

type DrawArtifacts = NonNullable<Parameters<typeof extractFrames>[4]>['getMaterialShaderArtifact'];

const NO_LODS: readonly (MeshAsset | undefined)[] = Object.freeze([]);
interface DrawMemo {
  readonly draws: readonly GpuDrivenDrawSnapshot[];
  readonly artifacts: DrawArtifacts | undefined;
  /** Set for a table still missing a prepared program: valid only within that preparation. */
  readonly preparation?: object;
}
/** The current synchronous preparation; artifact readiness cannot change within it. */
let currentPreparation: object = {};
// Mesh -> deformation -> fallback -> each material snapshot -> each LOD mesh.
const drawMemos = new WeakMap<object, Map<string, WeakMap<object, unknown>>>();

function memoLeaf(
  mesh: MeshAsset,
  keys: readonly object[],
  deformation: string,
): WeakMap<object, unknown> | undefined {
  let byDeformation = drawMemos.get(mesh);
  if (byDeformation === undefined) {
    byDeformation = new Map();
    drawMemos.set(mesh, byDeformation);
  }
  let node = byDeformation.get(deformation);
  if (node === undefined) {
    node = new WeakMap();
    byDeformation.set(deformation, node);
  }
  for (const key of keys.slice(0, -1)) {
    let next = node.get(key) as WeakMap<object, unknown> | undefined;
    if (next === undefined) {
      next = new WeakMap();
      node.set(key, next);
    }
    node = next;
  }
  return node;
}

/**
 * Rows of one template share one frozen draw table: draws are a pure function
 * of the immutable Mesh, material snapshots, deformation, LOD meshes and the
 * artifact owner. A table still missing a prepared program is never shared.
 */
function sharedGpuDrivenDraws(
  mesh: MeshAsset,
  materials: readonly MaterialSnapshot[],
  fallback: MaterialSnapshot,
  deformation: 'rigid' | 'skin',
  lodMeshes: readonly (MeshAsset | undefined)[] | undefined,
  artifacts: DrawArtifacts | undefined,
): readonly GpuDrivenDrawSnapshot[] {
  const lods = lodMeshes ?? NO_LODS;
  const keys: object[] = [fallback, ...materials, ...lods.map((lod) => lod ?? NO_LODS)];
  const leaf = memoLeaf(mesh, keys, `${deformation}|${materials.length}|${lods.length}`);
  const last = keys.at(-1) as object;
  const cached = leaf?.get(last) as DrawMemo | undefined;
  if (
    cached !== undefined &&
    cached.artifacts === artifacts &&
    (cached.preparation === undefined || cached.preparation === currentPreparation)
  )
    return cached.draws;
  const built = buildGpuDrivenDraws({
    mesh,
    materials,
    fallbackMaterial: fallback,
    deformation,
    ...(artifacts === undefined ? {} : { getMaterialShaderArtifact: artifacts }),
    ...(lodMeshes === undefined ? {} : { lodMeshes }),
  });
  const complete =
    artifacts === undefined ||
    built.every((draw) => draw.prepared !== undefined || draw.preparationError !== undefined);
  const draws = Object.freeze(built.map((draw) => Object.freeze(draw)));
  // An incomplete table is shared only by the rows of this preparation (a cold
  // first frame admits every row before any program is ready); a later
  // preparation rebuilds it against the then-current artifacts.
  leaf?.set(
    last,
    complete ? { draws, artifacts } : { draws, artifacts, preparation: currentPreparation },
  );
  return draws;
}

/** Resolve GPU ownership after source data has crossed the publication boundary. */
export function preparePublicationGeometry(
  input: PreparedRenderPublication,
  _assets: AssetRegistry,
  instances: InstanceProjectionStore,
  getMaterialShaderArtifact?: NonNullable<
    Parameters<typeof extractFrames>[4]
  >['getMaterialShaderArtifact'],
): PreparedRenderPublication {
  if (input.resources.revision !== input.packet.revision)
    throw new RenderPublicationError({
      reason: 'revision',
      subject: 'stale prepared geometry input',
    });
  currentPreparation = {};
  const replacements = new Map<number, RenderableSnapshot>();
  for (const operation of input.operations) {
    if (operation.kind !== 'remove' && operation.snapshot === undefined) continue;
    if (operation.kind === 'remove' || operation.snapshot?.instances === undefined)
      instances.release(input.resources, operation.entityKey);
  }
  for (const row of input.frame.renderables) {
    const projected =
      row.instances === undefined
        ? undefined
        : instances.project(input.resources, row.entityKey, row.instances.transforms);
    if (projected instanceof Error) throw projected;
    const projectedInstances =
      projected === undefined || row.instances === undefined
        ? undefined
        : { ...row.instances, ...projected, archVersion: 0 };
    if (projected !== undefined) instances.accept(input.resources, row.entityKey, projected);
    if (row.assetHandle === undefined || row.pointsLines !== undefined) {
      replacements.set(
        row.entityKey,
        projectedInstances === undefined ? { ...row } : { ...row, instances: projectedInstances },
      );
      continue;
    }
    const mesh = input.resources.resolveAsset<MeshAsset>(row.assetHandle as AssetHandle<'mesh'>);
    if (!mesh.ok) throw mesh.error;
    const gpuDrivenDraws = sharedGpuDrivenDraws(
      mesh.value,
      row.materials.map((material) => material.snapshot),
      row.material.snapshot,
      row.skinBinding === undefined ? 'rigid' : 'skin',
      row.lods?.map((lod) => renderAsset<MeshAsset>(input.resources, lod.mesh)),
      getMaterialShaderArtifact,
    );
    // One copy per row: the projected instances and draw table join in a single spread.
    const prepared: RenderableSnapshot =
      projectedInstances === undefined
        ? { ...row, gpuDrivenDraws }
        : { ...row, instances: projectedInstances, gpuDrivenDraws };
    replacements.set(row.entityKey, prepared);
  }
  return {
    ...input,
    frame: { ...input.frame, renderables: [...replacements.values()] },
    operations: input.operations.map((operation) =>
      operation.kind !== 'remove' && operation.snapshot !== undefined
        ? { ...operation, snapshot: replacements.get(operation.entityKey) as RenderableSnapshot }
        : operation,
    ),
  };
}

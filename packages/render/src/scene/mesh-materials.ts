import type { MaterialCookRasterContext } from '@forgeax/engine-pack/material-cook';
import { MaterialResource } from '../material-resource';
import type { MeshMaterialBindingSource } from '../mesh-material-bindings';
import { defaultMaterialSnapshot, type RenderableSnapshot } from '../render-system-extract';
import type { MeshGeometry } from './mesh-frame';

export const defaultMeshMaterial = MaterialResource.from(defaultMaterialSnapshot());
type Overrides = readonly (MaterialResource | undefined)[];
interface TupleNode {
  readonly children: WeakMap<MaterialResource, TupleNode>;
  empty?: TupleNode;
  value?: Overrides;
}
const tuples: TupleNode = { children: new WeakMap(), value: Object.freeze([]) };

/** Bind-time interning makes equal authored bindings share one table across entities. */
export function captureMaterialOverrides(values: Overrides): Overrides {
  let length = values.length;
  while (length > 0 && values[length - 1] === undefined) length--;
  let node = tuples;
  for (let index = 0; index < length; index++) {
    const material = values[index];
    let child = material === undefined ? node.empty : node.children.get(material);
    if (child === undefined) {
      child = { children: new WeakMap() };
      if (material === undefined) node.empty = child;
      else node.children.set(material, child);
    }
    node = child;
  }
  node.value ??= Object.freeze(values.slice(0, length));
  return node.value;
}

interface EffectiveMeshMaterials {
  readonly material: MaterialResource;
  readonly materials: readonly MaterialResource[];
  readonly materialBindingSources: readonly MeshMaterialBindingSource[];
}
export type MeshMaterialGeometry = MaterialCookRasterContext['geometry'];
export type MeshMaterialResolver = (
  worldId: number,
  handle: number,
  geometry: MeshMaterialGeometry,
  vertexColor: boolean,
) => MaterialResource;
const bindings = new WeakMap<
  MeshGeometry,
  WeakMap<Overrides, Map<MeshMaterialGeometry, EffectiveMeshMaterials>>
>();

/** Bounds-only versions retain their already prepared immutable binding table. */
export function retainMeshMaterialBindings(previous: MeshGeometry, next: MeshGeometry): void {
  const table = bindings.get(previous);
  if (table !== undefined) bindings.set(next, table);
}

export function meshMaterialGeometry(
  source: Pick<RenderableSnapshot, 'skin' | 'skinPose' | 'spriteInstances'>,
): MeshMaterialGeometry {
  return source.skin !== undefined || source.skinPose !== undefined
    ? 'skinned'
    : source.spriteInstances !== undefined
      ? 'sprite-instances'
      : 'mesh';
}

/** Query-local writes become visible only after the complete source fence passes. */
export interface MeshMaterialBindingWrite {
  readonly contexts: Map<MeshMaterialGeometry, EffectiveMeshMaterials>;
  readonly geometry: MeshMaterialGeometry;
  readonly value: EffectiveMeshMaterials;
}

/** Prepare one actual shared Pass expression before any fixed-frame consumers run. */
export function prepareMeshMaterialBindings(
  source: Parameters<typeof effectiveMeshMaterials>[0],
  mesh: MeshGeometry,
  geometry: MeshMaterialGeometry,
  resolve: MeshMaterialResolver,
  pending: MeshMaterialBindingWrite[],
): EffectiveMeshMaterials {
  return meshMaterials(source, mesh, geometry, resolve, pending);
}

/** Actual draw/Pass assembly resolves one shared binding against one fixed Mesh version. */
export function effectiveMeshMaterials(
  source: Pick<
    RenderableSnapshot,
    'material' | 'materials' | 'materialBindingSources' | 'materialOverrides'
  >,
  mesh: MeshGeometry,
  geometry: MeshMaterialGeometry = 'mesh',
): EffectiveMeshMaterials {
  return meshMaterials(source, mesh, geometry);
}

function meshMaterials(
  source: Parameters<typeof effectiveMeshMaterials>[0],
  mesh: MeshGeometry,
  geometry: MeshMaterialGeometry,
  resolve?: MeshMaterialResolver,
  pending?: MeshMaterialBindingWrite[],
): EffectiveMeshMaterials {
  const overrides = source.materialOverrides;
  if (overrides === undefined) return source;
  let versions = bindings.get(mesh);
  if (versions === undefined) {
    versions = new WeakMap();
    bindings.set(mesh, versions);
  }
  let contexts = versions.get(overrides);
  if (contexts === undefined) {
    contexts = new Map();
    versions.set(overrides, contexts);
  }
  const cached = resolve === undefined ? contexts.get(geometry) : undefined;
  if (cached !== undefined) return cached;
  const materials: MaterialResource[] = [];
  const materialBindingSources: MeshMaterialBindingSource[] = [];
  for (let index = 0; index < mesh.materialSlots.length; index++) {
    const override = overrides[index];
    let material = override ?? mesh.materials[index] ?? defaultMeshMaterial;
    if (resolve !== undefined) {
      const handle =
        override?.snapshot.materialHandle ?? mesh.materialSlots[index]?.defaultMaterial;
      material =
        typeof handle === 'number' && handle !== 0
          ? resolve(
              mesh.worldId,
              handle,
              geometry,
              mesh.layout.attributes.some((attribute) => attribute.key === 'color'),
            )
          : defaultMeshMaterial;
    }
    materials.push(material);
    materialBindingSources.push(
      override !== undefined
        ? 'renderer-override'
        : mesh.materialSlots[index]?.defaultMaterial === undefined
          ? 'engine-default'
          : 'mesh-default',
    );
  }
  const result = Object.freeze({
    material: materials[0] ?? defaultMeshMaterial,
    materials: Object.freeze(materials),
    materialBindingSources: Object.freeze(materialBindingSources),
  });
  if (pending === undefined) contexts.set(geometry, result);
  else pending.push({ contexts, geometry, value: result });
  return result;
}

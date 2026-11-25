import { vertexLayoutHasColor } from '@forgeax/engine-geometry';
import type { MaterialCookRasterContext } from '@forgeax/engine-pack/material-cook';
import { MaterialResource } from '../material-resource';
import type { MeshMaterialBindingSource } from '../mesh-material-bindings';
import { defaultMaterialSnapshot, type RenderableSnapshot } from '../render-system-extract';
import { identityOrdinal } from './generational-weak-map';
import type { MeshGeometry } from './mesh-frame';

export const defaultMeshMaterial = MaterialResource.from(defaultMaterialSnapshot());
type Overrides = readonly (MaterialResource | undefined)[];
const emptyOverrides: Overrides = Object.freeze([]);
const singleOverrides = new WeakMap<MaterialResource, Overrides>();
type MaterialSlotKey = number | string;
type MaterialSlots = Map<MaterialSlotKey, WeakRef<Overrides>>;
// A live composite holds its address table. Keeping the underlying assets loaded
// does not keep any composite or its per-Mesh resolved binding alive.
const issuedOverrides = new WeakMap<Overrides, MaterialSlots>();
const slotsByLastMaterial = new WeakMap<MaterialResource, WeakRef<MaterialSlots>>();
const retiredOverrides = new FinalizationRegistry<{
  slots: WeakRef<MaterialSlots>;
  key: MaterialSlotKey;
  row: WeakRef<Overrides>;
}>(({ slots, key, row }) => {
  const table = slots.deref();
  if (table?.get(key) === row) table.delete(key);
});

/** A two-slot binding has one numeric prefix. Delimit each additional physical slot. */
function overridePrefix(values: Overrides, end: number): MaterialSlotKey {
  const first = values[0];
  let key: MaterialSlotKey = first === undefined ? 0 : identityOrdinal(first);
  for (let index = 1; index < end; index++) {
    const value = values[index];
    key = `${key},${value === undefined ? 0 : identityOrdinal(value)}`;
  }
  return key;
}

/** Bind-time interning makes equal authored bindings share one table across entities. */
export function captureMaterialOverrides(values: Overrides): Overrides {
  let length = values.length;
  if (length > 1 && issuedOverrides.has(values)) return values;
  while (length > 0 && values[length - 1] === undefined) length--;
  if (length === 0) return emptyOverrides;
  const last = values[length - 1] as MaterialResource;
  if (length === 1) {
    let single = singleOverrides.get(last);
    if (single === undefined) {
      single = Object.freeze([last]);
      singleOverrides.set(last, single);
    }
    return single;
  }
  let owner = slotsByLastMaterial.get(last);
  let table = owner?.deref();
  if (table === undefined || owner === undefined) {
    table = new Map();
    owner = new WeakRef(table);
    slotsByLastMaterial.set(last, owner);
  }
  // The final material selects the table. The prefix names each physical slot,
  // including missing overrides. Ordinals are positive and never name gaps.
  const key = overridePrefix(values, length - 1);
  const present = table.get(key)?.deref();
  if (present !== undefined) return present;
  const row = Object.freeze(values.slice(0, length));
  const ref = new WeakRef(row);
  table.set(key, ref);
  issuedOverrides.set(row, table);
  retiredOverrides.register(row, { slots: owner, key, row: ref });
  return row;
}

export interface EffectiveMeshMaterials {
  readonly material: MaterialResource;
  readonly materials: readonly MaterialResource[];
  readonly materialBindingSources: readonly MeshMaterialBindingSource[];
}

const EMPTY_COLUMN: readonly never[] = Object.freeze([]);

/** A new immutable column needs its accepted prefix only on the first differing slot. */
function copyBindingPrefix<T>(fixed: readonly T[], count: number, end: number): T[] {
  const next = new Array<T>(count);
  for (let index = 0; index < end; index++) next[index] = fixed[index] as T;
  return next;
}
export type MeshMaterialGeometry = MaterialCookRasterContext['geometry'];
export type MeshMaterialResolver = (
  handle: number,
  geometry: MeshMaterialGeometry,
  vertexColor: boolean,
) => MaterialResource;
type BindingContexts = Record<MeshMaterialGeometry, EffectiveMeshMaterials | undefined>;
type BindingVersions = WeakMap<Overrides, BindingContexts>;
interface BindingTable {
  versions: BindingVersions;
}
const bindings = new WeakMap<MeshGeometry, BindingTable>();

function bindingTable(mesh: MeshGeometry): BindingTable {
  let table = bindings.get(mesh);
  if (table === undefined) {
    table = { versions: new WeakMap() };
    bindings.set(mesh, table);
  }
  return table;
}

function bindingContexts(versions: BindingVersions, overrides: Overrides): BindingContexts {
  let contexts = versions.get(overrides);
  if (contexts === undefined) {
    contexts = {
      mesh: undefined,
      skinned: undefined,
      sprite: undefined,
      'sprite-instances': undefined,
      terrain: undefined,
    };
    versions.set(overrides, contexts);
  }
  return contexts;
}

/** Bounds-only versions retain their already prepared immutable binding table. */
export function retainMeshMaterialBindings(previous: MeshGeometry, next: MeshGeometry): void {
  const table = bindings.get(previous);
  if (table !== undefined) bindingTable(next).versions = table.versions;
}

/** An admitted draw addresses one context for its lifetime. Fenced material writes
 * update this context in place. A bounds-only mesh can adopt another versions table. */
export class BoundMeshMaterials {
  private readonly table: BindingTable;
  private versions: BindingVersions;
  private contexts: BindingContexts;

  constructor(
    readonly mesh: MeshGeometry,
    private readonly overrides: Overrides,
    private readonly geometry: MeshMaterialGeometry,
  ) {
    this.table = bindingTable(mesh);
    this.versions = this.table.versions;
    this.contexts = bindingContexts(this.versions, overrides);
  }

  read(): EffectiveMeshMaterials {
    if (this.versions !== this.table.versions) {
      this.versions = this.table.versions;
      this.contexts = bindingContexts(this.versions, this.overrides);
    }
    return (
      this.contexts[this.geometry] ??
      buildMeshMaterials(this.mesh, this.geometry, this.overrides, this.contexts)
    );
  }
}

export function meshMaterialGeometry(
  source: Pick<RenderableSnapshot, 'skinBinding' | 'spriteInstances'>,
): MeshMaterialGeometry {
  return source.skinBinding !== undefined
    ? 'skinned'
    : source.spriteInstances !== undefined
      ? 'sprite-instances'
      : 'mesh';
}

/** Query-local writes become visible only after the complete source fence passes. */
export interface MeshMaterialBindingWrite {
  readonly contexts: BindingContexts;
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
  const overrides = source.materialOverrides;
  if (overrides === undefined) return source;
  const contexts = bindingContexts(bindingTable(mesh).versions, overrides);
  return buildMeshMaterials(
    mesh,
    geometry,
    overrides,
    contexts,
    contexts[geometry],
    resolve,
    pending,
  );
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
  const overrides = source.materialOverrides;
  if (overrides === undefined) return source;
  const contexts = bindingContexts(bindingTable(mesh).versions, overrides);
  return contexts[geometry] ?? buildMeshMaterials(mesh, geometry, overrides, contexts);
}

/** Numeric asset identity consulted by a geometry-specific material resolver. */
export function meshMaterialSourceHandle(
  mesh: MeshGeometry,
  index: number,
  override: MaterialResource | undefined,
): number | undefined {
  const handle = override?.snapshot.materialHandle ?? mesh.materialSlots[index]?.defaultMaterial;
  return typeof handle === 'number' && handle !== 0 ? handle : undefined;
}

function writeBindingValue<T>(
  fixed: readonly T[],
  output: T[] | undefined,
  count: number,
  index: number,
  value: T,
): T[] | undefined {
  if (output === undefined) {
    if (fixed[index] === value) return undefined;
    output = copyBindingPrefix(fixed, count, index);
  }
  output[index] = value;
  return output;
}

function bindingSource(
  mesh: MeshGeometry,
  override: MaterialResource | undefined,
  index: number,
): MeshMaterialBindingSource {
  if (override !== undefined) return 'renderer-override';
  return mesh.materialSlots[index]?.defaultMaterial === undefined
    ? 'engine-default'
    : 'mesh-default';
}

function buildMeshMaterials(
  mesh: MeshGeometry,
  geometry: MeshMaterialGeometry,
  overrides: Overrides,
  contexts: BindingContexts,
  cached?: EffectiveMeshMaterials,
  resolve?: MeshMaterialResolver,
  pending?: MeshMaterialBindingWrite[],
): EffectiveMeshMaterials {
  const count = mesh.materialSlots.length;
  const fixedMaterials = cached?.materials ?? EMPTY_COLUMN;
  const fixedSources = cached?.materialBindingSources ?? EMPTY_COLUMN;
  let materials: MaterialResource[] | undefined =
    fixedMaterials.length === count ? undefined : new Array(count);
  let sources: MeshMaterialBindingSource[] | undefined =
    fixedSources.length === count ? undefined : new Array(count);
  let vertexColor: boolean | undefined;
  for (let index = 0; index < count; index++) {
    const override = overrides[index];
    let material: MaterialResource;
    if (resolve === undefined) material = override ?? mesh.materials[index] ?? defaultMeshMaterial;
    else {
      const handle = meshMaterialSourceHandle(mesh, index, override);
      if (handle === undefined) material = defaultMeshMaterial;
      else {
        vertexColor ??= vertexLayoutHasColor(mesh.layout);
        material = resolve(handle, geometry, vertexColor);
      }
    }
    materials = writeBindingValue(fixedMaterials, materials, count, index, material);
    sources = writeBindingValue(
      fixedSources,
      sources,
      count,
      index,
      bindingSource(mesh, override, index),
    );
  }
  // Membership-only queries still resolve the current source, but an unchanged
  // binding must retain the draw/GPU projection identity shared by its instances.
  if (cached !== undefined && materials === undefined && sources === undefined) return cached;
  const selected = materials === undefined ? fixedMaterials : Object.freeze(materials);
  const result = Object.freeze({
    material: selected[0] ?? defaultMeshMaterial,
    materials: selected,
    materialBindingSources: sources === undefined ? fixedSources : Object.freeze(sources),
  });
  if (pending === undefined) contexts[geometry] = result;
  else pending.push({ contexts, geometry, value: result });
  return result;
}

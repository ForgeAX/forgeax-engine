import { derive } from '@forgeax/engine-types';
import type { MaterialResource } from '../material-resource';
import { isCanonicalStandardPbrMaterialShader } from '../pbr-pipeline';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import type { MaterialFrame } from '../scene/material-dispatch';

const classes = new WeakMap<MaterialSnapshot, string | null>();

const sortedEntries = (map: ReadonlyMap<string, unknown> | undefined) =>
  map === undefined ? null : [...map].sort(([left], [right]) => (left < right ? -1 : 1));

const sortedFields = (fields: ReadonlySet<string> | undefined) =>
  fields === undefined ? null : [...fields].sort();

/**
 * GPU batch compatibility of a material whose numeric values live in its GPU
 * Scene material row. Every scene-index program reads its values through the
 * row's own material slot, so materials with an equal class share one batch:
 * only pipeline, bind-group and route facts separate them. Materials whose
 * bindings come from frame-published sources have no class.
 */
export function materialBatchClass(snapshot: MaterialSnapshot): string | undefined {
  const cached = classes.get(snapshot);
  if (cached !== undefined) return cached ?? undefined;
  const shader = snapshot.materialShaderId;
  const value = supportsRowMaterials(snapshot)
    ? JSON.stringify([
        shader,
        snapshot.passes,
        snapshot.materialProgramKeys ?? null,
        snapshot.materialSceneIndexProgramKeys ?? null,
        snapshot.materialSurfacePrograms ?? null,
        snapshot.materialContext ?? null,
        snapshot.renderState ?? null,
        snapshot.surfaceModel ?? null,
        snapshot.deferredPass ?? null,
        snapshot.transparent ?? null,
        snapshot.positionBounds ?? null,
        snapshot.standardTextureMask ?? null,
        snapshot.materialParamSchema === undefined
          ? null
          : derive(snapshot.materialParamSchema).layoutIdentity,
        sortedEntries(snapshot.textureHandles),
        sortedEntries(snapshot.samplerHandles),
        sortedFields(snapshot.authoredTextureFields),
        sortedFields(snapshot.authoredSamplerFields),
        [
          snapshot.baseColorTexture,
          snapshot.metallicRoughnessTexture,
          snapshot.normalTexture,
          snapshot.emissiveTexture,
          snapshot.occlusionTexture,
        ],
        materialBatchRoute(snapshot),
      ])
    : null;
  classes.set(snapshot, value);
  return value ?? undefined;
}

/** Only canonical scene-index materials with retained bindings share numeric rows. */
function supportsRowMaterials(snapshot: MaterialSnapshot): boolean {
  return (
    (snapshot.textureSources?.size ?? 0) === 0 &&
    (snapshot.videoTextureFields?.size ?? 0) === 0 &&
    (isCanonicalStandardPbrMaterialShader(snapshot.materialShaderId) ||
      snapshot.materialShaderId === 'forgeax::default-unlit')
  );
}

/** Numeric values matter to membership only when they select a different route. */
function materialBatchRoute(snapshot: MaterialSnapshot): readonly (boolean | null)[] {
  const values = snapshot.paramSnapshot;
  return [
    Number(values?.alphaCutoff ?? 0) > 0,
    Number(values?.alphaHash ?? 0) > 0.5,
    values?.transmission === undefined ? null : Number(values.transmission) > 0,
  ];
}

type RowMaterialSource = Pick<
  RenderableSnapshot,
  'material' | 'materials' | 'materialOverrides' | 'materialBindingSources'
>;

/**
 * The material a row addresses through its own GPU Scene material slot: the
 * single override, or the material an explicit table repeats in every slot.
 * Other slots of a one-entry override are the Mesh defaults, shared by the key.
 */
export function rowMaterialResource(snapshot: RowMaterialSource): MaterialResource | undefined {
  const overrides = snapshot.materialOverrides;
  if (overrides !== undefined) return overrides.length === 1 ? overrides[0] : undefined;
  const material = snapshot.material;
  return snapshot.materials.every((other) => other === material) ? material : undefined;
}

/** Binding-source signature of a row; sources are a closed comma-free union. */
export function rowMaterialSourcesKey(
  sources: RenderableSnapshot['materialBindingSources'],
): string {
  return sources.length === 1 ? (sources[0] as string) : sources.join(',');
}

const rowClassText = (materialClass: string, sources: string) =>
  JSON.stringify([materialClass, sources]);

/** Whether draw `materialSlot` of a row-material row reads the member's own material slot. */
export function rowMaterialSlot(
  snapshot: Pick<RenderableSnapshot, 'materialOverrides'>,
  materialSlot: number,
): boolean {
  return materialSlot === 0 || snapshot.materialOverrides === undefined;
}

/** Materials of one class sharing row-material batches under a stable text. */
export interface RowMaterialGroup {
  readonly text: string;
  /** Retained binding-source signature that already partitions this group. */
  readonly sources: string;
  /** Row count by material; a batch's binding answers ownership through it. */
  readonly rows: ReadonlyMap<MaterialResource, number>;
}

interface RowGroup extends RowMaterialGroup {
  /** Current class; new rows of an unheld material join the group holding it. */
  rowClass: string;
  readonly rows: Map<MaterialResource, number>;
}

interface BatchMaterials<Binding> {
  representative: MaterialResource;
  readonly members: Map<MaterialResource, { readonly binding: Binding; count: number }>;
}

interface RowMember {
  readonly material: MaterialResource;
  readonly group: RowGroup;
}

let nextGroup = 0;

/**
 * Members of row-material batches by material. Rows join the one group of
 * their class and keep it under a stable text: a group whose only material
 * changes class follows that material without moving rows; a material that
 * shares its group, or whose new class already has one, moves exactly its own
 * rows. Groups persist for reuse, so their count is bounded by the classes
 * seen. A batch binds one held material for its pipeline and bind-group facts;
 * when that material's last member leaves, another held material takes over.
 */
export class RowMaterialMembers<Batch extends object, Binding> {
  private readonly bySlot: (RowMember | undefined)[] = [];
  private readonly slots = new Map<MaterialResource, Set<number>>();
  private readonly groups = new Map<string, RowGroup>();
  private readonly joinable = new Map<string, RowGroup>();
  private readonly groupOf = new Map<MaterialResource, Map<string, RowGroup>>();
  private readonly batches = new WeakMap<Batch, BatchMaterials<Binding>>();
  private materials: MaterialFrame | undefined;

  /** Group of a row, or `undefined` for a per-material row. */
  group(snapshot: RowMaterialSource): RowMaterialGroup | undefined {
    const material = rowMaterialResource(snapshot);
    const materialClass =
      material === undefined ? undefined : materialBatchClass(material.snapshot);
    if (material === undefined || materialClass === undefined) return undefined;
    const sources = rowMaterialSourcesKey(snapshot.materialBindingSources);
    const rowClass = rowClassText(materialClass, sources);
    const held = this.groupOf.get(material)?.get(sources);
    if (held !== undefined) return held;
    let group = this.joinable.get(rowClass);
    if (group === undefined) {
      group = { text: JSON.stringify(['row', nextGroup++]), sources, rowClass, rows: new Map() };
      this.joinable.set(rowClass, group);
      this.groups.set(group.text, group);
    }
    return group;
  }

  materialOf(slot: number): MaterialResource | undefined {
    return this.bySlot[slot]?.material;
  }

  /** Register row `slot` of `batch` under the group `text` returned for `snapshot`. */
  add(
    batch: Batch,
    slot: number,
    snapshot: RowMaterialSource,
    binding: Binding,
    text: string,
  ): void {
    const material = rowMaterialResource(snapshot);
    const group = this.groups.get(text);
    if (material === undefined || group === undefined)
      throw new Error('Missing row-material group');
    group.rows.set(material, (group.rows.get(material) ?? 0) + 1);
    let held = this.groupOf.get(material);
    if (held === undefined) {
      held = new Map();
      this.groupOf.set(material, held);
    }
    held.set(group.sources, group);
    let state = this.batches.get(batch);
    if (state === undefined) {
      state = { representative: material, members: new Map() };
      this.batches.set(batch, state);
    }
    let member = state.members.get(material);
    if (member === undefined) {
      member = { binding, count: 0 };
      state.members.set(material, member);
    }
    member.count++;
    this.bySlot[slot] = { material, group };
    let slots = this.slots.get(material);
    if (slots === undefined) {
      slots = new Set();
      this.slots.set(material, slots);
    }
    slots.add(slot);
  }

  /** Forget `slot`; returns the binding of the batch's new representative, if it changed. */
  remove(batch: Batch, slot: number): Binding | undefined {
    const member = this.bySlot[slot];
    if (member === undefined) return undefined;
    this.bySlot[slot] = undefined;
    return this.release(batch, slot, member);
  }

  /** A row of the same batch now addresses `material`; the binding follows a held material. */
  retarget(
    batch: Batch,
    slot: number,
    snapshot: RowMaterialSource,
    binding: Binding,
    text: string,
  ): Binding | undefined {
    const previous = this.bySlot[slot];
    if (previous?.material === rowMaterialResource(snapshot)) return undefined;
    this.add(batch, slot, snapshot, binding, text);
    return previous === undefined ? undefined : this.release(batch, slot, previous);
  }

  private release(batch: Batch, slot: number, { material, group }: RowMember): Binding | undefined {
    const slots = this.slots.get(material);
    slots?.delete(slot);
    if (slots?.size === 0) this.slots.delete(material);
    const rows = (group.rows.get(material) ?? 0) - 1;
    if (rows > 0) group.rows.set(material, rows);
    else {
      group.rows.delete(material);
      const held = this.groupOf.get(material);
      if (held?.get(group.sources) === group) held.delete(group.sources);
      if (held?.size === 0) this.groupOf.delete(material);
    }
    const state = this.batches.get(batch);
    const member = state?.members.get(material);
    if (state === undefined || member === undefined || --member.count > 0) return undefined;
    state.members.delete(material);
    if (state.representative !== material) return undefined;
    const next = state.members.entries().next();
    if (next.done) return undefined;
    state.representative = next.value[0];
    return next.value[1].binding;
  }

  /**
   * Adopt a material frame; returns the rows that must leave their group
   * because their material changed class while sharing it.
   */
  adopt(materials: MaterialFrame): readonly number[] {
    const previous = this.materials;
    this.materials = materials;
    if (previous === undefined || previous === materials || this.groupOf.size === 0) return [];
    const moved: number[] = [];
    materials.changesSince(previous, (before, after) => {
      if (before === undefined || after === undefined) return;
      const held = this.groupOf.get(after.resource);
      const next = materialBatchClass(after.snapshot);
      if (held === undefined || materialBatchClass(before.snapshot) === next) return;
      let move = false;
      for (const [sources, group] of held) {
        const rowClass = next === undefined ? undefined : rowClassText(next, sources);
        if (rowClass !== undefined && group.rows.size === 1 && !this.joinable.has(rowClass)) {
          this.reclass(group, rowClass);
          continue;
        }
        held.delete(sources);
        move = true;
      }
      if (held.size === 0) this.groupOf.delete(after.resource);
      if (move) moved.push(...(this.slots.get(after.resource) ?? []));
    });
    return moved;
  }

  private reclass(group: RowGroup, rowClass: string): void {
    this.joinable.delete(group.rowClass);
    group.rowClass = rowClass;
    this.joinable.set(rowClass, group);
  }

  clear(): void {
    this.bySlot.length = 0;
    this.slots.clear();
    this.groups.clear();
    this.joinable.clear();
    this.groupOf.clear();
    this.materials = undefined;
  }
}

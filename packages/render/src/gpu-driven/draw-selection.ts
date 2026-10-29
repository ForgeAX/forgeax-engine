import type { PassKind } from '@forgeax/engine-types';
import { gpuDrivenSourceDrawItemIndex } from '../extract/gpu-driven';
import type { MaterialResource } from '../material-resource';
import type { RenderPipelineGpuDrivenFilter } from '../render-pipeline';
import type { GpuDrivenDrawSnapshot, RenderableSnapshot } from '../render-system-extract';
import type { FrameList } from '../scene/frame-list';
import { MemberCandidates } from './batch-members';
import {
  type GpuDrivenBatch,
  type GpuDrivenBatchBinding,
  gpuDrivenGeometryEligible,
} from './batch-topology';
import { gpuRasterFilterMatches, gpuTemporalEligible } from './raster-selection';
import {
  type RowMaterialGroup,
  rowMaterialResource,
  rowMaterialSlot,
  rowMaterialSourcesKey,
} from './row-materials';

type Draws = Map<number, readonly GpuDrivenBatch[]>;
type Meshes = Map<number, Draws>;
type Worlds = Map<number, Meshes>;

function sameGeometry(
  source: RenderableSnapshot,
  draw: GpuDrivenDrawSnapshot,
  binding: GpuDrivenBatchBinding,
): boolean {
  const accepted = binding.geometry,
    geometry = draw.geometry;
  return (
    accepted.receipt.identity === geometry.receipt.identity &&
    accepted.deformation === geometry.deformation &&
    accepted.draw.kind === geometry.draw.kind &&
    accepted.draw.first === geometry.draw.first &&
    accepted.draw.count === geometry.draw.count &&
    accepted.draw.baseVertex === geometry.draw.baseVertex &&
    accepted.draw.topology === geometry.draw.topology &&
    // Morphed members draw LOD0 only.
    (source.morph === undefined
      ? binding.morph === undefined &&
        (binding.lods?.length ?? 0) === (source.lods?.length ?? 0) &&
        (binding.lods === undefined ||
          binding.lods.every((asset, index) => asset === source.lods?.[index]?.mesh))
      : binding.morph === true)
  );
}

/** A row-material binding answers through its group for every material the group holds. */
function selectionKey(binding: GpuDrivenBatchBinding): MaterialResource | RowMaterialGroup {
  return binding.rowGroup ?? binding.material;
}

const MASK_DRAWS = 31;
const MASK_COMPUTED = 1 << 31;
const MASK_DRAWS_ALL = 0x7fffffff;

/** Shared execution membership, queried by the draw that is about to consume it. */
export class GpuDrawSelection {
  /** Source-addressed index by material, or by group for row-material batches. */
  #materials: Map<MaterialResource | RowMaterialGroup, Worlds> | undefined;
  /** Row-material groups of the index; one per batch class. */
  readonly #groups: RowMaterialGroup[] = [];
  /** Owned executions per shared binding; selections diff these to retain derived answers. */
  readonly #byBinding = new Map<GpuDrivenBatchBinding, GpuDrivenBatch[]>();
  /** Weakly keyed: a selection never keeps an earlier selection (or its plan) reachable. */
  readonly #changes = new WeakMap<GpuDrawSelection, ReadonlySet<GpuDrivenBatchBinding>>();

  constructor(batches: FrameList<GpuDrivenBatch>) {
    for (const batch of batches) {
      if (batch.visibleCapacity === 0) continue;
      const binding = batch.binding;
      if (binding === undefined)
        throw new Error('GPU draw selection requires a shared geometry binding');
      const owned = this.#byBinding.get(binding);
      if (owned === undefined) this.#byBinding.set(binding, [batch]);
      else owned.push(batch);
    }
  }

  /**
   * Bindings whose owned executions differ from an earlier selection. Every
   * binding-keyed answer of this selection depends only on that binding's
   * executions, so consumers retain all other answers across a replacement.
   */
  changedBindingsSince(previous: GpuDrawSelection): ReadonlySet<GpuDrivenBatchBinding> {
    const cached = this.#changes.get(previous);
    if (cached !== undefined) return cached;
    const changed = new Set<GpuDrivenBatchBinding>();
    for (const [binding, owned] of this.#byBinding) {
      const before = previous.#byBinding.get(binding);
      if (
        before === undefined ||
        before.length !== owned.length ||
        before.some((batch, index) => batch !== owned[index])
      )
        changed.add(binding);
    }
    for (const binding of previous.#byBinding.keys())
      if (!this.#byBinding.has(binding)) changed.add(binding);
    this.#changes.set(previous, changed);
    return changed;
  }

  private get materials(): Map<MaterialResource | RowMaterialGroup, Worlds> {
    if (this.#materials !== undefined) return this.#materials;
    const materials = new Map<MaterialResource | RowMaterialGroup, Worlds>();
    for (const owned of this.#byBinding.values())
      for (const batch of owned) {
        const binding = batch.binding as GpuDrivenBatchBinding;
        const key = selectionKey(binding);
        let worlds = materials.get(key);
        if (worlds === undefined) {
          worlds = new Map();
          materials.set(key, worlds);
          if (binding.rowGroup !== undefined) this.#groups.push(binding.rowGroup);
        }
        let meshes = worlds.get(binding.worldId);
        if (meshes === undefined) {
          meshes = new Map();
          worlds.set(binding.worldId, meshes);
        }
        let draws = meshes.get(binding.assetHandle);
        if (draws === undefined) {
          draws = new Map();
          meshes.set(binding.assetHandle, draws);
        }
        // Arrays are private to this selection and complete before any query.
        const selected = draws.get(binding.drawItemIndex) as GpuDrivenBatch[] | undefined;
        if (selected === undefined) draws.set(binding.drawItemIndex, [batch]);
        else selected.push(batch);
      }
    this.#materials = materials;
    return materials;
  }

  /** No binding executes: every source draw stays CPU-recorded. */
  get empty(): boolean {
    return this.#byBinding.size === 0;
  }

  /**
   * Materials of executed bindings by World; their readiness covers every
   * owned draw. A row-material batch's members share its texture bindings.
   */
  coveredBindings(): Iterable<GpuDrivenBatchBinding> {
    return this.#byBinding.keys();
  }

  private batches(source: RenderableSnapshot, draw: GpuDrivenDrawSnapshot, compactIndex: number) {
    if (source.assetHandle === undefined) return undefined;
    const material = source.materials[draw.materialSlot] ?? source.material;
    // Like a material batch, a group answers for every draw of a material it holds.
    const rowMaterial = rowMaterialSlot(source, draw.materialSlot)
      ? (rowMaterialResource(source) ?? material)
      : undefined;
    const materials = this.materials;
    let group: RowMaterialGroup | undefined;
    if (rowMaterial !== undefined) {
      // Most materials sit in one group; derive the source signature only on a membership hit.
      let sources: string | undefined;
      for (const candidate of this.#groups) {
        if (!candidate.rows.has(rowMaterial)) continue;
        sources ??= rowMaterialSourcesKey(source.materialBindingSources);
        if (candidate.sources === sources) {
          group = candidate;
          break;
        }
      }
    }
    return materials
      .get(group ?? material)
      ?.get(source.worldId)
      ?.get(source.assetHandle)
      ?.get(gpuDrivenSourceDrawItemIndex(draw, compactIndex));
  }

  /**
   * Does this selection execute a source batch's binding? Every member of an
   * uncovered binding keeps a CPU-recorded residual draw.
   */
  coversBinding(binding: GpuDrivenBatchBinding): boolean {
    const owned = this.materials
      .get(selectionKey(binding))
      ?.get(binding.worldId)
      ?.get(binding.assetHandle)
      ?.get(binding.drawItemIndex);
    return (
      owned?.some(
        (batch) =>
          batch.binding === binding ||
          (batch.binding !== undefined &&
            batch.binding.morph === binding.morph &&
            batch.binding.geometry.deformation === binding.geometry.deformation &&
            batch.binding.geometry.draw.first === binding.geometry.draw.first &&
            batch.binding.geometry.draw.count === binding.geometry.draw.count),
      ) === true
    );
  }

  /** Select accepted shared execution before reading a batch's source members. */
  ownsBinding(
    binding: GpuDrivenBatchBinding,
    passKind: PassKind,
    filter: RenderPipelineGpuDrivenFilter | undefined,
    medium: boolean,
  ): boolean {
    for (const batch of this.#byBinding.get(binding) ?? []) {
      if (!gpuRasterFilterMatches(filter, batch.key.materialPass, medium)) continue;
      if (
        passKind === 'temporal' &&
        !gpuTemporalEligible(
          batch.prepared?.identity.material,
          batch.prepared?.identity.deformation,
          batch.lod?.coverages.length ?? 0,
        )
      )
        continue;
      return true;
    }
    return false;
  }

  /**
   * Per-snapshot ownership masks. Snapshots are immutable publications and this
   * selection never changes after construction, so a pose-stable source answers
   * from one lookup instead of re-joining its draws on every frame and reader.
   */
  readonly #forwardMasks = new WeakMap<RenderableSnapshot, number>();
  readonly #temporalMasks = new WeakMap<RenderableSnapshot, number>();

  private ownsUncached(
    source: RenderableSnapshot,
    draw: GpuDrivenDrawSnapshot,
    compactIndex: number,
    passKind: PassKind,
  ): boolean {
    for (const batch of this.batches(source, draw, compactIndex) ?? [])
      if (
        batch.binding !== undefined &&
        sameGeometry(source, draw, batch.binding) &&
        (passKind !== 'temporal' ||
          gpuTemporalEligible(
            batch.prepared?.identity.material,
            batch.prepared?.identity.deformation,
            batch.lod?.coverages.length ?? 0,
          ))
      )
        return true;
    return false;
  }

  /** Bit i answers compact draw i; bit 31 marks a computed mask. */
  private ownershipMask(source: RenderableSnapshot, passKind: PassKind): number {
    const masks = passKind === 'temporal' ? this.#temporalMasks : this.#forwardMasks;
    let mask = masks.get(source);
    if (mask !== undefined) return mask;
    mask = MASK_COMPUTED;
    const draws = source.gpuDrivenDraws;
    if (draws !== undefined && gpuDrivenGeometryEligible(source))
      for (let index = 0; index < draws.length; index++) {
        const draw = draws[index];
        if (draw !== undefined && this.ownsUncached(source, draw, index, passKind))
          mask |= 1 << index;
      }
    masks.set(source, mask);
    return mask;
  }

  owns(
    source: RenderableSnapshot,
    draw: GpuDrivenDrawSnapshot,
    compactIndex: number,
    passKind: PassKind = 'forward',
  ): boolean {
    const memoized =
      compactIndex >= 0 &&
      compactIndex < MASK_DRAWS &&
      (passKind === 'forward' || passKind === 'temporal') &&
      source.gpuDrivenDraws !== undefined &&
      source.gpuDrivenDraws.length <= MASK_DRAWS &&
      source.gpuDrivenDraws[compactIndex] === draw;
    if (memoized) return (this.ownershipMask(source, passKind) & (1 << compactIndex)) !== 0;
    if (!gpuDrivenGeometryEligible(source)) return false;
    return this.ownsUncached(source, draw, compactIndex, passKind);
  }

  /** Native view ranges are ordered by slot; lookup never expands them into entity claims. */
  ownsSlot(
    source: RenderableSnapshot,
    sourceDrawIndex: number,
    slot: number,
    generation: number,
  ): boolean {
    if (!gpuDrivenGeometryEligible(source)) return false;
    const compactIndex = source.gpuDrivenDraws?.findIndex(
      (draw, index) => gpuDrivenSourceDrawItemIndex(draw, index) === sourceDrawIndex,
    );
    const draw = compactIndex === undefined ? undefined : source.gpuDrivenDraws?.[compactIndex];
    if (draw === undefined || compactIndex === undefined) return false;
    for (const batch of this.batches(source, draw, compactIndex) ?? []) {
      if (batch.binding === undefined || !sameGeometry(source, draw, batch.binding)) continue;
      const candidates = batch.candidates;
      if (MemberCandidates.is(candidates)) {
        if (MemberCandidates.prototype.containsSlot.call(candidates, slot, generation)) return true;
        continue;
      }
      let start = 0,
        end = candidates.length;
      while (start < end) {
        const middle = (start + end) >>> 1;
        const candidate = candidates.at(middle);
        if (candidate !== undefined && candidate.primitiveIndex < slot) start = middle + 1;
        else end = middle;
      }
      const candidate = candidates.at(start);
      if (candidate?.primitiveIndex === slot && candidate.generation === generation) return true;
    }
    return false;
  }

  has(source: RenderableSnapshot, drawItemIndex: number): boolean {
    const index = source.gpuDrivenDraws?.findIndex(
      (draw, index) => gpuDrivenSourceDrawItemIndex(draw, index) === drawItemIndex,
    );
    const draw = index === undefined ? undefined : source.gpuDrivenDraws?.[index];
    return draw !== undefined && index !== undefined && this.owns(source, draw, index);
  }

  ownsAll(source: RenderableSnapshot): boolean {
    const draws = source.gpuDrivenDraws;
    if (draws === undefined || draws.length === 0) return false;
    if (draws.length <= MASK_DRAWS) {
      const all = draws.length === MASK_DRAWS ? MASK_DRAWS_ALL : (1 << draws.length) - 1;
      return (this.ownershipMask(source, 'forward') & all) === all;
    }
    return draws.every((draw, index) => this.owns(source, draw, index));
  }
}

export const EMPTY_GPU_DRAW_SELECTION = new GpuDrawSelection([]);

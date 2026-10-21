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
    (binding.lods?.length ?? 0) === (source.lods?.length ?? 0) &&
    (binding.lods === undefined ||
      binding.lods.every((asset, index) => asset === source.lods?.[index]?.mesh))
  );
}

/** Shared execution membership, queried by the draw that is about to consume it. */
export class GpuDrawSelection {
  private readonly materials = new Map<MaterialResource, Worlds>();

  constructor(batches: FrameList<GpuDrivenBatch>) {
    for (const batch of batches) {
      if (batch.visibleCapacity === 0) continue;
      const binding = batch.binding;
      if (binding === undefined)
        throw new Error('GPU draw selection requires a shared geometry binding');
      let worlds = this.materials.get(binding.material);
      if (worlds === undefined) {
        worlds = new Map();
        this.materials.set(binding.material, worlds);
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
      const selected = draws.get(binding.drawItemIndex) ?? [];
      draws.set(binding.drawItemIndex, [...selected, batch]);
    }
  }

  private batches(source: RenderableSnapshot, draw: GpuDrivenDrawSnapshot, compactIndex: number) {
    if (source.assetHandle === undefined) return undefined;
    return this.materials
      .get(source.materials[draw.materialSlot] ?? source.material)
      ?.get(source.worldId)
      ?.get(source.assetHandle)
      ?.get(gpuDrivenSourceDrawItemIndex(draw, compactIndex));
  }

  /** Select accepted shared execution before reading a batch's source members. */
  ownsBinding(
    binding: GpuDrivenBatchBinding,
    passKind: PassKind,
    filter: RenderPipelineGpuDrivenFilter | undefined,
    medium: boolean,
  ): boolean {
    const batches = this.materials
      .get(binding.material)
      ?.get(binding.worldId)
      ?.get(binding.assetHandle)
      ?.get(binding.drawItemIndex);
    for (const batch of batches ?? []) {
      if (batch.binding !== binding) continue;
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

  owns(
    source: RenderableSnapshot,
    draw: GpuDrivenDrawSnapshot,
    compactIndex: number,
    passKind: PassKind = 'forward',
  ): boolean {
    if (!gpuDrivenGeometryEligible(source)) return false;
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
    return (
      draws !== undefined &&
      draws.length > 0 &&
      draws.every((draw, index) => this.owns(source, draw, index))
    );
  }
}

export const EMPTY_GPU_DRAW_SELECTION = new GpuDrawSelection([]);

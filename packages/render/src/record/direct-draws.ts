import { RhiError } from '@forgeax/engine-rhi';
import type { MeshGpuHandles } from '../device/gpu-residency';
import type { GpuDrivenBatchBinding } from '../gpu-driven/batch-topology';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import type { FrameList } from '../scene/frame-list';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import type { ValidatedRenderable } from './frame-snapshot';

function invalid(expected: string): never {
  throw new RhiError({
    code: 'rhi-descriptor-invalid',
    expected,
    hint: 'prepare direct geometry from the same Scene and material publication as GPU batches',
  });
}

/**
 * Actual CPU draw work: select the shared execution first, then visit only its
 * members. GPU batches never expose their members to this projection.
 */
export function directDrawRows(
  scene: Pick<PersistentGpuDrivenState, 'plan' | 'slotAt' | 'drawSnapshotAt' | 'unbatchedSlots'>,
  select: (binding: GpuDrivenBatchBinding) => MaterialSnapshot | undefined,
  meshes: ReadonlyMap<GpuDrivenBatchBinding, MeshGpuHandles>,
  worlds: readonly RenderResourceScope[],
  pass: string,
  prepareUnbatched: (sources: FrameList<RenderableSnapshot>) => readonly ValidatedRenderable[],
  viewDraws: FrameList<RenderableSnapshot> = [],
  prepareMaterialGeometry?: (
    mesh: MeshGpuHandles,
    material: import('../render-system-extract').MaterialSnapshot,
  ) => MeshGpuHandles,
  visible?: (source: RenderableSnapshot) => boolean,
): readonly ValidatedRenderable[] {
  const snapshotAt = scene.drawSnapshotAt ?? invalid('the Scene-owned direct draw projection');
  const rows: ValidatedRenderable[] = [];
  const bySlot = new Map<
    number,
    { readonly row: ValidatedRenderable; readonly indices: number[] }
  >();
  for (const batch of scene.plan.batches) {
    const binding = batch.binding ?? invalid('a native geometry binding for every Scene batch');
    const material = select(binding);
    if (material === undefined) continue;
    const baseMesh = meshes.get(binding) ?? invalid('resident geometry for a direct batch');
    const mesh = prepareMaterialGeometry?.(baseMesh, material) ?? baseMesh;
    const world = worlds[binding.worldId] ?? invalid('the asset scope of a direct batch');
    const members = batch.members ?? invalid('native source members for a direct batch');
    for (const member of members) {
      const slot = scene.slotAt(member.primitiveIndex);
      if (
        slot === undefined ||
        slot.generation !== member.generation ||
        slot.entityKey !== member.entityKey
      )
        invalid('a live generation for each direct batch member');
      const source = snapshotAt(slot.slot);
      if (source === undefined || visible?.(source) === false) continue;
      if (source.authorVisible === false || (pass === 'shadow' && source.shadowCaster === false))
        continue;
      if (member.instanceCount === 0) continue;
      if (source.worldId !== binding.worldId || source.assetHandle !== binding.assetHandle)
        invalid('matching source and resident mesh identities');
      const index = binding.drawItemIndex;
      if (mesh.submeshes[index] === undefined)
        invalid('the source submesh addressed by the direct batch');
      let selected = bySlot.get(slot.slot);
      if (selected === undefined) {
        const indices: number[] = [];
        const row: ValidatedRenderable = {
          source,
          world,
          mesh,
          renderableIndex: rows.length,
          meshSlot: rows.length,
          submeshIndices: indices,
          renderState: undefined,
          stencilReference: undefined,
        };
        selected = { row, indices };
        bySlot.set(slot.slot, selected);
        rows.push(row);
      } else if (selected.row.mesh !== mesh) invalid('one resident geometry per source slot');
      selected.indices.push(index);
    }
  }

  const unbatched: RenderableSnapshot[] = [];
  for (const index of scene.unbatchedSlots ??
    invalid('the Scene-owned unbatched geometry roster')) {
    if (scene.slotAt(index) === undefined) invalid('a live unbatched Scene slot');
    const source = snapshotAt(index);
    if (source === undefined || visible?.(source) === false) continue;
    // Native view owners have already projected these roots into actual draw geometry.
    if (
      source.terrain !== undefined ||
      source.glyph !== undefined ||
      source.tilemap !== undefined ||
      source.authorVisible === false ||
      source.instances?.instanceCount === 0 ||
      (pass === 'shadow' && source.shadowCaster === false)
    )
      continue;
    unbatched.push(source);
  }
  for (const source of viewDraws) {
    if (
      visible?.(source) !== false &&
      source.authorVisible !== false &&
      (pass !== 'shadow' || source.shadowCaster !== false)
    )
      unbatched.push(source);
  }
  if (unbatched.length > 0) {
    for (const row of prepareUnbatched(unbatched))
      rows.push({ ...row, renderableIndex: rows.length });
  }
  return rows;
}

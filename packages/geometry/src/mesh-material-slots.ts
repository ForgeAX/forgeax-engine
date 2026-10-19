import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  type MeshAsset,
  type MeshMaterialSlot,
  type MeshMaterialSlotReconcileResult,
  type MeshMaterialSlotTopologyEntry,
  resolveMeshMaterialSlotDefaultGuid,
} from '@forgeax/engine-types';

function runtimeSlot(
  slot: MeshMaterialSlotTopologyEntry,
  guid: string | undefined,
): MeshMaterialSlot {
  const parsed = guid === undefined ? undefined : AssetGuid.parse(guid);
  return {
    slotName: slot.slotName,
    ...(slot.sourceKey === undefined ? {} : { sourceKey: slot.sourceKey }),
    ...(parsed?.ok ? { defaultMaterial: parsed.value } : {}),
  };
}

/** Project source topology into the runtime mesh; invalid defaults remain unbound. */
export function meshMaterialSlotsFromTopology(
  slots: readonly MeshMaterialSlotTopologyEntry[],
): MeshMaterialSlot[] {
  return slots.map((slot) => runtimeSlot(slot, slot.defaultMaterialGuid));
}

export function meshMaterialSlotsToTopology(
  slots: readonly MeshMaterialSlot[],
): MeshMaterialSlotTopologyEntry[] {
  return slots.map((slot) => ({
    slotName: slot.slotName,
    ...(slot.sourceKey === undefined ? {} : { sourceKey: slot.sourceKey }),
    ...(slot.defaultMaterial === undefined
      ? {}
      : { defaultMaterialGuid: AssetGuid.format(slot.defaultMaterial) }),
  }));
}

/** Apply accepted stable indices and author defaults; removed slots stay unbound. */
export function applyMeshMaterialSlotTopology(
  mesh: MeshAsset,
  reconciled: Extract<MeshMaterialSlotReconcileResult, { ok: true }>,
  authoredDefaults?: Readonly<Record<string, unknown>>,
): MeshAsset {
  const activeSlots = new Set(reconciled.currentToStableSlot);
  return {
    ...mesh,
    submeshes: mesh.submeshes.map((submesh) => ({
      ...submesh,
      materialSlot: reconciled.currentToStableSlot[submesh.materialSlot] as number,
    })),
    materialSlots: reconciled.slots.map((slot, index) => {
      const authored = authoredDefaults?.[slot.sourceKey ?? slot.slotName];
      const effectiveDefault = activeSlots.has(index)
        ? resolveMeshMaterialSlotDefaultGuid(
            slot,
            typeof authored === 'string' || authored === null ? authored : undefined,
          )
        : undefined;
      return runtimeSlot(slot, effectiveDefault);
    }),
  };
}

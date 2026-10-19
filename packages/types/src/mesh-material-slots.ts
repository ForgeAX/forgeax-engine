import type { MeshMaterialSlotTopologyEntry } from './mesh-contracts.js';

/** Source material facts shared by mesh and sidecar producers. */
export interface MeshMaterialSlotSource {
  readonly guidByIndex?: ReadonlyMap<number, string>;
  readonly nameByIndex?: ReadonlyMap<number, string>;
  readonly sourceKeyByIndex?: ReadonlyMap<number, string>;
}

/** Assign one stable slot per source material, in first-use order. */
export function createMeshMaterialSlotTable(prefix: string, source: MeshMaterialSlotSource = {}) {
  const slots: MeshMaterialSlotTopologyEntry[] = [];
  const slotByMaterial = new Map<number | null, number>();
  const usedNames = new Set<string>();
  return {
    slots,
    slotFor(materialIndex: number | null): number {
      const existing = slotByMaterial.get(materialIndex);
      if (existing !== undefined) return existing;
      const rawName =
        materialIndex === null
          ? 'Default'
          : (source.nameByIndex?.get(materialIndex) ?? `Material_${materialIndex}`);
      const base = rawName.trim() || 'Material';
      let slotName = base;
      let suffix = 2;
      while (usedNames.has(slotName)) slotName = `${base}_${suffix++}`;
      usedNames.add(slotName);
      const defaultMaterialGuid =
        materialIndex === null ? undefined : source.guidByIndex?.get(materialIndex);
      const slot = slots.length;
      slots.push({
        slotName,
        sourceKey:
          materialIndex === null
            ? `${prefix}:default`
            : (source.sourceKeyByIndex?.get(materialIndex) ??
              `${prefix}:material:${materialIndex}`),
        ...(defaultMaterialGuid === undefined ? {} : { defaultMaterialGuid }),
      });
      slotByMaterial.set(materialIndex, slot);
      return slot;
    },
  };
}

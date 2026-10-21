import type { RenderPublication } from '@forgeax/engine-render';

/** Detach admitted material values once at native receive; templates carry only IDs. */
export function ownReceivedPublicationMaterials(packet: RenderPublication): RenderPublication {
  if (packet.materials.length === 0) return packet;
  const values = structuredClone(
    packet.materials.map(({ value }) => ({
      baseColor: value.baseColor.slice() as typeof value.baseColor,
      specularColor: value.specularColor,
      normalScale: value.normalScale,
      emissive: value.emissive,
      paramSnapshot: value.paramSnapshot,
      materialParamSchema: value.materialParamSchema,
    })),
  );
  return {
    ...packet,
    materials: packet.materials.map((material, index) => ({
      ...material,
      value: Object.freeze({ ...material.value, ...values[index], immutableValues: true as const }),
    })),
  };
}

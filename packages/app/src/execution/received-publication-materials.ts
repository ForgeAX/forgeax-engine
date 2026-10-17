import type { RenderPublication } from '@forgeax/engine-render';

/**
 * Finish the native message receiver's exclusive material values. Source
 * updates arrive as new snapshots. Detach numeric values and their ABI from
 * other packet consumers; native cloning can preserve aliases into Feature or
 * asset data in this Worker. Resource maps remain live for target/UV preparation.
 * Public Renderer/receiver inputs never pass through this constructor.
 */
export function ownReceivedPublicationMaterials(packet: RenderPublication): RenderPublication {
  if (packet.templates.length === 0) return packet;
  type Material = RenderPublication['templates'][number]['snapshot']['material'];
  const materials = new Map<Material, Material>();
  for (const { snapshot } of packet.templates) {
    materials.set(snapshot.material, snapshot.material);
    for (const material of snapshot.materials) materials.set(material, material);
  }
  const originals = [...materials.keys()];
  // One clone preserves shared parameter ABI storage between these materials,
  // without retaining aliases into the rest of the received publication.
  const values = structuredClone(
    originals.map((material) => ({
      baseColor: material.baseColor.slice() as Material['baseColor'],
      specularColor: material.specularColor,
      normalScale: material.normalScale,
      emissive: material.emissive,
      paramSnapshot: material.paramSnapshot,
      materialParamSchema: material.materialParamSchema,
    })),
  );
  for (let index = 0; index < originals.length; index++) {
    const material = originals[index];
    if (material === undefined) continue;
    materials.set(
      material,
      Object.freeze({
        ...material,
        ...values[index],
        immutableValues: true as const,
      }),
    );
  }
  const own = (material: Material): Material => materials.get(material) ?? material;
  return {
    ...packet,
    templates: packet.templates.map((template) => ({
      ...template,
      snapshot: {
        ...template.snapshot,
        material: own(template.snapshot.material),
        materials: template.snapshot.materials.map(own),
      },
    })),
  };
}

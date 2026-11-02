import { captureMaterialSnapshot } from '../material-resource';
import type { RenderPublicationMessage } from './record';

/** Detach admitted material values once at native receive; templates carry only IDs. */
export function ownReceivedPublicationMaterials(
  message: RenderPublicationMessage,
): RenderPublicationMessage {
  const side = message.side;
  const materials = side?.materials;
  if (side === undefined || materials === undefined || materials.length === 0) return message;
  const values = structuredClone(
    materials.map(({ value }) => ({
      baseColor: value.baseColor.slice() as typeof value.baseColor,
      specularColor: value.specularColor,
      normalScale: value.normalScale,
      emissive: value.emissive,
      paramSnapshot: value.paramSnapshot,
      materialParamSchema: value.materialParamSchema,
    })),
  );
  return {
    ...message,
    side: {
      ...side,
      materials: materials.map((material, index) => ({
        ...material,
        value: captureMaterialSnapshot({
          ...material.value,
          ...values[index],
        }),
      })),
    },
  };
}

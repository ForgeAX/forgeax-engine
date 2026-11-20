import { ownDetachedMaterialSnapshot } from '../material-resource';
import type { RenderPublicationMessage } from './record';

/** A Worker message already owns its cloned values. Only shared memory can still alias the sender. */
export function adoptWorkerPublicationMaterials(
  message: RenderPublicationMessage,
): RenderPublicationMessage {
  const side = message.side;
  const materials = side?.materials;
  if (side === undefined || materials === undefined || materials.length === 0) return message;
  return {
    ...message,
    side: {
      ...side,
      materials: materials.map((material) => {
        const value = material.value;
        const baseColor = value.baseColor;
        return {
          ...material,
          value: ownDetachedMaterialSnapshot(
            baseColor.buffer instanceof ArrayBuffer
              ? value
              : { ...value, baseColor: baseColor.slice() as typeof baseColor },
          ),
        };
      }),
    },
  };
}

/** Detach admitted material values and program facts at native receive; templates carry IDs. */
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
      passes: value.passes,
      materialProgramKeys: value.materialProgramKeys,
      ...(value.materialProgramInputs === undefined
        ? {}
        : { materialProgramInputs: value.materialProgramInputs }),
      materialPublication: value.materialPublication,
      ...(value.materialContext === undefined ? {} : { materialContext: value.materialContext }),
    })),
  );
  return {
    ...message,
    side: {
      ...side,
      materials: materials.map((material, index) => ({
        ...material,
        value: ownDetachedMaterialSnapshot({
          ...material.value,
          ...values[index],
          passes: values[index]?.passes ?? [],
        }),
      })),
    },
  };
}

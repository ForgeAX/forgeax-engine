import { ownDetachedMaterialSnapshot } from '../material-resource';
import type { MaterialSnapshot } from '../render-system-extract';
import type { RenderPublicationMessage } from './record';

/** The transport detached program data. Keep the received wire record intact for repeated receipts. */
export function adoptWorkerMaterialSnapshot(value: MaterialSnapshot): MaterialSnapshot {
  const baseColor = value.baseColor;
  return ownDetachedMaterialSnapshot({
    ...value,
    baseColor:
      baseColor.buffer instanceof ArrayBuffer ? baseColor : (baseColor.slice() as typeof baseColor),
  });
}

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
      materials: materials.map((material) => ({
        ...material,
        value: adoptWorkerMaterialSnapshot(material.value),
      })),
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

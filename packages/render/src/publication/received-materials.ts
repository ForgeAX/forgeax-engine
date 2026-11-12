import { internJson } from '@forgeax/engine-types';
import { captureMaterialSnapshot } from '../material-resource';
import type { RenderPublicationMessage } from './record';

function fixedJson<T>(value: T): T {
  return value !== null && typeof value === 'object' ? (internJson(value) ?? value) : value;
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
      ...(value.materialEntryPoints === undefined
        ? {}
        : { materialEntryPoints: value.materialEntryPoints }),
      materialPublication: value.materialPublication,
      ...(value.materialContext === undefined ? {} : { materialContext: value.materialContext }),
    })),
  );
  return {
    ...message,
    side: {
      ...side,
      materials: materials.map((material, index) => {
        const copied = values[index];
        return {
          ...material,
          value: captureMaterialSnapshot({
            ...material.value,
            ...copied,
            passes: fixedJson(copied?.passes ?? []),
            materialProgramKeys: fixedJson(copied?.materialProgramKeys),
            ...(copied?.materialEntryPoints === undefined
              ? {}
              : { materialEntryPoints: fixedJson(copied.materialEntryPoints) }),
            materialPublication: fixedJson(copied?.materialPublication),
            ...(copied?.materialContext === undefined
              ? {}
              : { materialContext: fixedJson(copied.materialContext) }),
          }),
        };
      }),
    },
  };
}

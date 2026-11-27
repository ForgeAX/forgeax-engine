import type { ParamSchemaEntry } from '@forgeax/engine-types';
import { isEngineOwnedMaterialShader } from './assembly/material/pipeline-helpers';
import {
  isStandardPbrMaterialShader,
  materialBindGroupLayoutIdentity,
  physicalTextureFields,
} from './pbr-pipeline';

const layouts = new WeakMap<readonly ParamSchemaEntry[], Map<string, string | undefined>>();

/** Register layout facts only for the immutable schemas admitted by Render. */
export function prepareMaterialLayoutIdentity(
  shader: string,
  schema: readonly ParamSchemaEntry[] | undefined,
): void {
  if (schema === undefined) return;
  let byShader = layouts.get(schema);
  if (byShader === undefined) {
    // The layout descriptor reads only own fields of the admitted schema.
    if (
      !Object.isFrozen(schema) ||
      !schema.every(
        (entry) =>
          Object.isFrozen(entry) &&
          Object.values(Object.getOwnPropertyDescriptors(entry)).every((field) => 'value' in field),
      )
    )
      return;
    byShader = new Map();
    layouts.set(schema, byShader);
  }
  if (!byShader.has(shader)) byShader.set(shader, effectiveMaterialLayoutIdentity(shader, schema));
}

export function preparedMaterialLayoutIdentity(
  shader: string,
  schema: readonly ParamSchemaEntry[] | undefined,
): string | undefined {
  if (schema === undefined) return undefined;
  const owned = layouts.get(schema);
  return owned?.has(shader) ? owned.get(shader) : effectiveMaterialLayoutIdentity(shader, schema);
}

/**
 * Returns the layout identity that can distinguish a material PSO in the
 * record cache. Shared boot shaders keep the boot layout identity even when a
 * manifest exposes a schema; Standard PBR only opts into a schema-derived
 * identity when authored clearcoat texture bindings extend that layout.
 */
export function effectiveMaterialLayoutIdentity(
  materialShaderId: string,
  materialParamSchema?: readonly ParamSchemaEntry[],
): string | undefined {
  if (materialParamSchema === undefined) return undefined;
  const hasStandardPhysicalMaps =
    isStandardPbrMaterialShader(materialShaderId) &&
    physicalTextureFields(materialParamSchema).length > 0;
  if (isEngineOwnedMaterialShader(materialShaderId) && !hasStandardPhysicalMaps) {
    return undefined;
  }
  return materialBindGroupLayoutIdentity(materialShaderId, materialParamSchema);
}
